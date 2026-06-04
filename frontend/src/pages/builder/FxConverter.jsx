import React, { useState } from "react";
import api from "@/lib/api";
import { fmtUSD } from "./utils";

// FX converter — shows the EUR totals in USD using the daily ECB rate fetched
// from /api/fx/rate. The rate is editable; "auto" resets it to the cached one.
export function FxConverter({ fx, setFx, totals }) {
  const [busy, setBusy] = useState(false);
  const onChangeRate = (v) => {
    const n = parseFloat(v);
    if (Number.isFinite(n) && n > 0) setFx((prev) => ({ ...prev, rate: n, source: "manual" }));
  };
  const reload = async () => {
    setBusy(true);
    try {
      const { data } = await api.get("/fx/rate", { params: { refresh: true } });
      if (data?.rate) setFx({ rate: Number(data.rate), source: data.source, date: data.date });
    } catch (_e) {
      // FX refresh is best-effort; we keep showing the previously cached rate.
    } finally {
      setBusy(false);
    }
  };
  const pvpUsd = (totals.pvp || 0) * (fx.rate || 0);
  const sourceLabel = fx.source === "fresh" ? "ECB (hoy)"
    : fx.source === "cache" ? "ECB (cache)"
    : fx.source === "stale" ? "ECB (último guardado)"
    : fx.source === "manual" ? "Manual"
    : fx.source === "fallback" ? "Fallback 1.10" : "Cargando…";
  return (
    <div className="mt-3 border border-clay-300 bg-clay-50/50 p-3" data-testid="fx-converter">
      <div className="flex items-center justify-between text-[11px] text-clay-700 mb-2">
        <span className="smallcaps">Conversión EUR → USD</span>
        <span className="text-clay-600">{sourceLabel}{fx.date ? ` · ${fx.date}` : ""}</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs text-clay-700">1 € =</span>
        <input
          data-testid="fx-rate-input"
          type="number"
          step="0.0001"
          min="0.1"
          max="10"
          value={Number(fx.rate || 0).toFixed(4)}
          onChange={(e) => onChangeRate(e.target.value)}
          className="w-24 bg-white border border-clay-300 px-1 py-0.5 text-sm tabular text-right"
        />
        <span className="text-xs text-clay-700">USD</span>
        <button
          data-testid="fx-refresh"
          onClick={reload}
          disabled={busy}
          className="ml-auto text-[10px] uppercase tracking-wider border border-clay-400 px-2 py-1 hover:bg-clay-900 hover:text-white transition disabled:opacity-50"
          title="Refrescar cambio del día"
        >
          {busy ? "…" : "Auto"}
        </button>
      </div>
      <div className="flex items-center justify-between py-2 bg-pine text-white px-3" data-testid="pvp-usd">
        <div className="smallcaps text-white/70">PVP en USD</div>
        <div className="font-serif text-2xl tabular">{fmtUSD(pvpUsd)}</div>
      </div>
    </div>
  );
}
