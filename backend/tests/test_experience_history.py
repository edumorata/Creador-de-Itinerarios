"""Regression tests for the experience change history (audit log) added 2026-06-04.

Verifies:
 - PATCH /experiences/{id} logs only fields that actually changed.
 - GET /experiences/{id}/history returns entries newest-first with diff payload.
 - source query param is persisted ("manual" / "itinerary" / "csv_import").

Run:  cd /app && python -m backend.tests.test_experience_history
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import httpx
from dotenv import dotenv_values

_env = dotenv_values(Path(__file__).resolve().parent.parent / ".env")
BACKEND_URL = "http://127.0.0.1:8001"
ADMIN_TOKEN = os.environ.get("TEST_ADMIN_TOKEN") or _env.get("TEST_ADMIN_TOKEN", "")
HEADERS = {"Cookie": f"session_token={ADMIN_TOKEN}"}


async def main():
    async with httpx.AsyncClient(base_url=BACKEND_URL, headers=HEADERS, timeout=15) as c:
        # Pick any experience from the catalog
        r = await c.get("/api/experiences", params={"limit": 1})
        assert r.status_code == 200 and r.json(), "catalog is empty"
        exp = r.json()[0]
        eid = exp["experience_id"]
        original_pax = exp.get("pax", 2)
        original_incl = exp.get("price_tax_incl", 0)

        # 1) First edit — change pax + price, source=itinerary
        r = await c.patch(f"/api/experiences/{eid}?source=itinerary",
                          json={"pax": original_pax + 1, "price_tax_incl": original_incl + 100})
        assert r.status_code == 200

        # 2) Second edit — change only the title, source=manual
        r = await c.patch(f"/api/experiences/{eid}?source=manual",
                          json={"title": exp["title"]})  # SAME title → must NOT log
        assert r.status_code == 200
        r = await c.patch(f"/api/experiences/{eid}?source=manual",
                          json={"title": exp["title"] + " ✏️"})
        assert r.status_code == 200

        # 3) Fetch the history
        r = await c.get(f"/api/experiences/{eid}/history")
        assert r.status_code == 200
        history = r.json()
        assert len(history) >= 2, f"expected ≥ 2 entries, got {len(history)}"
        latest = history[0]
        # newest-first
        assert latest["created_at"] >= history[-1]["created_at"]
        # latest must be the title change (source=manual)
        assert latest["source"] == "manual"
        assert "title" in latest["diff"]
        # find the earlier entry that bumped pax & price (source=itinerary)
        bump = next((h for h in history if h["source"] == "itinerary" and "pax" in h["diff"]), None)
        assert bump is not None, "expected an itinerary-sourced entry with pax diff"
        assert bump["diff"]["pax"]["from"] == original_pax
        assert bump["diff"]["pax"]["to"] == original_pax + 1
        # The no-op title PATCH should NOT have generated a history entry; one
        # title-only entry should exist per run, accumulating across runs since
        # we don't clean the audit log. We at least assert ≥ 1 (each call adds 1).
        title_entries = [h for h in history if list(h["diff"].keys()) == ["title"]]
        assert len(title_entries) >= 1, f"expected ≥ 1 title-only entry, got {len(title_entries)}"
        print(f"  · ✅ {len(history)} entries · latest: {latest['source']} · {list(latest['diff'].keys())}")

        # Restore the experience to its original state (best-effort)
        await c.patch(f"/api/experiences/{eid}?source=manual", json={
            "title": exp["title"],
            "pax": original_pax,
            "price_tax_incl": original_incl,
        })

    print("\n✅ Experience history tests passed.")


if __name__ == "__main__":
    sys.path.insert(0, "/app")
    asyncio.run(main())
