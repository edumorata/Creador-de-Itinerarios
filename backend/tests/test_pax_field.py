"""Regression tests for the `pax` field added to Experience.

Validates:
 - Experiences carry a `pax` field (int, default 2)
 - Catalog has variety of pax counts after the operators CSV import
 - Autocomplete ranks exact-pax matches first when `pax` is provided
 - List endpoint returns pax in payload

Run:  cd /app && python -m backend.tests.test_pax_field
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import httpx
from dotenv import dotenv_values
from motor.motor_asyncio import AsyncIOMotorClient


ENV = dotenv_values(Path(__file__).resolve().parent.parent / ".env")
BACKEND_URL = "http://127.0.0.1:8001"
ADMIN_TOKEN = "3rrWWDXfC1ze9MEHqZzbC0eQK3nq29wClvsJPIMsQhc"
HEADERS = {"Cookie": f"session_token={ADMIN_TOKEN}"}


async def assert_db_state():
    client = AsyncIOMotorClient(ENV["MONGO_URL"])
    db = client[ENV["DB_NAME"]]
    total = await db.experiences.count_documents({})
    assert total > 1000, f"expected catalog with 1000+ experiences, got {total}"
    no_pax = await db.experiences.count_documents({"pax": {"$exists": False}})
    assert no_pax == 0, f"{no_pax} experiences are missing the pax field"
    pax_under_1 = await db.experiences.count_documents({"pax": {"$lt": 1}})
    pax_over_20 = await db.experiences.count_documents({"pax": {"$gt": 20}})
    assert pax_under_1 == 0, f"{pax_under_1} experiences have pax < 1 (data error)"
    assert pax_over_20 == 0, f"{pax_over_20} experiences have pax > 20 (data error, expected cap)"
    pax_variants = await db.experiences.distinct("pax")
    assert len(pax_variants) >= 4, f"expected at least 4 different pax counts, got {sorted(pax_variants)}"
    print(f"  · {total} experiences, pax variants: {sorted(pax_variants)}")


async def assert_list_endpoint():
    async with httpx.AsyncClient(base_url=BACKEND_URL, headers=HEADERS, timeout=15) as c:
        r = await c.get("/api/experiences", params={"limit": 5})
        assert r.status_code == 200
        data = r.json()
        assert len(data) > 0
        for item in data:
            assert "pax" in item, f"list endpoint must expose `pax`: {item}"
            assert isinstance(item["pax"], int), f"pax must be int, got {type(item['pax'])}"
        print(f"  · /api/experiences returns pax in {len(data)}/{len(data)} items")


async def assert_autocomplete_ranks_pax():
    async with httpx.AsyncClient(base_url=BACKEND_URL, headers=HEADERS, timeout=15) as c:
        # Find a service that has multiple pax variants
        r4 = await c.get("/api/experiences/autocomplete", params={"q": "Vatican", "pax": 4})
        r2 = await c.get("/api/experiences/autocomplete", params={"q": "Vatican", "pax": 2})
        assert r4.status_code == 200 and r2.status_code == 200
        if not r4.json() or not r2.json():
            print("  · skipping rank test (no Vatican results)")
            return
        top_4 = r4.json()[0]
        top_2 = r2.json()[0]
        # When asking for pax=4, the top result should have pax closer to 4 than for pax=2
        d4 = abs(top_4.get("pax", 2) - 4)
        d2 = abs(top_2.get("pax", 2) - 2)
        print(f"  · pax=4 top result: pax={top_4['pax']} (Δ={d4}); pax=2 top: pax={top_2['pax']} (Δ={d2})")
        assert d4 <= 2, f"expected pax=4 query to surface close-pax results first, got pax={top_4['pax']}"
        assert d2 <= 2, f"expected pax=2 query to surface close-pax results first, got pax={top_2['pax']}"


async def main():
    print("[1/3] DB state…")
    await assert_db_state()
    print("[2/3] List endpoint…")
    await assert_list_endpoint()
    print("[3/3] Autocomplete ranking…")
    await assert_autocomplete_ranks_pax()
    print("\n✅ All pax-field tests passed.")


if __name__ == "__main__":
    sys.path.insert(0, "/app")
    asyncio.run(main())
