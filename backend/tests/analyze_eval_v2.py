"""Analyse the batch_eval_v2 results to surface systematic patterns.

Reads /app/memory/batch_eval_v2.jsonl and produces:
- Global metrics (median/mean/stdev ratios, error distributions)
- Country-stratified deltas
- Per-sales-agent deltas
- Top systematic errors (city mismatch, hotel over/under, activity over-program)
- Suggested new prompt rules backed by examples

Outputs both a Markdown report (/app/memory/batch_eval_v2_report.md) and a
JSON summary (/app/memory/batch_eval_v2_summary.json).
"""
from __future__ import annotations
import json
import statistics
from collections import Counter, defaultdict
from pathlib import Path


INP = Path("/app/memory/batch_eval_v2.jsonl")
REPORT = Path("/app/memory/batch_eval_v2_report.md")
SUMMARY = Path("/app/memory/batch_eval_v2_summary.json")


def load() -> list[dict]:
    rows: list[dict] = []
    with INP.open("r", encoding="utf-8") as f:
        for ln in f:
            try:
                r = json.loads(ln)
                if not r.get("error"):
                    rows.append(r)
            except Exception:
                continue
    return rows


def stats(values):
    vs = [v for v in values if isinstance(v, (int, float)) and v > 0]
    if not vs:
        return None
    vs.sort()
    return {
        "n": len(vs),
        "min": round(min(vs), 3),
        "max": round(max(vs), 3),
        "median": round(statistics.median(vs), 3),
        "mean": round(statistics.mean(vs), 3),
        "stdev": round(statistics.pstdev(vs), 3) if len(vs) > 1 else 0,
        "p10": round(vs[max(0, int(len(vs)*0.1)-1)], 3),
        "p90": round(vs[min(len(vs)-1, int(len(vs)*0.9))], 3),
    }


def main():
    rows = load()
    print(f"Loaded {len(rows)} evaluated rows.")
    if not rows:
        return

    # ----- Global -----
    ratios = [r.get("ratio_draft_over_real") for r in rows]
    summary = {"total": len(rows), "ratio_global": stats(ratios)}

    # ----- By country -----
    by_country = defaultdict(list)
    for r in rows:
        by_country[r.get("country") or "unknown"].append(r)
    country_stats = {}
    for c, lst in by_country.items():
        country_stats[c] = {
            "n": len(lst),
            "ratio": stats([r.get("ratio_draft_over_real") for r in lst]),
            "activity_ratio": stats([
                (r.get("draft_activities") or 0) / max(1, (r.get("real_activities") or 1))
                for r in lst if (r.get("real_activities") or 0) > 0
            ]),
            "hotel_diff": stats([
                (r.get("draft_hotels") or 0) - (r.get("real_hotels") or 0)
                for r in lst
            ]),
        }
    summary["by_country"] = country_stats

    # ----- By sales agent -----
    by_agent = defaultdict(list)
    for r in rows:
        by_agent[r.get("sales_agent") or "unknown"].append(r)
    agent_stats = {}
    for a, lst in by_agent.items():
        if len(lst) < 3:
            continue
        agent_stats[a] = {
            "n": len(lst),
            "ratio": stats([r.get("ratio_draft_over_real") for r in lst]),
        }
    summary["by_sales_agent"] = agent_stats

    # ----- Error buckets -----
    severe_over = [r for r in rows if (r.get("ratio_draft_over_real") or 0) > 1.5]
    severe_under = [r for r in rows if 0 < (r.get("ratio_draft_over_real") or 0) < 0.7]
    big_hotel_diff = [r for r in rows if abs(
        (r.get("draft_hotels_subtotal_eur") or 0) - (r.get("real_alojamientos_eur") or 0)
    ) > 3000 and (r.get("real_alojamientos_eur") or 0) > 0]
    activity_over = [r for r in rows if (r.get("draft_activities") or 0) - (r.get("real_activities") or 0) > 3]
    activity_under = [r for r in rows if (r.get("real_activities") or 0) - (r.get("draft_activities") or 0) > 3]

    # ----- City mismatch -----
    city_mismatch = []
    for r in rows:
        real_set = set(c.lower() for c in (r.get("real_cities") or []))
        draft_set = set(c.lower() for c in (r.get("draft_cities") or []))
        if real_set and draft_set:
            overlap = real_set & draft_set
            if not overlap:
                city_mismatch.append({
                    "id": r["example_id"], "agent": r.get("sales_agent"),
                    "country": r.get("country"),
                    "real_cities": r.get("real_cities"),
                    "draft_cities": r.get("draft_cities"),
                    "ratio": r.get("ratio_draft_over_real"),
                })

    summary["error_buckets"] = {
        "severe_over_quote_>1.5x": len(severe_over),
        "severe_under_quote_<0.7x": len(severe_under),
        "big_hotel_diff_>3000eur": len(big_hotel_diff),
        "activity_over_+3": len(activity_over),
        "activity_under_-3": len(activity_under),
        "zero_city_overlap": len(city_mismatch),
    }
    summary["city_mismatch_examples"] = city_mismatch[:25]

    # Top free-form hotels (when free-form > library)
    free_form_hotels = [r for r in rows if (r.get("draft_free_form_hotels") or 0) > 0]
    summary["draft_uses_free_form_hotels"] = len(free_form_hotels)

    # Hotels subtotal vs Total Alojamientos
    hotels_compare = []
    for r in rows:
        ra = r.get("real_alojamientos_eur")
        da = r.get("draft_hotels_subtotal_eur")
        if ra is None or da is None:
            continue
        diff = da - ra
        if ra > 0:
            ratio = da / ra
        else:
            ratio = None
        hotels_compare.append({"id": r["example_id"], "real": ra, "draft": da, "diff": diff, "ratio": ratio})
    if hotels_compare:
        valid = [h for h in hotels_compare if h["ratio"] is not None and h["real"] > 100]
        valid.sort(key=lambda x: x["ratio"] or 0, reverse=True)
        summary["worst_hotel_overshoots"] = valid[:15]
        summary["worst_hotel_undershoots"] = valid[-15:]

    # Activities subtotal vs Total Actividades
    act_compare = []
    for r in rows:
        ra = r.get("real_actividades_eur")
        da = r.get("draft_activities_subtotal_eur")
        if ra is None or da is None:
            continue
        if ra > 100:
            act_compare.append({"id": r["example_id"], "real": ra, "draft": da, "ratio": da/ra})
    if act_compare:
        summary["activities_eur_ratio"] = stats([x["ratio"] for x in act_compare])

    SUMMARY.write_text(json.dumps(summary, indent=2, ensure_ascii=False, default=str))

    # ----- Render Markdown report -----
    lines = []
    lines.append(f"# Batch Eval v2 — {len(rows)} sold trips analysed\n")
    lines.append("## Global PVP ratio (draft / real)\n")
    lines.append("```\n" + json.dumps(summary["ratio_global"], indent=2) + "\n```\n")
    lines.append("## By country\n")
    for c, s in sorted(country_stats.items(), key=lambda x: -x[1]["n"]):
        lines.append(f"- **{c}** (n={s['n']}): ratio median={s['ratio']['median'] if s['ratio'] else 'n/a'} · mean={s['ratio']['mean'] if s['ratio'] else 'n/a'} · activities {s['activity_ratio']['median'] if s['activity_ratio'] else 'n/a'}x · hotel-diff median {s['hotel_diff']['median'] if s['hotel_diff'] else 'n/a'}")
    lines.append("\n## By sales agent\n")
    for a, s in sorted(agent_stats.items(), key=lambda x: -x[1]["n"]):
        if s["ratio"]:
            lines.append(f"- **{a}** (n={s['n']}): median ratio={s['ratio']['median']} · mean={s['ratio']['mean']}")
    lines.append("\n## Error buckets\n")
    for k, v in summary["error_buckets"].items():
        lines.append(f"- {k}: {v}")
    if "activities_eur_ratio" in summary:
        lines.append("\n## Activities subtotal (draft€ / real€)\n")
        lines.append("```\n" + json.dumps(summary["activities_eur_ratio"], indent=2) + "\n```\n")
    lines.append("\n## Worst hotel overshoots (draft >> real)\n")
    for h in summary.get("worst_hotel_overshoots", [])[:10]:
        lines.append(f"- {h['id']}: draft {h['draft']}€ vs real {h['real']}€ → ratio {h['ratio']:.2f}x")
    lines.append("\n## Worst hotel undershoots (draft << real)\n")
    for h in summary.get("worst_hotel_undershoots", [])[:10]:
        lines.append(f"- {h['id']}: draft {h['draft']}€ vs real {h['real']}€ → ratio {h['ratio']:.2f}x")
    lines.append("\n## Zero city overlap (draft picked completely different cities)\n")
    for m in summary["city_mismatch_examples"][:15]:
        lines.append(f"- {m['id']} ({m['country']}, {m['agent']}): real={m['real_cities']} · draft={m['draft_cities']}")

    REPORT.write_text("\n".join(lines))
    print(f"Report → {REPORT}")
    print(f"Summary → {SUMMARY}")


if __name__ == "__main__":
    main()
