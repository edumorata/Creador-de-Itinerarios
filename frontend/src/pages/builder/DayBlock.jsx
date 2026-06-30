import React, { useState } from "react";
import { Calendar, MapPin, Plus, Bed, ArrowDown } from "lucide-react";
import { fmt, fmtEUR } from "./utils";
import { ServiceRow } from "./ServiceRow";
import { confirmAsync } from "@/lib/safeConfirm";

// Pick the accommodations from the itinerary that overlap a given day (by
// date). Each chip carries a tag so the agent can see at a glance whether
// THIS day is the check-in, a mid-stay night, or the check-out.
const overlappingStays = (accommodations, dayDate) => {
  if (!dayDate || !accommodations) return [];
  const dd = new Date(dayDate);
  if (isNaN(dd)) return [];
  const out = [];
  for (const a of accommodations) {
    if (!a?.name || !a?.date_from || !a?.date_to) continue;
    const df = new Date(a.date_from);
    const dt = new Date(a.date_to);
    if (isNaN(df) || isNaN(dt)) continue;
    if (dd < df || dd > dt) continue;
    let tag;
    if (dd.getTime() === df.getTime()) tag = "check-in";
    else if (dd.getTime() === dt.getTime()) tag = "check-out";
    else tag = "alojamiento";
    out.push({ acc: a, tag });
  }
  return out;
};

// Stay chip — read-only summary card for an accommodation overlapping this
// day. Edits happen only in the "Alojamientos (sumario)" block at the
// bottom; clicking the chip scrolls there for quick context-switching.
function StayChip({ acc, tag }) {
  const rooms = acc.rooms || [];
  const numRooms = rooms.length;
  const totalPax = rooms.reduce((s, r) => s + (r.pax || 0), 0);
  const total = acc.price_tax_incl || acc.price || 0;
  const tagColor = tag === "check-in"
    ? "bg-pine-soft/40 text-pine border-pine-soft"
    : tag === "check-out"
    ? "bg-terracotta/15 text-terracotta border-terracotta/30"
    : "bg-clay-100 text-clay-700 border-clay-300";
  return (
    <button
      type="button"
      data-testid={`stay-chip-${acc.acc_id}`}
      onClick={(e) => {
        e.stopPropagation();
        const target = document.getElementById(`acc-row-${acc.acc_id}`);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.classList.add("ring-2", "ring-terracotta");
          setTimeout(() => target.classList.remove("ring-2", "ring-terracotta"), 1800);
        }
      }}
      className="w-full text-left flex items-center gap-3 px-3 py-2 bg-clay-50/60 border-l-2 border-clay-300 hover:border-terracotta hover:bg-clay-100 transition-colors group cursor-pointer"
      title="Ver/editar en Alojamientos (abajo)"
    >
      <Bed size={14} className="text-clay-500 shrink-0" />
      <span className={`text-[9px] uppercase tracking-widest px-1.5 py-0.5 border ${tagColor} shrink-0`}>
        {tag}
      </span>
      <span className="text-sm font-medium text-clay-900 truncate flex-1">{acc.name}</span>
      <span className="text-xs text-clay-700 tabular shrink-0">
        {numRooms > 0 && `${numRooms} hab · `}
        {totalPax > 0 && `${totalPax} pax`}
      </span>
      {tag === "check-in" && total > 0 && (
        <span className="text-sm tabular font-semibold text-clay-900 shrink-0">{fmtEUR(total)}</span>
      )}
      <ArrowDown size={11} className="text-clay-400 group-hover:text-terracotta shrink-0" />
    </button>
  );
}

export function DayBlock({ day, idx, active, numTravelers, accommodations, cityFacets, markup, onActivate, onUpdateDay, onAddBlank, onRemoveDay, onUpdateService, onRemoveService, onDragStart, onDropService, onOrient, onAccommodate }) {
  const [dragOverIdx, setDragOverIdx] = useState(null);
  // Ephemeral toggle: while ON, the autocomplete search ignores `day.city` so
  // the agent can browse the entire country without losing the city tags they
  // had configured. Resets on page reload (intentional — most uses are quick
  // lookups).
  const [allCountry, setAllCountry] = useState(false);
  // When toggle is ON, pass empty string to children so the search widens.
  const effectiveCity = allCountry ? "" : (day.city || "");

  // 1) Chips computed from the parent itinerary's accommodations[]. These
  //    are read-only references — editing happens in AccommodationsBlock.
  const stays = overlappingStays(accommodations, day.date);
  // 2) Filter out any legacy "carrier service" rows (services with acc_id
  //    that the old auto-spread logic created). They duplicated the stay,
  //    double-counted the cost, and confused the editor. New itineraries
  //    won't generate them; existing data is hidden here without being
  //    deleted from the DB so the cleanup is non-destructive.
  const editableServices = (day.services || []).filter((s) => !s.acc_id);

  return (
    <div className={`border ${active ? "border-terracotta" : "border-clay-300"} bg-white transition-colors`}
         data-testid={`day-${idx}`}
         data-day-id={day.day_id}
         onClick={onActivate}>
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
          <button className="text-xs px-2 py-1 hover:bg-clay-200 text-destructive" onClick={async (e) => { e.stopPropagation(); if (await confirmAsync("¿Eliminar este día?", { destructive: true, confirmLabel: "Eliminar" })) onRemoveDay(); }}>
            Eliminar día
          </button>
        </div>
      </div>

      {/* Stay chips — derived from itn.accommodations[]. Show only when this
          day falls within at least one stay's date range. Read-only; click
          scrolls to the bottom Alojamientos row for editing. */}
      {stays.length > 0 && (
        <div className="border-b border-clay-300" data-testid={`stays-${idx}`}>
          {stays.map(({ acc, tag }) => (
            <StayChip key={acc.acc_id} acc={acc} tag={tag} />
          ))}
        </div>
      )}

      {editableServices.length > 0 && (
        <div className="grid grid-cols-[28px_110px_1fr_60px_100px_100px_30px] gap-2 px-3 py-2 text-[10px] tracking-[0.2em] uppercase text-clay-700 font-semibold bg-clay-50 border-b border-clay-300">
          <div></div><div>Tipo</div><div>Servicio</div><div className="text-right">Qty</div>
          <div className="text-right">Con IVA</div><div className="text-right">PVP</div><div></div>
        </div>
      )}

      {editableServices.length === 0 ? (
        <div
          className="p-6 text-center text-sm text-clay-700"
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverIdx(0); }}
          onDragLeave={() => setDragOverIdx(null)}
          onDrop={(e) => { e.preventDefault(); onDropService(day.day_id, 0); setDragOverIdx(null); }}
        >
          <p>
            {stays.length > 0
              ? "Sólo alojamiento por defecto. Añade servicios extra (traslados, experiencias…) si lo necesitas."
              : <>Selecciona experiencias en el panel derecho o pulsa <span className="font-semibold text-clay-900">+ servicio en blanco</span> para escribir manualmente con autocompletado.</>}
          </p>
        </div>
      ) : (
        <div className="grid-borders">
          {editableServices.map((s, sIdx) => (
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
            className={`h-2 ${dragOverIdx === editableServices.length ? "border-t-2 border-terracotta" : ""}`}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverIdx(editableServices.length); }}
            onDragLeave={() => setDragOverIdx(null)}
            onDrop={(e) => { e.preventDefault(); onDropService(day.day_id, -1); setDragOverIdx(null); }}
          />
        </div>
      )}
    </div>
  );
}
