"""Quick Expedia.es hotel price scraper.

Goal: return an orientation price/night for a city given check-in/check-out
dates and traveler count, WITHOUT logging in. Uses Playwright headless
Chromium with a normal user-agent. Expedia (Cloudflare-protected) sometimes
blocks bots — when that happens we return a structured `blocked=true` so the
UI can fall back to a manual estimate.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import date, timedelta
from typing import Optional
from urllib.parse import quote_plus

from playwright.async_api import async_playwright

logger = logging.getLogger("expedia")


def _format_date(s: str) -> str:
    """Accept YYYY-MM-DD or DD/MM/YYYY and return YYYY-MM-DD."""
    s = (s or "").strip()
    if not s:
        return ""
    if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
        return s
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", s)
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    return s


async def search_hotels(
    city: str,
    checkin: Optional[str] = None,
    checkout: Optional[str] = None,
    adults: int = 2,
    timeout_s: int = 25,
    max_results: int = 5,
) -> dict:
    """Run a hotel search on expedia.es and parse the top N results.

    Returns:
        {
            "ok": bool,
            "blocked": bool,
            "city": str,
            "checkin": "YYYY-MM-DD",
            "checkout": "YYYY-MM-DD",
            "adults": int,
            "nights": int,
            "results": [
                {"name": str, "rating": float|None, "price_per_night_eur": float,
                 "currency": "EUR", "url": str|None}
            ],
            "median_price_per_night_eur": float|None,
            "source_url": str,
            "error": str|None,
        }
    """
    if not city or not city.strip():
        return {"ok": False, "error": "city is required", "blocked": False, "results": []}
    city = city.strip()

    # Default dates: 30 days from now, 3-night stay (typical orientation window).
    today = date.today()
    if not checkin:
        checkin = (today + timedelta(days=30)).isoformat()
    if not checkout:
        checkout = (today + timedelta(days=33)).isoformat()
    checkin = _format_date(checkin)
    checkout = _format_date(checkout)
    try:
        nights = max(1, (date.fromisoformat(checkout) - date.fromisoformat(checkin)).days)
    except Exception:
        nights = 3

    # Expedia.es deep-link. Using the /Hotel-Search URL with destination=<city>
    # gives us the same SERP a logged-out browser sees.
    url = (
        "https://www.expedia.es/Hotel-Search"
        f"?destination={quote_plus(city)}"
        f"&startDate={checkin}&endDate={checkout}"
        f"&adults={adults}"
        f"&sort=RECOMMENDED"
    )

    out: dict = {
        "ok": False,
        "blocked": False,
        "city": city,
        "checkin": checkin,
        "checkout": checkout,
        "adults": adults,
        "nights": nights,
        "results": [],
        "median_price_per_night_eur": None,
        "source_url": url,
        "error": None,
    }

    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                args=[
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-blink-features=AutomationControlled",
                ],
            )
            ctx = await browser.new_context(
                locale="es-ES",
                viewport={"width": 1366, "height": 900},
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/125.0.0.0 Safari/537.36"
                ),
                extra_http_headers={"Accept-Language": "es-ES,es;q=0.9,en;q=0.5"},
            )
            page = await ctx.new_page()
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=timeout_s * 1000)
                # Expedia loads results progressively. Wait a little for cards.
                try:
                    await page.wait_for_selector('[data-stid="lodging-card-responsive"]', timeout=10000)
                except Exception:
                    # No cards in 10s — could be a captcha / block / location modal.
                    pass

                # Detect bot challenge / blocked
                title = (await page.title() or "").lower()
                body_text = await page.inner_text("body")
                blocked_signals = [
                    "verifying you are human",
                    "are you a robot",
                    "access denied",
                    "verify you are human",
                    "captcha",
                    "demuéstranos tu lado más humano",
                    "demuestranos tu lado mas humano",
                    "¿eres un robot?",
                    "eres un robot",
                    "no estamos seguros de si eres un humano",
                ]
                lbody = body_text.lower()
                if "¿eres un robot?" in title or any(s in lbody for s in blocked_signals):
                    out["blocked"] = True
                    out["error"] = "Expedia mostró un challenge anti-bot."
                    return out

                # Parse hotel cards.
                cards = await page.query_selector_all('[data-stid="lodging-card-responsive"]')
                rows: list[dict] = []
                for c in cards[: max_results * 2]:
                    try:
                        name_el = await c.query_selector('h3') or await c.query_selector('[data-stid="content-hotel-title"]')
                        price_el = (
                            await c.query_selector('[data-test-id="price-summary"] div div')
                            or await c.query_selector('[data-test-id="price-summary"]')
                            or await c.query_selector('[data-stid="content-hotel-lead-price"]')
                        )
                        if not name_el or not price_el:
                            continue
                        name = (await name_el.inner_text()).strip()
                        price_txt = (await price_el.inner_text()).strip()
                        # Examples: "238 €", "1.234 €", "238 EUR", "238€"
                        m = re.search(r"([\d\.\,]+)\s*€?\s*", price_txt)
                        if not m:
                            continue
                        raw = m.group(1).replace(".", "").replace(",", ".")
                        try:
                            price_total = float(raw)
                        except ValueError:
                            continue
                        # Expedia usually shows total-for-stay or per-night depending on locale.
                        # On expedia.es the displayed price is generally per-night for the first card,
                        # but some show total. We normalise to per-night and let the consumer round.
                        per_night = price_total / nights if price_total > 800 and nights > 1 else price_total

                        rating = None
                        rating_el = await c.query_selector('[data-stid="content-hotel-reviews-rating"]')
                        if rating_el:
                            rt = (await rating_el.inner_text()).strip()
                            mr = re.search(r"([\d,\.]+)", rt)
                            if mr:
                                try:
                                    rating = float(mr.group(1).replace(",", "."))
                                except Exception:
                                    rating = None

                        href = None
                        link_el = await c.query_selector('a')
                        if link_el:
                            href = await link_el.get_attribute("href")
                            if href and href.startswith("/"):
                                href = "https://www.expedia.es" + href

                        rows.append({
                            "name": name[:120],
                            "rating": rating,
                            "price_per_night_eur": round(per_night, 2),
                            "currency": "EUR",
                            "url": href,
                        })
                        if len(rows) >= max_results:
                            break
                    except Exception as e:
                        logger.debug(f"card parse failed: {e}")
                        continue

                if rows:
                    prices = sorted([r["price_per_night_eur"] for r in rows if r["price_per_night_eur"] > 0])
                    mid = len(prices) // 2
                    median = prices[mid] if prices else None
                    out.update({
                        "ok": True,
                        "results": rows,
                        "median_price_per_night_eur": median,
                    })
                else:
                    out["error"] = "No se encontraron tarjetas de hotel en la respuesta."
            finally:
                await ctx.close()
                await browser.close()
    except Exception as e:
        logger.exception("expedia search failed")
        out["error"] = str(e)[:200]

    return out


if __name__ == "__main__":
    # Quick CLI for ops debugging:
    #   python -m backend.expedia_scraper Madrid
    import sys
    city = sys.argv[1] if len(sys.argv) > 1 else "Madrid"
    res = asyncio.run(search_hotels(city))
    print(json.dumps(res, indent=2, ensure_ascii=False))
