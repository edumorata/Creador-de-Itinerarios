"""PayPal Orders v2 client.

Thin wrapper around PayPal's REST API using httpx — no SDK dependency so we
control the exact request shape, idempotency keys, and error surface.

Public API:
  • get_access_token() -> str            cached OAuth bearer
  • create_order(payment) -> dict        POST /v2/checkout/orders
  • capture_order(order_id) -> dict      POST /v2/checkout/orders/{id}/capture
  • verify_webhook(headers, body) -> bool POST /v1/notifications/verify-webhook-signature

Configuration (read from environment, never hard-coded):
  PAYPAL_MODE         "sandbox" | "live"   (default: sandbox)
  PAYPAL_CLIENT_ID    REST app client id
  PAYPAL_SECRET       REST app secret
  PAYPAL_WEBHOOK_ID   webhook id from developer.paypal.com (filled in after
                      the first deploy when the public URL exists)
"""
from __future__ import annotations

import base64
import logging
import os
import time
from typing import Optional

import httpx

logger = logging.getLogger("paypal")

_SANDBOX_BASE = "https://api-m.sandbox.paypal.com"
_LIVE_BASE = "https://api-m.paypal.com"


def _base_url() -> str:
    mode = (os.environ.get("PAYPAL_MODE") or "sandbox").lower()
    return _LIVE_BASE if mode == "live" else _SANDBOX_BASE


def _client_id() -> str:
    cid = os.environ.get("PAYPAL_CLIENT_ID") or ""
    if not cid:
        raise RuntimeError("PAYPAL_CLIENT_ID is not configured")
    return cid


def _secret() -> str:
    s = os.environ.get("PAYPAL_SECRET") or ""
    if not s:
        raise RuntimeError("PAYPAL_SECRET is not configured")
    return s


# Cached OAuth token. PayPal tokens live ~9 hours; we refresh 60s early to
# avoid edge cases where a long-running request crosses the boundary.
_token_cache: dict = {"value": None, "expires_at": 0.0}


async def get_access_token() -> str:
    """Fetch (or reuse) a PayPal OAuth bearer token via the
    client_credentials grant. Tokens are cached in-process; concurrent
    requests will race but the worst case is two redundant calls in the
    first second after boot, which PayPal accepts."""
    now = time.time()
    if _token_cache["value"] and _token_cache["expires_at"] > now + 60:
        return _token_cache["value"]
    auth = base64.b64encode(f"{_client_id()}:{_secret()}".encode()).decode()
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(
            f"{_base_url()}/v1/oauth2/token",
            headers={"Authorization": f"Basic {auth}",
                     "Content-Type": "application/x-www-form-urlencoded"},
            data="grant_type=client_credentials",
        )
        r.raise_for_status()
        data = r.json()
    _token_cache["value"] = data["access_token"]
    _token_cache["expires_at"] = now + float(data.get("expires_in", 32000))
    return data["access_token"]


async def create_order(
    *,
    amount_eur: float,
    return_url: str,
    cancel_url: str,
    reference: str,
    description: str,
    payer_email: Optional[str] = None,
) -> dict:
    """Create a new PayPal Order (intent=CAPTURE). Returns the parsed JSON
    response which includes `id`, `status="CREATED"`, and a `links[]` array
    where the `rel="approve"` entry is the URL the buyer must visit.

    `reference` lets us trace the order back to one of our `Payment` rows
    in the webhook handler (Mongo lookup by paypal_order_id is also stored,
    but reference travels with PayPal's payment record forever).
    """
    token = await get_access_token()
    body = {
        "intent": "CAPTURE",
        "purchase_units": [{
            "reference_id": reference,
            "description": description[:127],   # PayPal hard limit
            "amount": {
                "currency_code": "EUR",
                "value": f"{round(amount_eur, 2):.2f}",
            },
        }],
        "application_context": {
            "brand_name": "Viajad Verdad",
            "locale": "es-ES",
            "landing_page": "BILLING",          # show CC fields first, not the PP login
            "shipping_preference": "NO_SHIPPING",
            "user_action": "PAY_NOW",
            "return_url": return_url,
            "cancel_url": cancel_url,
        },
    }
    if payer_email:
        body["payer"] = {"email_address": payer_email}
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            f"{_base_url()}/v2/checkout/orders",
            headers={"Authorization": f"Bearer {token}",
                     "Content-Type": "application/json",
                     "Prefer": "return=representation"},
            json=body,
        )
        if r.status_code >= 400:
            logger.warning("paypal create_order %d: %s", r.status_code, r.text[:400])
            r.raise_for_status()
        return r.json()


async def capture_order(order_id: str) -> dict:
    """Capture a previously-approved Order. PayPal returns the final
    capture_id and the status flips to COMPLETED on success. Idempotent on
    PayPal's side — capturing an already-captured order returns the same
    capture record."""
    token = await get_access_token()
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            f"{_base_url()}/v2/checkout/orders/{order_id}/capture",
            headers={"Authorization": f"Bearer {token}",
                     "Content-Type": "application/json"},
        )
        if r.status_code >= 400:
            logger.warning("paypal capture_order %d: %s", r.status_code, r.text[:400])
            r.raise_for_status()
        return r.json()


async def get_order(order_id: str) -> dict:
    """Fetch the current status of an Order. Useful when our `return_url`
    handler runs BEFORE the webhook arrives — we re-poll to confirm the
    capture without waiting on the webhook."""
    token = await get_access_token()
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(
            f"{_base_url()}/v2/checkout/orders/{order_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        r.raise_for_status()
        return r.json()


async def verify_webhook(headers: dict, body_raw: str) -> bool:
    """Ask PayPal whether a webhook payload is authentic. Calls
    /v1/notifications/verify-webhook-signature, which is the official
    server-side verification path (cheaper and less error-prone than
    manually reimplementing the X-PAYPAL-CERT chain check).

    Headers we need from the incoming request (case-insensitive):
      paypal-transmission-id
      paypal-transmission-time
      paypal-transmission-sig
      paypal-cert-url
      paypal-auth-algo
    """
    webhook_id = os.environ.get("PAYPAL_WEBHOOK_ID")
    if not webhook_id:
        # Webhook id not yet configured (typical pre-deploy). Treat the
        # event as unverifiable but don't crash — the caller decides
        # whether to honour the payload.
        return False
    token = await get_access_token()
    import json
    try:
        webhook_event = json.loads(body_raw) if isinstance(body_raw, str) else body_raw
    except Exception:
        return False
    payload = {
        "transmission_id": headers.get("paypal-transmission-id"),
        "transmission_time": headers.get("paypal-transmission-time"),
        "cert_url": headers.get("paypal-cert-url"),
        "auth_algo": headers.get("paypal-auth-algo"),
        "transmission_sig": headers.get("paypal-transmission-sig"),
        "webhook_id": webhook_id,
        "webhook_event": webhook_event,
    }
    if not all(payload[k] for k in ("transmission_id", "transmission_time",
                                     "cert_url", "auth_algo", "transmission_sig")):
        return False
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(
            f"{_base_url()}/v1/notifications/verify-webhook-signature",
            headers={"Authorization": f"Bearer {token}",
                     "Content-Type": "application/json"},
            json=payload,
        )
        if r.status_code >= 400:
            logger.warning("paypal verify_webhook %d: %s", r.status_code, r.text[:200])
            return False
        return r.json().get("verification_status") == "SUCCESS"


def approval_url(order: dict) -> Optional[str]:
    """Pull the `rel="approve"` link out of a create_order response."""
    for link in order.get("links") or []:
        if link.get("rel") == "approve" and link.get("href"):
            return link["href"]
    return None
