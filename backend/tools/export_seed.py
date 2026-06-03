"""Generate a portable seed snapshot of the database.

Output: /app/backend/data/seed.json.gz — a single gzipped JSON file containing
the contents of every operational collection needed to bring a fresh deploy
to feature-parity with this development environment.

What's included
---------------
- providers (hotel/activity vendors)
- experiences (activity catalog)
- hotels (lodging catalog, both 'library' and 'imported_from_trip')
- training_examples (167 sold trips + AI calibration markers)
- allowed_emails (authorised users for production)
- calibration_jobs (job history — kept for context)
- fx_rates (cached EUR↔USD)

What's deliberately EXCLUDED
----------------------------
- itineraries (work in progress — keep prod fresh)
- users / user_sessions (auth state is per-deploy)

Usage:
    cd /app/backend && python -m tools.export_seed
"""
from __future__ import annotations

import asyncio
import gzip
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

SEED_PATH = Path(__file__).resolve().parent.parent / "data" / "seed.json.gz"
SEED_PATH.parent.mkdir(parents=True, exist_ok=True)

COLLECTIONS_TO_EXPORT = [
    "providers",
    "experiences",
    "hotels",
    "training_examples",
    "allowed_emails",
    "calibration_jobs",
    "fx_rates",
]


def _strip_mongo(doc: dict) -> dict:
    """Drop MongoDB's _id since we re-insert by application-level IDs."""
    doc.pop("_id", None)
    return doc


async def main():
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        print("ERR: MONGO_URL or DB_NAME missing")
        sys.exit(1)
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    snapshot: dict = {
        "_meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source_db": db_name,
            "schema_version": 1,
        }
    }
    for coll in COLLECTIONS_TO_EXPORT:
        docs = []
        async for d in db[coll].find({}, {"_id": 0}):
            docs.append(_strip_mongo(d))
        snapshot[coll] = docs
        print(f"  · {coll}: {len(docs)} docs")

    raw = json.dumps(snapshot, default=str, ensure_ascii=False).encode("utf-8")
    with gzip.open(SEED_PATH, "wb", compresslevel=9) as f:
        f.write(raw)
    print(f"\nWritten {SEED_PATH} ({SEED_PATH.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    asyncio.run(main())
