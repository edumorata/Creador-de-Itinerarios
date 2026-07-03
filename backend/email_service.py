"""Thin async wrapper around Resend for transactional emails.

Designed to be **non-blocking** (Resend SDK is sync, so we offload to a
thread) and **safe to call from any endpoint**: if `RESEND_API_KEY` is not
configured, helpers log a warning and return False instead of raising —
the calling endpoint should never fail because the email service isn't
set up yet.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

import resend

logger = logging.getLogger(__name__)


def _is_configured() -> bool:
    return bool(os.environ.get("RESEND_API_KEY"))


def _sender() -> str:
    return os.environ.get("RESEND_SENDER_EMAIL") or "onboarding@resend.dev"


async def send_email(
    *,
    to: str,
    subject: str,
    html: str,
    text: Optional[str] = None,
    reply_to: Optional[str] = None,
) -> bool:
    """Send a one-off transactional email. Returns True on success, False
    if the email service isn't configured or the send failed. Never raises."""
    if not _is_configured():
        logger.warning("Resend not configured — skipping email to %s", to)
        return False
    api_key = os.environ["RESEND_API_KEY"]
    resend.api_key = api_key
    params = {
        "from": _sender(),
        "to": [to],
        "subject": subject,
        "html": html,
    }
    if text:
        params["text"] = text
    if reply_to:
        params["reply_to"] = reply_to
    try:
        result = await asyncio.to_thread(resend.Emails.send, params)
        logger.info("sent email to %s subject=%r id=%s", to, subject, result.get("id"))
        return True
    except Exception as e:  # noqa: BLE001 — Resend SDK has many error types
        logger.warning("resend send failed to=%s err=%s", to, e)
        return False


def render_traveler_info_email(itn: dict, info: dict, public_url: Optional[str] = None) -> tuple[str, str, str]:
    """Render the subject/HTML/text bodies for the 'client has filled in
    the booking form' notification."""
    trip_name = itn.get("name") or "Viaje"
    main_traveler = itn.get("main_traveler") or ""
    subject = f"[Espíritu Travel] Datos rellenados — {trip_name}"

    # Compose people rows
    people = info.get("people") or []
    people_rows_html = "".join(
        f"<tr>"
        f"<td style='padding:6px 10px;border-bottom:1px solid #eee'>{(p.get('full_name') or '—')}</td>"
        f"<td style='padding:6px 10px;border-bottom:1px solid #eee;font-family:monospace'>{(p.get('passport_number') or '—')}</td>"
        f"<td style='padding:6px 10px;border-bottom:1px solid #eee'>{(p.get('date_of_birth') or '—')}</td>"
        f"</tr>"
        for p in people
    )
    people_rows_text = "\n".join(
        f"  - {p.get('full_name') or '(sin nombre)'} | {p.get('passport_number') or '—'} | {p.get('date_of_birth') or '—'}"
        for p in people
    ) or "  (sin viajeros)"

    fields_html = (
        f"<tr><td style='padding:4px 10px;color:#666'>Vuelo llegada</td><td style='padding:4px 10px'>{info.get('arrival_flight') or '—'}</td></tr>"
        f"<tr><td style='padding:4px 10px;color:#666'>Vuelo salida</td><td style='padding:4px 10px'>{info.get('departure_flight') or '—'}</td></tr>"
        f"<tr><td style='padding:4px 10px;color:#666'>Teléfono</td><td style='padding:4px 10px'>{info.get('phone') or '—'}</td></tr>"
        f"<tr><td style='padding:4px 10px;color:#666'>Email cliente</td><td style='padding:4px 10px'>{info.get('submitted_by_email') or '—'}</td></tr>"
    )
    notes = info.get("notes") or ""

    link_block_html = (
        f"<p style='margin:24px 0 8px'><a href='{public_url}' style='color:#e37e5e'>Ver enlace público del cliente →</a></p>"
        if public_url else ""
    )
    link_block_text = f"\nEnlace público del cliente: {public_url}\n" if public_url else ""

    html = f"""\
<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4ebd7;padding:24px;color:#121b28">
    <table cellpadding="0" cellspacing="0" width="100%" style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #ead9b8">
      <tr><td style="padding:20px 28px;border-bottom:1px solid #ead9b8">
        <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#666">Datos del cliente recibidos</div>
        <div style="font-size:22px;font-weight:700;margin-top:6px">{trip_name}</div>
        {f'<div style="color:#666;margin-top:2px">Cliente principal: {main_traveler}</div>' if main_traveler else ''}
      </td></tr>
      <tr><td style="padding:16px 28px">
        <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#666;margin-bottom:6px">Viajeros ({len(people)})</div>
        <table cellpadding="0" cellspacing="0" width="100%" style="font-size:14px;border:1px solid #eee">
          <thead><tr style="background:#fafafa">
            <th align="left" style="padding:6px 10px;border-bottom:1px solid #eee">Nombre</th>
            <th align="left" style="padding:6px 10px;border-bottom:1px solid #eee">Pasaporte</th>
            <th align="left" style="padding:6px 10px;border-bottom:1px solid #eee">F. nacimiento</th>
          </tr></thead>
          <tbody>{people_rows_html or '<tr><td colspan=3 style="padding:10px;color:#999">(sin viajeros)</td></tr>'}</tbody>
        </table>
      </td></tr>
      <tr><td style="padding:8px 28px 16px">
        <table cellpadding="0" cellspacing="0" width="100%" style="font-size:14px;border:1px solid #eee">{fields_html}</table>
      </td></tr>
      {f'<tr><td style="padding:8px 28px 16px"><div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#666;margin-bottom:6px">Alergias / notas</div><div style="font-size:14px;white-space:pre-wrap;background:#faf6ec;padding:12px;border-left:3px solid #e37e5e">{notes}</div></td></tr>' if notes else ''}
      <tr><td style="padding:8px 28px 22px;font-size:12px;color:#666">
        {link_block_html}
        Enviado por el cliente desde el enlace público de pago · {info.get('submitted_at')}
      </td></tr>
    </table>
  </body>
</html>
"""
    text = f"""\
Datos del cliente recibidos
{trip_name}
{f'Cliente principal: {main_traveler}' if main_traveler else ''}

Viajeros ({len(people)}):
{people_rows_text}

- Vuelo llegada: {info.get('arrival_flight') or '—'}
- Vuelo salida: {info.get('departure_flight') or '—'}
- Teléfono: {info.get('phone') or '—'}
- Email cliente: {info.get('submitted_by_email') or '—'}

Alergias / notas:
{notes or '—'}
{link_block_text}
Enviado: {info.get('submitted_at')}
"""
    return subject, html, text


def render_split_invite_email(
    *,
    trip_name: str,
    payer_name: Optional[str],
    from_name: Optional[str],
    share_eur: float,
    remaining_eur: float,
    booking_secured: bool,
    deposit_threshold_eur: float,
    paid_eur: float,
    public_url: str,
) -> tuple[str, str, str]:
    """Compose the transactional email a traveler sends to the NEXT
    payer in a split invoice. Includes the trip name, how much has been
    paid so far, the recipient's suggested share, and a big CTA to the
    same /pay/:token link (they'll land in split-mode auto-detected)."""
    subject = f"Your share of {trip_name} · pay securely"
    who_name = (payer_name or "there").strip() or "there"
    from_line = (
        f"{from_name.strip()} just paid their share of the trip and asked us to send you this link."
        if (from_name or "").strip()
        else "You're being invited to pay your share of this trip."
    )
    if booking_secured:
        booking_line = (
            f"The booking is <strong>confirmed</strong> — enough of the "
            f"{deposit_threshold_eur:.2f} € deposit has already been collected."
        )
        booking_line_text = (
            f"The booking is confirmed — enough of the {deposit_threshold_eur:.2f} € "
            f"deposit has already been collected."
        )
    else:
        gap = max(0.0, deposit_threshold_eur - paid_eur)
        booking_line = (
            f"So far <strong>{paid_eur:.2f} €</strong> has been paid. "
            f"Booking is confirmed once we reach <strong>{deposit_threshold_eur:.2f} €</strong> "
            f"(deposit) — {gap:.2f} € to go."
        )
        booking_line_text = (
            f"So far {paid_eur:.2f} € has been paid. Booking is confirmed once we "
            f"reach {deposit_threshold_eur:.2f} € (deposit) — {gap:.2f} € to go."
        )
    html = f"""\
<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4ebd7;padding:24px;color:#121b28">
    <table cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #ead9b8">
      <tr><td style="padding:24px 28px;border-bottom:1px solid #ead9b8">
        <div style="font-size:11px;letter-spacing:.25em;text-transform:uppercase;color:#B08749">Espíritu Travel · payment invite</div>
        <div style="font-family:Georgia,serif;font-size:26px;margin-top:8px;line-height:1.15">{trip_name}</div>
      </td></tr>
      <tr><td style="padding:20px 28px">
        <p style="font-size:15px;line-height:1.65;margin:0 0 12px">Hi {who_name},</p>
        <p style="font-size:15px;line-height:1.65;margin:0 0 12px">{from_line}</p>
        <p style="font-size:15px;line-height:1.65;margin:0 0 12px">{booking_line}</p>
      </td></tr>
      <tr><td style="padding:0 28px 8px">
        <div style="background:#f4ebd7;padding:20px;border-left:4px solid #e37e5e">
          <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#B08749">Your share</div>
          <div style="font-family:Georgia,serif;font-size:36px;color:#121b28;margin-top:4px">{share_eur:.2f} €</div>
          <div style="font-size:12px;color:#666;margin-top:4px">Remaining balance in the invoice: {remaining_eur:.2f} €</div>
        </div>
      </td></tr>
      <tr><td style="padding:20px 28px 8px">
        <a href="{public_url}" style="display:inline-block;background:#121b28;color:#fff;padding:14px 28px;text-decoration:none;font-size:13px;letter-spacing:.15em;text-transform:uppercase;font-weight:700">Pay my share →</a>
      </td></tr>
      <tr><td style="padding:12px 28px 24px;font-size:12px;color:#666">
        Secure checkout via PayPal — credit/debit cards accepted, no account needed.
        The link is unique to this trip; open it on any device and use the
        <em>Splitting with fellow travelers?</em> toggle if you'd like to change the split.
      </td></tr>
    </table>
  </body>
</html>
"""
    text = f"""\
Hi {who_name},

{from_line}

{booking_line_text}

Your share: {share_eur:.2f} €
Remaining balance in the invoice: {remaining_eur:.2f} €

Pay securely here: {public_url}

Espíritu Travel · payment invite
"""
    return subject, html, text
