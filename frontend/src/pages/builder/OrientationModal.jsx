import React from "react";
import { ExternalLink } from "lucide-react";

export function OrientationModal({ city, hotelName, checkin, checkout, adults, busy, data, onClose, onApply }) {
  const rec = data?.recommendation;
  const td = data?.training_data;
  const ex = data?.expedia;

  // Open Expedia.es with the hotel name as destination + check-in/out dates.
  // We add `searchType=HOTEL` so Expedia treats the destination string as a
  // property-name lookup (not a city). Combined with the comma-separated
  // "Hotel, City" format, this lands on the specific hotel page in most cases.
  // When the hotel is not in Expedia's inventory, it falls back to the city
  // SERP — still useful for the agent to verify a price.
  const expediaUrl = (() => {
    const destStr = hotelName?.trim()
      ? `${hotelName.trim()}${city ? `, ${city}` : ""}`
      : (city || "");
    const params = new URLSearchParams({
      destination: destStr,
      adults: String(adults || 2),
      searchType: "HOTEL",
    });
    if (checkin) params.set("startDate", checkin);
    if (checkout) params.set("endDate", checkout);
    return `https://www.expedia.es/Hotel-Search?${params.toString()}`;
  })();

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose} data-testid="orient-modal">
      <div className="bg-white border border-clay-300 max-w-xl w-full p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="smallcaps">Precio orientativo</div>
            <div className="font-serif text-xl">{hotelName || city}</div>
            {hotelName && city && <div className="text-xs text-clay-700">{city}</div>}
          </div>
          <button onClick={onClose} className="text-clay-500 hover:text-clay-900">✕</button>
        </div>
        {busy && <div className="py-8 text-center text-sm text-clay-700">Consultando histórico y Expedia…</div>}
        {!busy && rec && rec.price_per_night_eur && (
          <div className="border border-pine bg-pine/5 p-4 mb-3">
            <div className="text-xs text-clay-700 uppercase tracking-wider mb-1">Recomendación · {rec.source === "training_data" ? "Histórico" : rec.source === "expedia" ? "Expedia" : "—"}</div>
            <div className="flex items-baseline gap-2">
              <div className="font-serif text-3xl tabular">€ {rec.price_per_night_eur}</div>
              <div className="text-sm text-clay-700">/ noche</div>
              <div className="ml-auto text-xs text-clay-700">Confianza: {rec.confidence}</div>
            </div>
            <div className="text-xs text-clay-700 mt-2">{rec.rationale}</div>
            <button
              data-testid="apply-orient"
              onClick={() => onApply(rec.price_per_night_eur)}
              className="mt-3 px-3 py-1.5 text-xs uppercase tracking-wider bg-pine text-white hover:bg-clay-900"
            >Aplicar a este alojamiento</button>
          </div>
        )}
        {!busy && td && (
          <div className="border border-clay-300 p-3 mb-3 text-sm">
            <div className="smallcaps mb-1">Histórico ({td.n_trips} viajes vendidos en {city})</div>
            <div className="grid grid-cols-3 text-center gap-2">
              <div><div className="text-[10px] uppercase text-clay-700">p25</div><div className="tabular font-semibold">€ {td.p25_eur}</div></div>
              <div><div className="text-[10px] uppercase text-clay-700">mediana</div><div className="tabular font-bold text-terracotta">€ {td.median_price_per_night_eur}</div></div>
              <div><div className="text-[10px] uppercase text-clay-700">p75</div><div className="tabular font-semibold">€ {td.p75_eur}</div></div>
            </div>
            {td.sample_hotels && td.sample_hotels.length > 0 && (
              <div className="mt-3 text-xs text-clay-700">
                <div className="smallcaps mb-1">Hoteles vistos en histórico</div>
                <div className="flex flex-wrap gap-1">
                  {td.sample_hotels.slice(0,8).map((h) => (<span key={h.name} className="px-2 py-0.5 bg-clay-100 border border-clay-300">{h.name}</span>))}
                </div>
              </div>
            )}
          </div>
        )}
        {!busy && ex && (
          <div className="border border-clay-300 p-3 text-xs">
            <div className="smallcaps mb-1">Expedia.es {ex.blocked ? "(bloqueado por anti-bot)" : (ex.ok ? "" : "(sin resultados)")}</div>
            {ex.ok && (ex.results || []).slice(0,4).map((h) => (
              <div key={h.name} className="flex items-center justify-between py-1 border-t border-clay-200">
                <div className="truncate">{h.name}</div>
                <div className="tabular font-semibold ml-3">€ {Math.round(h.price_per_night_eur)}/n</div>
              </div>
            ))}
            {ex.error && !ex.blocked && <div className="text-clay-700">{ex.error}</div>}
          </div>
        )}
        {!busy && !rec?.price_per_night_eur && !td && (
          <div className="text-sm text-clay-700 mb-3">
            Sin datos suficientes para esta ciudad. Usa el botón de Expedia para verificarlo manualmente o estima con la Regla H (budget × pax × 0.27 / noches).
          </div>
        )}

        <a
          href={expediaUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="open-expedia"
          className="mt-3 flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-clay-900 text-white hover:bg-terracotta transition uppercase text-xs tracking-wider"
        >
          <ExternalLink size={14}/>
          {hotelName ? `Abrir "${hotelName}" en Expedia` : "Buscar en Expedia"}
        </a>
      </div>
    </div>
  );
}
