import React, { useState } from "react";
import { Calendar, MapPin, Plus } from "lucide-react";
import { fmt } from "./utils";
import { ServiceRow } from "./ServiceRow";

export function DayBlock({ day, idx, active, numTravelers, accommodations, cityFacets, markup, onActivate, onUpdateDay, onAddBlank, onRemoveDay, onUpdateService, onRemoveService, onDragStart, onDropService, onOrient, onAccommodate }) {
  const [dragOverIdx, setDragOverIdx] = useState(null);
  // Ephemeral toggle: while ON, the autocomplete search ignores `day.city` so
  // the agent can browse the entire country without losing the city tags they
  // had configured. Resets on page reload (intentional — most uses are quick
  // lookups).
  const [allCountry, setAllCountry] = useState(false);
  // When toggle is ON, pass empty string to children so the search widens.
  const effectiveCity = allCountry ? "" : (day.city || "");
  return (
    <div className={`border ${active ? "border-terracotta" : "border-clay-300"} bg-white transition-colors`} data-testid={`day-${idx}`} onClick={onActivate}>
      <div className="px-4 py-3 bg-clay-100 flex items-center justify-between border-b border-clay-300"
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
        onDrop={(e) => { e.preventDefault(); onDropService(day.day_id, -1); setDragOverIdx(null); }}
      >
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <div className="smallcaps shrink-0">Día {idx + 1}</div>
          <div className="flex items-center gap-1 text-sm text-clay-700 shrink-0"><Calendar size={13}/>{fmt(day.date)}</div>
          <div className="flex items-center gap-1 text-sm text-clay-700 min-w-0">
            <MapPin size={13} className="shrink-0"/>
            <input
              data-testid={`day-city-${idx}`}
              list={`day-cities-${idx}`}
              value={day.city || ""}
              onChange={(e) => onUpdateDay({ city: e.target.value })}
              placeholder="Ciudad o ciudades, separadas por coma"
              onClick={(e) => e.stopPropagation()}
              title="Una o más ciudades separadas por coma. El buscador combina los resultados de todas."
              className="bg-transparent outline-none border-b border-transparent focus:border-terracotta text-sm w-56"
            />
            <datalist id={`day-cities-${idx}`}>
              {(cityFacets || []).map((c) => <option key={c} value={c} />)}
            </datalist>
            {day.city ? (
              <button
                type="button"
                data-testid={`day-city-allcountry-${idx}`}
                onClick={(e) => { e.stopPropagation(); setAllCountry((v) => !v); }}
                className={`ml-1 px-1.5 py-0.5 text-[9px] uppercase tracking-wider transition-colors ${
                  allCountry
                    ? "bg-terracotta text-white"
                    : "bg-clay-100 hover:bg-terracotta hover:text-white"
                }`}
                title={
                  allCountry
                    ? "Filtro de ciudad desactivado. Pulsa para volver a filtrar por la ciudad del día."
                    : "Buscar en todo el país sin perder las ciudades del día. Pulsa otra vez para reactivar el filtro."
                }
              >
                {allCountry ? "Todo el país · ON" : "Todo el país"}
              </button>
            ) : (
              <span
                className="ml-1 px-1.5 py-0.5 text-[9px] uppercase tracking-wider bg-pine/20 text-pine"
                title="Sin filtro de ciudad — el buscador muestra resultados de cualquier ciudad"
              >
                Sin filtro
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button data-testid={`add-blank-${idx}`} className="text-xs px-2 py-1 hover:bg-clay-200 inline-flex items-center gap-1" onClick={(e) => { e.stopPropagation(); onAddBlank(); }}>
            <Plus size={12}/> servicio en blanco
          </button>
          <button className="text-xs px-2 py-1 hover:bg-clay-200 text-destructive" onClick={(e) => { e.stopPropagation(); if (window.confirm("¿Eliminar este día?")) onRemoveDay(); }}>
            Eliminar día
          </button>
        </div>
      </div>

      {(day.services || []).length > 0 && (
        <div className="grid grid-cols-[28px_110px_1fr_60px_100px_100px_30px] gap-2 px-3 py-2 text-[10px] tracking-[0.2em] uppercase text-clay-700 font-semibold bg-clay-50 border-b border-clay-300">
          <div></div><div>Tipo</div><div>Servicio</div><div className="text-right">Qty</div>
          <div className="text-right">Con IVA</div><div className="text-right">PVP</div><div></div>
        </div>
      )}

      {(day.services || []).length === 0 ? (
        <div
          className="p-6 text-center text-sm text-clay-700"
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverIdx(0); }}
          onDragLeave={() => setDragOverIdx(null)}
          onDrop={(e) => { e.preventDefault(); onDropService(day.day_id, 0); setDragOverIdx(null); }}
        >
          <p>Selecciona experiencias en el panel derecho o pulsa <span className="font-semibold text-clay-900">+ servicio en blanco</span> para escribir manualmente con autocompletado.</p>
        </div>
      ) : (
        <div className="grid-borders">
          {day.services.map((s, sIdx) => (
            <div
              key={s.service_id}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverIdx(sIdx); }}
              onDragLeave={() => setDragOverIdx((cur) => (cur === sIdx ? null : cur))}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDropService(day.day_id, sIdx); setDragOverIdx(null); }}
              className={dragOverIdx === sIdx ? "border-t-2 border-terracotta -mt-px" : ""}
            >
              <ServiceRow service={s} markup={markup} dayCity={effectiveCity} numTravelers={numTravelers}
                accommodations={accommodations}
                onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", s.service_id); onDragStart(day.day_id, s.service_id); }}
                onChange={(patch) => onUpdateService(s.service_id, patch)}
                onRemove={() => onRemoveService(s.service_id)}
                onPickExperience={(exp) => {
                  // Convert catalog total → per-pax and assign qty = num_travelers.
                  const expPax = Math.max(1, parseInt(exp.pax || 1, 10));
                  const totalIncl = exp.price_tax_incl ?? exp.price ?? 0;
                  const totalExcl = exp.price_tax_excl ?? totalIncl;
                  const perPaxIncl = totalIncl / expPax;
                  const perPaxExcl = totalExcl / expPax;
                  onUpdateService(s.service_id, {
                    experience_id: exp.experience_id, name: exp.title, type: exp.type,
                    provider_name: exp.provider_name, pax: expPax,
                    quantity: numTravelers || 1,
                    unit_price_tax_excl: Math.round(perPaxExcl * 100) / 100,
                    unit_price_tax_incl: Math.round(perPaxIncl * 100) / 100,
                    unit_price: Math.round(perPaxIncl * 100) / 100,
                    currency: exp.currency || "EUR",
                  });
                }}
                onOrient={onOrient}
                onAccommodate={(dFrom, dTo) => onAccommodate(s, dFrom, dTo)}
                dayDate={day.date}
              />
            </div>
          ))}
          <div
            className={`h-2 ${dragOverIdx === day.services.length ? "border-t-2 border-terracotta" : ""}`}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverIdx(day.services.length); }}
            onDragLeave={() => setDragOverIdx(null)}
            onDrop={(e) => { e.preventDefault(); onDropService(day.day_id, -1); setDragOverIdx(null); }}
          />
        </div>
      )}
    </div>
  );
}
