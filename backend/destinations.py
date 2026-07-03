"""Curated destination image galleries.

Small hand-picked Unsplash URLs per major destination we support. The
`pick_hero()` helper takes an itinerary and returns the best hero image
URL by searching (city ⇒ region ⇒ generic) with sensible fallbacks.

Fuzzy matching: diacritics are stripped, common suffixes ("coast",
"region", "province", "area") are removed, and known synonyms
("costa amalfitana" → "amalfi") map back to the canonical key. So an
LLM-imported Travefy city can name anything and we still hit the right
photo bucket.
"""

from __future__ import annotations

import re
import unicodedata
from typing import List, Optional


def _photo(photo_id: str, w: int = 1920, h: int = 1080) -> str:
    """Return an Unsplash image URL sized w × h, quality 80."""
    return (
        f"https://images.unsplash.com/photo-{photo_id}"
        f"?ixlib=rb-4.0.3&auto=format&fit=crop&w={w}&h={h}&q=80"
    )


# Key = lowercased, ASCII-only, no suffix noise. Value = list of 1–5
# Unsplash photo IDs. First entry is used for the hero by default;
# accommodations/days without their own image can decorate with the rest.
_GALLERY = {
    # ---- Italy ------------------------------------------------------------
    "rome": [
        "1552832230-c0197dd311b5",
        "1531572753322-ad063cecc140",
        "1525874684015-58379d421a52",
    ],
    "florence": [
        "1541370545831-faf645b12dd8",
        "1543429770-b0f9de0fed11",
    ],
    "tuscany": [
        "1523906630133-f6934a1ab2b9",   # Tuscan hills
        "1533107862482-0e6974b06ec4",
    ],
    "venice": [
        "1523906834658-6e24ef2386f9",
        "1514890547357-a9ee288728e0",
    ],
    "milan": ["1512058564366-18510be2db19"],
    "naples": ["1631274329756-e6b04a06c0cc"],
    "sorrento": ["1560800452-f2d475982b96"],
    "capri": ["1533107862482-0e6974b06ec4"],
    "amalfi": ["1533105079780-92b9be482077"],
    "positano": ["1583312605516-4c14e9d9c1a1"],
    "sicily": ["1602343168117-bb8ffe3e2e9f"],
    "cinque terre": ["1517093602195-b40af9688b46"],
    "bologna": ["1543429770-b0f9de0fed11"],
    "verona": ["1567604134859-f5bbe20b0f2f"],
    "lake como": ["1550399105-c4db5fb85c18"],
    "puglia": ["1594906297894-27e0e2f0d90d"],
    "italy": ["1552832230-c0197dd311b5"],
    # ---- Spain ------------------------------------------------------------
    "madrid": [
        "1543783207-ec64e4d95325",
        "1509840841025-9088ba78a826",
    ],
    "barcelona": [
        "1583422409516-2895a77efded",
        "1591261730799-ee4e6c2d1e5f",
    ],
    "seville": ["1560179707-f14e90ef3623"],
    "cordoba": ["1591634616938-1dfa13ee1f0f"],  # placeholder — Cordoba mezquita
    "granada": ["1591121779720-3f27f28fbbd6"],
    "valencia": ["1560787313-5dff3307e257"],
    "san sebastian": ["1571893544028-06b07af6dade"],
    "bilbao": ["1580419443186-31acbf50c1c9"],
    "toledo": ["1591634616938-1dfa13ee1f0f"],
    "salamanca": ["1543783207-ec64e4d95325"],
    "mallorca": ["1519677100203-a0e668c92439"],
    "menorca": ["1519677100203-a0e668c92439"],
    "ibiza": ["1520370968810-f5f8e5b8b0a4"],
    "tenerife": ["1509233725247-49e657c54213"],
    "gran canaria": ["1509233725247-49e657c54213"],
    "andalusia": ["1560179707-f14e90ef3623"],
    "basque country": ["1571893544028-06b07af6dade"],
    "spain": ["1543783207-ec64e4d95325"],
    # ---- Portugal ---------------------------------------------------------
    "lisbon": ["1526392060635-9d6019884377"],
    "porto": ["1555990538-32a76bbeb1e5"],
    "algarve": ["1590420889722-eeb2bdbc32d5"],
    "madeira": ["1590420889722-eeb2bdbc32d5"],
    "portugal": ["1526392060635-9d6019884377"],
    # ---- France -----------------------------------------------------------
    "paris": ["1502602898657-3e91760cbb34"],
    "provence": ["1595351298080-25c92e79b47b"],
    "nice": ["1502602898657-3e91760cbb34"],
    "cannes": ["1502602898657-3e91760cbb34"],
    "france": ["1502602898657-3e91760cbb34"],
    # ---- Greece -----------------------------------------------------------
    "athens": ["1503152394-c571994fd383"],
    "santorini": ["1570077188670-e3a8d69ac5ff"],
    "mykonos": ["1601581875039-e899893d520c"],
    "crete": ["1570077188670-e3a8d69ac5ff"],
    "greece": ["1503152394-c571994fd383"],
    # ---- Fallback (elegant travel scene) ----------------------------------
    "_default": ["1476514525535-07fb3b4ae5f1"],
}


# Common variants → canonical key. Lower/ASCII already applied when looked
# up. Additions here are cheap and safe.
_SYNONYMS = {
    "amalfi coast": "amalfi",
    "costa amalfitana": "amalfi",
    "amalfi coast italy": "amalfi",
    "seville": "seville",
    "sevilla": "seville",
    "cordoba spain": "cordoba",
    "cordova": "cordoba",
    "cinque terre italy": "cinque terre",
    "cinque terre national park": "cinque terre",
    "roma": "rome",
    "firenze": "florence",
    "venezia": "venice",
    "napoli": "naples",
    "toscana": "tuscany",
    "sicilia": "sicily",
    "puglia italy": "puglia",
    "apulia": "puglia",
    "lake como italy": "lake como",
    "lago di como": "lake como",
    "lisboa": "lisbon",
    "algarve region": "algarve",
    "provence france": "provence",
    "provence-alpes-cote d'azur": "provence",
    "french riviera": "nice",
    "cote d'azur": "nice",
    "santorini greece": "santorini",
    "san sebastian spain": "san sebastian",
    "donostia": "san sebastian",
    "donostia-san sebastian": "san sebastian",
    "pais vasco": "basque country",
    "euskadi": "basque country",
    "andalucia": "andalusia",
    "islas baleares": "mallorca",
    "balearic islands": "mallorca",
    "canary islands": "tenerife",
    "islas canarias": "tenerife",
}


# Suffix words to strip when matching (order matters — longest first).
_STRIP_SUFFIXES = [
    "national park",
    "province of",
    "region of",
    "coast",
    "region",
    "province",
    "area",
    "district",
    "city",
]


def _normalize(text: Optional[str]) -> str:
    """lowercase + strip diacritics + collapse spaces. Used both for
    matching keys and for stripping suffixes."""
    if not text:
        return ""
    s = text.strip().lower()
    # Strip diacritics: "Córdoba" → "cordoba", "São Paulo" → "sao paulo"
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[’']", "", s)  # apostrophes noise
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _strip_suffix(text: str) -> str:
    """Return the destination without generic suffix words. "Amalfi Coast"
    → "amalfi", "Provence region" → "provence"."""
    t = text
    for suffix in _STRIP_SUFFIXES:
        if t.endswith(" " + suffix):
            t = t[: -(len(suffix) + 1)].strip()
            break
    return t


def _lookup(key: str) -> Optional[list]:
    """Try a few progressive relaxations to hit the gallery. Returns the
    raw list of photo IDs, or None if nothing matched."""
    if not key:
        return None
    # 1. Direct hit
    if key in _GALLERY:
        return _GALLERY[key]
    # 2. Synonym remap
    if key in _SYNONYMS:
        mapped = _SYNONYMS[key]
        if mapped in _GALLERY:
            return _GALLERY[mapped]
    # 3. Strip common suffix ("Amalfi Coast" → "amalfi")
    stripped = _strip_suffix(key)
    if stripped != key:
        return _lookup(stripped)
    # 4. Country / region fallback via last comma-separated token
    tokens = [t.strip() for t in key.split(",") if t.strip()]
    if len(tokens) > 1:
        for tok in tokens:
            if tok in _GALLERY:
                return _GALLERY[tok]
            if tok in _SYNONYMS and _SYNONYMS[tok] in _GALLERY:
                return _GALLERY[_SYNONYMS[tok]]
    return None


def gallery_for(destination: Optional[str]) -> List[str]:
    """Return the image list for a destination, resolved through
    normalisation → synonyms → suffix stripping → country fallback →
    default. Never raises; always returns at least one URL."""
    key = _normalize(destination)
    hit = _lookup(key)
    if hit:
        return [_photo(pid) for pid in hit]
    return [_photo(pid) for pid in _GALLERY["_default"]]


def pick_hero(itinerary: dict) -> str:
    """Choose the best hero image for an itinerary. Priority: explicit
    `hero_image` → first city on day 1 → first accommodation city →
    default."""
    if itinerary.get("hero_image"):
        return itinerary["hero_image"]
    for d in itinerary.get("days") or []:
        city = d.get("city")
        if city:
            return gallery_for(city)[0]
    for a in itinerary.get("accommodations") or []:
        for hint in (a.get("city"), a.get("destination"), a.get("name")):
            if hint:
                imgs = gallery_for(hint)
                if imgs:
                    return imgs[0]
    return _DEFAULT_URL


def pick_day_image(day: dict, itinerary: dict) -> Optional[str]:
    """Choose a decorative image for a day tile. Different image than the
    hero when possible (varies by day date)."""
    if day.get("image_url"):
        return day["image_url"]
    city = day.get("city") or ""
    imgs = gallery_for(city)
    if imgs:
        seed = day.get("date") or day.get("day_id") or "seed"
        idx = (sum(ord(c) for c in str(seed))) % len(imgs)
        return imgs[idx]
    return None


_DEFAULT_URL = _photo(_GALLERY["_default"][0])
