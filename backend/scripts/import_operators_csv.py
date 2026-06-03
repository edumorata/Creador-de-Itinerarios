"""One-shot script to (re)build the experiences catalog from
/app/artifacts/catalog_db/app_operators.csv

Equivalent to calling POST /api/catalog/import-from-trips-csv?wipe=true
but runs directly against MongoDB so we don't need an auth token.

Usage:  python -m backend.scripts.import_operators_csv [csv_path]
"""
from __future__ import annotations

import asyncio
import csv as _csv
import os
import pathlib
import sys
from collections import defaultdict
from typing import Any

from dotenv import dotenv_values
from motor.motor_asyncio import AsyncIOMotorClient

# Make backend importable when running from /app
sys.path.insert(0, "/app/backend")
from models import Experience, Hotel, Provider  # noqa: E402


CITY_COUNTRY = {
    # Spain
    "Madrid": "España", "Barcelona": "España", "Sevilla": "España", "Seville": "España",
    "Valencia": "España", "Bilbao": "España", "Granada": "España", "Toledo": "España",
    "Cordoba": "España", "Córdoba": "España", "Ronda": "España", "Malaga": "España",
    "Málaga": "España", "San Sebastian": "España", "San Sebastián": "España",
    "Mallorca": "España", "Ibiza": "España", "Segovia": "España", "Salamanca": "España",
    "Logroño": "España", "La Rioja": "España", "Pamplona": "España", "Avila": "España",
    "Ávila": "España", "Cuenca": "España", "Marbella": "España", "Tenerife": "España",
    "Cadiz": "España", "Cádiz": "España", "Jerez": "España", "Jerez de la Frontera": "España",
    "Tarifa": "España", "Vejer": "España", "Vejer de la Frontera": "España",
    "San Pedro de Alcantara": "España",
    # Portugal
    "Lisbon": "Portugal", "Lisboa": "Portugal", "Porto": "Portugal", "Oporto": "Portugal",
    "Sintra": "Portugal", "Cascais": "Portugal", "Algarve": "Portugal", "Lagos": "Portugal",
    "Coimbra": "Portugal", "Evora": "Portugal", "Évora": "Portugal", "Douro": "Portugal",
    "Douro Valley": "Portugal", "Madeira": "Portugal", "Azores": "Portugal", "Braga": "Portugal",
    "Faro": "Portugal", "Aveiro": "Portugal", "Madeira (Funchal)": "Portugal",
    "Funchal": "Portugal", "Terceira": "Portugal",
    # Italy
    "Rome": "Italia", "Roma": "Italia", "Florence": "Italia", "Firenze": "Italia",
    "Florencia": "Italia", "Venice": "Italia", "Venezia": "Italia", "Venecia": "Italia",
    "Naples": "Italia", "Napoli": "Italia", "Milan": "Italia", "Milano": "Italia",
    "Sorrento": "Italia", "Positano": "Italia", "Amalfi": "Italia", "Capri": "Italia",
    "Pompeii": "Italia", "Tuscany": "Italia", "Toscana": "Italia", "Bologna": "Italia",
    "Verona": "Italia", "Siena": "Italia", "Pisa": "Italia", "Cinque Terre": "Italia",
    "Lake Como": "Italia", "Sicily": "Italia", "Sicilia": "Italia", "Palermo": "Italia",
    "Taormina": "Italia", "Catania": "Italia", "Matera": "Italia", "Puglia": "Italia",
    "Lecce": "Italia", "Reggio Calabria": "Italia",
    # Morocco
    "Marrakech": "Marruecos", "Marrakesh": "Marruecos", "Casablanca": "Marruecos",
    "Fes": "Marruecos", "Fez": "Marruecos", "Rabat": "Marruecos", "Tangier": "Marruecos",
    "Chefchaouen": "Marruecos", "Essaouira": "Marruecos", "Merzouga": "Marruecos",
}
CITY_ALIASES = {
    "Roma": "Rome", "Florencia": "Florence", "Firenze": "Florence",
    "Venecia": "Venice", "Venezia": "Venice", "Napoli": "Naples", "Milano": "Milan",
    "Lisboa": "Lisbon", "Oporto": "Porto", "Sevilla": "Seville", "Marrakesh": "Marrakech",
    "Fez": "Fes", "Cádiz": "Cadiz",
}

HOTEL_KW = ("hotel", "hostel", "hostal", "apartam", "apartment", "resort", "pousada",
            "riad", "villa", "b&b", "bed and breakfast", "lodge", "boutique stay")
TRANSFER_KW = ("transfer", "taxi", "limo", "driver", "private car", "private vehicle")
FLIGHT_KW = ("flight", "vuelo", "airline")
TRAIN_KW = ("train", "tren", "renfe", "trenitalia", "italo", "ave ", "ave-")
RESTAURANT_KW = ("restaur", "lunch", "dinner", "cena", " menu ", "wine pairing")


def classify(name: str) -> str:
    n = name.lower()
    if any(k in n for k in TRANSFER_KW):
        return "transfer"
    if any(k in n for k in FLIGHT_KW):
        return "vuelo"
    if any(k in n for k in TRAIN_KW):
        return "transporte"
    if any(k in n for k in RESTAURANT_KW):
        return "restaurante"
    if any(k in n for k in HOTEL_KW):
        return "hotel"
    return "actividad"


def tier_from_name(name: str) -> str:
    n = name.lower()
    if any(w in n for w in ("luxury", "deluxe", "5*", "5 star", "5-star")):
        return "luxury"
    if any(w in n for w in ("4*", "4 star", "boutique", "premium")):
        return "upscale"
    return "upscale"


def _num(v: Any):
    if v is None:
        return None
    s = str(v).strip()
    if not s or s.upper() == "NULL":
        return None
    try:
        return float(s.replace(",", "."))
    except ValueError:
        return None


def _pax(r: dict) -> int:
    ad = _num(r.get("AD")) or 0
    ch = _num(r.get("CH")) or 0
    total = int(ad) + int(ch)
    if total <= 0:
        return 2  # default for missing values
    return min(total, 20)  # cap at 20 to filter out corrupted entries


async def main():
    csv_path = sys.argv[1] if len(sys.argv) > 1 else "/app/artifacts/catalog_db/app_operators.csv"
    fp = pathlib.Path(csv_path)
    if not fp.exists():
        print(f"❌ File not found: {csv_path}")
        sys.exit(1)
    env = dotenv_values("/app/backend/.env")
    client = AsyncIOMotorClient(env["MONGO_URL"])
    db = client[env["DB_NAME"]]

    # Wipe experiences (keep providers and hotels — providers will be upserted)
    deleted = await db.experiences.delete_many({})
    print(f"🗑  experiences wiped: {deleted.deleted_count}")

    try:
        text = fp.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        text = fp.read_text(encoding="latin-1")

    rows = list(_csv.DictReader(text.splitlines(), delimiter=";"))
    print(f"📄 rows read: {len(rows)}")

    grouped: dict = defaultdict(lambda: {
        "excl_all": [], "incl_all": [],
        "best_excl": None, "best_incl": None, "best_date": "",
    })
    for r in rows:
        svc = (r.get("Servicio") or "").strip()
        prov = (r.get("Proveedor") or "").strip()
        city_raw = (r.get("Ciudad") or "").strip()
        if not svc or not prov or not city_raw:
            continue
        city = CITY_ALIASES.get(city_raw, city_raw)
        pax = _pax(r)
        key = (svc, prov, city, pax)
        e = _num(r.get("Sin_IVA"))
        i = _num(r.get("Con_IVA"))
        sale_date = (r.get("Fecha_venta") or "").strip()
        bucket = grouped[key]
        if e is not None:
            bucket["excl_all"].append(e)
        if i is not None:
            bucket["incl_all"].append(i)
        if ((i and i > 0) or (e and e > 0)) and sale_date >= bucket["best_date"]:
            bucket["best_date"] = sale_date
            bucket["best_excl"] = e
            bucket["best_incl"] = i

    print(f"🔑 unique (service, provider, city, pax) keys: {len(grouped)}")

    def _median(lst):
        vals = [v for v in lst if v is not None]
        if not vals:
            return 0.0
        s = sorted(vals)
        n = len(s)
        return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2

    provider_cache: dict = {}
    exp_created = 0
    hotels_added = 0
    hotels_skipped = 0
    for (svc, prov_name, city, pax), agg in grouped.items():
        country = CITY_COUNTRY.get(city)
        if prov_name not in provider_cache:
            doc = await db.providers.find_one({"name": prov_name}, {"_id": 0})
            if not doc:
                doc = Provider(name=prov_name, country=country).model_dump()
                await db.providers.insert_one(dict(doc))
            provider_cache[prov_name] = doc
        provider = provider_cache[prov_name]
        price_excl = agg["best_excl"] if agg["best_excl"] is not None else _median(agg["excl_all"])
        price_incl = agg["best_incl"] if agg["best_incl"] is not None else _median(agg["incl_all"])
        if not price_incl:
            price_incl = price_excl
        if not price_excl:
            price_excl = price_incl
        price_excl = round(price_excl or 0.0, 2)
        price_incl = round(price_incl or 0.0, 2)
        if (country or "").strip().lower() not in ("españa", "espana", "spain"):
            price_excl = price_incl

        kind = classify(svc)
        if kind == "hotel":
            existing = await db.hotels.find_one({"name": svc, "city": city}, {"_id": 0})
            if existing:
                hotels_skipped += 1
                continue
            h = Hotel(
                name=svc, city=city, country=country, tier=tier_from_name(svc),
                price_per_night_excl=price_excl, price_per_night_incl=price_incl,
                currency="EUR", contact=prov_name,
                notes=f"Importado del histórico de viajes. Proveedor: {prov_name}",
                source="imported_from_trip",
            )
            await db.hotels.insert_one(h.model_dump())
            hotels_added += 1
        else:
            exp = Experience(
                title=svc, provider_id=provider["provider_id"], provider_name=prov_name,
                country=country, city=city, type=kind,
                price_tax_excl=price_excl, price_tax_incl=price_incl, price=price_incl,
                currency="EUR", pax=pax,
            )
            await db.experiences.insert_one(exp.model_dump())
            exp_created += 1

    final_exp = await db.experiences.count_documents({})
    final_prov = await db.providers.count_documents({})
    final_hot = await db.hotels.count_documents({})
    print(f"✅ experiences created: {exp_created} (db total now: {final_exp})")
    print(f"🏨 hotels added (from trip): {hotels_added} · skipped duplicates: {hotels_skipped} (db total: {final_hot})")
    print(f"🏢 providers cached: {len(provider_cache)} (db total: {final_prov})")
    # Sanity: pax distribution
    pipeline = [{"$group": {"_id": "$pax", "n": {"$sum": 1}}}, {"$sort": {"_id": 1}}]
    print("\nPax distribution after import:")
    async for row in db.experiences.aggregate(pipeline):
        print(f"   pax={row['_id']}: {row['n']}")


if __name__ == "__main__":
    asyncio.run(main())
