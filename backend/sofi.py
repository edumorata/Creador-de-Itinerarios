"""Sofi (gestion.viajadverdad.com) integration — push a sold itinerary as a
new Trip header in the agency's internal management system.

This module talks to Sofi via Playwright (the same headless Chromium pool the
Travefy importer uses). Sofi runs on Joomla + Fabrik so there is no public
API; the form submit is the only documented surface, and Fabrik validates
the CSRF tokens / hidden fields per session, so we have to render a real
browser, log in, fill the form and click submit.

Two modes:
- `dry_run=True`  → fill the form, capture a PNG screenshot + the (selector,
  value) pairs we filled in, but DO NOT click submit. Used by the agent to
  validate the mapping before the very first real push.
- `dry_run=False` → fill + submit + read back the new Sofi trip_id.

Only the trip-header + summary fields are written. Day-by-day services and
hotels live in separate Fabrik forms which we will integrate iteratively
once this first version is signed off.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
from datetime import datetime, timezone
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
    "zicasso": "Zicasso105",            # 10.5% rate — the variant the agency uses
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
    "salamanca": "Spain", "segovia": "Spain", "ávila": "Spain", "avila": "Spain",
    "girona": "Spain", "tarragona": "Spain", "zaragoza": "Spain", "pamplona": "Spain",
    # Italy
    "rome": "Italy", "roma": "Italy", "florence": "Italy", "firenze": "Italy",
    "venice": "Italy", "venezia": "Italy", "milan": "Italy", "milano": "Italy",
    "naples": "Italy", "napoli": "Italy", "sorrento": "Italy", "amalfi coast": "Italy",
    "amalfi": "Italy", "capri": "Italy", "siena": "Italy", "pisa": "Italy",
    "bologna": "Italy", "verona": "Italy", "lake garda": "Italy", "lake como": "Italy",
    "matera": "Italy", "alberobello": "Italy", "lecce": "Italy", "puglia": "Italy",
    "sicily": "Italy", "sicilia": "Italy", "palermo": "Italy", "taormina": "Italy",
    # Portugal
    "lisbon": "Portugal", "lisboa": "Portugal", "porto": "Portugal", "oporto": "Portugal",
    "sintra": "Portugal", "douro": "Portugal", "madeira": "Portugal", "algarve": "Portugal",
    "azores": "Portugal", "açores": "Portugal", "evora": "Portugal", "évora": "Portugal",
    "são miguel": "Portugal", "sao miguel": "Portugal", "pico": "Portugal",
    # Morocco
    "marrakech": "Morocco", "marrakesh": "Morocco", "casablanca": "Morocco",
    "fez": "Morocco", "fes": "Morocco", "rabat": "Morocco", "tangier": "Morocco",
    "chefchaouen": "Morocco", "essaouira": "Morocco", "merzouga": "Morocco",
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
    """Day cities are free-text and can be multi-city ('Madrid - Bilbao' or
    'Madrid, Bilbao'). Split on commas / hyphens / slashes so we capture
    every leg the agent typed."""
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
async def push_itinerary_to_sofi(itn: dict, totals: dict, *, dry_run: bool = False) -> dict:
    """Open Sofi, fill the create-trip form with `itn`'s data and either
    capture a screenshot (dry_run) or submit it.

    Returns
    -------
    dry_run=True  : { ok, dry_run: True, filled_fields, screenshot_b64, errors? }
    dry_run=False : { ok, dry_run: False, trip_id, url } on success
                    { ok: False, error, details? }       on failure
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
                ctx = await browser.new_context(viewport={"width": 1400, "height": 1100})
                page = await ctx.new_page()
                return await _fill_and_submit(page, itn, totals, dry_run=dry_run)
            finally:
                await browser.close()


async def _fill_and_submit(page, itn: dict, totals: dict, *, dry_run: bool) -> dict:
    filled: list[dict] = []  # accumulator of what we wrote where (debug + dry-run review)

    # Step 1 — log in
    try:
        await page.goto(f"{GESTION_BASE}/login", wait_until="domcontentloaded", timeout=30000)
    except Exception as e:
        return {"ok": False, "error": f"No se pudo abrir Sofi: {e}"}

    # Sofi's login form uses the standard Joomla input ids, but to stay
    # tolerant to small markup tweaks we try a few selectors.
    for sel in ['input[name="username"]', "#username", "#mod-login-username"]:
        if await page.query_selector(sel):
            await page.fill(sel, GESTION_USER)
            break
    for sel in ['input[name="password"]', "#password", "#mod-login-password"]:
        if await page.query_selector(sel):
            await page.fill(sel, GESTION_PASS)
            break
    submit_btn = (await page.query_selector('button[type="submit"]')
                  or await page.query_selector('input[type="submit"]'))
    if submit_btn:
        await submit_btn.click()
    try:
        await page.wait_for_load_state("networkidle", timeout=20000)
    except Exception:
        pass
    if "/login" in page.url.lower():
        return {"ok": False, "error": "Login a Sofi falló — revisa GESTION_VIAJADVERDAD_USER/PASS"}

    # Step 2 — open the create-trip form
    await page.goto(f"{GESTION_BASE}/trips/form/1/", wait_until="domcontentloaded", timeout=30000)
    try:
        await page.wait_for_selector("#app_trips___main_traveler", timeout=15000)
    except Exception:
        # Some Fabrik builds render the form lazily; give it one more beat.
        await page.wait_for_timeout(2000)

    # Step 3 — fill all the trip-header + summary fields we have data for
    fx_rate = float(itn.get("fx_rate") or 0) or None
    pvp_eur = float(totals.get("pvp") or 0)
    pvp_usd = pvp_eur * fx_rate if fx_rate else 0.0

    # --- Trip group ---
    main_traveler = (itn.get("main_traveler") or itn.get("name") or "").strip()
    await _safe_fill(page, "#app_trips___main_traveler", main_traveler, filled, "Viajero principal")
    await _safe_fill(page, "#app_trips___start_date_cal", _to_sofi_date(itn.get("start_date")), filled, "Fecha inicio")
    await _safe_fill(page, "#app_trips___end_date_cal", _to_sofi_date(itn.get("end_date")), filled, "Fecha fin")
    await _safe_fill(page, "#app_trips___booking_date_cal",
                     datetime.now(timezone.utc).strftime("%d/%m/%Y"),
                     filled, "Fecha de Venta")
    await _safe_fill(page, "#app_trips___number_of_travelers", str(itn.get("num_travelers") or 2),
                     filled, "Número de viajeros")
    await _safe_fill(page, "#app_trips___number_of_children", "0", filled, "Niños")
    await _safe_fill(page, "#app_trips___notes", itn.get("notes") or "", filled, "Notas (trip)")

    # Multi-select destinations (free-text-tolerant on Sofi side).
    destinations = _derive_destinations(itn)
    await _safe_select(page, "#app_trips___destination", destinations, multiple=True,
                       filled=filled, label="Destinos")
    # Source = single-select (cosmetic) — best guess from our partner enum
    src = SOURCE_TO_SOFI.get((itn.get("partner") or "kimkim").lower())
    if src:
        await _safe_select(page, "#app_trips___source", [src], multiple=False,
                           filled=filled, label="Source")

    # --- Summary group ---
    if fx_rate:
        await _safe_fill(page, "#app_summary_trip___currency_exchange_rate", f"{fx_rate:.4f}",
                         filled, "Tipo de cambio €→$")
    if pvp_usd:
        await _safe_fill(page, "#app_summary_trip___final_price_dolars_override", f"{pvp_usd:.2f}",
                         filled, "Precio final ($) override")
        await _safe_fill(page, "#app_summary_trip___customer_price_override", f"{pvp_usd:.2f}",
                         filled, "Customer price ($) override")
    await _safe_fill(page, "#app_summary_trip___customer_price_euro_override", f"{pvp_eur:.2f}",
                     filled, "Customer price (€) override")
    if itn.get("commission_pct") is not None:
        await _safe_fill(page, "#app_summary_trip___agency_commission_perc",
                         str(itn.get("commission_pct") or 0), filled, "% Comisión agencia")

    sofi_partner = PARTNER_TO_SOFI.get((itn.get("partner") or "kimkim").lower(), "Direct")
    await _safe_select(page, "#app_summary_trip___partner", [sofi_partner], multiple=False,
                       filled=filled, label="Partner")
    # PayPal fee radio (radios are rendered as id+suffix '0'/'1')
    paypal_id = "#app_summary_trip___paypal_fee1" if itn.get("paypal_fee") else "#app_summary_trip___paypal_fee0"
    await _safe_click(page, paypal_id, filled, f"PayPal Fee = {'Sí' if itn.get('paypal_fee') else 'No'}")
    # Trip sold in euro = Yes (we work in EUR)
    await _safe_click(page, "#app_summary_trip___trip_sold_in_euro1", filled, "Trip sold in EUR = Sí")
    # Status = INICIAL on first push (radio_0 in Fabrik)
    await _safe_click(page, "#app_summary_trip___status_input_0", filled, "Estado = INICIAL")
    await _safe_fill(page, "#app_summary_trip___notas_summary", itn.get("notes") or "",
                     filled, "Notas (summary)")

    # --- Dry-run branch: snapshot + return BEFORE submitting ---
    if dry_run:
        # Scroll back to the top so the screenshot starts at the form header.
        try:
            await page.evaluate("window.scrollTo(0, 0)")
            await page.wait_for_timeout(300)
        except Exception:
            pass
        try:
            png = await page.screenshot(full_page=True)
            screenshot_b64 = base64.b64encode(png).decode("ascii")
        except Exception:
            screenshot_b64 = None
        return {
            "ok": True,
            "dry_run": True,
            "filled_fields": filled,
            "screenshot_b64": screenshot_b64,
            "form_url": page.url,
        }

    # --- Real push branch ---
    submit = (await page.query_selector("button[name='Submit']")
              or await page.query_selector("input[type='submit']")
              or await page.query_selector("button[type='submit']"))
    if not submit:
        return {"ok": False, "error": "No encontré el botón Submit en el form de Sofi", "filled_fields": filled}
    await submit.click()
    try:
        await page.wait_for_load_state("networkidle", timeout=45000)
    except Exception:
        pass

    # On success Fabrik typically redirects to /trips/details/1/{id} or back
    # to /trips, with a success flash message. Capture whichever ID we can.
    landed = page.url
    trip_id: Optional[int] = None
    m = re.search(r"/trips/(?:details|form)/\d+/(\d+)", landed)
    if m:
        trip_id = int(m.group(1))
    if trip_id is None:
        # Fabrik leaves the row id on the hidden input after a stay-on-form save.
        rid = await page.evaluate("() => document.getElementById('app_trips___id')?.value || null")
        if rid and str(rid).isdigit():
            trip_id = int(rid)

    # Surface form-level errors that Fabrik renders inline so we don't claim
    # success when the save was rejected.
    errors = await page.evaluate("""() => {
        const out = [];
        document.querySelectorAll('.fabrikError, .invalid-feedback, .has-error, .alert-error, .alert-danger').forEach(el => {
            const t = (el.textContent || '').trim();
            if (t) out.push(t.slice(0, 200));
        });
        return out;
    }""")
    if errors and not trip_id:
        return {"ok": False, "dry_run": False, "error": "Sofi rechazó el envío",
                "details": errors, "filled_fields": filled}

    if not trip_id:
        return {"ok": False, "dry_run": False,
                "error": f"Submit ejecutado pero no pude leer el trip_id. URL final: {landed}",
                "filled_fields": filled}

    return {
        "ok": True,
        "dry_run": False,
        "trip_id": trip_id,
        "url": f"{GESTION_BASE}/trips/details/1/{trip_id}",
        "filled_fields": filled,
    }


# ---------------------------------------------------------------------------
# Small helpers — defensive fillers that don't blow up if a selector is gone.
# Fabrik renders radios behind styled labels (input is technically off-screen)
# and some text inputs ship with size="0" which makes Playwright's standard
# `fill()` time out waiting for "actionability". Hence the dual-strategy
# fallbacks below: first try the native API, then fall back to a direct DOM
# write + change/blur dispatch so Fabrik's reactive calc fields recompute.
# ---------------------------------------------------------------------------
async def _safe_fill(page, selector: str, value: str, filled: list[dict], label: str):
    try:
        el = await page.query_selector(selector)
        if not el:
            return
        try:
            await el.fill(value or "", timeout=4000)
        except Exception:
            # Fallback for non-actionable inputs (size=0, readonly-via-css, etc.):
            # write the value directly and dispatch the events Fabrik listens
            # to (change + blur) so observers recalc downstream fields.
            await page.evaluate(
                "({sel, val}) => {"
                "  const el = document.querySelector(sel);"
                "  if (!el) return false;"
                "  el.value = val;"
                "  el.dispatchEvent(new Event('input', {bubbles: true}));"
                "  el.dispatchEvent(new Event('change', {bubbles: true}));"
                "  el.dispatchEvent(new Event('blur', {bubbles: true}));"
                "  return true;"
                "}",
                {"sel": selector, "val": value or ""},
            )
        filled.append({"label": label, "selector": selector, "value": value or ""})
    except Exception as e:
        logger.warning("safe_fill %s failed: %s", selector, e)
        filled.append({"label": label, "selector": selector, "value": value or "", "error": str(e)})


async def _safe_select(page, selector: str, values: list[str], *, multiple: bool,
                       filled: list[dict], label: str):
    if not values:
        return
    try:
        await page.select_option(selector, value=values if multiple else values[0])
        filled.append({"label": label, "selector": selector,
                       "value": ", ".join(values) if multiple else values[0]})
    except Exception as e:
        # Many Fabrik selects expose the visible label rather than the value;
        # try a label-based match before giving up.
        try:
            await page.select_option(selector, label=values if multiple else values[0])
            filled.append({"label": label, "selector": selector,
                           "value": ", ".join(values) if multiple else values[0],
                           "matched_by": "label"})
            return
        except Exception:
            pass
        logger.warning("safe_select %s = %s failed: %s", selector, values, e)
        filled.append({"label": label, "selector": selector,
                       "value": ", ".join(values) if multiple else values[0],
                       "error": str(e)})


async def _safe_click(page, selector: str, filled: list[dict], label: str):
    """Click an element. For Fabrik YesNo radios the input is hidden behind a
    label, so we first try clicking `label[for=id]`, then `el.click()` natively
    (with timeout), then a JS-level dispatch as a last resort."""
    try:
        el = await page.query_selector(selector)
        if not el:
            return
        # 1. Prefer the visible label that Fabrik renders for radios.
        if selector.startswith("#"):
            label_el = await page.query_selector(f'label[for="{selector[1:]}"]')
            if label_el:
                try:
                    await label_el.click(timeout=4000)
                    filled.append({"label": label, "selector": selector,
                                   "value": "click", "via": "label"})
                    return
                except Exception:
                    pass
        # 2. Native click, short timeout.
        try:
            await el.click(timeout=4000)
            filled.append({"label": label, "selector": selector, "value": "click"})
            return
        except Exception:
            pass
        # 3. Last resort: JS-level click + change dispatch.
        await page.evaluate(
            "({sel}) => {"
            "  const el = document.querySelector(sel);"
            "  if (!el) return false;"
            "  if (el.type === 'radio' || el.type === 'checkbox') { el.checked = true; }"
            "  el.dispatchEvent(new Event('click', {bubbles: true}));"
            "  el.dispatchEvent(new Event('change', {bubbles: true}));"
            "  return true;"
            "}",
            {"sel": selector},
        )
        filled.append({"label": label, "selector": selector, "value": "click", "via": "js"})
    except Exception as e:
        logger.warning("safe_click %s failed: %s", selector, e)
        filled.append({"label": label, "selector": selector, "value": "click",
                       "error": str(e)})
