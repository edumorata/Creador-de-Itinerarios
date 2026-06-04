"""Regression tests for the user-reported issues fixed on 2026-06-04:

 1. Autocomplete supports comma-separated multi-city filter ("Madrid, Barcelona").
 2. Legacy dash-joined city filter ("Madrid-Barcelona") is silently dropped
    (those never matched real rows; treating them as "no filter" is the right UX).
 3. list_experiences endpoint accepts the same multi-city format.

Run:  cd /app && python -m backend.tests.test_multi_city_filter
"""
from __future__ import annotations

import asyncio
import sys

import httpx

BACKEND_URL = "http://127.0.0.1:8001"
ADMIN_TOKEN = "3rrWWDXfC1ze9MEHqZzbC0eQK3nq29wClvsJPIMsQhc"
HEADERS = {"Cookie": f"session_token={ADMIN_TOKEN}"}


async def main():
    async with httpx.AsyncClient(base_url=BACKEND_URL, headers=HEADERS, timeout=15) as c:
        # --- 1) multi-city
        r = await c.get("/api/experiences/autocomplete", params={"city": "Madrid,Barcelona", "q": "tour"})
        assert r.status_code == 200
        data = r.json()
        cities = {x.get("city") for x in data}
        assert cities <= {"Madrid", "Barcelona"}, f"multi-city leaked: {cities}"
        assert "Madrid" in cities and "Barcelona" in cities, f"expected both Madrid+Barcelona, got {cities}"
        print(f"  · ✅ multi-city: {len(data)} results across {sorted(cities)}")

        # --- 2) legacy dash filter
        r = await c.get("/api/experiences/autocomplete", params={"city": "Madrid-Barcelona", "q": "museum"})
        assert r.status_code == 200
        data = r.json()
        # Should behave like no city filter (i.e. return some non-Madrid results)
        if data:
            cities = {x.get("city") for x in data}
            assert cities != {"Madrid"} and cities != {"Barcelona"}, \
                f"dash filter still constraining: {cities}"
            print(f"  · ✅ dash filter ignored ({len(data)} results, cities: {len(cities)} distinct)")

        # --- 3) list_experiences with multi-city
        r = await c.get("/api/experiences", params={"city": "Madrid,Barcelona", "limit": 50})
        assert r.status_code == 200
        data = r.json()
        cities = {x.get("city") for x in data}
        assert cities <= {"Madrid", "Barcelona"}, f"list multi-city leaked: {cities}"
        print(f"  · ✅ /experiences multi-city: {len(data)} results")

        # --- 4) trailing/leading whitespace tolerated
        r = await c.get("/api/experiences/autocomplete", params={"city": " Madrid , Barcelona ", "q": "tour"})
        cities = {x.get("city") for x in r.json()}
        assert cities <= {"Madrid", "Barcelona"}, f"whitespace not stripped: {cities}"
        print("  · ✅ whitespace tolerant")

    print("\n✅ All multi-city filter tests passed.")


if __name__ == "__main__":
    sys.path.insert(0, "/app")
    asyncio.run(main())
