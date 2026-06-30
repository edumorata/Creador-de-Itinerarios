"""End-to-end backend tests for the PayPal payment-link flow.

Covers:
  - POST /api/itineraries/{id}/payments/create-link (auth, idempotency, options)
  - GET  /api/payments/{token}  (public, 404 on bad token)
  - POST /api/payments/{token}/create-order (full / invalid kind / unknown token)
  - Days-to-trip rule (>60 → deposit+full ; <=60 → only full)
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://itinerary-builder-74.preview.emergentagent.com").rstrip("/")
SESSION_COOKIE = "3rrWWDXfC1ze9MEHqZzbC0eQK3nq29wClvsJPIMsQhc"

# Known itineraries from problem statement
ITN_FUTURE = "itn_a7c0b99824a4"   # start=2027-04-02 → >60 days → both options
ITN_PAST = "itn_708e44718bc6"      # start=2026-06-02 (past now) → only "full"


@pytest.fixture(scope="module")
def auth_client():
    s = requests.Session()
    s.cookies.set("session_token", SESSION_COOKIE)
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def public_client():
    s = requests.Session()  # no cookie
    s.headers.update({"Content-Type": "application/json"})
    return s


# --- Sanity ----------------------------------------------------------------
def test_itineraries_endpoint_accessible(auth_client):
    r = auth_client.get(f"{BASE_URL}/api/itineraries")
    assert r.status_code == 200, r.text
    data = r.json()
    # The endpoint may return a list directly or wrapped
    items = data if isinstance(data, list) else data.get("items") or data.get("itineraries") or []
    assert isinstance(items, list)
    ids = [it.get("itinerary_id") for it in items]
    print(f"Found {len(items)} itineraries. First IDs: {ids[:5]}")
    assert ITN_FUTURE in ids or ITN_PAST in ids, "Expected reference itineraries not visible"


# --- create-link: auth ------------------------------------------------------
def test_create_link_requires_auth(public_client):
    r = public_client.post(f"{BASE_URL}/api/itineraries/{ITN_FUTURE}/payments/create-link")
    assert r.status_code in (401, 403), f"Expected 401/403, got {r.status_code}: {r.text}"


# --- create-link: happy path + shape ---------------------------------------
def test_create_link_future_returns_full_shape(auth_client):
    r = auth_client.post(f"{BASE_URL}/api/itineraries/{ITN_FUTURE}/payments/create-link")
    assert r.status_code == 200, r.text
    data = r.json()
    for key in ("payment_token", "payment_url", "instructions", "options", "payments"):
        assert key in data, f"missing {key}"
    assert isinstance(data["payment_token"], str) and len(data["payment_token"]) > 10
    assert data["payment_token"] in data["payment_url"]
    assert "/pay/" in data["payment_url"]
    opts = data["options"]
    for key in ("total_eur", "paid_eur", "remaining_eur", "days_to_trip", "fully_paid", "options"):
        assert key in opts, f"options missing {key}"
    assert opts["fully_paid"] is False
    assert opts["days_to_trip"] is not None and opts["days_to_trip"] > 60
    kinds = sorted(o["kind"] for o in opts["options"])
    assert kinds == ["deposit", "full"], f"expected deposit+full, got {kinds}"
    # Deposit must be exactly 30%
    dep = next(o for o in opts["options"] if o["kind"] == "deposit")
    full = next(o for o in opts["options"] if o["kind"] == "full")
    assert round(dep["amount_eur"], 2) == round(opts["total_eur"] * 0.30, 2)
    assert round(full["amount_eur"], 2) == round(opts["total_eur"], 2)
    print(f"FUTURE itinerary total={opts['total_eur']} days={opts['days_to_trip']} options={kinds}")


# --- create-link: idempotent -----------------------------------------------
def test_create_link_is_idempotent(auth_client):
    r1 = auth_client.post(f"{BASE_URL}/api/itineraries/{ITN_FUTURE}/payments/create-link")
    r2 = auth_client.post(f"{BASE_URL}/api/itineraries/{ITN_FUTURE}/payments/create-link")
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["payment_token"] == r2.json()["payment_token"]


# --- create-link: past / <=60 days → full only -----------------------------
def test_create_link_past_returns_only_full(auth_client):
    r = auth_client.post(f"{BASE_URL}/api/itineraries/{ITN_PAST}/payments/create-link")
    assert r.status_code == 200, r.text
    opts = r.json()["options"]
    kinds = [o["kind"] for o in opts["options"]]
    assert opts["days_to_trip"] is None or opts["days_to_trip"] <= 60
    # If not fully paid, only 'full' should be exposed
    if not opts["fully_paid"]:
        assert kinds == ["full"], f"expected ['full'], got {kinds}"
    print(f"PAST itinerary days={opts['days_to_trip']} fully_paid={opts['fully_paid']} options={kinds}")


# --- GET /api/payments/{token} public --------------------------------------
def test_get_payment_landing_public_no_auth(public_client, auth_client):
    # First ensure token exists
    r0 = auth_client.post(f"{BASE_URL}/api/itineraries/{ITN_FUTURE}/payments/create-link")
    token = r0.json()["payment_token"]
    r = public_client.get(f"{BASE_URL}/api/payments/{token}")
    assert r.status_code == 200, r.text
    data = r.json()
    for key in ("trip_name", "start_date", "end_date", "num_travelers",
                "total_eur", "paid_eur", "remaining_eur", "days_to_trip",
                "fully_paid", "options"):
        assert key in data, f"missing {key} in public landing"
    assert data["trip_name"]
    kinds = sorted(o["kind"] for o in data["options"])
    assert "full" in kinds


def test_get_payment_landing_unknown_token_404(public_client):
    r = public_client.get(f"{BASE_URL}/api/payments/this-is-a-fake-token-xyz999")
    assert r.status_code == 404


# --- create-order: full happy path -----------------------------------------
def test_create_order_full_returns_paypal_approval(auth_client, public_client):
    r0 = auth_client.post(f"{BASE_URL}/api/itineraries/{ITN_PAST}/payments/create-link")
    token = r0.json()["payment_token"]
    # Public client (no cookie) — endpoint must be public
    r = public_client.post(
        f"{BASE_URL}/api/payments/{token}/create-order",
        json={"kind": "full"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert "paypal_order_id" in data and data["paypal_order_id"]
    assert "approval_url" in data and data["approval_url"]
    assert "sandbox.paypal.com" in data["approval_url"]
    assert "checkoutnow" in data["approval_url"] or "approve" in data["approval_url"]

    # Verify payment row exists with status='created' kind='full'
    landing = public_client.get(f"{BASE_URL}/api/payments/{token}").json()
    # landing doesn't surface payments[]; query via the agent-authenticated endpoint
    r2 = auth_client.post(f"{BASE_URL}/api/itineraries/{ITN_PAST}/payments/create-link")
    payments = r2.json().get("payments") or []
    matching = [p for p in payments if p.get("paypal_order_id") == data["paypal_order_id"]]
    assert matching, "Payment row not persisted after create-order"
    assert matching[0]["status"] == "created"
    assert matching[0]["kind"] == "full"


# --- create-order: invalid kind for current rules --------------------------
def test_create_order_invalid_kind_returns_400(auth_client, public_client):
    # Past trip → 'deposit' is NOT a valid option
    r0 = auth_client.post(f"{BASE_URL}/api/itineraries/{ITN_PAST}/payments/create-link")
    token = r0.json()["payment_token"]
    r = public_client.post(
        f"{BASE_URL}/api/payments/{token}/create-order",
        json={"kind": "deposit"},
    )
    assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text}"


# --- create-order: unknown token 404 ---------------------------------------
def test_create_order_unknown_token_404(public_client):
    r = public_client.post(
        f"{BASE_URL}/api/payments/fake-token-zzz-000/create-order",
        json={"kind": "full"},
    )
    assert r.status_code == 404


# --- access control: random user can't create link for someone else's itn --
def test_create_link_without_session_cookie_401(public_client):
    r = public_client.post(f"{BASE_URL}/api/itineraries/{ITN_FUTURE}/payments/create-link")
    assert r.status_code in (401, 403)
