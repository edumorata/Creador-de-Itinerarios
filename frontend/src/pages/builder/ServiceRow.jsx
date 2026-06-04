import React, { useEffect, useState } from "react";
import { GripVertical, Save, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";
import { TYPE_BADGE, TYPES, BADGE_FALLBACK, fmtEUR } from "./utils";
import { AutocompleteInput } from "./AutocompleteInput";

export function ServiceRow({ service, markup, dayCity, dayDate, numTravelers, accommodations, onChange, onRemove, onPickExperience, onDragStart, onOrient, onAccommodate, onSaveToCatalog }) {
  const totalIncl = (service.unit_price_tax_incl || service.unit_price || 0) * (service.quantity || 0);
  const totalPVP = totalIncl * (1 + (markup || 0) / 100);
  const isLodging = service.type === "alojamiento";
  const linkedAcc = service.acc_id ? (accommodations || []).find((a) => a.acc_id === service.acc_id) : null;
  const canSaveCatalog = !!service.experience_id && !isLodging;
  const [savingCatalog, setSavingCatalog] = useState(false);

  // Local state for the in-line check-in/out date inputs (only used for lodging).
  const [stayFrom, setStayFrom] = useState(dayDate || "");
  const [stayTo, setStayTo] = useState("");
  // Pre-fill from the linked accommodation when there is one (Check-in carrier),
  // otherwise fall back to dayDate.
  useEffect(() => {
    if (!isLodging) return;
    if (linkedAcc && linkedAcc.date_from && linkedAcc.date_to) {
      setStayFrom(linkedAcc.date_from);
      setStayTo(linkedAcc.date_to);
    } else if (!service.acc_id && dayDate && !stayFrom) {
      setStayFrom(dayDate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayDate, linkedAcc?.date_from, linkedAcc?.date_to, isLodging]);

  const applyDates = () => {
    const dFrom = stayFrom || dayDate;
    const dTo = stayTo;
    if (!dFrom || !dTo) return;
    if (!service.name?.trim()) { toast.error("Pon primero el nombre del hotel"); return; }
    onAccommodate?.(dFrom, dTo);
    toast.success("Alojamiento aplicado a todos los días");
  };

  const saveToCatalog = async () => {
    if (!service.experience_id) { toast.error("Sin experience_id, no se puede guardar"); return; }
    setSavingCatalog(true);
    try {
      const pax = Math.max(1, parseInt(service.pax || 1, 10));
      const perPaxIncl = service.unit_price_tax_incl || service.unit_price || 0;
      const perPaxExcl = service.unit_price_tax_excl || perPaxIncl;
      await api.patch(`/experiences/${service.experience_id}?source=itinerary`, {
        title: service.name,
        type: service.type,
        pax,
        price_tax_excl: Math.round(perPaxExcl * pax * 100) / 100,
        price_tax_incl: Math.round(perPaxIncl * pax * 100) / 100,
        price: Math.round(perPaxIncl * pax * 100) / 100,
        currency: service.currency || "EUR",
      });
      toast.success("Guardado en el catálogo");
      onSaveToCatalog?.(service);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Error al guardar en catálogo");
    } finally {
      setSavingCatalog(false);
    }
  };

  return (
    <div className="border-b border-clay-200 last:border-0">
    <div className={`grid ${isLodging ? "grid-cols-[28px_110px_1fr_60px_100px_100px_100px_28px_28px]" : "grid-cols-[28px_110px_1fr_60px_100px_100px_100px_30px]"} gap-2 items-center px-3 py-2.5 text-sm hover:bg-clay-50 transition-colors`}>
      <span
        draggable
        onDragStart={onDragStart}
        className="inline-flex items-center justify-center cursor-grab active:cursor-grabbing text-clay-400 hover:text-terracotta hover:bg-clay-100 rounded select-none"
        title="Arrastra para reordenar o mover de día"
      >
        <GripVertical size={14} />
      </span>
      <select className={`text-[10px] tracking-widest uppercase px-1.5 py-1 ${TYPE_BADGE[service.type] || BADGE_FALLBACK} border-none outline-none`} value={service.type} onChange={(e) => onChange({ type: e.target.value })}>
        {!TYPE_BADGE[service.type] && <option value={service.type}>{service.type}</option>}
        <option value="alojamiento">alojamiento</option>
        {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <div className="min-w-0">
        <AutocompleteInput
          value={service.name}
          dayCity={dayCity}
          serviceType={service.type}
          pax={numTravelers}
          onTextChange={(v) => onChange({ name: v })}
          onPick={onPickExperience}
        />
        {(service.provider_name || isLodging || (service.experience_id || service.pax)) && (
          <div className="text-[11px] text-clay-700 truncate flex items-center gap-2">
            {service.provider_name && <span className="truncate">{service.provider_name}</span>}
            {!isLodging && (
              <span
                className="text-[10px] px-1 py-0.5 rounded bg-clay-100 text-clay-700 inline-flex items-center gap-1"
                title="Para cuántos pax cuenta el precio unitario. Por defecto 1 (precio por persona). Edítalo si el proveedor cotiza por grupo."
                data-testid={`svc-pax-${service.service_id}`}
              >
                precio para
                <input
                  type="number" min={1} max={50}
                  className="w-9 bg-white border border-clay-300 px-1 text-[10px] tabular text-center outline-none focus:border-terracotta"
                  value={service.pax || 1}
                  onChange={(ev) => onChange({ pax: Math.max(1, parseInt(ev.target.value || "1", 10)) })}
                  onClick={(ev) => ev.stopPropagation()}
                  data-testid={`svc-pax-input-${service.service_id}`}
                />
                pax
              </span>
            )}
            {isLodging && linkedAcc && (linkedAcc.rooms || []).length > 0 && (
              <span className="text-[10px] px-1 py-0.5 rounded bg-clay-100 text-clay-700">
                {(linkedAcc.rooms || []).length} hab{(linkedAcc.rooms || []).length === 1 ? "" : "s"} × {(() => {
                  const dF = new Date(linkedAcc.date_from);
                  const dT = new Date(linkedAcc.date_to);
                  if (isNaN(dF) || isNaN(dT)) return "?";
                  return Math.max(1, Math.round((dT - dF) / 86400000));
                })()} noches
              </span>
            )}
          </div>
        )}
      </div>
      <input type="number" min="0" step="1" className="bg-transparent text-right outline-none tabular" value={service.quantity || 0} onChange={(e) => onChange({ quantity: parseFloat(e.target.value || "0") })} />
      <div className="flex items-center gap-1 justify-end">
        <span className="text-clay-500 text-[10px]">€</span>
        <input type="number" min="0" step="0.01" className="bg-transparent text-right outline-none tabular w-16" value={service.unit_price_tax_excl || 0} onChange={(e) => onChange({ unit_price_tax_excl: parseFloat(e.target.value || "0") })} title="Sin IVA" />
      </div>
      <div className="flex items-center gap-1 justify-end">
        <span className="text-clay-500 text-[10px]">€</span>
        <input type="number" min="0" step="0.01" className="bg-transparent text-right outline-none tabular w-16" value={service.unit_price_tax_incl || service.unit_price || 0} onChange={(e) => onChange({ unit_price_tax_incl: parseFloat(e.target.value || "0") })} title="Con IVA" />
      </div>
      <div className="text-right text-xs tabular text-clay-700 leading-tight">
        <div>{fmtEUR(totalIncl)}</div>
        <div className="font-semibold text-clay-900">{fmtEUR(totalPVP)}</div>
      </div>
      {isLodging && (
        <button
          data-testid="service-orient"
          onClick={() => onOrient?.({
            hotelName: service.name,
            city: dayCity,
            checkin: dayDate,
            checkout: dayDate,
            adults: numTravelers || 2,
            onApply: (pricePerNight) => {
              onChange({
                unit_price_tax_incl: pricePerNight,
                unit_price_tax_excl: Math.round((pricePerNight / 1.10) * 100) / 100,
                unit_price: pricePerNight,
              });
              toast.success(`${pricePerNight}€/noche aplicado`);
            },
          })}
          className="text-clay-700 hover:text-terracotta hover:bg-clay-100 p-1 border border-clay-300 flex items-center justify-center"
          title="Buscar precio orientativo · histórico + Expedia"
        ><Search size={13}/></button>
      )}
      {canSaveCatalog && (
        <button
          data-testid={`svc-save-catalog-${service.service_id}`}
          onClick={saveToCatalog}
          disabled={savingCatalog}
          title="Guardar precio actualizado en el catálogo de experiencias"
          className="text-clay-700 hover:text-pine hover:bg-pine/10 p-1 border border-clay-300 flex items-center justify-center disabled:opacity-40"
        ><Save size={13}/></button>
      )}
      <button onClick={onRemove} className="text-clay-500 hover:text-destructive p-1" title="Quitar"><Trash2 size={14}/></button>
    </div>
    {isLodging && (!service.acc_id || /^Check-in/.test(service.name || "")) && (
      <div className="grid grid-cols-[28px_110px_1fr_60px_100px_100px_100px_28px_28px] gap-2 items-center px-3 pb-2 -mt-1 text-[11px] text-clay-700">
        <span />
        <span />
        <div className="flex items-center gap-2">
          <span className="smallcaps text-[9px]">Check-in</span>
          <input
            type="date"
            data-testid="svc-stay-from"
            value={stayFrom}
            onChange={(e) => setStayFrom(e.target.value)}
            className="bg-white border border-clay-300 px-1 py-0.5 text-[11px] tabular outline-none focus:border-terracotta"
          />
          <span className="smallcaps text-[9px]">Check-out</span>
          <input
            type="date"
            data-testid="svc-stay-to"
            value={stayTo}
            onChange={(e) => setStayTo(e.target.value)}
            className="bg-white border border-clay-300 px-1 py-0.5 text-[11px] tabular outline-none focus:border-terracotta"
          />
          <button
            data-testid="svc-stay-apply"
            disabled={!stayFrom || !stayTo || !service.name?.trim()}
            onClick={applyDates}
            className="px-2 py-0.5 text-[10px] uppercase tracking-wider bg-clay-900 text-white hover:bg-terracotta disabled:opacity-40"
          >
            Aplicar a estancia
          </button>
        </div>
      </div>
    )}
    </div>
  );
}
