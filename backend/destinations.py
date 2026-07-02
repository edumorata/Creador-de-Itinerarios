"""Curated destination image galleries.

Small hand-picked Unsplash URLs per major destination we support. The
`pick_hero()` helper takes an itinerary and returns the best hero image
URL by searching (city ⇒ region ⇒ generic) with sensible fallbacks.

All image URLs are stable Unsplash CDN paths (photo_id + query params for
crop/quality). Add new destinations as `_GALLERY[key] = [url1, url2, ...]`.
"""

from __future__ import annotations

import random
from typing import List, Optional


def _photo(photo_id: str, w: int = 1920, h: int = 1080) -> str:
    """Return an Unsplash image URL sized w × h, quality 80."""
    return (
        f"https://images.unsplash.com/photo-{photo_id}"
        f"?ixlib=rb-4.0.3&auto=format&fit=crop&w={w}&h={h}&q=80"
    )


# Key = lowercased destination name (city, region, or country). Value = list
# of 1–5 Unsplash photo IDs. First entry is used for hero by default;
# accommodations/days that don't have their own image can pick from the
# rest as decorative fillers.
_GALLERY = {
    # ---- Italy ------------------------------------------------------------
    "rome": [
        "1552832230-c0197dd311b5",   # St. Peter's dome at sunset
        "1531572753322-ad063cecc140",  # Roman forum
        "1525874684015-58379d421a52",  # Trevi at night
    ],
    "florence": [
        "1541370545831-faf645b12dd8",  # Duomo skyline
        "1543429770-b0f9de0fed11",     # Ponte Vecchio
    ],
    "venice": [
        "1523906834658-6e24ef2386f9",  # Grand Canal
        "1514890547357-a9ee288728e0",  # Gondolas
    ],
    "milan": ["1512058564366-18510be2db19"],
    "naples": ["1631274329756-e6b04a06c0cc"],
    "sorrento": ["1560800452-f2d475982b96"],
    "capri": ["1533107862482-0e6974b06ec4"],
    "amalfi": ["1533105079780-92b9be482077"],
    "positano": ["1583312605516-4c14e9d9c1a1"],
    "sicily": ["1602343168117-bb8ffe3e2e9f"],
    "italy": ["1552832230-c0197dd311b5"],
    # ---- Spain ------------------------------------------------------------
    "madrid": [
        "1543783207-ec64e4d95325",   # Plaza Mayor / Cibeles
        "1509840841025-9088ba78a826",  # Retiro
    ],
    "barcelona": [
        "1583422409516-2895a77efded",  # Sagrada Familia
        "1591261730799-ee4e6c2d1e5f",  # Park Guell
    ],
    "sevilla": ["1560179707-f14e90ef3623"],
    "seville": ["1560179707-f14e90ef3623"],
    "granada": ["1591121779720-3f27f28fbbd6"],
    "valencia": ["1560787313-5dff3307e257"],
    "san sebastian": ["1571893544028-06b07af6dade"],
    "bilbao": ["1580419443186-31acbf50c1c9"],
    "toledo": ["1591634616938-1dfa13ee1f0f"],
    "mallorca": ["1519677100203-a0e668c92439"],
    "ibiza": ["1520370968810-f5f8e5b8b0a4"],
    "spain": ["1543783207-ec64e4d95325"],
    # ---- Portugal ---------------------------------------------------------
    "lisbon": ["1526392060635-9d6019884377"],
    "porto": ["1555990538-32a76bbeb1e5"],
    "portugal": ["1526392060635-9d6019884377"],
    # ---- France -----------------------------------------------------------
    "paris": ["1502602898657-3e91760cbb34"],
    "provence": ["1595351298080-25c92e79b47b"],
    "france": ["1502602898657-3e91760cbb34"],
    # ---- Greece -----------------------------------------------------------
    "athens": ["1503152394-c571994fd383"],
    "santorini": ["1570077188670-e3a8d69ac5ff"],
    "mykonos": ["1601581875039-e899893d520c"],
    "greece": ["1503152394-c571994fd383"],
    # ---- Fallback (elegant travel scene) ----------------------------------
    "_default": ["1476514525535-07fb3b4ae5f1"],  # cliff coastline
}


def _key(text: Optional[str]) -> str:
    return (text or "").strip().lower()


def gallery_for(destination: Optional[str]) -> List[str]:
    """Return the full list of images for a destination, resolving through
    a couple of common variants (comma-stripped, region fallback)."""
    if not destination:
        return _GALLERY["_default"]
    k = _key(destination)
    # try the raw key first
    if k in _GALLERY:
        return [_photo(pid) for pid in _GALLERY[k]]
    # try the first token (e.g. "Rome, Italy" → "rome")
    first = k.split(",")[0].strip()
    if first in _GALLERY:
        return [_photo(pid) for pid in _GALLERY[first]]
    # try the last token (country fallback)
    last = k.split(",")[-1].strip()
    if last in _GALLERY:
        return [_photo(pid) for pid in _GALLERY[last]]
    return [_photo(pid) for pid in _GALLERY["_default"]]


def pick_hero(itinerary: dict) -> str:
    """Choose the best hero image for an itinerary.

    Priority: explicit `hero_image` on the doc → first city on day 1 →
    first accommodation destination → default fallback.
    """
    if itinerary.get("hero_image"):
        return itinerary["hero_image"]
    days = itinerary.get("days") or []
    for d in days:
        city = d.get("city")
        if city:
            return gallery_for(city)[0]
    accs = itinerary.get("accommodations") or []
    for a in accs:
        for hint in (a.get("city"), a.get("destination"), a.get("name")):
            if hint:
                imgs = gallery_for(hint)
                if imgs:
                    return imgs[0]
    return _GALLERY_URLS_DEFAULT[0]


def pick_day_image(day: dict, itinerary: dict) -> Optional[str]:
    """Choose a decorative image for a day tile. Uses the day's `city`
    (auto-Unsplash) when there's no explicit `image_url`. Different image
    than the hero when possible."""
    if day.get("image_url"):
        return day["image_url"]
    city = day.get("city") or ""
    imgs = gallery_for(city)
    # Pick a deterministic-but-varied index based on the day date so days
    # in the same city don't all show the exact same photo.
    if imgs:
        seed = day.get("date") or day.get("day_id") or "seed"
        idx = (sum(ord(c) for c in str(seed))) % len(imgs)
        return imgs[idx]
    return None


_GALLERY_URLS_DEFAULT = [_photo(pid) for pid in _GALLERY["_default"]]
