"""Regression tests for the simplified pricing model added on 2026-06-04:

Experiences (any type except 'alojamiento'):
    qty = num_travelers
    unit_price = catalog_total / catalog_pax   (i.e. €/pax)
    total = qty × unit_price

Lodging (alojamiento):
    qty = nights × num_rooms
    unit_price = avg(rooms.price_per_night)
    total = qty × unit_price   == Σ(rooms × nights)

Run:  cd /app && python -m backend.tests.test_simple_pricing_model
"""
from __future__ import annotations

import math


def add_experience_to_day(catalog_total_incl, catalog_pax, num_travelers, type_="actividad"):
    """Mirror addServiceToDay() for an experience pick."""
    if type_ == "alojamiento":
        return {"quantity": 1, "unit_price_tax_incl": catalog_total_incl}
    expPax = max(1, int(catalog_pax))
    per_pax = catalog_total_incl / expPax
    return {
        "quantity": num_travelers,
        "unit_price_tax_incl": round(per_pax, 2),
        "pax": expPax,
    }


def acc_totals(rooms, nights):
    """Mirror updateRooms() / upsertAccommodationFromService()."""
    num_rooms = max(1, len(rooms))
    sum_incl = sum(r.get("price_per_night_incl") or r.get("price_per_night_excl") or 0 for r in rooms)
    avg_incl = round(sum_incl / num_rooms, 2)
    total_qty = nights * num_rooms
    total = round(avg_incl * total_qty, 2)
    return total_qty, avg_incl, total


# --- experiences --------------------------------------------------------------
def test_experience_couple():
    """Tapas tour priced for 2 pax at €72 → €/pax = €36. Trip for 2 → €72 total."""
    s = add_experience_to_day(catalog_total_incl=72, catalog_pax=2, num_travelers=2)
    total = s["quantity"] * s["unit_price_tax_incl"]
    assert s["quantity"] == 2 and s["unit_price_tax_incl"] == 36
    assert total == 72
    print(f"  · ✅ tapas 2pax × €72 → unit=€36/pax × 2 = €{total}")


def test_experience_family_of_four():
    """Same tapas tour for a family of 4 → €144 total."""
    s = add_experience_to_day(catalog_total_incl=72, catalog_pax=2, num_travelers=4)
    total = s["quantity"] * s["unit_price_tax_incl"]
    assert s["quantity"] == 4 and total == 144
    print(f"  · ✅ tapas 2pax × €72 + 4 viajeros → unit=€36 × 4 = €{total}")


def test_transfer_for_three_with_four():
    """Transfer priced for 3 pax at €180 → €/pax = €60. Trip for 4 → €240."""
    s = add_experience_to_day(catalog_total_incl=180, catalog_pax=3, num_travelers=4)
    assert s["unit_price_tax_incl"] == 60 and s["quantity"] == 4
    assert s["quantity"] * s["unit_price_tax_incl"] == 240
    print(f"  · ✅ transfer 3pax × €180 + 4 viajeros → €60 × 4 = €240")


def test_single_pax_ticket():
    """Per-person ticket (catalog pax=1) at €25 → €/pax = €25. Trip for 4 → €100."""
    s = add_experience_to_day(catalog_total_incl=25, catalog_pax=1, num_travelers=4)
    assert s["unit_price_tax_incl"] == 25 and s["quantity"] == 4
    print(f"  · ✅ ticket pax=1 × €25 + 4 → €100")


# --- lodging ------------------------------------------------------------------
def test_lodging_one_room_three_nights():
    rooms = [{"price_per_night_incl": 640}]
    qty, unit, total = acc_totals(rooms, nights=3)
    assert qty == 3 and unit == 640 and total == 1920
    print(f"  · ✅ 1 hab × 3 noches × €640 → qty={qty}, unit=€{unit}, total=€{total}")


def test_lodging_two_rooms_three_nights():
    rooms = [{"price_per_night_incl": 320}, {"price_per_night_incl": 320}]
    qty, unit, total = acc_totals(rooms, nights=3)
    # New model: qty = 3*2 = 6, unit = avg = €320, total = 6 × 320 = €1920
    assert qty == 6 and unit == 320 and total == 1920
    print(f"  · ✅ 2 habs × 3 noches × €320/hab → qty={qty}, unit=€{unit}, total=€{total}")


def test_lodging_two_rooms_two_nights_303():
    """User's example: 2 habs × 2 noches × €303 = €1.212."""
    rooms = [{"price_per_night_incl": 303}, {"price_per_night_incl": 303}]
    qty, unit, total = acc_totals(rooms, nights=2)
    assert qty == 4 and unit == 303 and total == 1212
    print(f"  · ✅ 2 habs × 2 noches × €303 → qty={qty}, unit=€{unit}, total=€{total}")


def test_lodging_mixed_rooms():
    """Mixed room prices: average is what carries on the matrix row."""
    rooms = [{"price_per_night_incl": 200}, {"price_per_night_incl": 100}]
    qty, unit, total = acc_totals(rooms, nights=5)
    # avg = 150, qty = 10, total = 1500 = Σ(200+100) × 5 ✅
    assert unit == 150 and qty == 10 and total == 1500
    sum_check = sum(r["price_per_night_incl"] for r in rooms) * 5
    assert math.isclose(total, sum_check)
    print(f"  · ✅ mixed (200+100) × 5 noches → avg=€{unit}, qty={qty}, total=€{total}")


def main():
    print("[1] tapas for couple…")
    test_experience_couple()
    print("[2] tapas for family of 4…")
    test_experience_family_of_four()
    print("[3] transfer for 3 with 4…")
    test_transfer_for_three_with_four()
    print("[4] single-pax ticket…")
    test_single_pax_ticket()
    print("[5] 1 hab × 3 noches…")
    test_lodging_one_room_three_nights()
    print("[6] 2 habs × 3 noches…")
    test_lodging_two_rooms_three_nights()
    print("[7] 2 habs × 2 noches × €303…")
    test_lodging_two_rooms_two_nights_303()
    print("[8] mixed rooms…")
    test_lodging_mixed_rooms()
    print("\n✅ All simplified pricing model tests passed.")


if __name__ == "__main__":
    main()
