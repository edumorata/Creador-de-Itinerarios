"""Itinerary URL scraper using a real headless browser + LLM-based parser."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from typing import Optional

from playwright.async_api import async_playwright

logger = logging.getLogger("scraper")

GESTION_USER = os.environ.get("GESTION_VIAJADVERDAD_USER", "")
GESTION_PASS = os.environ.get("GESTION_VIAJADVERDAD_PASS", "")
EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")


async def _render_url(url: str) -> dict:
    """Open the URL in a headless Chromium and return the rendered body text + source label."""
    source = "anonymous"
    text = ""
    ok = False
    error = None
    is_gestion = "gestion.viajadverdad.com" in url
    is_travefy = "travefy.com" in url

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        try:
            ctx = await browser.new_context(user_agent="Mozilla/5.0 (X11; Linux x86_64) ItineraryBot/1.0")
            page = await ctx.new_page()

            if is_gestion:
                source = "gestion"
                try:
                    await page.goto("https://gestion.viajadverdad.com/login", wait_until="networkidle", timeout=30000)
                    await page.fill('input[name="username"]', GESTION_USER)
                    await page.fill('input[name="password"]', GESTION_PASS)
                    await page.click('button[type="submit"], input[type="submit"]')
                    await page.wait_for_load_state("networkidle", timeout=20000)
                    if "/login" in page.url:
                        error = "login_failed"
                except Exception as e:
                    error = f"login_error: {e}"

            try:
                await page.goto(url, wait_until="networkidle", timeout=45000)
            except Exception as e:
                error = error or f"goto_error: {e}"

            if is_travefy:
                try:
                    await page.wait_for_selector("text=/Day|Jun|Jan|Feb|Mar|Apr|May|Jul|Aug|Sep|Oct|Nov|Dec/", timeout=15000)
                except Exception:
                    pass
                await page.wait_for_timeout(2500)

            await page.wait_for_timeout(1500)
            try:
                text = await page.evaluate("document.body.innerText")
                text = "\n".join(line.strip() for line in (text or "").splitlines() if line.strip())
            except Exception as e:
                error = error or f"extract_error: {e}"

            # For gestion: the /trips/form/{type}/{tripId} page only shows the lead form;
            # the actual bookings/services live in /reservas/list/3?app_bookings___trip_id_raw={tripId}
            # Travelers in /trips/list/2?app_travelers___trip_id_raw={tripId}. Fetch both and concat.
            if is_gestion and not error:
                m = re.search(r"/trips/form/\d+/(\d+)", url)
                if m:
                    trip_id = m.group(1)
                    extra_chunks = []
                    for label, sub in [
                        ("TRAVELERS", f"/trips/list/2?app_travelers___trip_id_raw={trip_id}&limitstart2=0&resetfilters=1"),
                        ("BOOKINGS", f"/reservas/list/3?app_bookings___trip_id_raw={trip_id}&limitstart3=0&resetfilters=1"),
                    ]:
                        full = "https://gestion.viajadverdad.com" + sub
                        try:
                            await page.goto(full, wait_until="networkidle", timeout=30000)
                            await page.wait_for_timeout(2000)
                            t2 = await page.evaluate("document.body.innerText")
                            t2 = "\n".join(line.strip() for line in (t2 or "").splitlines() if line.strip())
                            extra_chunks.append(f"=== {label} ({full}) ===\n{t2}")
                        except Exception as e:
                            extra_chunks.append(f"=== {label} (error: {e}) ===")
                    text = (text or "") + "\n\n" + "\n\n".join(extra_chunks)

            if len(text) > 200 and not (is_gestion and error == "login_failed"):
                ok = True
        finally:
            await browser.close()

    return {"ok": ok, "source": source, "text": text[:80000], "error": error}


PARSE_SYSTEM = """You are a travel itinerary parser. You receive the rendered text of a published itinerary page (Travefy, Sofi, or similar) and must extract a structured JSON.

Output ONLY a single JSON object, no markdown, no commentary. Schema:
{
  "trip_name": "Portugal Off the Beaten Path - Georgianne Graves",
  "start_date": "YYYY-MM-DD" or null,
  "end_date": "YYYY-MM-DD" or null,
  "num_travelers": null or integer,
  "days": [
    {
      "day": 1,
      "date": "YYYY-MM-DD" or null,
      "city": "Porto",
      "activities": [
        {"name": "Private Transfer Airport to Hotel", "provider": null, "time": "16:30"},
        {"name": "Wine tasting at Sandeman", "provider": null, "time": null}
      ],
      "hotels": [
        {"name": "The Yeatman", "nights": 2, "check_in": "YYYY-MM-DD", "check_out": "YYYY-MM-DD"}
      ],
      "transfers": [
        {"description": "Flight IB 3094 MAD → OPO", "from": "Madrid", "to": "Porto"}
      ]
    }
  ],
  "notes": "1-2 sentences with any high-level observation about pacing or tier"
}

Rules:
- Skip Travefy boilerplate ("Add this itinerary", "Itinerary Chat", agent contact info).
- Parse dates intelligently. If the page only shows a month + day, infer year from any nearby year reference or leave null.
- Hotels usually appear once per stay-block; figure out check-in / check-out from the surrounding days.
- Activities are anything that's NOT a hotel or a flight transfer.
- If you find no structured info, return {"days": [], "notes": "could not parse"}.
"""


async def _parse_with_llm(text: str) -> dict:
    """Use Claude Sonnet 4.6 to extract structured itinerary JSON from rendered text."""
    if not EMERGENT_LLM_KEY or not text:
        return {"days": [], "notes": "no_llm_key_or_text"}
    from emergentintegrations.llm.chat import LlmChat, UserMessage
    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=f"parse-{uuid.uuid4().hex[:8]}",
        system_message=PARSE_SYSTEM,
    ).with_model("anthropic", "claude-sonnet-4-6")
    # Cap input length to keep cost predictable
    truncated = text[:25000]
    msg = UserMessage(text=f"Rendered itinerary text to parse:\n\n{truncated}")
    try:
        raw = await chat.send_message(msg)
    except Exception as e:
        logger.warning("LLM parse error: %s", e)
        return {"days": [], "notes": f"llm_error: {e}"}
    out = (raw or "").strip()
    if out.startswith("```"):
        out = out.strip("`")
        if out.lower().startswith("json"):
            out = out[4:].strip()
    s = out.find("{")
    e = out.rfind("}")
    if s == -1 or e == -1:
        return {"days": [], "notes": "no_json_in_response"}
    try:
        return json.loads(out[s:e + 1])
    except Exception as ex:
        logger.warning("JSON parse failed: %s", ex)
        return {"days": [], "notes": f"json_parse_failed: {ex}"}


async def scrape_and_parse(url: str) -> dict:
    """Scrape URL with browser rendering, then parse structured itinerary JSON."""
    rendered = await _render_url(url)
    text = rendered.get("text", "")
    structured = await _parse_with_llm(text) if rendered["ok"] else {"days": [], "notes": rendered.get("error") or "scrape_failed"}
    return {
        "ok": rendered["ok"],
        "source": rendered["source"],
        "error": rendered.get("error"),
        "text": text,
        "structured": structured,
    }
