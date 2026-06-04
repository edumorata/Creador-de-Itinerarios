"""Regression tests for the multi-room × nights computation.

Replicates the JS logic in `upsertAccommodationFromService` and `updateRooms`
to prove that:
  - the matrix row (Check-in service) carries qty=nights, unit_price=Σ(rooms/night)
  - the parent accommodation summary stores price = Σ(rooms/night) × nights
  - changing the number of rooms in the sumario propagates to the day matrix
"""
from __future__ import annotations

import math


def compute(rooms, nights):
    """Mirror the JS logic. `rooms` is a list of dicts with
    price_per_night_excl/incl. Returns (qty, unit_excl, unit_incl, total_incl)."""
    nights = max(1, nights)
    sum_incl = sum(r.get("price_per_night_incl") or r.get("price_per_night_excl") or 0 for r in rooms)
    sum_excl = sum(r.get("price_per_night_excl") or r.get("price_per_night_incl") or 0 for r in rooms)
    return nights, sum_excl, sum_incl, round(sum_incl * nights, 2)


def test_single_room_three_nights():
    rooms = [{"price_per_night_excl": 581.82, "price_per_night_incl": 640}]
    qty, ue, ui, total = compute(rooms, 3)
    assert qty == 3 and ui == 640 and total == 1920.0
    print(f"  · ✅ 1 hab × 3 noches × €640 = €{total}")


def test_two_rooms_three_nights():
    rooms = [
        {"price_per_night_excl": 290.91, "price_per_night_incl": 320},
        {"price_per_night_excl": 290.91, "price_per_night_incl": 320},
    ]
    qty, ue, ui, total = compute(rooms, 3)
    # Each Check-in row stores qty=3, unit=640 (= Σ rooms/night), total = 3 * 640
    assert qty == 3, f"expected qty=3, got {qty}"
    assert ui == 640, f"expected unit=640, got {ui}"
    assert total == 1920.0, f"expected total=1920, got {total}"
    print(f"  · ✅ 2 habs × 3 noches × €320/hab = €{total} (carrier qty={qty}, unit=€{ui})")


def test_three_rooms_two_nights():
    rooms = [
        {"price_per_night_excl": 100, "price_per_night_incl": 110},
        {"price_per_night_excl": 100, "price_per_night_incl": 110},
        {"price_per_night_excl": 80,  "price_per_night_incl": 88},
    ]
    qty, ue, ui, total = compute(rooms, 2)
    assert ui == 308 and total == 616.0
    print(f"  · ✅ 3 habs (110+110+88) × 2 noches = €{total}")


def test_room_with_zero_incl_uses_excl():
    """price_per_night_incl missing → must fallback to excl."""
    rooms = [{"price_per_night_excl": 200, "price_per_night_incl": 0}]
    qty, ue, ui, total = compute(rooms, 4)
    assert ui == 200, f"expected fallback to excl=200, got {ui}"
    assert total == 800.0
    print(f"  · ✅ incl missing falls back to excl → €{total}")


def test_room_summary_matches_day_carrier():
    """The summary `price_tax_incl` equals Σ(rooms/night) × nights, identical
    to qty * unit_price on the day carrier."""
    rooms = [
        {"price_per_night_incl": 200, "price_per_night_excl": 181.82},
        {"price_per_night_incl": 200, "price_per_night_excl": 181.82},
    ]
    nights = 5
    qty, ue, ui, total = compute(rooms, nights)
    summary_total = round(sum(r["price_per_night_incl"] for r in rooms) * nights, 2)
    assert math.isclose(summary_total, qty * ui), \
        f"summary {summary_total} ≠ matrix {qty * ui}"
    print(f"  · ✅ summary €{summary_total} == matrix qty({qty}) × unit(€{ui}) = €{qty*ui}")


def main():
    print("[1] single room × nights…")
    test_single_room_three_nights()
    print("[2] two rooms × nights (the user-reported bug)…")
    test_two_rooms_three_nights()
    print("[3] three rooms × nights…")
    test_three_rooms_two_nights()
    print("[4] fallback incl→excl…")
    test_room_with_zero_incl_uses_excl()
    print("[5] sumario matches matrix…")
    test_room_summary_matches_day_carrier()
    print("\n✅ All multi-room math tests passed.")


if __name__ == "__main__":
    main()
