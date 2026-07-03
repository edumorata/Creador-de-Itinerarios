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


_PAYMENT_KIND_LABEL = {
    "deposit": "Depósito (30%)",
    "full":    "Pago completo (100%)",
    "balance": "Saldo restante",
    "partial": "Pago parcial",
    "extra":   "Extra post-venta",
}


def render_payment_captured_email(
    *,
    trip_name: str,
    main_traveler: str,
    kind: str,
    share_label: str,
    payer_name: str,
    amount_eur: float,
    currency: str,
    paid_eur_total: float,
    total_eur: float,
    remaining_eur: float,
    booking_secured: bool,
    paypal_capture_id: str,
    itinerary_url: str,
) -> tuple[str, str, str]:
    """Email to the agent (created_by) whenever a client captures a payment.
    Covers deposit, full, balance, partial share and post-sale extra.
    Includes the running total and remaining balance."""
    kind_label = _PAYMENT_KIND_LABEL.get(kind, kind or "Pago")
    if share_label:
        kind_label = f"{kind_label} · {share_label}"
    subject = f"[Pago recibido] {trip_name} · {amount_eur:.2f} {currency or '€'}"
    status_line = (
        "Reserva asegurada — se ha alcanzado el umbral del depósito."
        if booking_secured else
        f"Cobrado hasta ahora: {paid_eur_total:.2f} € de {total_eur:.2f} €. "
        f"Falta cobrar {remaining_eur:.2f} €."
    )
    accent = "#3d7d5b" if booking_secured else "#B08749"
    payer_html = (
        f'<div style="color:#666;margin-top:4px;font-size:13px">De: <strong>{payer_name}</strong></div>'
        if payer_name else ""
    )
    html = f"""\
<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4ebd7;padding:24px;color:#121b28">
    <table cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #ead9b8">
      <tr><td style="padding:24px 28px;border-bottom:1px solid #ead9b8">
        <div style="font-size:11px;letter-spacing:.25em;text-transform:uppercase;color:{accent}">Pago recibido</div>
        <div style="font-family:Georgia,serif;font-size:24px;margin-top:8px;line-height:1.15">{trip_name}</div>
        {f'<div style="color:#666;margin-top:4px;font-size:13px">Cliente: {main_traveler}</div>' if main_traveler else ''}
        {payer_html}
      </td></tr>
      <tr><td style="padding:0 28px">
        <div style="background:#f4ebd7;padding:20px;border-left:4px solid {accent};margin-top:20px">
          <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#B08749">{kind_label}</div>
          <div style="font-family:Georgia,serif;font-size:36px;color:{accent};margin-top:4px">+ {amount_eur:.2f} {currency or '€'}</div>
          <div style="font-size:12px;color:#666;margin-top:8px;font-family:monospace">PayPal capture: {paypal_capture_id or '(pendiente)'}</div>
        </div>
      </td></tr>
      <tr><td style="padding:16px 28px 8px">
        <p style="font-size:14px;line-height:1.65;margin:0 0 6px"><strong>Estado del cobro:</strong></p>
        <p style="font-size:14px;line-height:1.65;margin:0 0 12px">{status_line}</p>
      </td></tr>
      <tr><td style="padding:8px 28px 8px">
        <a href="{itinerary_url}" style="display:inline-block;background:#121b28;color:#fff;padding:14px 28px;text-decoration:none;font-size:13px;letter-spacing:.15em;text-transform:uppercase;font-weight:700">Ver itinerario →</a>
      </td></tr>
      <tr><td style="padding:12px 28px 24px;font-size:12px;color:#666">Espíritu Travel · notificaciones internas</td></tr>
    </table>
  </body>
</html>
"""
    text = f"""\
Pago recibido
{trip_name}
{f'Cliente: {main_traveler}' if main_traveler else ''}
{f'De: {payer_name}' if payer_name else ''}

{kind_label}: {amount_eur:.2f} {currency or '€'}
PayPal capture: {paypal_capture_id or '(pendiente)'}

{status_line}

Ver itinerario: {itinerary_url}
"""
    return subject, html, text


def render_balance_reminder_email(
    *,
    trip_name: str,
    main_traveler: str,
    total_eur: float,
    paid_eur: float,
    remaining_eur: float,
    trip_start_date: str,
    balance_due_date: str,
    days_left: int,
    itinerary_url: str,
) -> tuple[str, str, str]:
    """Reminder to the agent 5 days before the client must complete the
    full payment (i.e. `trip_start_date - 45 days`)."""
    subject = f"[Recordatorio] En {days_left} días vence el saldo de {trip_name} · {remaining_eur:.2f} €"
    html = f"""\
<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4ebd7;padding:24px;color:#121b28">
    <table cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #ead9b8">
      <tr><td style="padding:24px 28px;border-bottom:1px solid #ead9b8">
        <div style="font-size:11px;letter-spacing:.25em;text-transform:uppercase;color:#e37e5e">Aviso · saldo próximo a vencer</div>
        <div style="font-family:Georgia,serif;font-size:24px;margin-top:8px;line-height:1.15">{trip_name}</div>
        {f'<div style="color:#666;margin-top:4px;font-size:13px">Cliente: {main_traveler}</div>' if main_traveler else ''}
      </td></tr>
      <tr><td style="padding:0 28px">
        <div style="background:#f4ebd7;padding:20px;border-left:4px solid #e37e5e;margin-top:20px">
          <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#B08749">Saldo restante</div>
          <div style="font-family:Georgia,serif;font-size:36px;color:#c94433;margin-top:4px">{remaining_eur:.2f} €</div>
          <div style="font-size:13px;color:#666;margin-top:8px">Cobrado hasta ahora: {paid_eur:.2f} € de {total_eur:.2f} €</div>
        </div>
      </td></tr>
      <tr><td style="padding:16px 28px 8px">
        <table cellpadding="0" cellspacing="0" width="100%" style="font-size:14px;border:1px solid #eee">
          <tr><td style="padding:8px 12px;color:#666">Salida del viaje</td><td style="padding:8px 12px">{trip_start_date}</td></tr>
          <tr><td style="padding:8px 12px;color:#666">Vencimiento del saldo</td><td style="padding:8px 12px"><strong>{balance_due_date}</strong> (en {days_left} días)</td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:16px 28px 8px">
        <p style="font-size:14px;line-height:1.65;margin:0 0 12px">Contacta con el cliente y envíale el enlace de pago para que abone el saldo antes de la fecha límite.</p>
      </td></tr>
      <tr><td style="padding:8px 28px 8px">
        <a href="{itinerary_url}" style="display:inline-block;background:#121b28;color:#fff;padding:14px 28px;text-decoration:none;font-size:13px;letter-spacing:.15em;text-transform:uppercase;font-weight:700">Abrir itinerario →</a>
      </td></tr>
      <tr><td style="padding:12px 28px 24px;font-size:12px;color:#666">Espíritu Travel · recordatorio automático</td></tr>
    </table>
  </body>
</html>
"""
    text = f"""\
Aviso · saldo próximo a vencer
{trip_name}
{f'Cliente: {main_traveler}' if main_traveler else ''}

Saldo restante: {remaining_eur:.2f} €
Cobrado hasta ahora: {paid_eur:.2f} € de {total_eur:.2f} €

Salida del viaje: {trip_start_date}
Vencimiento del saldo: {balance_due_date} (en {days_left} días)

Contacta con el cliente y envíale el enlace de pago para que abone el saldo antes de la fecha límite.

Abrir itinerario: {itinerary_url}
"""
    return subject, html, text


def render_refund_request_email(
    *,
    trip_name: str,
    main_traveler: str,
    amount_eur: float,
    reason: str,
    requested_by: str,
    itinerary_url: str,
) -> tuple[str, str, str]:
    """Email to the approver whitelist (Bea, Marina) when an agent files a
    new refund request. Direct link back to the itinerary so the approver
    can review the RefundsModal in one click."""
    subject = f"[Reembolso pendiente] {trip_name} · {amount_eur:.2f} €"
    reason_line = (reason or "").strip() or "(sin motivo especificado)"
    html = f"""\
<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4ebd7;padding:24px;color:#121b28">
    <table cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #ead9b8">
      <tr><td style="padding:24px 28px;border-bottom:1px solid #ead9b8">
        <div style="font-size:11px;letter-spacing:.25em;text-transform:uppercase;color:#B08749">Reembolso pendiente de aprobación</div>
        <div style="font-family:Georgia,serif;font-size:24px;margin-top:8px;line-height:1.15">{trip_name}</div>
        {f'<div style="color:#666;margin-top:4px;font-size:13px">Cliente: {main_traveler}</div>' if main_traveler else ''}
      </td></tr>
      <tr><td style="padding:0 28px">
        <div style="background:#f4ebd7;padding:18px 20px;border-left:4px solid #e37e5e;margin-top:20px">
          <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#B08749">Importe solicitado</div>
          <div style="font-family:Georgia,serif;font-size:34px;color:#c94433;margin-top:4px">− {amount_eur:.2f} €</div>
          <div style="font-size:12px;color:#666;margin-top:8px">Solicitado por <strong>{requested_by}</strong></div>
        </div>
      </td></tr>
      <tr><td style="padding:16px 28px 8px">
        <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#666;margin-bottom:6px">Motivo</div>
        <div style="font-size:14px;white-space:pre-wrap;background:#faf6ec;padding:12px 14px;border:1px solid #ead9b8">{reason_line}</div>
      </td></tr>
      <tr><td style="padding:20px 28px 8px">
        <a href="{itinerary_url}" style="display:inline-block;background:#121b28;color:#fff;padding:14px 28px;text-decoration:none;font-size:13px;letter-spacing:.15em;text-transform:uppercase;font-weight:700">Revisar y aprobar →</a>
      </td></tr>
      <tr><td style="padding:12px 28px 24px;font-size:12px;color:#666;line-height:1.6">
        Al aprobar, PayPal ejecuta el reembolso automáticamente y el importe se descuenta del PVP del viaje. Sólo Beatriz, Marina o Eduardo pueden aprobar.
      </td></tr>
    </table>
  </body>
</html>
"""
    text = f"""\
Reembolso pendiente de aprobación
{trip_name}
{f'Cliente: {main_traveler}' if main_traveler else ''}

Importe solicitado: {amount_eur:.2f} €
Solicitado por: {requested_by}

Motivo:
{reason_line}

Revisar y aprobar: {itinerary_url}

Al aprobar, PayPal ejecuta el reembolso automáticamente.
"""
    return subject, html, text


def render_refund_decision_email(
    *,
    trip_name: str,
    main_traveler: str,
    amount_eur: float,
    reason: str,
    approved: bool,
    approver_email: str,
    decision_note: str,
    paypal_refund_id: Optional[str],
    itinerary_url: str,
) -> tuple[str, str, str]:
    """Email to the agent who requested the refund, once a manager has
    approved (money returned) or rejected the request."""
    verb = "aprobado" if approved else "rechazado"
    accent = "#3d7d5b" if approved else "#c94433"
    subject = f"[Reembolso {verb}] {trip_name} · {amount_eur:.2f} €"
    reason_line = (reason or "").strip() or "(sin motivo especificado)"
    note_html = (
        f"<tr><td style='padding:16px 28px 8px'><div style='font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#666;margin-bottom:6px'>Nota del aprobador</div>"
        f"<div style='font-size:14px;white-space:pre-wrap;background:#faf6ec;padding:12px 14px;border:1px solid #ead9b8'>{decision_note}</div></td></tr>"
        if (decision_note or "").strip() else ""
    )
    pp_line_html = (
        f"<div style='font-size:12px;color:#666;margin-top:8px'>PayPal refund id: <code style='font-family:monospace'>{paypal_refund_id}</code></div>"
        if paypal_refund_id else ""
    )
    action_line = (
        "El importe se ha devuelto al cliente vía PayPal y ya se descuenta del PVP del viaje."
        if approved else
        "La solicitud ha sido rechazada. No se ha movido dinero."
    )
    html = f"""\
<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4ebd7;padding:24px;color:#121b28">
    <table cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #ead9b8">
      <tr><td style="padding:24px 28px;border-bottom:1px solid #ead9b8">
        <div style="font-size:11px;letter-spacing:.25em;text-transform:uppercase;color:{accent}">Reembolso {verb}</div>
        <div style="font-family:Georgia,serif;font-size:24px;margin-top:8px;line-height:1.15">{trip_name}</div>
        {f'<div style="color:#666;margin-top:4px;font-size:13px">Cliente: {main_traveler}</div>' if main_traveler else ''}
      </td></tr>
      <tr><td style="padding:0 28px">
        <div style="background:#f4ebd7;padding:18px 20px;border-left:4px solid {accent};margin-top:20px">
          <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#B08749">Importe</div>
          <div style="font-family:Georgia,serif;font-size:34px;color:{accent};margin-top:4px">{'− ' if approved else ''}{amount_eur:.2f} €</div>
          <div style="font-size:13px;color:#666;margin-top:8px">Decisión tomada por <strong>{approver_email}</strong></div>
          {pp_line_html}
        </div>
      </td></tr>
      <tr><td style="padding:16px 28px 8px">
        <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#666;margin-bottom:6px">Motivo original</div>
        <div style="font-size:14px;white-space:pre-wrap;background:#faf6ec;padding:12px 14px;border:1px solid #ead9b8">{reason_line}</div>
      </td></tr>
      {note_html}
      <tr><td style="padding:16px 28px">
        <p style="font-size:14px;line-height:1.65;margin:0 0 12px">{action_line}</p>
      </td></tr>
      <tr><td style="padding:8px 28px 8px">
        <a href="{itinerary_url}" style="display:inline-block;background:#121b28;color:#fff;padding:14px 28px;text-decoration:none;font-size:13px;letter-spacing:.15em;text-transform:uppercase;font-weight:700">Abrir itinerario →</a>
      </td></tr>
      <tr><td style="padding:12px 28px 24px;font-size:12px;color:#666">Espíritu Travel · notificaciones internas</td></tr>
    </table>
  </body>
</html>
"""
    text = f"""\
Reembolso {verb}
{trip_name}
{f'Cliente: {main_traveler}' if main_traveler else ''}

Importe: {amount_eur:.2f} €
Decisión de: {approver_email}
{f'PayPal refund id: {paypal_refund_id}' if paypal_refund_id else ''}

Motivo original:
{reason_line}

{f'Nota del aprobador: {decision_note}' if (decision_note or '').strip() else ''}

{action_line}

Abrir itinerario: {itinerary_url}
"""
    return subject, html, text
