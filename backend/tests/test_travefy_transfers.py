"""Regression: the Travefy importer used to read ONLY `days[].activities[]`
and `days[].hotels[]`, completely ignoring the `days[].transfers[]` array
that Claude populates with internal flights and private transfers (per the
PARSE_SYSTEM prompt in scraper.py). Result: a trip with "Flight TP 874
LIS → FLR" between Lisbon and Florence would silently drop the flight on
import.

This test exercises the import worker against a synthetic Travefy payload
that mirrors the user-reported example URL and verifies that the resulting
preview surfaces the flight as a `vuelo` item on the correct day.
"""
import os
import sys
import asyncio
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server


# Synthetic version of the user's actual URL — same shape Claude returns
# for travefy.com/trip/itinerary/k5SSks4Ac0ynBJLOAIPOWQXAwMDEEAFMv0NPXkye_LC5_-qp3FQN
SYNTHETIC_SCRAPE = {
    "ok": True,
    "source": "anonymous",
    "structured": {
        "trip_name": "Portugal + Italy",
        "num_travelers": 2,
        "days": [
            {"day": 1, "date": "2026-09-01", "city": "Lisbon",
             "activities": [{"name": "Pastéis de Belém tasting"}],
             "hotels": [{"name": "The Art Inn Lisbon", "check_in": "2026-09-01", "check_out": "2026-09-04"}],
             "transfers": [{"description": "Private Transfer Airport to Hotel",
                            "from": "Lisbon Airport", "to": "The Art Inn Lisbon"}]},
            {"day": 5, "date": "2026-09-05", "city": "Tuscany",
             "activities": [{"name": "Truffle hunting walk"},
                            {"name": "Cooking class with Marco"}],
             "hotels": [{"name": "Villa il Salice", "check_in": "2026-09-05", "check_out": "2026-09-08"}],
             "transfers": [
                 {"description": "Private Transfer Hotel to Airport",
                  "from": "The Art Inn Lisbon", "to": "Lisbon Airport"},
                 {"description": "Flight TP 874 LIS → FLR",
                  "from": "Lisbon", "to": "Florence"},
             ]},
            {"day": 9, "date": "2026-09-09", "city": "Rome",
             "activities": [],
             "hotels": [],
             "transfers": [{"description": "Private Transfer Hotel to Fiumicino Airport",
                            "from": "Rome Life Hotel", "to": "Fiumicino Airport"}]},
        ],
    },
}


def _run_worker_with_scrape(scrape):
    """Spin up the preview worker against a canned scrape payload and
    return the `preview` dict the worker writes into the job doc."""
    captured = {}

    async def fake_update_one(_filter, update_doc):
        if "$set" in update_doc:
            captured.update(update_doc["$set"])

    fake_jobs = AsyncMock()
    fake_jobs.update_one = fake_update_one

    async def _go():
        with patch("scraper.scrape_and_parse", new=AsyncMock(return_value=scrape)), \
             patch.object(server.db, "travefy_import_jobs", fake_jobs), \
             patch("server._match_experience", new=AsyncMock(return_value=None)), \
             patch("server._match_hotel", new=AsyncMock(return_value=None)):
            await server._run_travefy_preview_job(
                job_id="test_job_transfers", url="https://x",
            )
        return captured

    return asyncio.run(_go())


def test_travefy_import_picks_up_transfers_and_flights():
    """The preview worker must lift internal flights + private transfers out
    of `transfers[]` and into `items_out` alongside activities. Skipping
    them used to make trip preview show zero transport lines."""
    captured = _run_worker_with_scrape(SYNTHETIC_SCRAPE)
    preview = captured.get("preview")
    assert preview is not None, f"job never finished, captured={captured}"
    days = preview.get("days") or []
    assert len(days) == 3

    # Day 1 — should have 1 activity + 1 transfer = 2 items
    day1 = next(d for d in days if d["day"] == 1)
    day1_kinds = [(it["travefy_name"], it["type"]) for it in (day1.get("items") or [])]
    assert ("Private Transfer Airport to Hotel", "transfer") in day1_kinds
    assert len(day1_kinds) == 2  # tasting + transfer

    # Day 5 — the smoking gun: must include BOTH the private transfer AND the flight
    day5 = next(d for d in days if d["day"] == 5)
    day5_items = day5.get("items") or []
    names = {it["travefy_name"]: it["type"] for it in day5_items}
    assert "Flight TP 874 LIS → FLR" in names, f"flight missing, items={day5_items}"
    assert names["Flight TP 874 LIS → FLR"] == "vuelo"
    assert "Private Transfer Hotel to Airport" in names
    # 2 activities + 2 transfers = 4 items
    assert len(day5_items) == 4

    # Day 9 — no activity, only the transfer
    day9 = next(d for d in days if d["day"] == 9)
    day9_items = day9.get("items") or []
    assert len(day9_items) == 1
    assert day9_items[0]["travefy_name"] == "Private Transfer Hotel to Fiumicino Airport"
    assert day9_items[0]["type"] == "transfer"


def test_travefy_import_skips_empty_transfer_descriptions():
    """If Claude returns a transfer with an empty description (rare but
    possible when an OCR pass fails), the import worker MUST silently
    skip it instead of crashing or surfacing an empty entry."""
    scrape = {
        "ok": True,
        "source": "anonymous",
        "structured": {
            "days": [{
                "day": 1, "date": "2026-09-01", "city": "Rome",
                "activities": [],
                "hotels": [],
                "transfers": [
                    {"description": "", "from": "X", "to": "Y"},
                    {"description": None},
                ],
            }],
        },
    }
    captured = _run_worker_with_scrape(scrape)
    preview = captured.get("preview")
    assert preview is not None
    assert (preview["days"][0].get("items") or []) == []
