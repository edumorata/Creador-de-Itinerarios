import React, { useCallback, useEffect, useRef, useState } from "react";
import api from "@/lib/api";
import { TYPE_BADGE, BADGE_FALLBACK, fmtEUR } from "./utils";

export function AutocompleteInput({ value, dayCity, serviceType, pax, onTextChange, onPick }) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState([]);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef(null);
  const timer = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const search = useCallback(async (text) => {
    const t = (text || "").trim();
    // Multiple cities supported via comma: "Sorrento, Positano" → two parallel
    // queries merged and de-duplicated. An empty `dayCity` means "no filter".
    const cities = (dayCity || "")
      .split(",").map((c) => c.trim()).filter(Boolean);
    if (t.length < 3 && cities.length === 0 && !serviceType) { setResults([]); return; }
    const baseParams = {};
    if (t) baseParams.q = t;
    if (serviceType) baseParams.type = serviceType;
    if (pax) baseParams.pax = pax;
    try {
      let data = [];
      if (cities.length === 0) {
        const r = await api.get("/experiences/autocomplete", { params: baseParams });
        data = r.data;
      } else {
        const responses = await Promise.all(
          cities.map((c) => api.get("/experiences/autocomplete", { params: { ...baseParams, city: c } }))
        );
        const seen = new Set();
        for (const r of responses) {
          for (const it of r.data) {
            if (!seen.has(it.experience_id)) {
              seen.add(it.experience_id); data.push(it);
            }
          }
        }
      }
      setResults(data); setHighlight(0);
    } catch (_e) { setResults([]); }
  }, [dayCity, serviceType, pax]);

  // Auto-refresh dropdown when user changes type or city pre-filter while it's open
  useEffect(() => {
    if (open) search(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceType, dayCity, pax]);

  const handleChange = (e) => {
    const v = e.target.value;
    onTextChange(v);
    setOpen(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => search(v), 220);
  };

  const handleKey = (e) => {
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && results[highlight]) { e.preventDefault(); onPick(results[highlight]); setOpen(false); }
    else if (e.key === "Escape") { setOpen(false); }
  };

  return (
    <div ref={wrapRef} className="relative">
      <input
        data-testid="svc-name-input"
        className="w-full bg-transparent outline-none font-semibold"
        value={value}
        onChange={handleChange}
        onFocus={() => { setOpen(true); search(value); }}
        onKeyDown={handleKey}
        placeholder={dayCity ? `Buscar en ${dayCity}…` : "3+ letras para sugerencias…"}
      />
      {open && results.length > 0 && (
        <div className="absolute left-0 top-full mt-1 z-40 bg-white border border-clay-300 shadow-lg max-h-80 overflow-auto w-[560px] max-w-[90vw]" data-testid="svc-autocomplete">
          {results.map((r, i) => {
            const total = r.price_tax_incl ?? r.price ?? 0;
            const perPax = (r.pax || 1) > 0 ? total / r.pax : total;
            return (
            <button
              key={r.experience_id}
              data-testid={`ac-${r.experience_id}`}
              onClick={() => { onPick(r); setOpen(false); }}
              onMouseEnter={() => setHighlight(i)}
              className={`w-full text-left px-3 py-2 text-sm border-b border-clay-200 last:border-0 ${i === highlight ? "bg-terracotta/10" : "hover:bg-clay-50"}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{r.title}</div>
                  <div className="text-[11px] text-clay-700">{r.provider_name} · {[r.city, r.country].filter(Boolean).join(" · ")}</div>
                </div>
                <div className="text-right shrink-0 text-xs">
                  <div className="tabular font-semibold">{fmtEUR(perPax)} <span className="text-[10px] font-normal text-clay-700">/pax</span></div>
                  <div className="text-[10px] text-clay-700 tabular">
                    total {fmtEUR(total)} · <span className={pax && (r.pax || 2) !== pax ? "text-amber-700 font-semibold" : ""}>{r.pax || 2} pax</span>
                  </div>
                  <span className={`inline-block mt-0.5 px-1 py-0.5 text-[8px] tracking-widest uppercase ${TYPE_BADGE[r.type] || BADGE_FALLBACK}`}>{r.type}</span>
                </div>
              </div>
            </button>
          );})}
        </div>
      )}
    </div>
  );
}
