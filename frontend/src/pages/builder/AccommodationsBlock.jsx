import React, { useMemo } from "react";
import { AlertTriangle, Bed, Plus, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { ROOM_PAX_DEFAULT, ROOM_TYPES, fmtEUR, nightsBetween, uid } from "./utils";
import { HotelAutocomplete } from "./HotelAutocomplete";
import { RoomConfigEditor } from "./RoomConfigEditor";

export function AccommodationsBlock({ itn, schedSave, markup, onOrient }) {
  // Build rooms from the itinerary default config.
  const buildDefaultRooms = () => {
    const out = [];
    const cfg = itn.room_config || [];
    (cfg.length > 0 ? cfg : [{ room_type: "doble", pax: 2, quantity: 1 }]).forEach((rc) => {
      for (let i = 0; i < (rc.quantity || 1); i++) {
        out.push({
          room_id: uid("room"),
          room_type: rc.room_type, pax: rc.pax,
          price_per_night_excl: 0, price_per_night_incl: 0, currency: "EUR",
        });
      }
    });
    return out;
  };

  const add = () => {
    const newAcc = {
      acc_id: uid("acc"),
      date_from: itn.start_date, date_to: itn.end_date,
      name: "", price_tax_excl: 0, price_tax_incl: 0, price: 0, currency: "EUR",
      rooms: buildDefaultRooms(),
    };
    schedSave({ ...itn, accommodations: [...(itn.accommodations || []), newAcc] });
  };

  const upd = (idx, patch) => {
    const synced = { ...patch };
    if ("price_tax_incl" in synced) synced.price = synced.price_tax_incl;
    const next = [...(itn.accommodations || [])];
    next[idx] = { ...next[idx], ...synced };
    schedSave({ ...itn, accommodations: next });
  };

  // Room CRUD on an accommodation. After any change re-derive:
  //  - accommodation aggregate: price = avg(rooms) × nights × num_rooms = Σ(rooms) × nights
  //  - day matrix carrier:       qty = nights × num_rooms, unit = avg(rooms)
  // so qty × unit always equals the total. Changing ANY parameter recomputes.
  const updateRooms = (idx, newRooms) => {
    const accs = [...(itn.accommodations || [])];
    const acc = { ...accs[idx], rooms: newRooms };
    const nights = nightsBetween(acc.date_from, acc.date_to) || 1;
    const numRooms = Math.max(1, (newRooms || []).length);
    const sumIncl = (newRooms || []).reduce((s, r) => s + (r.price_per_night_incl || r.price_per_night_excl || 0), 0);
    const sumExcl = (newRooms || []).reduce((s, r) => s + (r.price_per_night_excl || r.price_per_night_incl || 0), 0);
    const avgIncl = Math.round((sumIncl / numRooms) * 100) / 100;
    const avgExcl = Math.round((sumExcl / numRooms) * 100) / 100;
    const totalQty = nights * numRooms;
    acc.price_tax_excl = Math.round(avgExcl * totalQty * 100) / 100;
    acc.price_tax_incl = Math.round(avgIncl * totalQty * 100) / 100;
    acc.price = acc.price_tax_incl;
    accs[idx] = acc;

    const noteSummary = sumIncl
      ? `${nights} noches × ${numRooms} hab${numRooms === 1 ? "" : "s"} × €${avgIncl.toFixed(2)}/hab/noche`
      : "";
    const newDays = (itn.days || []).map((d) => ({
      ...d,
      services: (d.services || []).map((s) => {
        if (s.acc_id !== acc.acc_id) return s;
        const isCarrier = (s.name || "").startsWith("Check-in") || (s.quantity || 0) > 0;
        if (isCarrier) {
          return {
            ...s,
            quantity: totalQty,
            unit_price_tax_excl: avgExcl,
            unit_price_tax_incl: avgIncl,
            unit_price: avgIncl,
            notes: noteSummary,
          };
        }
        return s;
      }),
    }));
    schedSave({ ...itn, accommodations: accs, days: newDays });
  };

  const addRoom = (idx) => {
    const acc = (itn.accommodations || [])[idx];
    const rooms = [...(acc.rooms || []), {
      room_id: uid("room"), room_type: "doble", pax: 2,
      price_per_night_excl: 0, price_per_night_incl: 0, currency: "EUR",
    }];
    updateRooms(idx, rooms);
  };

  const removeRoom = (idx, room_id) => {
    const acc = (itn.accommodations || [])[idx];
    updateRooms(idx, (acc.rooms || []).filter((r) => r.room_id !== room_id));
  };

  const patchRoom = (idx, room_id, patch) => {
    const acc = (itn.accommodations || [])[idx];
    const rooms = (acc.rooms || []).map((r) => {
      if (r.room_id !== room_id) return r;
      const merged = { ...r, ...patch };
      if ("room_type" in patch && !("pax" in patch)) {
        merged.pax = ROOM_PAX_DEFAULT[patch.room_type] || merged.pax;
      }
      return merged;
    });
    updateRooms(idx, rooms);
  };

  const fetchOrient = (idx, a) => {
    onOrient?.({
      hotelName: a.name,
      city: null,
      checkin: a.date_from || itn.start_date,
      checkout: a.date_to || itn.end_date,
      adults: itn.num_travelers || 2,
      onApply: (pricePerNight) => {
        const dFrom = a.date_from ? new Date(a.date_from) : null;
        const dTo = a.date_to ? new Date(a.date_to) : null;
        const n = (dFrom && dTo) ? Math.max(1, Math.round((dTo - dFrom) / 86400000)) : 1;
        const total = pricePerNight * n;
        upd(idx, { price_tax_incl: total, price_tax_excl: total / 1.10 });
        toast.success(`Aplicado · ${pricePerNight}€/noche × ${n} noches = ${Math.round(total)}€`);
      },
    });
  };

  // Spread Check-in/Mid/Check-out service rows across the days.
  const unspreadAccommodation = (acc_id) => (itn.days || []).map((d) => ({
    ...d,
    services: (d.services || []).filter((s) => s.acc_id !== acc_id),
  }));

  const updWithSpread = (idx, patch, hotelRecord = null) => {
    const synced = { ...patch };
    if ("price_tax_incl" in synced) synced.price = synced.price_tax_incl;
    const list = [...(itn.accommodations || [])];
    const newAcc = { ...list[idx], ...synced };
    list[idx] = newAcc;
    if (newAcc.name && newAcc.date_from && newAcc.date_to) {
      const nights = Math.max(1, Math.round((new Date(newAcc.date_to) - new Date(newAcc.date_from)) / 86400000));
      const rooms = newAcc.rooms || [];
      const numRooms = Math.max(1, rooms.length || 1);
      const sumIncl = rooms.reduce((s, r) => s + (r.price_per_night_incl || r.price_per_night_excl || 0), 0);
      const sumExcl = rooms.reduce((s, r) => s + (r.price_per_night_excl || r.price_per_night_incl || 0), 0);
      let avgIncl, avgExcl;
      if (rooms.length > 0 && sumIncl > 0) {
        avgIncl = sumIncl / numRooms;
        avgExcl = sumExcl / numRooms;
      } else if (hotelRecord?.price_per_night_incl) {
        avgIncl = hotelRecord.price_per_night_incl;
        avgExcl = hotelRecord.price_per_night_excl || hotelRecord.price_per_night_incl;
      } else {
        avgIncl = (newAcc.price_tax_incl || 0) / Math.max(1, nights * numRooms);
        avgExcl = (newAcc.price_tax_excl || newAcc.price_tax_incl || 0) / Math.max(1, nights * numRooms);
      }
      avgIncl = Math.round(avgIncl * 100) / 100;
      avgExcl = Math.round(avgExcl * 100) / 100;
      const totalQty = nights * numRooms;
      list[idx] = {
        ...newAcc,
        price_tax_incl: Math.round(avgIncl * totalQty * 100) / 100,
        price_tax_excl: Math.round(avgExcl * totalQty * 100) / 100,
        price: Math.round(avgIncl * totalQty * 100) / 100,
      };
      const dFrom = new Date(newAcc.date_from);
      const dTo = new Date(newAcc.date_to);
      const newDays = (itn.days || []).map((d) => {
        const filtered = (d.services || []).filter((s) => s.acc_id !== newAcc.acc_id);
        if (!d.date) return { ...d, services: filtered };
        const dd = new Date(d.date);
        if (isNaN(dd) || dd < dFrom || dd > dTo) return { ...d, services: filtered };
        let label;
        if (dd.getTime() === dFrom.getTime()) label = `Check-in · ${newAcc.name}`;
        else if (dd.getTime() === dTo.getTime()) label = `Check-out · ${newAcc.name}`;
        else label = `Alojamiento · ${newAcc.name}`;
        const isPriceCarrier = dd.getTime() === dFrom.getTime();
        return {
          ...d,
          services: [
            ...filtered,
            {
              service_id: uid("svc"),
              acc_id: newAcc.acc_id,
              experience_id: hotelRecord?.hotel_id || null,
              type: "alojamiento",
              name: label,
              provider_name: hotelRecord ? "Hotel · catálogo" : null,
              quantity: isPriceCarrier ? totalQty : 0,
              unit_price_tax_excl: isPriceCarrier ? avgExcl : 0,
              unit_price_tax_incl: isPriceCarrier ? avgIncl : 0,
              unit_price: isPriceCarrier ? avgIncl : 0,
              currency: "EUR",
              notes: isPriceCarrier ? `${nights} noches × ${numRooms} hab × €${avgIncl}/hab/noche` : "",
            },
          ],
        };
      });
      schedSave({ ...itn, accommodations: list, days: newDays });
    } else {
      schedSave({ ...itn, accommodations: list });
    }
  };

  const pickHotel = (idx, hotel) => {
    const accs = [...(itn.accommodations || [])];
    const current = accs[idx] || {};
    const existing = (current.rooms && current.rooms.length > 0) ? current.rooms : buildDefaultRooms();
    const rooms = existing.map((r) => ({
      ...r,
      price_per_night_excl: hotel.price_per_night_excl || hotel.price_per_night_incl || 0,
      price_per_night_incl: hotel.price_per_night_incl || hotel.price_per_night_excl || 0,
    }));
    accs[idx] = { ...current, name: hotel.name, rooms };
    const nights = nightsBetween(current.date_from, current.date_to) || 1;
    const numRooms = Math.max(1, rooms.length);
    const sumIncl = rooms.reduce((s, r) => s + (r.price_per_night_incl || r.price_per_night_excl || 0), 0);
    const sumExcl = rooms.reduce((s, r) => s + (r.price_per_night_excl || r.price_per_night_incl || 0), 0);
    const avgIncl = Math.round((sumIncl / numRooms) * 100) / 100;
    const avgExcl = Math.round((sumExcl / numRooms) * 100) / 100;
    const totalQty = nights * numRooms;
    accs[idx] = {
      ...accs[idx],
      price_tax_excl: Math.round(avgExcl * totalQty * 100) / 100,
      price_tax_incl: Math.round(avgIncl * totalQty * 100) / 100,
      price: Math.round(avgIncl * totalQty * 100) / 100,
    };
    const newAcc = accs[idx];
    const dFrom = new Date(newAcc.date_from);
    const dTo = new Date(newAcc.date_to);
    let newDays = itn.days || [];
    if (newAcc.date_from && newAcc.date_to && !isNaN(dFrom) && !isNaN(dTo) && dTo >= dFrom) {
      newDays = (itn.days || []).map((d) => {
        const filtered = (d.services || []).filter((s) => s.acc_id !== newAcc.acc_id);
        if (!d.date) return { ...d, services: filtered };
        const dd = new Date(d.date);
        if (isNaN(dd) || dd < dFrom || dd > dTo) return { ...d, services: filtered };
        let label;
        if (dd.getTime() === dFrom.getTime()) label = `Check-in · ${newAcc.name}`;
        else if (dd.getTime() === dTo.getTime()) label = `Check-out · ${newAcc.name}`;
        else label = `Alojamiento · ${newAcc.name}`;
        const isPriceCarrier = dd.getTime() === dFrom.getTime();
        return {
          ...d,
          services: [
            ...filtered,
            {
              service_id: uid("svc"),
              acc_id: newAcc.acc_id,
              type: "alojamiento",
              name: label,
              provider_name: "Hotel · catálogo",
              quantity: isPriceCarrier ? totalQty : 0,
              unit_price_tax_excl: isPriceCarrier ? avgExcl : 0,
              unit_price_tax_incl: isPriceCarrier ? avgIncl : 0,
              unit_price: isPriceCarrier ? avgIncl : 0,
              currency: hotel.currency || "EUR",
              notes: isPriceCarrier ? `${nights} noches × ${numRooms} hab × €${avgIncl}/hab/noche` : "",
            },
          ],
        };
      });
    }
    schedSave({ ...itn, accommodations: accs, days: newDays });
  };

  const delAndUnspread = (idx) => {
    const accId = (itn.accommodations || [])[idx]?.acc_id;
    const newDays = unspreadAccommodation(accId);
    schedSave({
      ...itn,
      accommodations: (itn.accommodations || []).filter((_, i) => i !== idx),
      days: newDays,
    });
  };

  const overlaps = useMemo(() => {
    const accs = (itn.accommodations || []).filter((a) => a.name && a.date_from && a.date_to);
    const out = [];
    for (let i = 0; i < accs.length; i++) {
      for (let j = i + 1; j < accs.length; j++) {
        const a = accs[i], b = accs[j];
        const aFrom = new Date(a.date_from), aTo = new Date(a.date_to);
        const bFrom = new Date(b.date_from), bTo = new Date(b.date_to);
        if (isNaN(aFrom) || isNaN(aTo) || isNaN(bFrom) || isNaN(bTo)) continue;
        if (aFrom < bTo && bFrom < aTo) {
          const overlapStart = aFrom > bFrom ? aFrom : bFrom;
          const overlapEnd = aTo < bTo ? aTo : bTo;
          const days = Math.max(0, Math.round((overlapEnd - overlapStart) / 86400000));
          if (days > 0) out.push({ a, b, days });
        }
      }
    }
    return out;
  }, [itn.accommodations]);

  return (
    <div className="mt-10">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 smallcaps"><Bed size={13}/> Alojamientos (sumario)</div>
        <button onClick={add} className="text-xs inline-flex items-center gap-1 px-2 py-1 hover:bg-clay-200" data-testid="add-accommodation">
          <Plus size={12}/> Añadir alojamiento
        </button>
      </div>

      {overlaps.length > 0 && (
        <div
          data-testid="acc-overlap-warning"
          className="mb-3 border border-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          <div className="font-semibold mb-1 flex items-center gap-2">
            <AlertTriangle size={14}/>
            {overlaps.length === 1 ? "Solapamiento detectado en alojamientos" : `${overlaps.length} solapamientos detectados en alojamientos`}
          </div>
          <ul className="list-disc pl-5 space-y-0.5 text-[12px]">
            {overlaps.map((o) => (
              <li key={`${o.a.acc_id}-${o.b.acc_id}`}>
                <span className="font-semibold">{o.a.name}</span> ({o.a.date_from} → {o.a.date_to})
                {" "}solapa con{" "}
                <span className="font-semibold">{o.b.name}</span> ({o.b.date_from} → {o.b.date_to})
                {" "}— {o.days} {o.days === 1 ? "día" : "días"} en conflicto.
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="border border-clay-300 bg-white">
        {(itn.accommodations || []).length === 0 ? (
          <div className="p-4 text-sm text-clay-700">Opcional. Añade alojamientos resumidos por estancia.</div>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_120px_120px_90px_90px_90px_28px_28px] gap-2 px-3 py-2 text-[10px] tracking-[0.2em] uppercase text-clay-700 font-semibold bg-clay-50 border-b border-clay-300">
              <div>Hotel / Apartamento</div><div>Desde</div><div>Hasta</div>
              <div className="text-right">Sin IVA</div><div className="text-right">Con IVA</div><div className="text-right">PVP</div><div></div><div></div>
            </div>
            {(itn.accommodations || []).map((a, idx) => {
              const incl = a.price_tax_incl || a.price || 0;
              const pvp = incl * (1 + (markup || 0) / 100);
              const rooms = a.rooms || [];
              const nights = nightsBetween(a.date_from, a.date_to);
              const roomsTotalPax = rooms.reduce((s, r) => s + (r.pax || 0), 0);
              const usingRooms = rooms.length > 0;
              return (
                <div key={a.acc_id} className="border-t border-clay-300">
                  <div className="grid grid-cols-[1fr_120px_120px_90px_90px_90px_28px_28px] gap-2 px-3 py-2 items-center text-sm">
                    <HotelAutocomplete
                      value={a.name}
                      onTextChange={(v) => updWithSpread(idx, { name: v })}
                      onPick={(h) => pickHotel(idx, h)}
                      placeholder="Buscar hotel del catálogo…"
                    />
                    <input type="date" className="bg-transparent outline-none tabular" value={a.date_from || ""} onChange={(e) => updWithSpread(idx, { date_from: e.target.value })} />
                    <input type="date" className="bg-transparent outline-none tabular" value={a.date_to || ""} onChange={(e) => updWithSpread(idx, { date_to: e.target.value })} />
                    <div className="flex items-center gap-1 justify-end">
                      <span className="text-clay-500 text-[10px]">€</span>
                      <input
                        type="number" min="0" step="0.01"
                        className={`bg-transparent text-right outline-none tabular w-full ${usingRooms ? "text-clay-500" : ""}`}
                        value={a.price_tax_excl || 0}
                        readOnly={usingRooms}
                        title={usingRooms ? "Calculado a partir de las habitaciones" : "Editable"}
                        onChange={(e) => upd(idx, { price_tax_excl: parseFloat(e.target.value || "0") })}
                      />
                    </div>
                    <div className="flex items-center gap-1 justify-end">
                      <span className="text-clay-500 text-[10px]">€</span>
                      <input
                        type="number" min="0" step="0.01"
                        className={`bg-transparent text-right outline-none tabular w-full ${usingRooms ? "text-clay-500" : ""}`}
                        value={incl}
                        readOnly={usingRooms}
                        title={usingRooms ? "Calculado a partir de las habitaciones" : "Editable"}
                        onChange={(e) => upd(idx, { price_tax_incl: parseFloat(e.target.value || "0") })}
                      />
                    </div>
                    <div className="text-right tabular font-semibold">{fmtEUR(pvp)}</div>
                    <button
                      data-testid={`orient-${idx}`}
                      onClick={() => fetchOrient(idx, a)}
                      title="Buscar precio orientativo · histórico + Expedia"
                      className="text-clay-700 hover:text-terracotta hover:bg-clay-100 p-1 border border-clay-300 flex items-center justify-center"
                    ><Search size={14}/></button>
                    <button onClick={() => delAndUnspread(idx)} className="text-clay-500 hover:text-destructive p-1"><Trash2 size={14}/></button>
                  </div>
                  <div className="pl-4 pr-3 pb-3 -mt-1">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-clay-700 mb-1 flex items-center gap-2">
                      Habitaciones
                      <span className="font-semibold text-clay-900" data-testid={`rooms-summary-${idx}`}>
                        {rooms.length} · {roomsTotalPax} pax · {nights || 0} noches
                      </span>
                      {itn.num_travelers && roomsTotalPax !== itn.num_travelers && (
                        <span className="text-amber-700 normal-case tracking-normal text-[11px]">
                          (viaje de {itn.num_travelers} pax)
                        </span>
                      )}
                    </div>
                    {rooms.length === 0 ? (
                      <div className="text-xs text-clay-500 italic mb-1">Sin habitaciones — usando precio plano</div>
                    ) : (
                      <div className="space-y-1">
                        {rooms.map((r) => (
                          <div
                            key={r.room_id}
                            className="grid grid-cols-[1fr_120px_120px_90px_90px_90px_28px_28px] gap-2 items-center text-xs border-l-2 border-clay-200 pl-2"
                            data-testid={`room-${r.room_id}`}
                          >
                            <div className="flex items-center gap-2 text-[11px]">
                              <select
                                className="bg-white border border-clay-200 px-1 py-0.5 text-xs w-24"
                                value={r.room_type}
                                onChange={(e) => patchRoom(idx, r.room_id, { room_type: e.target.value })}
                                data-testid={`room-type-${r.room_id}`}
                              >
                                {ROOM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                              </select>
                              <span className="text-clay-500">·</span>
                              <input
                                type="number" min="1" max="20"
                                className="bg-white border border-clay-200 px-1 py-0.5 text-right tabular w-12"
                                value={r.pax || 1}
                                onChange={(e) => patchRoom(idx, r.room_id, { pax: parseInt(e.target.value || "1", 10) })}
                                title="Pax en esta habitación"
                                data-testid={`room-pax-${r.room_id}`}
                              />
                              <span className="text-clay-500 text-[11px]">pax · €/noche</span>
                            </div>
                            <div />
                            <div />
                            <div className="flex items-center gap-1 justify-end">
                              <span className="text-clay-500 text-[10px]">€</span>
                              <input
                                type="number" min="0" step="0.01"
                                className="bg-white border border-clay-200 px-1 py-0.5 text-right tabular w-full"
                                value={r.price_per_night_excl || 0}
                                onChange={(e) => patchRoom(idx, r.room_id, { price_per_night_excl: parseFloat(e.target.value || "0") })}
                                title="Precio por noche sin IVA"
                                data-testid={`room-excl-${r.room_id}`}
                              />
                            </div>
                            <div className="flex items-center gap-1 justify-end">
                              <span className="text-clay-500 text-[10px]">€</span>
                              <input
                                type="number" min="0" step="0.01"
                                className="bg-white border border-clay-200 px-1 py-0.5 text-right tabular w-full font-semibold"
                                value={r.price_per_night_incl || 0}
                                onChange={(e) => patchRoom(idx, r.room_id, { price_per_night_incl: parseFloat(e.target.value || "0") })}
                                title="Precio por noche con IVA"
                                data-testid={`room-incl-${r.room_id}`}
                              />
                            </div>
                            <div />
                            <div />
                            <button
                              onClick={() => removeRoom(idx, r.room_id)}
                              className="text-clay-400 hover:text-destructive p-1 flex items-center justify-center"
                              title="Quitar habitación"
                              data-testid={`room-del-${r.room_id}`}
                            ><X size={12}/></button>
                          </div>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={() => addRoom(idx)}
                      className="mt-1 text-[11px] inline-flex items-center gap-1 px-1.5 py-0.5 text-clay-700 hover:text-terracotta hover:bg-clay-100"
                      data-testid={`add-room-${idx}`}
                    >
                      <Plus size={10}/> Añadir habitación
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

// Re-export the room config editor from the same module barrel.
export { RoomConfigEditor };
