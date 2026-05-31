"""Batch self-evaluation v2 — run AI generator against every sold trip and
record the draft-vs-real deltas to disk.

Why: after adding the 45 business rules (A→AQ) the system prompt has shifted.
We need a fresh pass over the FULL 167-trip dataset to find systematic errors
not yet covered by the existing rules.

Usage:
    cd /app/backend && python -m tests.batch_eval_v2

The script is RESUMABLE: it appends to /app/memory/batch_eval_v2.jsonl and skips
example_ids already evaluated. Safe to Ctrl-C and re-run.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import sys
import time
import traceback
from pathlib import Path
from typing import Any

# Import everything we need from server.py
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import (  # type: ignore
    db,
    SYSTEM_PROMPT_GENERATE,
    _call_claude_json,
    _detect_country,
    _detect_cities,
    _summ_experience,
    _summ_hotel,
    _compact_json,
    _COUNTRY_KEYWORDS,
)
from retrieval import get_retriever  # type: ignore


OUTPUT_PATH = Path("/app/memory/batch_eval_v2.jsonl")
OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

# Allow user to interrupt cleanly.
_STOP = False


def _handle_sigint(*_):
    global _STOP
    _STOP = True
    print("\n[batch_eval] SIGINT received — finishing current trip then stopping.")


signal.signal(signal.SIGINT, _handle_sigint)
signal.signal(signal.SIGTERM, _handle_sigint)


# ---------- Real-itinerary metric extraction ----------

_REAL_FIELDS = {
    "real_pvp_usd": r"Precio final \(\$\)\s*\n\s*([\d,\.]+)",
    "real_cotizado_eur": r"Cotizado Total \(€\)\s*\n\s*([\d,\.]+)",
    "real_cotizado_usd": r"Cotizado Total \(\$\)\s*\n\s*([\d,\.]+)",
    "real_ingresado_usd": r"Ingresado \(\$\)\s*\n\s*([\d,\.]+)",
    "real_alojamientos_eur": r"Total Alojamientos \(€\)\s*\n\s*([\d,\.]+)",
    "real_actividades_eur": r"Total Actividades \(€\)\s*\n\s*([\d,\.]+)",
    "real_margen_pct": r"Margen \(%\)\s*\n\s*([\d,\.]+)",
    "real_margen_usd": r"Margen \(\$\)\s*\n\s*([\d,\.]+)",
}

_SOURCE_RE = re.compile(r"Source\s*\n([A-Za-z][A-Za-z0-9 _\-]{0,40})\s*\n")
_DESTINATION_RE = re.compile(r"Destination\s*\n((?:[A-Za-z][A-Za-z ]{0,40}\s*\n){1,8})Source")


def parse_real_metrics(text: str) -> dict:
    out: dict[str, Any] = {}
    for key, pat in _REAL_FIELDS.items():
        m = re.search(pat, text)
        if m:
            try:
                out[key] = float(m.group(1).replace(",", ""))
            except Exception:
                out[key] = None
        else:
            out[key] = None
    # Source detection: the gestion page lists ALL sources; the active one is
    # the one with a checkmark, but since the scraped text loses that style,
    # we infer source by looking for unique tokens elsewhere in the text.
    # Fallback: leave None.
    m = _SOURCE_RE.search(text)
    if m:
        out["real_source_first"] = m.group(1).strip()
    else:
        out["real_source_first"] = None
    return out


def structured_metrics(ops: dict | None) -> dict:
    if not ops or not isinstance(ops, dict):
        return {"real_num_days": 0, "real_activities": 0, "real_hotels": 0,
                "real_cities": [], "real_hotel_names": []}
    days = ops.get("days") or []
    activities = 0
    cities: list[str] = []
    hotel_names: list[str] = []
    for d in days:
        for a in d.get("activities") or []:
            # Don't count transfers as activities (they are logistics).
            n = (a.get("name") or "").lower()
            if "transfer" in n or "airport" in n and "tour" not in n:
                continue
            activities += 1
        for h in d.get("hotels") or []:
            nm = (h.get("name") or "").strip()
            if nm and nm not in hotel_names:
                hotel_names.append(nm)
        c = (d.get("city") or "").strip()
        if c and c not in cities:
            cities.append(c)
    return {
        "real_num_days": len(days),
        "real_activities": activities,
        "real_hotels": len(hotel_names),
        "real_cities": cities,
        "real_hotel_names": hotel_names,
    }


# ---------- Draft generation (mirrors ai_generate without auth) ----------

async def generate_draft(request_text: str, exclude_id: str) -> dict:
    """Reproduce the prompt-build of /api/ai/generate-itinerary then call Claude."""
    country = _detect_country(request_text)
    cities = _detect_cities(request_text, country)

    exp_flt: dict = {}
    if country:
        exp_flt["country"] = country
    if cities:
        city_exps = await db.experiences.find({**exp_flt, "city": {"$in": cities}}, {"_id": 0}).limit(80).to_list(80)
    else:
        city_exps = []
    rest_exps = await db.experiences.find(exp_flt, {"_id": 0}).limit(150).to_list(150)
    seen = {e["experience_id"] for e in city_exps}
    exps = list(city_exps)
    for e in rest_exps:
        if e["experience_id"] not in seen:
            exps.append(e)
            if len(exps) >= 120:
                break
    if len(exps) < 20:
        more = await db.experiences.find({}, {"_id": 0}).limit(60).to_list(60)
        seen = {e["experience_id"] for e in exps}
        for e in more:
            if e["experience_id"] not in seen:
                exps.append(e)
                if len(exps) >= 80:
                    break

    hotel_flt: dict = {}
    if country:
        hotel_flt["country"] = country
    if cities:
        city_hotels = await db.hotels.find({**hotel_flt, "city": {"$in": cities}}, {"_id": 0}).limit(60).to_list(60)
    else:
        city_hotels = []
    rest_hotels = await db.hotels.find(hotel_flt, {"_id": 0}).limit(80).to_list(80)
    seen_h = {h.get("hotel_id") for h in city_hotels}
    hotels = list(city_hotels)
    for h in rest_hotels:
        if h.get("hotel_id") not in seen_h:
            hotels.append(h)
            if len(hotels) >= 80:
                break
    if len(hotels) < 10:
        more_h = await db.hotels.find({}, {"_id": 0}).limit(60).to_list(60)
        seen_h = {h.get("hotel_id") for h in hotels}
        for h in more_h:
            if h.get("hotel_id") not in seen_h:
                hotels.append(h)
                if len(hotels) >= 40:
                    break

    retriever = await get_retriever(db)
    sold = retriever.top_k(request_text, k=5, prefer_outcomes=["sold"], min_score=0.05)
    not_sold = retriever.top_k(request_text, k=2, prefer_outcomes=["not_sold"], min_score=0.05)
    examples = [e for e in (sold + not_sold) if e.get("example_id") != exclude_id]
    if country:
        country_kws = {k.lower() for k in _COUNTRY_KEYWORDS.get(country, [])}
        filtered = [
            ex for ex in examples
            if any(k in (ex.get("client_request") or "").lower() for k in country_kws)
        ]
        if len(filtered) >= 2:
            examples = filtered
    if not examples:
        examples = await db.training_examples.find(
            {"outcome": {"$in": ["sold", "not_sold"]}, "client_request": {"$nin": [None, ""]},
             "example_id": {"$ne": exclude_id}},
            {"_id": 0},
        ).sort("created_at", -1).limit(5).to_list(5)

    user_prompt_parts = [
        f"NEW CLIENT REQUEST:\n{request_text}",
        "",
        (
            f"DETECTED CONTEXT — country={country or 'unknown'} · cities={', '.join(cities) if cities else 'none'}.\n"
            f"All library items and past examples below are PRE-FILTERED to this destination."
        ),
        "",
        "EXPERIENCE LIBRARY (pick from these whenever possible):",
        _compact_json([_summ_experience(e) for e in exps]),
        "",
        "HOTEL LIBRARY (pick from these for accommodations):",
        _compact_json([_summ_hotel(h) for h in hotels]),
        "",
    ]
    if examples:
        user_prompt_parts.append(
            "PAST EXAMPLES (semantically similar, learn from these patterns)."
        )
        for ex in examples:
            client_struct = ex.get("itinerary_structured")
            ops_struct = ex.get("itinerary_structured_ops")
            blocks = []
            if client_struct and isinstance(client_struct, dict) and client_struct.get("days"):
                blocks.append(f"CLIENT-FACING ITINERARY (Travefy):\n{_compact_json(client_struct)}")
            if ops_struct and isinstance(ops_struct, dict) and ops_struct.get("days"):
                blocks.append(f"INTERNAL OPS VIEW (providers + real margins):\n{_compact_json(ops_struct)}")
            if not blocks and ex.get("itinerary_text_ops"):
                blocks.append(f"INTERNAL OPS VIEW (raw, truncated):\n{ex['itinerary_text_ops'][:1200]}")
            elif not blocks and ex.get("itinerary_text"):
                blocks.append(f"CLIENT ITINERARY (raw, truncated):\n{ex['itinerary_text'][:1200]}")
            if not blocks:
                continue
            score = ex.get("_score")
            score_tag = f" similarity={score:.2f}" if isinstance(score, (int, float)) else ""
            user_prompt_parts.append(
                f"--- outcome={ex['outcome']}{score_tag} ---\n"
                f"CLIENT REQUEST:\n{ex['client_request'][:1000]}\n\n"
                + "\n\n".join(blocks)
            )
    user_prompt_parts.append("\nNow produce ONLY the JSON itinerary for the NEW CLIENT REQUEST above.")

    data = await _call_claude_json(SYSTEM_PROMPT_GENERATE, "\n".join(user_prompt_parts))
    return {
        "draft": data,
        "country": country,
        "cities_detected": cities,
        "examples_in_context": len(examples),
        "experiences_in_context": len(exps),
        "hotels_in_context": len(hotels),
    }


def draft_metrics(draft: dict, num_travelers: int) -> dict:
    days = draft.get("days") or []
    accs = draft.get("accommodations") or []
    activities = 0
    free_form_act = 0
    hotel_names = []
    cities = []
    activities_subtotal_eur = 0.0
    transfers_subtotal_eur = 0.0
    for d in days:
        c = (d.get("city") or "").strip()
        if c and c not in cities:
            cities.append(c)
        for s in d.get("services") or []:
            stype = (s.get("type") or "").lower()
            qty = float(s.get("quantity") or 1)
            price = float(s.get("unit_price_tax_incl") or 0)
            if stype in ("transfer", "transporte", "vuelo"):
                transfers_subtotal_eur += price * qty
            else:
                activities += 1
                activities_subtotal_eur += price * qty
                if not s.get("experience_id"):
                    free_form_act += 1
    hotels_subtotal_eur = 0.0
    free_form_hotels = 0
    zero_price_hotels = 0
    for a in accs:
        name = (a.get("name") or "").strip()
        if name and name not in hotel_names:
            hotel_names.append(name)
        price = float(a.get("price_tax_incl") or 0)
        hotels_subtotal_eur += price
        if not a.get("hotel_id"):
            free_form_hotels += 1
        if price == 0:
            zero_price_hotels += 1
    draft_pvp_eur = (activities_subtotal_eur + transfers_subtotal_eur + hotels_subtotal_eur)
    # Apply markup
    mkp = float(draft.get("markup_pct") or 15)
    draft_pvp_with_markup = draft_pvp_eur * (1.0 + mkp / 100.0)
    return {
        "draft_num_days": len(days),
        "draft_activities": activities,
        "draft_free_form_activities": free_form_act,
        "draft_hotels": len(hotel_names),
        "draft_free_form_hotels": free_form_hotels,
        "draft_zero_price_hotels": zero_price_hotels,
        "draft_cities": cities,
        "draft_hotel_names": hotel_names,
        "draft_activities_subtotal_eur": round(activities_subtotal_eur, 2),
        "draft_transfers_subtotal_eur": round(transfers_subtotal_eur, 2),
        "draft_hotels_subtotal_eur": round(hotels_subtotal_eur, 2),
        "draft_pvp_eur_pre_markup": round(draft_pvp_eur, 2),
        "draft_pvp_eur_with_markup": round(draft_pvp_with_markup, 2),
        "draft_markup_pct": mkp,
        "draft_num_travelers": draft.get("num_travelers") or num_travelers,
    }


async def main():
    # Skip docs already evaluated in this prompt-revision.
    # The DB marker `last_learned_at` is the source of truth; the JSONL is a
    # secondary safety net so the run survives a wipe of the marker.
    done: set[str] = set()
    if OUTPUT_PATH.exists():
        with OUTPUT_PATH.open("r", encoding="utf-8") as f:
            for ln in f:
                try:
                    r = json.loads(ln)
                    if r.get("example_id") and not r.get("error"):
                        done.add(r["example_id"])
                except Exception:
                    continue
    db_done = {
        d["example_id"] async for d in db.training_examples.find(
            {"last_learned_at": {"$exists": True}}, {"example_id": 1, "_id": 0}
        )
    }
    done |= db_done
    print(f"[batch_eval] {len(done)} trips already processed (will be skipped)  "
          f"[file={len(done) - len(db_done)} db={len(db_done)}]")

    docs = await db.training_examples.find(
        {"outcome": "sold", "client_request": {"$nin": [None, ""]}},
        {"_id": 0},
    ).sort("created_at", 1).to_list(500)
    todo = [d for d in docs if d.get("example_id") not in done]
    print(f"[batch_eval] {len(todo)} trips remaining out of {len(docs)} total sold-with-request")

    t0 = time.time()
    ok = 0
    fail = 0

    with OUTPUT_PATH.open("a", encoding="utf-8") as out:
        for i, doc in enumerate(todo, start=1):
            if _STOP:
                print("[batch_eval] stop requested — exiting loop.")
                break
            eid = doc["example_id"]
            req = doc.get("client_request") or ""
            try:
                t_start = time.time()
                res = await generate_draft(req, eid)
                draft = res["draft"]
                # Number of travelers fallback
                num_pax = doc.get("itinerary_structured_ops", {}).get("num_travelers") or 2
                dm = draft_metrics(draft, num_pax)
                rm_struct = structured_metrics(doc.get("itinerary_structured_ops"))
                rm_real = parse_real_metrics(doc.get("itinerary_text_ops") or "")
                # Compute a few comparable values
                # USD↔EUR (use approx 1.20 if cotizado USD and EUR both present)
                cot_eur = rm_real.get("real_cotizado_eur") or 0.0
                cot_usd = rm_real.get("real_cotizado_usd") or 0.0
                eur_to_usd = (cot_usd / cot_eur) if cot_eur and cot_usd else 1.10
                real_pvp_eur = (rm_real.get("real_pvp_usd") or 0.0) / eur_to_usd if eur_to_usd else 0.0
                ratio = None
                if real_pvp_eur > 0 and dm["draft_pvp_eur_with_markup"] > 0:
                    ratio = dm["draft_pvp_eur_with_markup"] / real_pvp_eur

                row = {
                    "example_id": eid,
                    "client_name": doc.get("client_name") or "",
                    "sales_agent": doc.get("sales_agent") or "",
                    "country": res["country"],
                    "cities_detected": res["cities_detected"],
                    "num_travelers": num_pax,
                    "duration_seconds": round(time.time() - t_start, 1),
                    "real_pvp_eur": round(real_pvp_eur, 2),
                    **rm_real,
                    **rm_struct,
                    **dm,
                    "ratio_draft_over_real": round(ratio, 3) if ratio else None,
                    "examples_in_context": res["examples_in_context"],
                    "experiences_in_context": res["experiences_in_context"],
                    "hotels_in_context": res["hotels_in_context"],
                    "draft_summary": (draft.get("summary") or "")[:300],
                }
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
                out.flush()
                # Mark the trip as analysed so future runs skip it.
                from datetime import datetime, timezone as _tz
                await db.training_examples.update_one(
                    {"example_id": eid},
                    {"$set": {
                        "last_learned_at": datetime.now(_tz.utc).isoformat(),
                        "last_eval_ratio": ratio,
                        "last_eval_country": res["country"],
                    }},
                )
                ok += 1
                elapsed = time.time() - t0
                avg = elapsed / max(ok + fail, 1)
                eta_min = (len(todo) - (ok + fail)) * avg / 60.0
                print(f"[{i}/{len(todo)}] OK {eid} country={res['country']} pax={num_pax} "
                      f"draft={dm['draft_pvp_eur_with_markup']}€ real={round(real_pvp_eur,0)}€ "
                      f"ratio={ratio and round(ratio,2)} "
                      f"act={dm['draft_activities']}/{rm_struct['real_activities']} "
                      f"hot={dm['draft_hotels']}/{rm_struct['real_hotels']} "
                      f"({row['duration_seconds']}s, ETA {eta_min:.1f}m)")
            except KeyboardInterrupt:
                print("[batch_eval] keyboard interrupt — exiting.")
                break
            except Exception as e:
                fail += 1
                out.write(json.dumps({"example_id": eid, "error": str(e)[:300]},
                                     ensure_ascii=False) + "\n")
                out.flush()
                print(f"[{i}/{len(todo)}] FAIL {eid}: {e}")
                # Brief pause to avoid hammering the LLM in case of rate limit.
                await asyncio.sleep(2)
    print(f"\n[batch_eval] DONE — ok={ok} fail={fail} elapsed={(time.time()-t0)/60:.1f}m")


if __name__ == "__main__":
    asyncio.run(main())
