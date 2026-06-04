"""Regression tests for the two new features added on 2026-06-03:

 1. Service-type taxonomy refactor:
       restaurante → actividad
       transporte  → tren
       otro        → actividad
       NEW         entradas
    The Pydantic Literal ServiceType is now strict and rejects the old values.

 2. Pax-aware Itinerary fields:
    - ItineraryService gains a `pax` field (defaults to 1).
    - Accommodation gains a `rooms` array + Room model with per-night prices.
    - Itinerary gains a `room_config` default room layout.

Run:  cd /app && python -m backend.tests.test_pax_taxonomy
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, "/app/backend")

from models import (  # noqa: E402
    Accommodation, Experience, Itinerary, ItineraryDay, ItineraryService,
    Room, RoomConfig, ServiceType,
)
from pydantic import ValidationError


def test_taxonomy_strict():
    """Old service-type literals must be rejected."""
    for bad in ("restaurante", "transporte", "otro"):
        try:
            ItineraryService(name="x", type=bad)
        except ValidationError:
            print(f"  · ✅ rejected old type {bad!r}")
            continue
        raise AssertionError(f"expected ValidationError for type={bad!r}")
    # New 'entradas' must be accepted
    s = ItineraryService(name="Vatican tickets", type="entradas", pax=1)
    assert s.type == "entradas"
    print("  · ✅ accepted new type 'entradas'")


def test_experience_pax_default():
    """Experience.pax defaults to 1 (per-person pricing — the most common case).
    Group-priced services like private tours/transfers explicitly set pax > 1."""
    e = Experience(title="Tapas tour", provider_id="prov_xxx")
    assert e.pax == 1, f"expected default pax=1, got {e.pax}"
    print(f"  · ✅ Experience default pax = {e.pax}")


def test_service_pax_default():
    """ItineraryService.pax defaults to 1 (safe per-person fallback)."""
    s = ItineraryService(name="x", type="actividad")
    assert s.pax == 1, f"expected default pax=1, got {s.pax}"
    print(f"  · ✅ ItineraryService default pax = {s.pax}")


def test_smart_qty_logic():
    """Replicate the frontend qty calc and verify cases."""
    def qty(num_travelers, pax):
        return max(1, math.ceil(num_travelers / pax))

    cases = [
        (2, 2, 1),  # tapas-for-2 with couple → 1
        (4, 2, 2),  # tapas-for-2 with family of 4 → 2
        (4, 1, 4),  # per-person ticket with 4 travelers → 4
        (2, 4, 1),  # private tour for 4 with couple → 1 (capacity unused)
        (5, 4, 2),  # private tour for 4 with 5 → 2
        (3, 3, 1),  # transfer-for-3 with 3 travelers → 1
        (4, 3, 2),  # transfer-for-3 with 4 → 2
    ]
    for trav, p, expected in cases:
        got = qty(trav, p)
        assert got == expected, f"qty({trav},{p}) expected {expected}, got {got}"
        print(f"  · ✅ qty({trav} trav, {p} pax) = {got}")


def test_rooms_and_room_config():
    """Accommodation with rooms aggregates correctly + RoomConfig validates."""
    rc = RoomConfig(room_type="doble", pax=2, quantity=2)
    assert rc.quantity == 2 and rc.pax == 2
    rooms = [
        Room(room_type="doble", pax=2, price_per_night_excl=100, price_per_night_incl=110),
        Room(room_type="single", pax=1, price_per_night_excl=70,  price_per_night_incl=77),
    ]
    acc = Accommodation(name="Hotel X", rooms=rooms,
                        price_tax_excl=170 * 3, price_tax_incl=187 * 3)
    assert len(acc.rooms) == 2
    sum_excl = sum(r.price_per_night_excl for r in acc.rooms)
    sum_incl = sum(r.price_per_night_incl for r in acc.rooms)
    assert sum_excl == 170 and sum_incl == 187
    print(f"  · ✅ {len(acc.rooms)} rooms · €{sum_excl} excl / €{sum_incl} incl per night")


def test_itinerary_with_room_config():
    """Itinerary stores room_config and accepts saved Accommodation rooms."""
    itn = Itinerary(
        num_travelers=4,
        room_config=[
            RoomConfig(room_type="doble", pax=2, quantity=2),
        ],
        accommodations=[
            Accommodation(name="Hotel A", rooms=[
                Room(room_type="doble", pax=2, price_per_night_excl=80, price_per_night_incl=88),
                Room(room_type="doble", pax=2, price_per_night_excl=80, price_per_night_incl=88),
            ]),
        ],
        days=[
            ItineraryDay(label="Day 1", services=[
                ItineraryService(name="Tapas tour 2pax", type="actividad", pax=2, quantity=2),
                ItineraryService(name="Sagrada tickets", type="entradas", pax=1, quantity=4),
            ]),
        ],
    )
    assert itn.room_config[0].quantity == 2
    assert itn.accommodations[0].rooms[0].price_per_night_incl == 88
    assert itn.days[0].services[0].type == "actividad"
    assert itn.days[0].services[1].type == "entradas"
    print("  · ✅ full itinerary roundtrip OK")


def main():
    print("[1] taxonomy strictness…")
    test_taxonomy_strict()
    print("[2] experience pax default…")
    test_experience_pax_default()
    print("[3] service pax default…")
    test_service_pax_default()
    print("[4] smart quantity logic…")
    test_smart_qty_logic()
    print("[5] rooms + room_config models…")
    test_rooms_and_room_config()
    print("[6] full itinerary with room_config + entradas…")
    test_itinerary_with_room_config()
    print("\n✅ All pax/taxonomy tests passed.")


if __name__ == "__main__":
    main()
