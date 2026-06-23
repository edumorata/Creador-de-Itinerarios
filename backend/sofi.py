"""Sofi (gestion.viajadverdad.com) integration — push a sold itinerary as a
new Trip header in the agency's internal management system.

This module talks to Sofi via Playwright (the same headless Chromium pool the
Travefy importer uses). Sofi runs on Joomla + Fabrik so there is no public
API; the form submit is the only documented surface, and Fabrik validates
the CSRF tokens / hidden fields per session, so we have to render a real
browser, log in, fill the form and click submit.

We only push trip-header + summary fields. Day-by-day services and hotels
live in separate Fabrik forms which we will integrate iteratively once this
first version is signed off.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from datetime import datetime
from typing import Any, Optional

from playwright.async_api import async_playwright

from scraper import _BROWSER_SEMAPHORE, _CHROMIUM_LAUNCH_ARGS, _ensure_chromium_installed

logger = logging.getLogger("sofi")

GESTION_BASE = "https://gestion.viajadverdad.com"
GESTION_USER = os.environ.get("GESTION_VIAJADVERDAD_USER", "")
GESTION_PASS = os.environ.get("GESTION_VIAJADVERDAD_PASS", "")


# ---------------------------------------------------------------------------
# Mappings between our internal enums and Sofi's option values.
# ---------------------------------------------------------------------------
PARTNER_TO_SOFI = {
    "kimkim": "Kimkim",
    "zicasso": "Zicasso105",            # 10.5% rate, the one the agency uses
    "responsible_travel": "ResponsibleTravel",
    "baboo": "Baboo",
    "travel_agent_10": "TravelAgent10",
    "travel_agent_12": "TravelAgent12",
    "travel_agent_15": "TravelAgent15",
    "direct": "Direct",
    "other": "Direct",
}
SOURCE_TO_SOFI = {
    "kimkim": "KimKim",
    "zicasso": "Zicasso",
    "responsible_travel": "Responsible Travel",
    "baboo": "Baboo",
    "travel_agent_10": "Travel Agency",
    "travel_agent_12": "Travel Agency",
    "travel_agent_15": "Travel Agency",
    "direct": "Direct",
    "other": "Direct",
}

# Quick city→country lookup. We only need to surface this for the destination
# multi-select; Sofi accepts no-match and we fall back to "Spain" (the
# agency's home market) when nothing maps.
_CITY_TO_COUNTRY = {
    # Spain
    "madrid": "Spain", "barcelona": "Spain", "seville": "Spain", "sevilla": "Spain",
    "granada": "Spain", "valencia": "Spain", "bilbao": "Spain", "san sebastián": "Spain",
    "san sebastian": "Spain", "córdoba": "Spain", "cordoba": "Spain", "toledo": "Spain",
    "santander": "Spain", "málaga": "Spain", "malaga": "Spain", "ronda": "Spain",
    "logroño": "Spain", "logrono": "Spain", "la rioja": "Spain", "ibiza": "Spain",
    "mallorca": "Spain", "menorca": "Spain", "tenerife": "Spain", "gran canaria": "Spain",
    "lanzarote": "Spain", "fuerteventura": "Spain", "santiago de compostela": "Spain",
    # Italy
    "rome": "Italy", "roma": "Italy", "florence": "Italy", "firenze": "Italy",
    "venice": "Italy", "venezia": "Italy", "milan": "Italy", "milano": "Italy",
    "naples": "Italy", "napoli": "Italy", "sorrento": "Italy", "amalfi coast": "Italy",
    "amalfi": "Italy", "capri": "Italy", "siena": "Italy", "pisa": "Italy",
    # Portugal
    "lisbon": "Portugal", "lisboa": "Portugal", "porto": "Portugal", "oporto": "Portugal",
    "sintra": "Portugal", "douro": "Portugal", "madeira": "Portugal", "algarve": "Portugal",
    "azores": "Portugal", "açores": "Portugal", "evora": "Portugal", "évora": "Portugal",
    # Morocco
    "marrakech": "Morocco", "marrakesh": "Morocco", "casablanca": "Morocco",
    "fez": "Morocco", "fes": "Morocco", "rabat": "Morocco", "tangier": "Morocco",
    "chefchaouen": "Morocco", "essaouira": "Morocco",
    # France
    "paris": "France", "nice": "France", "lyon": "France", "marseille": "France",
    "bordeaux": "France", "biarritz": "France",
    # Cuba
    "havana": "Cuba", "la habana": "Cuba", "varadero": "Cuba", "trinidad": "Cuba",
    "viñales": "Cuba", "vinales": "Cuba", "cayo coco": "Cuba",
    # Dominican Republic
    "santo domingo": "RD", "punta cana": "RD", "samaná": "RD", "samana": "RD",
}


def _split_cities(s: Optional[str]) -> list[str]:
    """Day cities are free-text and can be multi-city ('Madrid - Bilbao').
    Split on commas / hyphens / slashes so we capture every leg."""
    if not s:
        return []
    parts = re.split(r"[,/\-]+", s)
    return [p.strip() for p in parts if p.strip()]


def _derive_destinations(itn: dict) -> list[str]:
    countries: list[str] = []
    seen: set[str] = set()
    for d in itn.get("days") or []:
        for city in _split_cities(d.get("city")):
            country = _CITY_TO_COUNTRY.get(city.lower())
            if country and country not in seen:
                countries.append(country)
                seen.add(country)
    for a in itn.get("accommodations") or []:
        for city in _split_cities(a.get("city")):
            country = _CITY_TO_COUNTRY.get(city.lower())
            if country and country not in seen:
                countries.append(country)
                seen.add(country)
    if not countries:
        countries = ["Spain"]  # Fallback to the agency's home market
    return countries


def _to_sofi_date(s: Optional[str]) -> str:
    """Sofi's calendar widget accepts DD/MM/YYYY when written as text."""
    if not s:
        return ""
    try:
        return datetime.fromisoformat(s).strftime("%d/%m/%Y")
    except (TypeError, ValueError):
        return s


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
async def push_itinerary_to_sofi(itn: dict, totals: dict) -> dict:
    """Open Sofi, fill the create-trip form with `itn`'s data, submit it, and
    return either {ok: True, trip_id: int, url: str} or {ok: False, error: str}.

    `totals` is the precomputed pricing summary (sub_excl, sub_incl, pvp, etc.)
    so we don't need to re-implement the calculator in two places.
    """
    if not GESTION_USER or not GESTION_PASS:
        return {"ok": False, "error": "Sofi credentials not configured (GESTION_VIAJADVERDAD_USER/PASS)"}

    # Memory: the same semaphore the Travefy scraper uses, so production never
    # runs more than one Chromium at a time. Travefy + Sofi will queue.
    async with _BROWSER_SEMAPHORE:
        async with async_playwright() as pw:
            try:
                browser = await pw.chromium.launch(args=_CHROMIUM_LAUNCH_ARGS)
            except Exception as e:
                msg = str(e)
                if "Executable doesn't exist" in msg or "playwright install" in msg:
                    await _ensure_chromium_installed()
                    browser = await pw.chromium.launch(args=_CHROMIUM_LAUNCH_ARGS)
                else:
                    raise
            try:
                ctx = await browser.new_context(viewport={"width": 1400, "height": 900})
                page = await ctx.new_page()
                return await _fill_and_submit(page, itn, totals)
            finally:
                await browser.close()


async def _fill_and_submit(page, itn: dict, totals: dict) -> dict:
    # Step 1 — log in
    await page.goto(f"{GESTION_BASE}/login", wait_until="networkidle", timeout=30000)
    await page.fill('input[name="username"]', GESTION_USER)
    await page.fill('input[name="password"]', GESTION_PASS)
    await page.click('button[type="submit"]')
    await page.wait_for_load_state("networkidle", timeout=20000)
    if "/login" in page.url.lower() or "logout" not in (await page.content()).lower():
        # Heuristic: a successful login takes us OFF /login and the navbar
        # contains a "logout" link.
        if "/login" in page.url.lower():
            return {"ok": False, "error": "Sofi login failed — check GESTION credentials"}

    # Step 2 — open the create-trip form
    await page.goto(f"{GESTION_BASE}/trips/form/1/", wait_until="networkidle", timeout=30000)

    # Step 3 — fill all the trip-header + summary fields we have data for
    fx_rate = float(itn.get("fx_rate") or 0) or None
    pvp_eur = float(totals.get("pvp") or 0)
    pvp_usd = pvp_eur * fx_rate if fx_rate else 0.0

    # --- Trip group ---
    await _safe_fill(page, "#app_trips___main_traveler", itn.get("main_traveler") or itn.get("name") or "")
    await _safe_fill(page, "#app_trips___start_date_cal", _to_sofi_date(itn.get("start_date")))
    await _safe_fill(page, "#app_trips___end_date_cal", _to_sofi_date(itn.get("end_date")))
    await _safe_fill(page, "#app_trips___booking_date_cal", datetime.utcnow().strftime("%d/%m/%Y"))
    await _safe_fill(page, "#app_trips___number_of_travelers", str(itn.get("num_travelers") or 2))
    await _safe_fill(page, "#app_trips___number_of_children", "0")
    await _safe_fill(page, "#app_trips___notes", itn.get("notes") or "")

    # Multi-select destinations
    destinations = _derive_destinations(itn)
    await _safe_select(page, "#app_trips___destination", destinations, multiple=True)
    # Source = single-select (cosmetic) — best guess from our partner enum
    src = SOURCE_TO_SOFI.get((itn.get("partner") or "kimkim").lower())
    if src:
        await _safe_select(page, "#app_trips___source", [src], multiple=True)

    # --- Summary group ---
    if fx_rate:
        await _safe_fill(page, "#app_summary_trip___currency_exchange_rate", f"{fx_rate:.4f}")
    await _safe_fill(page, "#app_summary_trip___final_price_dolars_override", f"{pvp_usd:.2f}" if pvp_usd else "")
    await _safe_fill(page, "#app_summary_trip___customer_price_override", f"{pvp_usd:.2f}" if pvp_usd else "")
    await _safe_fill(page, "#app_summary_trip___customer_price_euro_override", f"{pvp_eur:.2f}")
    await _safe_fill(page, "#app_summary_trip___agency_commission_perc", str(itn.get("commission_pct") or 0))
    sofi_partner = PARTNER_TO_SOFI.get((itn.get("partner") or "kimkim").lower(), "Direct")
    await _safe_select(page, "#app_summary_trip___partner", [sofi_partner], multiple=False)
    # PayPal fee radio (radios are rendered as id+suffix '0'/'1')
    yes_id = "#app_summary_trip___paypal_fee1" if itn.get("paypal_fee") else "#app_summary_trip___paypal_fee0"
    await _safe_click(page, yes_id)
    # Trip sold in euro = Yes (we work in EUR)
    await _safe_click(page, "#app_summary_trip___trip_sold_in_euro1")
    # Status = INICIAL on first push
    await _safe_click(page, "#app_summary_trip___status_input_0")
    await _safe_fill(page, "#app_summary_trip___notas_summary", itn.get("notes") or "")

    # Step 4 — submit. Fabrik calls its save action when we hit the submit button.
    submit = await page.query_selector("button[name='Submit']") or await page.query_selector("input[type='submit']")
    if not submit:
        return {"ok": False, "error": "No submit button found on Sofi form"}
    await submit.click()
    try:
        await page.wait_for_load_state("networkidle", timeout=30000)
    except Exception:
        pass

    # On success Fabrik typically redirects to /trips/details/1/{id} or back to
    # /trips with a success flash message. Capture whichever ID we can.
    landed = page.url
    trip_id = None
    m = re.search(r"/trips/(?:details|form)/\d+/(\d+)", landed)
    if m:
        trip_id = int(m.group(1))
    if trip_id is None:
        # Try to read it from the now-populated hidden id input (Fabrik sets it
        # after a successful save when staying on the form view).
        rid = await page.evaluate("() => document.getElementById('app_trips___id')?.value || null")
        if rid and rid.isdigit():
            trip_id = int(rid)

    # Surface form-level errors that Fabrik renders inline so we don't claim
    # success when the save was rejected.
    errors = await page.evaluate("""() => {
        const out = [];
        document.querySelectorAll('.fabrikError, .invalid-feedback, .has-error').forEach(el => {
            const t = (el.textContent || '').trim();
            if (t) out.push(t.slice(0, 150));
        });
        return out;
    }""")
    if errors and not trip_id:
        return {"ok": False, "error": "Sofi rechazó el envío", "details": errors}

    if not trip_id:
        return {"ok": False, "error": f"Submit fue, pero no pude leer el trip_id. URL final: {landed}"}

    return {
        "ok": True,
        "trip_id": trip_id,
        "url": f"{GESTION_BASE}/trips/details/1/{trip_id}",
    }


# ---------------------------------------------------------------------------
# Small helpers — defensive fillers that don't blow up if a selector is gone
# ---------------------------------------------------------------------------
async def _safe_fill(page, selector: str, value: str):
    try:
        el = await page.query_selector(selector)
        if el:
            await el.fill(value or "")
    except Exception as e:
        logger.warning("safe_fill %s failed: %s", selector, e)


async def _safe_select(page, selector: str, values: list[str], multiple: bool):
    try:
        if not values:
            return
        await page.select_option(selector, value=values if multiple else values[0])
    except Exception as e:
        logger.warning("safe_select %s = %s failed: %s", selector, values, e)


async def _safe_click(page, selector: str):
    try:
        el = await page.query_selector(selector)
        if el:
            await el.click()
    except Exception as e:
        logger.warning("safe_click %s failed: %s", selector, e)
