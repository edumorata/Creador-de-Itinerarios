"""One-shot migration:
 1. Re-map experiences `type`:
       restaurante → actividad
       transporte  → tren
       otro        → actividad
    (so the new strict taxonomy {alojamiento, actividad, entradas, transfer,
     tren, vuelo, hotel} validates.)
 2. Re-classify experiences for the NEW `entradas` type when the title clearly
    indicates entry tickets only (museums, monuments) and not a guided activity.
 3. Migrate itinerary days/services to the same new taxonomy. Old saved
    itineraries already in the DB get patched in-place.

Usage:  python -m backend.scripts.migrate_service_types
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from dotenv import dotenv_values
from motor.motor_asyncio import AsyncIOMotorClient

sys.path.insert(0, "/app/backend")


# Words that strongly suggest an entry-ticket-only line
TICKET_KEYWORDS = (
    "entradas", "entrance", "tickets only", "ticket only", "skip-the-line tickets",
    "entry only", "general admission",
)


def is_entradas(title: str) -> bool:
    t = (title or "").lower()
    if " tour" in t or "guided" in t or "guide" in t or "visit" in t:
        return False  # guided activities stay as actividad
    return any(k in t for k in TICKET_KEYWORDS)


REMAP = {
    "restaurante": "actividad",
    "transporte": "tren",
    "otro": "actividad",
}


async def main():
    env = dotenv_values("/app/backend/.env")
    client = AsyncIOMotorClient(env["MONGO_URL"])
    db = client[env["DB_NAME"]]

    # ---------- 1) experiences ----------
    total_exp = await db.experiences.count_documents({})
    print(f"experiences total: {total_exp}")
    remap_counts = {}
    for old, new in REMAP.items():
        r = await db.experiences.update_many({"type": old}, {"$set": {"type": new}})
        remap_counts[old] = r.modified_count
        print(f"  {old} → {new}: {r.modified_count}")

    # 2) Re-classify obvious entry-ticket items as 'entradas'
    entradas_n = 0
    cursor = db.experiences.find({"type": "actividad"}, {"experience_id": 1, "title": 1})
    async for doc in cursor:
        if is_entradas(doc.get("title", "")):
            await db.experiences.update_one(
                {"experience_id": doc["experience_id"]}, {"$set": {"type": "entradas"}}
            )
            entradas_n += 1
    print(f"  reclassified as entradas: {entradas_n}")

    # ---------- 3) itineraries (services inside days) ----------
    cursor = db.itineraries.find({}, {"itinerary_id": 1, "days": 1})
    fixed_itn = 0
    fixed_svc = 0
    async for itn in cursor:
        days = itn.get("days") or []
        dirty = False
        for d in days:
            for s in d.get("services", []) or []:
                if s.get("type") in REMAP:
                    s["type"] = REMAP[s["type"]]
                    dirty = True
                    fixed_svc += 1
        if dirty:
            await db.itineraries.update_one(
                {"itinerary_id": itn["itinerary_id"]}, {"$set": {"days": days}}
            )
            fixed_itn += 1
    print(f"itineraries patched: {fixed_itn} · services patched: {fixed_svc}")

    # Final taxonomy snapshot
    print("\nFinal experience type distribution:")
    async for row in db.experiences.aggregate([
        {"$group": {"_id": "$type", "n": {"$sum": 1}}},
        {"$sort": {"n": -1}},
    ]):
        print(f"  {row['_id']:<12}: {row['n']}")


if __name__ == "__main__":
    asyncio.run(main())
