"""Unit test for sofi._booking_form_data — the function that builds the
Fabrik booking POST payload. This regression test catches the SQL 1064 /
"Incorrect integer value: ''" bug class WITHOUT touching the live Sofi
instance.

The captured-from-browser baseline we replicate here:
  - 6 YesNo radio defaults must be "0" (contactado, flag,
    factura_solicitada, status_conciliado, status_proforma_voucher,
    status_pago).
  - The 10-field app_notes placeholder row must be present even when the
    booking has no notes (otherwise MariaDB raises 1064 on the join INSERT).
  - Join-group <select>s must use the "[]" suffix (product[], producto_2[],
    trip_id[]) — without it MySQL receives '' for an INT NOT NULL column.
  - Submit must be the empty string (not "Submit").
  - hiddenElements JSON is required for Fabrik's submit handler.
  - Dates must be sent as full 'YYYY-MM-DD HH:MM:SS' DATETIMEs.
"""
import sys
import os
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sofi import _booking_form_data


HIDDEN_STUB = {
    "Itemid": "112",
    "fabrik_referrer": "",
    "fabrik_ajax": "0",
    "format": "html",
    "formid": "3",
    "listid": "3",
    "listref": "3",
    "option": "com_fabrik",
    "package": "fabrik",
    "task": "form.process",
    "returntoform": "0",
    "fabrik_repeat_group[3]": "1",
    "fabrik_repeat_group[24]": "1",
    "fabrik_repeat_group[25]": "1",
    "fabrik_repeat_group[38]": "1",
    "fabrik_repeat_group[47]": "1",
    "app_notes___from[0][]": "53",  # already in hidden, must not be duplicated
    "abc1234567890abc1234567890abcdef": "1",  # CSRF token
}

SAMPLE_BOOKING = {
    "kind": "service",
    "trip_id": 2311,
    "service_name": "Madrid food tour",
    "city": "Madrid",
    "quantity": 2,
    "date_entry": "2026-08-01",
    "date_exit": None,
    "room": None,
    "invoice_excl": 82.64,
    "invoice_incl": 100.0,
    "price_total": 100.0,
    "notes": None,
    "provider": None,
    "type_radio": 0,
}


def _to_multidict(data):
    """Convert the (k, v) list to a dict-of-lists for assertions on duplicates."""
    out = {}
    for k, v in data:
        out.setdefault(k, []).append(v)
    return out


def test_join_group_selects_use_bracket_suffix():
    """Fabrik <select> elements that belong to a databasejoin group MUST
    use name="...[]" — sending the bare name made MySQL crash with
    "Incorrect integer value: '' for column 'product'/'producto_2'"."""
    data = _booking_form_data(SAMPLE_BOOKING, HIDDEN_STUB)
    keys = {k for k, _ in data}
    assert "app_bookings___product[]" in keys
    assert "app_bookings___producto_2[]" in keys
    assert "app_bookings___trip_id[]" in keys
    # And the SAME names without the [] suffix must NOT be present
    assert "app_bookings___product" not in keys
    assert "app_bookings___producto_2" not in keys


def test_yesno_radio_defaults_are_zero():
    """Each YesNo radio column is INT NOT NULL; we must send "0" or
    Fabrik's POST handler hits 'Incorrect integer value' on insert."""
    data = _to_multidict(_booking_form_data(SAMPLE_BOOKING, HIDDEN_STUB))
    for radio in ("contactado", "flag", "factura_solicitada",
                  "status_conciliado", "status_proforma_voucher", "status_pago"):
        key = f"app_bookings___{radio}[]"
        assert key in data, f"missing {key}"
        assert data[key] == ["0"], f"{key} should default to '0', got {data[key]!r}"


def test_app_notes_placeholder_row_complete():
    """The booking form embeds the app_notes sub-group (47). Even when the
    user has no note, the browser submits a full placeholder row — if we
    don't, MariaDB raises 1064 on the join INSERT."""
    data = _to_multidict(_booking_form_data(SAMPLE_BOOKING, HIDDEN_STUB))
    required_notes_keys = (
        "app_notes___id[0]",
        "app_notes___date_time[0]",
        "app_notes___fecha_recordatorio[0]",
        "app_notes___note[0]",
        "app_notes___to[0][]",
        "app_notes___reserva[0][]",
        "app_notes___recordado[0][]",
        "app_notes___solved[0][]",
        "app_notes___enviar_correo[0][]",
    )
    for k in required_notes_keys:
        assert k in data, f"missing {k}"


def test_app_notes_from_is_not_duplicated():
    """`app_notes___from[0][]` is emitted by the hidden-input template; we
    must NOT re-append it or Fabrik may concatenate the values."""
    data = _to_multidict(_booking_form_data(SAMPLE_BOOKING, HIDDEN_STUB))
    assert data.get("app_notes___from[0][]") == ["53"], data.get("app_notes___from[0][]")


def test_submit_value_is_empty_string():
    """Browser POSTs `Submit=` (empty), not `Submit=Submit`. The form's PHP
    handler checks for the KEY existence, not the value."""
    data = _to_multidict(_booking_form_data(SAMPLE_BOOKING, HIDDEN_STUB))
    assert data.get("Submit") == [""], data.get("Submit")


def test_hidden_elements_json_present():
    """Fabrik reads `hiddenElements` to know which fields come from JS state
    vs the form POST. Missing → form handler may rebuild calc fields with
    empty strings, triggering MySQL syntax errors."""
    data = _to_multidict(_booking_form_data(SAMPLE_BOOKING, HIDDEN_STUB))
    hidden_elements = data.get("hiddenElements")
    assert hidden_elements is not None
    assert hidden_elements[0].startswith("[")
    # Sanity: should mention the auto-calc fields
    assert "app_bookings___date_time" in hidden_elements[0]
    assert "app_bookings___proveedor_mensual" in hidden_elements[0]


def test_date_entry_is_full_datetime():
    """Sofi DB stores `date_entry` as DATETIME — send YYYY-MM-DD HH:MM:SS,
    not just the date portion."""
    data = _to_multidict(_booking_form_data(SAMPLE_BOOKING, HIDDEN_STUB))
    date_entry = data.get("app_bookings___date_entry", [""])[0]
    assert date_entry == "2026-08-01 00:00:00", date_entry


def test_room_and_note_always_emitted():
    """Browser always sends these keys (even empty). Omitting them caused
    Fabrik's update SQL to fail with 1064 because of missing column refs."""
    data = _to_multidict(_booking_form_data(SAMPLE_BOOKING, HIDDEN_STUB))
    assert "app_bookings___room" in data
    assert "app_bookings___note" in data
    assert "app_bookings___operator-auto-complete" in data
    assert "app_bookings___operator[]" in data


def test_accommodation_booking_sends_date_exit():
    """Accommodation bookings span check-in→check-out; both dates must be
    present as full DATETIMEs."""
    b = dict(SAMPLE_BOOKING)
    b.update({
        "kind": "accommodation",
        "type_radio": 1,
        "date_entry": "2026-08-01",
        "date_exit": "2026-08-04",
        "room": "doble",
    })
    data = _to_multidict(_booking_form_data(b, HIDDEN_STUB))
    assert data.get("app_bookings___date_entry") == ["2026-08-01 00:00:00"]
    assert data.get("app_bookings___date_exit") == ["2026-08-04 00:00:00"]
    assert data.get("app_bookings___room") == ["doble"]


def test_routing_fields_present():
    """Fabrik dispatches by `option=com_fabrik` + `task=form.process` +
    `formid=3`. These come from hidden inputs but we also re-emit them."""
    data = _to_multidict(_booking_form_data(SAMPLE_BOOKING, HIDDEN_STUB))
    assert "option" in data
    assert "task" in data
    assert "formid" in data
