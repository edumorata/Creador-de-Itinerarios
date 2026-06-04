import React from "react";
import { Plus, X } from "lucide-react";
import { ROOM_PAX_DEFAULT, ROOM_TYPES, uid } from "./utils";

export function RoomConfigEditor({ config, numTravelers, onChange }) {
  const list = config || [];
  const totalPax = list.reduce((s, r) => s + (r.pax || 0) * (r.quantity || 1), 0);
  const update = (i, patch) => {
    const next = [...list];
    next[i] = { ...next[i], ...patch };
    if ("room_type" in patch && !("pax" in patch)) {
      next[i].pax = ROOM_PAX_DEFAULT[patch.room_type] || next[i].pax;
    }
    onChange(next);
  };
  const remove = (i) => onChange(list.filter((_, ii) => ii !== i));
  const add = () => onChange([...list, { cfg_id: uid("cfg"), room_type: "doble", pax: 2, quantity: 1 }]);

  return (
    <div className="mb-3 border border-clay-300 bg-clay-50 px-3 py-2" data-testid="room-config-editor">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-[0.2em] text-clay-700 font-semibold">Habitaciones por defecto</span>
        <span className="text-[11px] text-clay-700">Aplicadas al añadir un nuevo alojamiento</span>
        <span className="ml-auto text-[11px]">
          Total: <span className="font-semibold tabular">{list.reduce((s, r) => s + (r.quantity || 1), 0)} habs</span>
          {" · "}<span className={`tabular ${numTravelers && totalPax !== numTravelers ? "text-amber-700 font-semibold" : ""}`}>{totalPax} pax</span>
          {numTravelers && totalPax !== numTravelers && (
            <span className="ml-1 text-amber-700">≠ viaje de {numTravelers}</span>
          )}
        </span>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        {list.map((r, i) => {
          const k = r.cfg_id || `cfg-${i}-${r.room_type}-${r.pax}`;
          return (
          <div key={k} className="inline-flex items-center gap-1 bg-white border border-clay-300 px-2 py-1 text-xs" data-testid={`room-config-${i}`}>
            <input type="number" min="1" max="20" value={r.quantity || 1} onChange={(e) => update(i, { quantity: parseInt(e.target.value || "1", 10) })} className="w-9 text-center bg-transparent" title="Cantidad"/>
            <span className="text-clay-500">×</span>
            <select value={r.room_type} onChange={(e) => update(i, { room_type: e.target.value })} className="bg-transparent">
              {ROOM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <span className="text-clay-500">·</span>
            <input type="number" min="1" max="20" value={r.pax || 1} onChange={(e) => update(i, { pax: parseInt(e.target.value || "1", 10) })} className="w-9 text-center bg-transparent" title="Pax por habitación"/>
            <span className="text-clay-500">pax</span>
            <button onClick={() => remove(i)} className="text-clay-400 hover:text-destructive ml-1" title="Quitar"><X size={11}/></button>
          </div>
        );})}
        <button onClick={add} className="text-[11px] inline-flex items-center gap-1 px-2 py-1 border border-dashed border-clay-400 text-clay-700 hover:text-terracotta hover:border-terracotta" data-testid="add-room-config">
          <Plus size={11}/> Tipo de habitación
        </button>
      </div>
    </div>
  );
}
