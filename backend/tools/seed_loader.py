"""Auto-seed the database on first deploy.

Strategy: at FastAPI startup we look at each operational collection. If the
collection is empty, we restore its documents from `data/seed.json.gz`.
Collections that already contain any rows are left untouched — re-deploys
or local dev pods never overwrite existing data.

This module is invoked from `server.py` startup_event. It is safe to call
on every boot; it's idempotent.
"""
from __future__ import annotations

import gzip
import json
import logging
from pathlib import Path

logger = logging.getLogger("seed")

SEED_PATH = Path(__file__).resolve().parent.parent / "data" / "seed.json.gz"

# Bulk insert sizes per collection (Mongo's default 16MB doc-batch limit).
_INSERT_CHUNK = 500


async def seed_if_empty(db) -> dict:
    """Restore each collection in the seed snapshot ONLY if it's empty.

    Returns a summary dict {collection: inserted_count}. Skipped collections
    map to 0.
    """
    if not SEED_PATH.exists():
        logger.info("seed: no snapshot at %s, skipping", SEED_PATH)
        return {}
    try:
        with gzip.open(SEED_PATH, "rb") as f:
            snapshot = json.loads(f.read().decode("utf-8"))
    except Exception as e:
        logger.exception("seed: failed to read snapshot")
        return {"_error": str(e)}

    meta = snapshot.pop("_meta", {})
    logger.info("seed: snapshot generated_at=%s", meta.get("generated_at"))
    summary: dict[str, int] = {}
    for coll, docs in snapshot.items():
        if not isinstance(docs, list) or not docs:
            summary[coll] = 0
            continue
        existing = await db[coll].count_documents({}, limit=1)
        if existing > 0:
            logger.info("seed: %s already has rows, skipping (%d in snapshot)", coll, len(docs))
            summary[coll] = 0
            continue
        # Bulk insert in chunks
        inserted = 0
        for i in range(0, len(docs), _INSERT_CHUNK):
            chunk = docs[i: i + _INSERT_CHUNK]
            if chunk:
                await db[coll].insert_many(chunk, ordered=False)
                inserted += len(chunk)
        summary[coll] = inserted
        logger.info("seed: %s ← %d docs inserted", coll, inserted)
    return summary
