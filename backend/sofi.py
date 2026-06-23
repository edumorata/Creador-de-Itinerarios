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

        # Build the list of bookings that WOULD be created on a real push.
        # We do NOT submit anything here — just compute the plan so the agent
        # can review it before committing. Then we open the bookings form and
        # fill the FIRST one as a visual sample (no submit).
        bookings_plan = list(_iter_bookings(itn, "(NEW_TRIP_ID)"))
        bookings_preview = None
        bookings_screenshot_b64: Optional[str] = None
        if bookings_plan:
            sample = dict(bookings_plan[0])
            # The trip_id select carries 1916 options — we can't use a fake id
            # here because select_option(value="(NEW_TRIP_ID)") would 404. For
            # the sample we leave trip_id unset (the rest of the form still
            # demoes the mapping faithfully).
            sample["trip_id"] = None
            bookings_preview = await _push_one_booking(page, sample, dry_run=True)
            try:
                await page.evaluate("window.scrollTo(0, 0)")
                await page.wait_for_timeout(300)
                png2 = await page.screenshot(full_page=True)
                bookings_screenshot_b64 = base64.b64encode(png2).decode("ascii")
            except Exception:
                bookings_screenshot_b64 = None

        return {
            "ok": True,
            "dry_run": True,
            "filled_fields": filled,
            "screenshot_b64": screenshot_b64,
            "form_url": page.url,
            # Bookings preview: list of plans + sample form preview/screenshot.
            "bookings_plan": [_booking_to_summary(b) for b in bookings_plan],
            "bookings_sample_filled": (bookings_preview or {}).get("filled_fields") or [],
            "bookings_screenshot_b64": bookings_screenshot_b64,
        }

    # --- Real push branch ---
    # Fabrik form save is a multi-step chain: native click on the primary
    # submit (#fabrikSubmit_1) triggers validators → POST `task=form.process`
    # → redirect to /trips/details/1/{id}. We MUST click the real Fabrik
    # button (not the Joomla header search "Submit"), and we use force=True
    # because Fabrik briefly disables the button during validation.
    #
    # We also wait for the actual save XHR (POST to /trips/form/1/) so the
    # subsequent URL/ID read happens AFTER Fabrik has redirected.
    btn = (await page.query_selector("#fabrikSubmit_1")
           or await page.query_selector("button.btn-primary.guardar[name='Submit']"))
    if not btn:
        return {"ok": False, "error": "No encontré el botón Submit en el form de Sofi", "filled_fields": filled}

    # Defensive: re-enable in case validators temporarily disabled it.
    await page.evaluate("""() => {
        const b = document.getElementById('fabrikSubmit_1');
        if (b) { b.disabled = false; b.removeAttribute('disabled'); }
    }""")
    # We MUST capture the 303 to confirm the save fired (POST has
    # `task=form.process`). Sofi unfortunately redirects to /trips (not
    # /trips/details/1/{id}), so the trip_id is NOT in the URL — we have to
    # query the listing afterwards filtered by main_traveler.
    save_303_seen = False
    try:
        async with page.expect_response(
            lambda r: r.status == 303 and "/trips/form/1" in r.url,
            timeout=45000,
        ):
            await btn.click(force=True, timeout=10000)
        save_303_seen = True
    except Exception:
        # No 303 means either the save was rejected by validators or it took
        # an alternative AJAX path. Wait once more then fall through to the
        # error/lookup branches below.
        await page.wait_for_timeout(5000)

    try:
        await page.wait_for_load_state("load", timeout=10000)
    except Exception:
        pass
    try:
        await page.wait_for_load_state("networkidle", timeout=45000)
    except Exception:
        pass

    # On success Sofi redirects to /trips (the listing) — NOT to
    # /trips/details/1/{id}. So we fetch the listing filtered by
    # main_traveler and read the new trip_id from the first matching row.
    landed = page.url
    trip_id: Optional[int] = None
    if save_303_seen:
        trip_id = await _lookup_trip_id_by_traveler(page, main_traveler)
    # Belt-and-suspenders: try the URL/hidden-input read in case Sofi's behaviour
    # ever changes back to the canonical /trips/details/1/{id} flow.
    if trip_id is None:
        m = re.search(r"/trips/(?:details|form)/\d+/(\d+)", landed)
        if m:
            trip_id = int(m.group(1))
    if trip_id is None:
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

    # --- Phase 2: push every booking sequentially in the SAME browser session.
    # We re-use the authenticated context so we don't pay another login round-
    # trip per booking. The global Playwright semaphore in scraper.py already
    # ensures we never run two Chromiums in parallel.
    bookings_plan = list(_iter_bookings(itn, trip_id))
    bookings_results: list[dict] = []
    for b in bookings_plan:
        try:
            r = await _push_one_booking(page, b, dry_run=False)
        except Exception as e:
            logger.exception("booking push crashed for service=%s", b.get("service_name"))
            r = {"ok": False, "service": b.get("service_name"),
                 "kind": b.get("kind"), "error": f"{type(e).__name__}: {e}"}
        bookings_results.append(r)

    return {
        "ok": True,
        "dry_run": False,
        "trip_id": trip_id,
        "url": f"{GESTION_BASE}/trips/details/1/{trip_id}",
        "filled_fields": filled,
        "bookings_results": bookings_results,
        "bookings_total": len(bookings_results),
        "bookings_ok": sum(1 for r in bookings_results if r.get("ok")),
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
        await page.select_option(selector, value=values if multiple else values[0], timeout=4000)
        filled.append({"label": label, "selector": selector,
                       "value": ", ".join(values) if multiple else values[0]})
        return
    except Exception:
        pass
    # Fallback 1: many Fabrik selects expose the visible label rather than the value.
    try:
        await page.select_option(selector, label=values if multiple else values[0], timeout=4000)
        filled.append({"label": label, "selector": selector,
                       "value": ", ".join(values) if multiple else values[0],
                       "matched_by": "label"})
        return
    except Exception:
        pass
    # Fallback 2: JS-level write. Needed for selects with `name="x[]"` (Fabrik
    # multivalue convention) where Playwright's actionability check sometimes
    # times out even though the option exists. Match by exact value first,
    # then by label substring.
    try:
        ok = await page.evaluate(
            """({sel, vals}) => {
              const el = document.querySelector(sel);
              if (!el) return {ok:false, error:'select not found'};
              const wanted = new Set(vals.map(v => String(v)));
              let matched = [];
              if (el.multiple) {
                  for (const o of el.options) {
                      o.selected = wanted.has(o.value) || wanted.has((o.textContent||'').trim());
                      if (o.selected) matched.push(o.value);
                  }
              } else {
                  const target = vals[0];
                  let opt = null;
                  for (const o of el.options) {
                      if (o.value === target || (o.textContent||'').trim() === target) { opt = o; break; }
                  }
                  if (!opt) {
                      for (const o of el.options) {
                          if ((o.textContent||'').includes(target)) { opt = o; break; }
                      }
                  }
                  if (opt) { el.value = opt.value; matched.push(opt.value); }
              }
              el.dispatchEvent(new Event('input', {bubbles:true}));
              el.dispatchEvent(new Event('change', {bubbles:true}));
              return {ok: matched.length > 0, matched};
            }""",
            {"sel": selector, "vals": values},
        )
        if ok and ok.get("ok"):
            filled.append({"label": label, "selector": selector,
                           "value": ", ".join(values) if multiple else values[0],
                           "via": "js"})
            return
        raise RuntimeError(f"option not found: {ok}")
    except Exception as e:
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


# ---------------------------------------------------------------------------
# Post-save id lookups — Sofi redirects to the LIST after a successful save,
# not to /trips/details/1/{id}. So we read the new id from the listing,
# filtered tightly to the same row we just inserted.
# ---------------------------------------------------------------------------
from urllib.parse import quote


async def _lookup_trip_id_by_traveler(page, main_traveler: str) -> Optional[int]:
    """Open /trips/list/1 filtered by main_traveler and return the highest
    id we can find. Idempotent for our use case because main_traveler is
    user-controlled and unique enough per session."""
    if not main_traveler:
        return None
    try:
        url = (f"{GESTION_BASE}/trips/list/1?resetfilters=1"
               f"&app_trips___main_traveler={quote(main_traveler)}"
               f"&fabrik_incsessionfilters=0")
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
        await page.wait_for_timeout(1500)
        ids = await page.evaluate("""() => {
            const ids = [];
            document.querySelectorAll(
              'a[href*="/trips/details/1/"], a[href*="/trips/form/1/"]'
            ).forEach(a => {
                const m = a.href.match(/\\/trips\\/(?:details|form)\\/1\\/(\\d+)/);
                if (m) ids.push(parseInt(m[1], 10));
            });
            ids.sort((a,b) => b - a);
            return ids;
        }""")
        return ids[0] if ids else None
    except Exception as e:
        logger.warning("_lookup_trip_id_by_traveler failed: %s", e)
        return None


async def _lookup_booking_id(page, trip_id, service_name: str) -> Optional[int]:
    """Open /reservas/list/3 filtered by trip_id (and best-effort by service
    name) and return the highest matching booking id."""
    if not trip_id:
        return None
    try:
        url = (f"{GESTION_BASE}/reservas/list/3?resetfilters=1"
               f"&app_bookings___trip_id_raw={trip_id}"
               f"&fabrik_incsessionfilters=0")
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
        await page.wait_for_timeout(1200)
        # Read all booking ids on the page; if more than one matches the same
        # service name, prefer the highest id (newest).
        ids = await page.evaluate("""(needle) => {
            const ids = [];
            document.querySelectorAll('table tr').forEach(tr => {
                const txt = (tr.textContent || '').toLowerCase();
                if (needle && !txt.includes(needle.toLowerCase().slice(0, 25))) return;
                tr.querySelectorAll(
                    'a[href*="/reservas/details/3/"], a[href*="/reservas/form/3/"]'
                ).forEach(a => {
                    const m = a.href.match(/\\/reservas\\/(?:details|form)\\/3\\/(\\d+)/);
                    if (m) ids.push(parseInt(m[1], 10));
                });
            });
            ids.sort((a,b) => b - a);
            return ids;
        }""", service_name or "")
        return ids[0] if ids else None
    except Exception as e:
        logger.warning("_lookup_booking_id failed: %s", e)
        return None




# ---------------------------------------------------------------------------
# Bookings: iterate the itinerary's services + accommodations + free days into
# a flat list of plans, then push them sequentially into Sofi's
# /reservas/form/3/ Fabrik form.
#
# Mapping (per user agreement, iter 16.5):
#  - 1 booking per service (excluding auto-spread accommodation carriers)
#  - 1 booking per accommodation (full check-in → check-out, qty=pax)
#  - 1 booking per "free day" (a day with no real services after filtering)
#  - status_reserva = "Sin Seleccion" (radio_4) — agent fills in Sofi later
#  - currency = EUR
# ---------------------------------------------------------------------------

def _iter_bookings(itn: dict, trip_id):
    """Yield booking-plan dicts. trip_id may be the real Sofi int id (real
    push) or None / placeholder (dry-run)."""
    num_travelers = int(itn.get("num_travelers") or 1) or 1

    # Per-day services (skip accommodation carriers — they're spread for the
    # builder UX but the actual hotel is pushed once via the Accommodations
    # branch below).
    for d in itn.get("days") or []:
        services_for_day = [
            s for s in (d.get("services") or [])
            if not s.get("acc_id")  # carriers always have acc_id set
        ]
        if not services_for_day:
            yield {
                "kind": "free_day",
                "trip_id": trip_id,
                "service_name": "Free Day",
                "city": d.get("city") or "",
                "quantity": num_travelers,
                "date_entry": d.get("date"),
                "date_exit": None,
                "room": None,
                "invoice_excl": 0.0,
                "invoice_incl": 0.0,
                "price_total": 0.0,
                "notes": "Día libre",
                "provider": None,
                "type_radio": 2,  # Free Day
            }
            continue
        for s in services_for_day:
            qty = int(s.get("quantity") or 1) or 1
            unit_excl = float(s.get("unit_price_tax_excl") or 0)
            unit_incl = float(s.get("unit_price_tax_incl") or s.get("unit_price") or 0)
            yield {
                "kind": "service",
                "trip_id": trip_id,
                "service_name": s.get("name") or "(Sin nombre)",
                "city": d.get("city") or "",
                "quantity": qty,
                "date_entry": d.get("date"),
                "date_exit": None,
                "room": None,
                "invoice_excl": round(unit_excl * qty, 2),
                "invoice_incl": round(unit_incl * qty, 2),
                "price_total": round(unit_incl * qty, 2),
                "notes": s.get("notes"),
                "provider": s.get("provider_name"),
                "type_radio": 0,  # Actividades / Transporte
            }

    # Accommodations (1 booking per hotel, full date_from → date_to range).
    for a in itn.get("accommodations") or []:
        rooms = a.get("rooms") or []
        try:
            df = datetime.fromisoformat(a.get("date_from") or "")
            dt = datetime.fromisoformat(a.get("date_to") or "")
            nights = max(1, (dt - df).days)
        except (TypeError, ValueError):
            nights = 1
        # Prefer the aggregate price already stored on the accommodation
        # (matches what the builder shows). Fall back to the rooms sum × nights.
        rooms_sum_excl = sum(float(r.get("price_per_night_excl") or 0) for r in rooms)
        rooms_sum_incl = sum(
            float(r.get("price_per_night_incl") or r.get("price_per_night_excl") or 0)
            for r in rooms
        )
        total_excl = float(a.get("price_tax_excl") or rooms_sum_excl * nights)
        total_incl = float(a.get("price_tax_incl") or a.get("price") or rooms_sum_incl * nights)
        room_str = " + ".join((r.get("room_type") or "doble") for r in rooms) if rooms else "doble"
        yield {
            "kind": "accommodation",
            "trip_id": trip_id,
            "service_name": a.get("name") or "(Sin nombre)",
            "city": a.get("city") or "",
            "quantity": num_travelers,
            "date_entry": a.get("date_from"),
            "date_exit": a.get("date_to"),
            "room": room_str,
            "invoice_excl": round(total_excl, 2),
            "invoice_incl": round(total_incl, 2),
            "price_total": round(total_incl, 2),
            "notes": None,
            "provider": None,
            "type_radio": 1,  # Alojamientos
        }


def _booking_to_summary(b: dict) -> dict:
    """Subset of the plan dict safe to ship to the frontend (no trip_id)."""
    return {
        "kind": b.get("kind"),
        "type_radio": b.get("type_radio"),
        "service_name": b.get("service_name"),
        "city": b.get("city"),
        "date_entry": b.get("date_entry"),
        "date_exit": b.get("date_exit"),
        "quantity": b.get("quantity"),
        "room": b.get("room"),
        "provider": b.get("provider"),
        "price_total": b.get("price_total"),
        "invoice_excl": b.get("invoice_excl"),
        "invoice_incl": b.get("invoice_incl"),
    }


async def _push_one_booking(page, b: dict, *, dry_run: bool) -> dict:
    """Open /reservas/form/3/, fill the booking fields, and (unless dry_run)
    submit. Returns a status dict. The browser context is shared across calls
    so we don't pay re-login latency between bookings."""
    try:
        await page.goto(f"{GESTION_BASE}/reservas/form/3/",
                        wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_selector("#app_bookings___service", timeout=15000)
    except Exception as e:
        return {"ok": False, "kind": b.get("kind"), "service": b.get("service_name"),
                "error": f"Form de reservas no cargó: {e}"}

    filled: list[dict] = []

    # Trip ID select — has 1916 options, only valid for real push.
    if b.get("trip_id"):
        await _safe_select(page, "#app_bookings___trip_id", [str(b["trip_id"])],
                           multiple=False, filled=filled, label="Trip ID")

    # Type radio: 0=Actividades/Transporte, 1=Alojamientos, 2=Free Day
    type_idx = int(b.get("type_radio") or 0)
    type_label = {0: "Actividades/Transporte", 1: "Alojamientos", 2: "Free Day"}.get(type_idx, "?")
    await _safe_click(page, f"#app_bookings___type_input_{type_idx}", filled,
                      f"Tipo = {type_label}")

    await _safe_fill(page, "#app_bookings___service",
                     b.get("service_name") or "", filled, "Service")
    await _safe_fill(page, "#app_bookings___ciudad",
                     b.get("city") or "", filled, "Ciudad")
    await _safe_fill(page, "#app_bookings___quantity",
                     str(b.get("quantity") or 1), filled, "AD")
    await _safe_fill(page, "#app_bookings___number_of_children", "0", filled, "Ch")
    await _safe_fill(page, "#app_bookings___date_entry_cal",
                     _to_sofi_date(b.get("date_entry")), filled, "Fecha entrada")
    if b.get("date_exit"):
        await _safe_fill(page, "#app_bookings___date_exit_cal",
                         _to_sofi_date(b["date_exit"]), filled, "Fecha salida")
    if b.get("room"):
        await _safe_fill(page, "#app_bookings___room",
                         b["room"], filled, "Room type")

    # Currency = EUR (radio_input_0)
    await _safe_click(page, "#app_bookings___currency_input_0", filled, "Currency = EUR")
    # Status reserva = Sin Seleccion (radio_input_4) — per user choice 5d
    await _safe_click(page, "#app_bookings___status_reserva_input_4", filled,
                      "Estado = Sin Seleccion")

    # Pricing
    await _safe_fill(page, "#app_bookings___price",
                     f"{float(b.get('price_total') or 0):.2f}", filled, "Cotizado kk")
    await _safe_fill(page, "#app_bookings___invoice_tax_excl",
                     f"{float(b.get('invoice_excl') or 0):.2f}", filled, "F. sin IVA")
    await _safe_fill(page, "#app_bookings___invoice_tax_incl",
                     f"{float(b.get('invoice_incl') or 0):.2f}", filled, "F. con IVA")

    if b.get("notes"):
        await _safe_fill(page, "#app_bookings___note",
                         (b["notes"] or "")[:255], filled, "Notas")

    # Operator (Fabrik autocomplete) — best-effort: just type the provider name
    # in. If the agent wants to match it to a Sofi operator id later they can
    # do it from inside Sofi.
    if b.get("provider"):
        await _safe_fill(page, "#app_bookings___operator-auto-complete",
                         b["provider"], filled, "Operador")

    if dry_run:
        return {
            "ok": True, "dry_run": True,
            "kind": b.get("kind"),
            "service": b.get("service_name"),
            "filled_fields": filled,
        }

    # Real submit on the bookings form. Same pattern as the trip form:
    # click #fabrikSubmit_3 (Fabrik primary, NOT the Joomla header search),
    # force=True to bypass the temporary disabled state, expect_navigation
    # then fall back to a fixed wait if Fabrik chose to AJAX-submit.
    btn = (await page.query_selector("#fabrikSubmit_3")
           or await page.query_selector("button.btn-primary.guardar[name='Submit']"))
    if not btn:
        return {"ok": False, "kind": b.get("kind"),
                "service": b.get("service_name"),
                "error": "No encontré el botón Submit en /reservas/form/3"}
    await page.evaluate("""() => {
        const x = document.getElementById('fabrikSubmit_3');
        if (x) { x.disabled = false; x.removeAttribute('disabled'); }
    }""")
    save_303_seen = False
    try:
        async with page.expect_response(
            lambda r: r.status == 303 and "/reservas/form/3" in r.url,
            timeout=30000,
        ):
            await btn.click(force=True, timeout=10000)
        save_303_seen = True
    except Exception:
        await page.wait_for_timeout(4000)
    try:
        await page.wait_for_load_state("load", timeout=8000)
    except Exception:
        pass
    try:
        await page.wait_for_load_state("networkidle", timeout=30000)
    except Exception:
        pass

    landed = page.url
    booking_id: Optional[int] = None
    if save_303_seen and b.get("trip_id"):
        booking_id = await _lookup_booking_id(page, b["trip_id"], b.get("service_name") or "")
    if booking_id is None:
        m = re.search(r"/reservas/(?:details|form)/\d+/(\d+)", landed)
        if m:
            booking_id = int(m.group(1))
    if booking_id is None:
        rid = await page.evaluate(
            "() => document.getElementById('app_bookings___id')?.value || null"
        )
        if rid and str(rid).isdigit():
            booking_id = int(rid)

    # Inline form errors
    errors = await page.evaluate("""() => {
        const out = [];
        document.querySelectorAll('.fabrikError, .invalid-feedback, .has-error, .alert-error, .alert-danger').forEach(el => {
            const t = (el.textContent || '').trim();
            if (t) out.push(t.slice(0, 200));
        });
        return out;
    }""")
    if errors and not booking_id:
        return {"ok": False, "kind": b.get("kind"),
                "service": b.get("service_name"),
                "error": "Sofi rechazó la reserva",
                "details": errors[:5]}

    if not booking_id:
        return {"ok": False, "kind": b.get("kind"),
                "service": b.get("service_name"),
                "error": f"Submit OK pero no pude leer el booking_id. URL: {landed}"}

    return {
        "ok": True,
        "kind": b.get("kind"),
        "service": b.get("service_name"),
        "sofi_booking_id": booking_id,
        "url": f"{GESTION_BASE}/reservas/details/3/{booking_id}",
    }
