import React, { useCallback, useEffect, useRef, useState } from "react";
import api from "@/lib/api";

export function HotelAutocomplete({ value, onTextChange, onPick, placeholder = "Buscar hotel…" }) {
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
    if (t.length < 2) { setResults([]); return; }
    try {
      const lib = await api.get("/hotels", { params: { q: t } });
      const combined = (lib.data || []).slice(0, 20);
      if (combined.length < 8) {
        const imp = await api.get("/hotels", { params: { q: t, include_imported: true } });
        const have = new Set(combined.map((h) => h.hotel_id));
        for (const h of imp.data || []) {
          if (!have.has(h.hotel_id) && h.source === "imported_from_trip") {
            combined.push(h);
            if (combined.length >= 12) break;
          }
        }
      }
      setResults(combined);
      setHighlight(0);
    } catch (_e) {
      setResults([]);
    }
  }, []);

  const handleChange = (e) => {
    const v = e.target.value;
    onTextChange(v);
    setOpen(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => search(v), 200);
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
        data-testid="hotel-name-input"
        className="w-full bg-transparent outline-none font-semibold"
        value={value}
        onChange={handleChange}
        onFocus={() => { setOpen(true); search(value); }}
        onKeyDown={handleKey}
        placeholder={placeholder}
      />
      {open && results.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-40 bg-white border border-clay-300 shadow-lg max-h-72 overflow-auto" data-testid="hotel-autocomplete">
          {results.map((h, i) => (
            <button
              key={h.hotel_id}
              data-testid={`hotel-ac-${h.hotel_id}`}
              onClick={() => { onPick(h); setOpen(false); }}
              onMouseEnter={() => setHighlight(i)}
              className={`w-full text-left px-3 py-2 text-sm border-b border-clay-200 last:border-0 ${i === highlight ? "bg-terracotta/10" : "hover:bg-clay-50"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold truncate">{h.name}</div>
                  <div className="text-[11px] text-clay-700 truncate">{[h.city, h.country, h.tier].filter(Boolean).join(" · ")}</div>
                </div>
                <div className="text-right text-xs tabular text-clay-700">
                  {h.price_per_night_incl ? `${Math.round(h.price_per_night_incl)}€/n` : "—"}
                  {h.source === "imported_from_trip" && <div className="text-[9px] text-clay-500 uppercase">histórico</div>}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
