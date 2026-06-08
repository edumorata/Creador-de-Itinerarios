import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, FileDown, MapPin, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import api, { API_BASE } from "@/lib/api";

import {
  TYPE_BADGE, TYPES, BADGE_FALLBACK,
  PARTNER_LABELS,
  fmtEUR, uid, daysBetween, dateAdd,
} from "./builder/utils";
import { Field, Row } from "./builder/atoms";
import { AccommodationsBlock, RoomConfigEditor } from "./builder/AccommodationsBlock";
import { DayBlock } from "./builder/DayBlock";
import { OrientationModal } from "./builder/OrientationModal";
import { FxConverter } from "./builder/FxConverter";
import { PartnerSelector } from "./builder/PartnerSelector";

export default function ItineraryBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [itn, setItn] = useState(null);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef(null);

  const [q, setQ] = useState("");
  const [filterCountry, setFilterCountry] = useState("");
  const [filterCity, setFilterCity] = useState("");
  const [filterType, setFilterType] = useState("");
  const [experiences, setExperiences] = useState([]);
  const [facets, setFacets] = useState({ countries: [], cities: [], types: [] });
  const [activeDayId, setActiveDayId] = useState(null);
  const dragRef = useRef(null);

  // FX rate for EUR↔USD conversion.
  const [fx, setFx] = useState({ rate: 1.10, source: "loading", date: "" });
  useEffect(() => {
    let alive = true;
    api.get("/fx/rate").then(({ data }) => {
      if (alive && data && data.rate) setFx({ rate: Number(data.rate), source: data.source, date: data.date });
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Initial itinerary load + legacy data cleanup (dash-separated cities).
  useEffect(() => {
    (async () => {
      const { data } = await api.get(`/itineraries/${id}`);
      if ((!data.days || data.days.length === 0) && data.start_date && data.end_date) {
        const n = daysBetween(data.start_date, data.end_date);
        data.days = Array.from({ length: n }).map((_, i) => ({
          day_id: uid("day"),
          date: dateAdd(data.start_date, i),
          label: `Día ${i + 1}`,
          city: "",
          services: [],
        }));
      }
      // Multi-city is now expressed with commas — legacy dash values returned 0 results.
      let cleaned = false;
      (data.days || []).forEach((d) => {
        if (typeof d.city === "string" && d.city.includes("-")) {
          d.city = ""; cleaned = true;
        }
      });
      if (cleaned) toast.message("Limpieza automática de filtros antiguos de ciudad (formato con guión).");
      setItn(data);
      setActiveDayId(data.days?.[0]?.day_id || null);
    })();
  }, [id]);

  useEffect(() => {
    (async () => {
      const { data } = await api.get("/experiences/facets");
      setFacets(data);
    })();
  }, []);

  const searchExperiences = useCallback(async () => {
    const params = {};
    if (q) params.q = q;
    if (filterCountry) params.country = filterCountry;
    if (filterCity) params.city = filterCity;
    if (filterType) params.type = filterType;
    const { data } = await api.get("/experiences", { params });
    setExperiences(data);
  }, [q, filterCountry, filterCity, filterType]);
  useEffect(() => { searchExperiences(); }, [searchExperiences]);

  // Global orientation modal state.
  const [orient, setOrient] = useState(null);
  const openOrient = useCallback(async (opts) => {
    const { hotelName, city: cityHint, checkin, checkout, adults, onApply } = opts;
    let city = cityHint;
    if (!city && hotelName) {
      try {
        const { data } = await api.get("/hotels", { params: { q: hotelName, include_imported: true } });
        const hit = (data || []).find((h) => (h.name || "").toLowerCase() === hotelName.toLowerCase())
                 || (data || [])[0];
        if (hit && hit.city) city = hit.city;
      } catch (_e) {
        // best-effort
      }
    }
    if (!city) {
      city = window.prompt(`¿Ciudad para buscar precio orientativo${hotelName ? ' de "' + hotelName + '"' : ""}?`, "");
      if (!city) return;
    }
    setOrient({ hotelName, city, busy: true, data: null, onApply });
    try {
      const { data } = await api.get("/hotels/price-orientation", {
        params: { city, checkin, checkout, adults: adults || 2 },
        timeout: 45000,
      });
      setOrient((prev) => prev ? { ...prev, data, busy: false } : prev);
    } catch (_e) {
      toast.error("Error consultando precio orientativo");
      setOrient(null);
    }
  }, []);

  // Debounced save with the latest itinerary snapshot.
  // Save the current itinerary immediately, cancelling any pending debounce.
  // Used by `onBlur` handlers on critical fields (name, dates) so a focus
  // change always persists the edit before the user can lose context.
  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    // Re-trigger save with 0ms delay (uses the latest state in setItn closure)
    setItn((cur) => {
      if (!cur) return cur;
      (async () => {
        setSaving(true);
        try {
          await api.patch(`/itineraries/${id}`, {
            name: cur.name, main_traveler: cur.main_traveler,
            start_date: cur.start_date, end_date: cur.end_date,
            duration_days: cur.duration_days, num_travelers: cur.num_travelers,
            travelers: cur.travelers, days: cur.days, accommodations: cur.accommodations,
            markup_pct: cur.markup_pct, commission_pct: cur.commission_pct,
            partner: cur.partner, currency: cur.currency, status: cur.status,
            room_config: cur.room_config,
          });
        } finally { setSaving(false); }
      })();
      return cur;
    });
  }, [id]);

  const schedSave = useCallback((next) => {
    setItn(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await api.patch(`/itineraries/${id}`, {
          name: next.name, main_traveler: next.main_traveler,
          start_date: next.start_date, end_date: next.end_date,
          duration_days: next.duration_days, num_travelers: next.num_travelers,
          travelers: next.travelers, days: next.days, accommodations: next.accommodations,
          markup_pct: next.markup_pct, commission_pct: next.commission_pct,
          partner: next.partner, currency: next.currency, status: next.status,
          room_config: next.room_config,
        });
      } finally { setSaving(false); }
    }, 600);
  }, [id]);

  const totals = useMemo(() => {
    if (!itn) return { sub_excl: 0, sub_incl: 0, sub_with_markup: 0, commission_eur: 0, markup_eur: 0, pvp: 0, iva: 0 };
    let excl = 0, incl = 0;
    (itn.days || []).forEach((d) => (d.services || []).forEach((s) => {
      excl += (s.unit_price_tax_excl || 0) * (s.quantity || 0);
      incl += (s.unit_price_tax_incl || s.unit_price || 0) * (s.quantity || 0);
    }));
    (itn.accommodations || []).forEach((a) => {
      excl += a.price_tax_excl || 0;
      incl += a.price_tax_incl || a.price || 0;
    });
    const mk = (itn.markup_pct || 0) / 100;
    const com = (itn.commission_pct || 0) / 100;
    const markup_eur = incl * mk;
    const sub_with_markup = incl + markup_eur;
    const commission_eur = sub_with_markup * com;
    const pvp = sub_with_markup + commission_eur;
    return { sub_excl: excl, sub_incl: incl, sub_with_markup, markup_eur, commission_eur, pvp, iva: incl - excl };
  }, [itn]);

  if (!itn) return <div className="p-10 text-sm text-clay-700">Cargando itinerario…</div>;

  const setField = (k, v) => {
    const next = { ...itn, [k]: v };
    // Auto-apply per-partner markup & commission defaults when the partner changes.
    if (k === "partner") {
      const defaults = {
        kimkim: { markup_pct: 33, commission_pct: 15 },
        zicasso: { markup_pct: 30, commission_pct: 10.5 },
        responsible_travel: { markup_pct: 30, commission_pct: 10 },
        direct: { markup_pct: 35, commission_pct: 0 },
        other: { markup_pct: 30, commission_pct: 0 },
      }[v] || { markup_pct: 30, commission_pct: 0 };
      next.markup_pct = defaults.markup_pct;
      next.commission_pct = defaults.commission_pct;
    }
    if (k === "start_date" || k === "end_date") {
      const n = daysBetween(k === "start_date" ? v : itn.start_date, k === "end_date" ? v : itn.end_date);
      next.duration_days = n;
      const current = [...(next.days || [])];
      if (n > current.length) {
        for (let i = current.length; i < n; i++) {
          current.push({ day_id: uid("day"), date: dateAdd(next.start_date, i), label: `Día ${i + 1}`, city: "", services: [] });
        }
      } else if (n < current.length) { current.length = n; }
      if (k === "start_date") current.forEach((d, i) => { d.date = dateAdd(v, i); d.label = `Día ${i + 1}`; });
      next.days = current;
    }
    schedSave(next);
  };

  const updateDay = (dayId, patch) =>
    schedSave({ ...itn, days: itn.days.map((d) => d.day_id === dayId ? { ...d, ...patch } : d) });

  const addDay = () => {
    const next = { ...itn };
    const i = (next.days || []).length;
    next.days = [...(next.days || []), { day_id: uid("day"), date: dateAdd(next.start_date, i), label: `Día ${i + 1}`, city: "", services: [] }];
    schedSave(next);
    setActiveDayId(next.days[next.days.length - 1].day_id);
  };

  const removeDay = (dayId) => {
    const next = { ...itn };
    next.days = (next.days || []).filter((d) => d.day_id !== dayId);
    next.days.forEach((d, i) => { d.label = `Día ${i + 1}`; if (next.start_date) d.date = dateAdd(next.start_date, i); });
    schedSave(next);
  };

  // SERVICE pricing rule:
  //   For experiences: qty = num_travelers, unit_price = catalog_total / catalog_pax (= €/pax).
  //   For lodging: handled separately by upsertAccommodationFromService.
  const addServiceToDay = (dayId, partial = {}) => {
    const trav = itn.num_travelers || 1;
    const expPax = Math.max(1, parseInt(partial.pax || 1, 10));
    const type = partial.type || "actividad";
    const isLodging = type === "alojamiento";
    const incl = partial.unit_price_tax_incl ?? 0;
    const excl = partial.unit_price_tax_excl ?? incl;
    const perPaxIncl = isLodging ? incl : (incl / expPax);
    const perPaxExcl = isLodging ? excl : (excl / expPax);
    const svc = {
      service_id: uid("svc"),
      experience_id: partial.experience_id || null,
      type,
      name: partial.name || "",
      provider_name: partial.provider_name || "",
      quantity: partial.quantity ?? (isLodging ? 1 : trav),
      pax: expPax,
      unit_price_tax_excl: Math.round(perPaxExcl * 100) / 100,
      unit_price_tax_incl: Math.round(perPaxIncl * 100) / 100,
      unit_price: Math.round(perPaxIncl * 100) / 100,
      currency: partial.currency || "EUR",
    };
    schedSave({ ...itn, days: itn.days.map((d) => d.day_id === dayId ? { ...d, services: [...(d.services || []), svc] } : d) });
    setActiveDayId(dayId);
  };

  const updateService = (dayId, sid, patch) => {
    const synced = { ...patch };
    if ("unit_price_tax_incl" in synced) synced.unit_price = synced.unit_price_tax_incl;
    schedSave({
      ...itn,
      days: itn.days.map((d) =>
        d.day_id === dayId
          ? { ...d, services: d.services.map((s) => s.service_id === sid ? { ...s, ...synced } : s) }
          : d),
    });
  };

  // LODGING pricing rule (from in-day service):
  //   qty = nights × num_rooms, unit_price = avg(rooms.price_per_night)
  // so qty × unit = total. See builder/AccommodationsBlock.jsx for the parallel
  // implementation triggered from the summary panel.
  const upsertAccommodationFromService = (dayId, service, dateFrom, dateTo) => {
    if (!service.name || !dateFrom || !dateTo) return;
    const dFrom = new Date(dateFrom);
    const dTo = new Date(dateTo);
    if (isNaN(dFrom) || isNaN(dTo) || dTo < dFrom) return;
    const accId = service.acc_id || uid("acc");
    const nights = Math.max(1, Math.round((dTo - dFrom) / 86400000));
    const typedNightlyIncl = service.unit_price_tax_incl || service.unit_price || 0;
    const typedNightlyExcl = service.unit_price_tax_excl || typedNightlyIncl;

    const accsBefore = itn.accommodations || [];
    const existingAcc = accsBefore.find((a) => a.acc_id === accId);
    const cfg = itn.room_config || [];
    const seedRooms = (existingAcc && existingAcc.rooms && existingAcc.rooms.length > 0)
      ? existingAcc.rooms
      : (cfg.length > 0 ? cfg : [{ room_type: "doble", pax: 2, quantity: 1 }])
          .flatMap((rc) => Array.from({ length: rc.quantity || 1 }, () => ({
            room_id: uid("room"),
            room_type: rc.room_type, pax: rc.pax,
            price_per_night_excl: 0, price_per_night_incl: 0, currency: "EUR",
          })));
    const roomsHaveAnyPrice = seedRooms.some((r) => (r.price_per_night_incl || 0) > 0 || (r.price_per_night_excl || 0) > 0);
    const rooms = seedRooms.map((r) => ({
      ...r,
      price_per_night_excl: roomsHaveAnyPrice ? r.price_per_night_excl : typedNightlyExcl,
      price_per_night_incl: roomsHaveAnyPrice ? r.price_per_night_incl : typedNightlyIncl,
    }));
    const numRooms = Math.max(1, rooms.length);
    const sumIncl = rooms.reduce((s, r) => s + (r.price_per_night_incl || r.price_per_night_excl || 0), 0);
    const sumExcl = rooms.reduce((s, r) => s + (r.price_per_night_excl || r.price_per_night_incl || 0), 0);
    const avgIncl = Math.round((sumIncl / numRooms) * 100) / 100;
    const avgExcl = Math.round((sumExcl / numRooms) * 100) / 100;
    const totalQty = nights * numRooms;
    const totalIncl = Math.round(avgIncl * totalQty * 100) / 100;
    const totalExcl = Math.round(avgExcl * totalQty * 100) / 100;
    const baseName = (service.name || "").replace(/^Check-in · |^Check-out · |^Alojamiento · /, "");
    const noteSummary = sumIncl
      ? `${nights} noches × ${numRooms} hab${numRooms === 1 ? "" : "s"} × €${avgIncl.toFixed(2)}/hab/noche`
      : "";

    const newDays = (itn.days || []).map((d) => {
      const filtered = (d.services || []).filter((s) =>
        s.acc_id !== accId || s.service_id === service.service_id
      );
      if (!d.date) return { ...d, services: filtered };
      const dd = new Date(d.date);
      if (isNaN(dd) || dd < dFrom || dd > dTo) {
        return { ...d, services: filtered.filter((s) => s.acc_id !== accId) };
      }
      const isCheckIn = dd.getTime() === dFrom.getTime();
      const isCheckOut = dd.getTime() === dTo.getTime();
      const label = isCheckIn ? `Check-in · ${baseName}`
                  : isCheckOut ? `Check-out · ${baseName}`
                  : `Alojamiento · ${baseName}`;
      const matrixIdx = filtered.findIndex((s) => s.service_id === service.service_id);
      const carrier = {
        acc_id: accId,
        type: "alojamiento",
        name: label,
        quantity: isCheckIn ? totalQty : 0,
        unit_price_tax_excl: isCheckIn ? avgExcl : 0,
        unit_price_tax_incl: isCheckIn ? avgIncl : 0,
        unit_price: isCheckIn ? avgIncl : 0,
        currency: "EUR",
        notes: isCheckIn ? noteSummary : "",
      };
      if (matrixIdx !== -1) {
        const services = [...filtered];
        services[matrixIdx] = { ...filtered[matrixIdx], ...carrier };
        return { ...d, services };
      }
      return {
        ...d,
        services: [
          ...filtered,
          { ...carrier, service_id: uid("svc"),
            experience_id: service.experience_id || null,
            provider_name: service.provider_name || null },
        ],
      };
    });

    const accs = [...accsBefore];
    const existingIdx = accs.findIndex((a) => a.acc_id === accId);
    const accRow = {
      acc_id: accId, name: baseName,
      date_from: dateFrom, date_to: dateTo,
      rooms,
      price_tax_excl: totalExcl, price_tax_incl: totalIncl, price: totalIncl,
      currency: "EUR",
    };
    if (existingIdx === -1) accs.push(accRow);
    else accs[existingIdx] = { ...accs[existingIdx], ...accRow };

    schedSave({ ...itn, days: newDays, accommodations: accs });
  };

  // Drag & drop: move a service between days or reorder within a day.
  const onDragStart = (srcDayId, srcServiceId) => { dragRef.current = { srcDayId, srcServiceId }; };
  const onDropService = (targetDayId, targetIndex) => {
    const src = dragRef.current;
    dragRef.current = null;
    if (!src) return;
    const { srcDayId, srcServiceId } = src;
    if (srcDayId === targetDayId && targetIndex === -1) return;
    let dragged = null;
    const days = itn.days.map((d) => {
      if (d.day_id !== srcDayId) return d;
      const services = [];
      for (const s of d.services || []) {
        if (s.service_id === srcServiceId) dragged = s;
        else services.push(s);
      }
      return { ...d, services };
    });
    if (!dragged) return;
    const finalDays = days.map((d) => {
      if (d.day_id !== targetDayId) return d;
      const services = [...(d.services || [])];
      if (targetIndex < 0 || targetIndex >= services.length) services.push(dragged);
      else services.splice(targetIndex, 0, dragged);
      return { ...d, services };
    });
    schedSave({ ...itn, days: finalDays });
    setActiveDayId(targetDayId);
  };
  const removeService = (dayId, sid) =>
    schedSave({ ...itn, days: itn.days.map((d) => d.day_id === dayId
      ? { ...d, services: d.services.filter((s) => s.service_id !== sid) } : d) });

  const addExperienceToActive = (exp) => {
    const targetDay = activeDayId || itn.days?.[0]?.day_id;
    if (!targetDay) { toast.error("Añade un día primero"); return; }
    addServiceToDay(targetDay, {
      experience_id: exp.experience_id, type: exp.type, name: exp.title,
      provider_name: exp.provider_name,
      pax: exp.pax || 1,
      unit_price_tax_excl: exp.price_tax_excl ?? 0,
      unit_price_tax_incl: exp.price_tax_incl ?? exp.price ?? 0,
      currency: exp.currency || "EUR",
    });
    toast.success(`Añadida a ${itn.days.find((d) => d.day_id === targetDay)?.label || "día"}`);
  };

  const exportXlsx = async () => {
    try {
      const res = await fetch(`${API_BASE}/itineraries/${id}/export`, { credentials: "include" });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${(itn.name || "itinerario").replace(/\s+/g, "_")}.xlsx`;
      link.click(); URL.revokeObjectURL(link.href);
      toast.success("Excel descargado");
    } catch (_e) { toast.error("No se pudo exportar"); }
  };

  return (
    <div className="grid grid-cols-[1fr_380px] min-h-screen">
      {/* Center: timeline */}
      <div className="px-8 py-6 border-r border-clay-300">
        <button onClick={() => navigate("/dashboard")} className="inline-flex items-center gap-2 text-xs smallcaps hover:text-terracotta" data-testid="back-dashboard">
          <ArrowLeft size={14} /> Itinerarios
        </button>

        <div className="mt-3 flex items-start justify-between gap-4">
          <div className="flex-1">
            <input
              data-testid="itn-name-input"
              className="font-serif text-4xl leading-none bg-transparent border-b border-clay-200 outline-none w-full px-1 py-1 hover:border-clay-400 focus:border-terracotta transition-colors"
              value={itn.name || ""}
              placeholder="Nombre del itinerario…"
              onChange={(e) => setField("name", e.target.value)}
              onBlur={flushSave}
            />
            <div className="smallcaps mt-2 flex items-center gap-3">
              <span data-testid="save-state">{saving ? "Guardando…" : "Guardado"}</span>
              <span>·</span>
              <select data-testid="itn-status" value={itn.status} onChange={(e) => setField("status", e.target.value)} className="bg-transparent border border-clay-300 px-2 py-0.5 text-[10px] uppercase tracking-widest">
                <option value="draft">Borrador</option>
                <option value="sold">Vendido</option>
                <option value="not_sold">No vendido</option>
              </select>
            </div>
          </div>
          <button onClick={exportXlsx} data-testid="export-xlsx" className="inline-flex items-center gap-2 px-4 py-2 border border-clay-300 hover:bg-clay-100 text-sm">
            <FileDown size={14} /> Exportar Excel
          </button>
        </div>

        {/* Trip metadata */}
        <div className="mt-6 grid grid-cols-5 gap-0 border border-clay-300">
          <Field label="Viajero principal">
            <input data-testid="main-traveler" className="w-full bg-transparent outline-none text-sm" value={itn.main_traveler || ""} onChange={(e) => setField("main_traveler", e.target.value)} placeholder="Nombre Apellido" />
          </Field>
          <Field label="Fuente">
            <PartnerSelector itn={itn} setField={setField} />
          </Field>
          <Field label="Inicio">
            <input data-testid="start-date" type="date" className="w-full bg-transparent outline-none text-sm tabular" value={itn.start_date || ""} onChange={(e) => setField("start_date", e.target.value)} />
          </Field>
          <Field label="Fin">
            <input data-testid="end-date" type="date" className="w-full bg-transparent outline-none text-sm tabular" value={itn.end_date || ""} onChange={(e) => setField("end_date", e.target.value)} />
          </Field>
          <Field label="Pax">
            <input data-testid="num-travelers" type="number" min={1} className="w-full bg-transparent outline-none text-sm tabular" value={itn.num_travelers || 1} onChange={(e) => setField("num_travelers", parseInt(e.target.value || "1", 10))} />
          </Field>
        </div>

        {/* Default room configuration */}
        <div className="mt-6">
          <RoomConfigEditor
            config={itn.room_config || []}
            numTravelers={itn.num_travelers}
            onChange={(next) => schedSave({ ...itn, room_config: next })}
          />
        </div>

        {/* Days */}
        <div className="mt-8 space-y-6">
          {(itn.days || []).map((day, idx) => (
            <DayBlock
              key={day.day_id}
              day={day}
              idx={idx}
              active={activeDayId === day.day_id}
              numTravelers={itn.num_travelers}
              accommodations={itn.accommodations || []}
              cityFacets={facets.cities}
              markup={itn.markup_pct || 0}
              onActivate={() => setActiveDayId(day.day_id)}
              onUpdateDay={(patch) => updateDay(day.day_id, patch)}
              onAddBlank={() => addServiceToDay(day.day_id)}
              onRemoveDay={() => removeDay(day.day_id)}
              onUpdateService={(sid, patch) => updateService(day.day_id, sid, patch)}
              onRemoveService={(sid) => removeService(day.day_id, sid)}
              onDragStart={onDragStart}
              onDropService={onDropService}
              onOrient={openOrient}
              onAccommodate={(svc, dFrom, dTo) => upsertAccommodationFromService(day.day_id, svc, dFrom, dTo)}
            />
          ))}
          <button onClick={addDay} data-testid="add-day-btn" className="w-full border border-dashed border-clay-300 py-3 text-sm text-clay-700 hover:border-terracotta hover:text-terracotta transition-colors">
            <Plus size={14} className="inline mr-2"/> Añadir día
          </button>
        </div>

        <AccommodationsBlock itn={itn} schedSave={schedSave} markup={itn.markup_pct || 0} onOrient={openOrient} />
      </div>

      {/* Right: search + cost summary */}
      <aside className="bg-clay-50/60">
        <div className="sticky top-0 max-h-screen overflow-auto flex flex-col">
          <div className="border-b border-clay-300 p-5 bg-white">
            <div className="smallcaps">Coste</div>
            <div className="grid-borders mt-3">
              <Row label="Subtotal con IVA">{fmtEUR(totals.sub_incl)}</Row>
              <Row label={(
                <div className="flex items-center gap-2">
                  <span>Markup</span>
                  <input data-testid="markup-input" type="number" step="0.5" min="0"
                    value={itn.markup_pct ?? 0}
                    onChange={(e) => setField("markup_pct", parseFloat(e.target.value || "0"))}
                    className="w-16 bg-transparent border border-clay-300 px-1 py-0.5 text-sm tabular text-right" />
                  <span className="text-xs text-clay-700">%</span>
                </div>
              )}>+ {fmtEUR(totals.markup_eur)}</Row>
              <Row label="Subtotal con markup">{fmtEUR(totals.sub_with_markup)}</Row>
              {(itn.commission_pct ?? 0) > 0 && (
                <Row label={(
                  <div className="flex items-center gap-2">
                    <span>Comisión <span className="text-clay-500 normal-case">({PARTNER_LABELS[itn.partner] || itn.partner})</span></span>
                    <input
                      data-testid="commission-input"
                      type="number" step="0.5" min="0"
                      value={itn.commission_pct ?? 0}
                      onChange={(e) => setField("commission_pct", parseFloat(e.target.value || "0"))}
                      className="w-16 bg-transparent border border-clay-300 px-1 py-0.5 text-sm tabular text-right"
                    />
                    <span className="text-xs text-clay-700">%</span>
                  </div>
                )}>+ {fmtEUR(totals.commission_eur)}</Row>
              )}
              <div className="flex items-center justify-between py-3 bg-clay-900 text-white px-3 mt-2" data-testid="final-price">
                <div className="smallcaps text-white/70">PVP final</div>
                <div className="font-serif text-2xl tabular">{fmtEUR(totals.pvp)}</div>
              </div>
              <FxConverter fx={fx} setFx={setFx} totals={totals} />
            </div>
          </div>

          <div className="p-5">
            <div className="smallcaps mb-3">Librería de experiencias</div>
            <div className="space-y-2">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-3 text-clay-500" />
                <input data-testid="exp-search" placeholder="Buscar título, proveedor…" value={q} onChange={(e) => setQ(e.target.value)} className="w-full pl-9 pr-3 py-2 bg-white border border-clay-300 text-sm focus:border-terracotta outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select data-testid="filter-country" value={filterCountry} onChange={(e) => setFilterCountry(e.target.value)} className="bg-white border border-clay-300 px-2 py-2 text-sm">
                  <option value="">País: todos</option>
                  {facets.countries.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <select data-testid="filter-type" value={filterType} onChange={(e) => setFilterType(e.target.value)} className="bg-white border border-clay-300 px-2 py-2 text-sm">
                  <option value="">Tipo: todos</option>
                  {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <input data-testid="filter-city" value={filterCity} onChange={(e) => setFilterCity(e.target.value)} placeholder="Ciudad" list="city-list-aside" className="w-full bg-white border border-clay-300 px-2 py-2 text-sm" />
              <datalist id="city-list-aside">
                {facets.cities.map((c) => <option key={c} value={c} />)}
              </datalist>
              <div className="text-[11px] text-clay-700">
                {experiences.length} resultados · día activo: <b>{itn.days.find((d) => d.day_id === activeDayId)?.label || "—"}</b>
              </div>
            </div>

            <div className="mt-4 space-y-2 max-h-[58vh] overflow-auto pr-1" data-testid="exp-results">
              {experiences.length === 0 ? (
                <div className="text-xs text-clay-700 p-4 border border-dashed border-clay-300">Sin resultados.</div>
              ) : experiences.map((e) => (
                <button key={e.experience_id} data-testid={`exp-add-${e.experience_id}`} onClick={() => addExperienceToActive(e)} className="w-full text-left p-3 bg-white border border-clay-300 hover:border-terracotta hover:bg-terracotta/5 transition-colors">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">{e.title}</div>
                      <div className="text-[11px] text-clay-700 mt-0.5 truncate flex items-center gap-1">
                        <MapPin size={10}/> {[e.city, e.country].filter(Boolean).join(" · ") || "—"} · {e.provider_name}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-semibold tabular text-sm">{fmtEUR(((e.price_tax_incl ?? e.price ?? 0) / Math.max(1, e.pax || 1)))} <span className="text-[9px] font-normal text-clay-700">/pax</span></div>
                      <div className="text-[10px] text-clay-700 tabular">
                        total {fmtEUR(e.price_tax_incl ?? e.price)} · <b>{e.pax || 2} pax</b>
                      </div>
                      <span className={`inline-block mt-1 px-1.5 py-0.5 text-[9px] tracking-widest uppercase ${TYPE_BADGE[e.type] || BADGE_FALLBACK}`}>{e.type}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </aside>

      {orient && (
        <OrientationModal
          city={orient.city}
          hotelName={orient.hotelName}
          checkin={orient.checkin}
          checkout={orient.checkout}
          adults={orient.adults}
          busy={orient.busy}
          data={orient.data}
          onClose={() => setOrient(null)}
          onApply={(price) => { if (orient.onApply) orient.onApply(price); setOrient(null); }}
        />
      )}
    </div>
  );
}
