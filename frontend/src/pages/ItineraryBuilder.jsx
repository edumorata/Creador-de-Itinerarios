import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Plus, Search, Trash2, GripVertical, FileDown, Bed, MapPin, Calendar, ExternalLink, AlertTriangle, X, Save } from "lucide-react";
import { toast } from "sonner";
import api, { API_BASE } from "@/lib/api";

const TYPE_BADGE = {
  alojamiento: "bg-pine text-white",
  actividad: "bg-terracotta text-white",
  entradas: "bg-[#8C5A2B] text-white",
  transfer: "bg-clay-500 text-white",
  tren: "bg-clay-700 text-white",
  vuelo: "bg-[#3C5A78] text-white",
};
const TYPES = ["actividad", "entradas", "transfer", "tren", "vuelo"];
// Types that scale with group size — for these, quantity = ceil(num_travelers / pax)
const SCALES_WITH_PAX = new Set(["actividad", "entradas", "transfer", "tren", "vuelo"]);
// Visual fallback for any unexpected legacy type strings
const BADGE_FALLBACK = "bg-clay-400 text-white";

const fmtEUR = (n) => `€ ${Number(n || 0).toLocaleString("es-ES", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const fmtUSD = (n) => `$ ${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0, minimumFractionDigits: 0 })}`;
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 12)}`;

// Partner labels used by the cost summary + selector.
const PARTNER_OPTIONS = [
  { value: "kimkim", label: "KimKim", hint: "+15% sobre coste · markup 33%" },
  { value: "zicasso", label: "Zicasso", hint: "+10.5% sobre coste · markup 30%" },
  { value: "responsible_travel", label: "Responsible Travel", hint: "+10% sobre coste · markup 30%" },
  { value: "direct", label: "Directo", hint: "sin comisión · markup 35%" },
  { value: "other", label: "Otro", hint: "manual" },
];
const PARTNER_LABELS = Object.fromEntries(PARTNER_OPTIONS.map((p) => [p.value, p.label]));
const fmt = (d) => {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString("es-ES", { day: "2-digit", month: "short" }); }
  catch { return d; }
};
const daysBetween = (a, b) => {
  if (!a || !b) return 0;
  return Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000) + 1);
};
const dateAdd = (start, n) => {
  if (!start) return "";
  const d = new Date(start); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

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

  // Drag & drop ref must be declared unconditionally (before any early return).
  const dragRef = useRef(null);

  // FX rate for EUR↔USD conversion. Auto-fetched on mount, editable by user.
  const [fx, setFx] = useState({ rate: 1.10, source: "loading", date: "" });
  useEffect(() => {
    let alive = true;
    api.get("/fx/rate").then(({ data }) => {
      if (alive && data && data.rate) setFx({ rate: Number(data.rate), source: data.source, date: data.date });
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

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
      // Auto-clean legacy city values like "Madrid-Barcelona" or any city
      // containing a dash — those were dead filters that returned 0 results.
      // Multi-city is now expressed with commas ("Madrid, Barcelona").
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

  // Global orientation modal state (used by AccommodationsBlock + day service rows).
  const [orient, setOrient] = useState(null); // {context, hotelName, city, dates, data, busy}
  const openOrient = useCallback(async (opts) => {
    const { hotelName, city: cityHint, checkin, checkout, adults, onApply } = opts;
    let city = cityHint;
    if (!city && hotelName) {
      try {
        const { data } = await api.get("/hotels", { params: { q: hotelName, include_imported: true } });
        const hit = (data || []).find((h) => (h.name || "").toLowerCase() === hotelName.toLowerCase())
                 || (data || [])[0];
        if (hit && hit.city) city = hit.city;
      } catch (e) {
        // Hotel-name lookup is best-effort — falls through to the day-plan
        // city detection if /api/hotels fails (offline, rate-limited, etc.).
        console.debug("hotel city lookup failed (using fallback)", e?.message);
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
    } catch (e) {
      toast.error("Error consultando precio orientativo");
      setOrient(null);
    }
  }, []);

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

  const updateDay = (dayId, patch) => {
    schedSave({ ...itn, days: itn.days.map((d) => d.day_id === dayId ? { ...d, ...patch } : d) });
  };

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

  const addServiceToDay = (dayId, partial = {}) => {
    // Always store the SERVICE price as price-per-pax × num_travelers.
    // The catalog stores `price_for_pax` (total for `experience.pax` people),
    // so €/pax = price_for_pax / experience.pax. Then qty = num_travelers and
    // unit_price = €/pax, so qty × unit = total cost for the whole group.
    // Group-priced services (transfer for 3, tour for 4, etc.) still scale
    // linearly because the user can override qty manually if needed (or we
    // could later round up by capacity — but the user explicitly asked for
    // "always price per pax × travelers", so that's what we do).
    const trav = itn.num_travelers || 1;
    const expPax = Math.max(1, parseInt(partial.pax || 1, 10));
    const type = partial.type || "actividad";
    const isLodging = type === "alojamiento";
    // For experiences: convert catalog total → per-pax.
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
      pax: expPax,  // pax the catalog price was originally quoted for (informative)
      unit_price_tax_excl: Math.round(perPaxExcl * 100) / 100,
      unit_price_tax_incl: Math.round(perPaxIncl * 100) / 100,
      unit_price: Math.round(perPaxIncl * 100) / 100,
      currency: partial.currency || "EUR",
    };
    const next = { ...itn, days: itn.days.map((d) => d.day_id === dayId ? { ...d, services: [...(d.services || []), svc] } : d) };
    schedSave(next);
    setActiveDayId(dayId);
  };

  const updateService = (dayId, sid, patch) => {
    const synced = { ...patch };
    if ("unit_price_tax_incl" in synced) synced.unit_price = synced.unit_price_tax_incl;
    const next = { ...itn, days: itn.days.map((d) => d.day_id === dayId ? { ...d, services: d.services.map((s) => s.service_id === sid ? { ...s, ...synced } : s) } : d) };
    schedSave(next);
  };

  // -------------------------------------------------------------------------
  // Accommodation from an in-day service. Triggered when the user sets
  // check-in + check-out dates on an "alojamiento" service row.
  //
  // MODEL (simple & consistent with experiences):
  //   qty        = nights × num_rooms
  //   unit_price = €/room/night (= the median per-room price)
  // So qty × unit = total cost. If the user has 2 rooms × 2 nights at
  // €303/room/night → qty=4, unit=€303, total=€1.212.
  // -------------------------------------------------------------------------
  const upsertAccommodationFromService = (dayId, service, dateFrom, dateTo) => {
    if (!service.name || !dateFrom || !dateTo) return;
    const dFrom = new Date(dateFrom);
    const dTo = new Date(dateTo);
    if (isNaN(dFrom) || isNaN(dTo) || dTo < dFrom) return;
    const accId = service.acc_id || uid("acc");
    const nights = Math.max(1, Math.round((dTo - dFrom) / 86400000));
    // The matrix row's unit price reflects ONE room per night (user-typed).
    const typedNightlyIncl = service.unit_price_tax_incl || service.unit_price || 0;
    const typedNightlyExcl = service.unit_price_tax_excl || typedNightlyIncl;

    // Source of truth for room layout: existing accommodation.rooms (if any)
    // else the itinerary default config, else "1 doble".
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
    // If rooms had no prices, propagate the user-typed unit_price. If they did,
    // keep user-edited per-room values.
    const roomsHaveAnyPrice = seedRooms.some((r) => (r.price_per_night_incl || 0) > 0 || (r.price_per_night_excl || 0) > 0);
    const rooms = seedRooms.map((r) => ({
      ...r,
      price_per_night_excl: roomsHaveAnyPrice ? r.price_per_night_excl : typedNightlyExcl,
      price_per_night_incl: roomsHaveAnyPrice ? r.price_per_night_incl : typedNightlyIncl,
    }));
    const numRooms = Math.max(1, rooms.length);
    // Average €/room/night (so multi-room hotels with different room prices
    // still satisfy qty × unit = total).
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
  // targetIndex = -1 means "append at end".
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
  const removeService = (dayId, sid) => {
    schedSave({ ...itn, days: itn.days.map((d) => d.day_id === dayId ? { ...d, services: d.services.filter((s) => s.service_id !== sid) } : d) });
  };

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
    } catch (e) { toast.error("No se pudo exportar"); }
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
              className="font-serif text-4xl leading-none bg-transparent border-none outline-none w-full focus:border-b focus:border-terracotta"
              value={itn.name}
              onChange={(e) => setField("name", e.target.value)}
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

        {/* Default room configuration — applied when adding new accommodations */}
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
              onAddExperience={(exp) => addServiceToDay(day.day_id, {
                experience_id: exp.experience_id, type: exp.type, name: exp.title,
                provider_name: exp.provider_name,
                pax: exp.pax || 1,
                unit_price_tax_excl: exp.price_tax_excl ?? 0,
                unit_price_tax_incl: exp.price_tax_incl ?? exp.price ?? 0,
                currency: exp.currency,
              })}
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
              <Row label="Subtotal sin IVA">{fmtEUR(totals.sub_excl)}</Row>
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
          busy={orient.busy}
          data={orient.data}
          onClose={() => setOrient(null)}
          onApply={(price) => { if (orient.onApply) orient.onApply(price); setOrient(null); }}
        />
      )}
    </div>
  );
}

function DayBlock({ day, idx, active, numTravelers, accommodations, cityFacets, markup, onActivate, onUpdateDay, onAddBlank, onAddExperience, onRemoveDay, onUpdateService, onRemoveService, onDragStart, onDropService, onOrient, onAccommodate }) {
  const [dragOverIdx, setDragOverIdx] = useState(null);
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
                data-testid={`day-city-clear-${idx}`}
                onClick={(e) => { e.stopPropagation(); onUpdateDay({ city: "" }); }}
                className="ml-1 px-1.5 py-0.5 text-[9px] uppercase tracking-wider bg-clay-100 hover:bg-terracotta hover:text-white"
                title="Quitar filtro de ciudad — buscar por todo el país"
              >
                Todo el país
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

      {/* Header row for prices */}
      {(day.services || []).length > 0 && (
        <div className="grid grid-cols-[28px_110px_1fr_60px_100px_100px_100px_30px] gap-2 px-3 py-2 text-[10px] tracking-[0.2em] uppercase text-clay-700 font-semibold bg-clay-50 border-b border-clay-300">
          <div></div><div>Tipo</div><div>Servicio</div><div className="text-right">Qty</div>
          <div className="text-right">Sin IVA</div><div className="text-right">Con IVA</div><div className="text-right">PVP</div><div></div>
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
              <ServiceRow service={s} markup={markup} dayCity={day.city} numTravelers={numTravelers}
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

function ServiceRow({ service, markup, dayCity, dayDate, numTravelers, accommodations, onChange, onRemove, onPickExperience, onDragStart, onOrient, onAccommodate, onSaveToCatalog }) {
  const totalExcl = (service.unit_price_tax_excl || 0) * (service.quantity || 0);
  const totalIncl = (service.unit_price_tax_incl || service.unit_price || 0) * (service.quantity || 0);
  const totalPVP = totalIncl * (1 + (markup || 0) / 100);
  const isLodging = service.type === "alojamiento";
  const linkedAcc = service.acc_id ? (accommodations || []).find((a) => a.acc_id === service.acc_id) : null;
  // Editable flag — only services backed by an experience_id can be persisted back to the catalog.
  const canSaveCatalog = !!service.experience_id && !isLodging;
  const [savingCatalog, setSavingCatalog] = useState(false);

  // Local state for the in-line check-in/out date inputs (only used for lodging).
  const [stayFrom, setStayFrom] = useState(dayDate || "");
  const [stayTo, setStayTo] = useState("");
  // Pre-fill from the linked accommodation when there is one (Check-in carrier),
  // otherwise fall back to dayDate. The previous logic derived check-out from
  // `service.quantity`, which broke when quantity = nights × rooms (new model).
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
      // The service stores price PER PAX. Catalog stores the TOTAL for `pax`
      // people, so multiply back. The user may have edited unit_price (which
      // is /pax) or pax itself; the catalog should reflect the new totals.
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
            checkout: dayDate,  // single-night; user can re-edit if needed
            adults: numTravelers || 2,
            onApply: (pricePerNight) => {
              // For a day-service hotel, assume 1 night × quantity (number of rooms or units).
              const qty = service.quantity || 1;
              const total = pricePerNight * qty;
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

function AutocompleteInput({ value, dayCity, serviceType, pax, onTextChange, onPick }) {
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
    } catch (e) { setResults([]); }
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

function Field({ label, children }) {
  return (
    <div className="px-4 py-3 border-r last:border-r-0 border-clay-300">
      <div className="smallcaps mb-1">{label}</div>
      {children}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between py-2.5 text-sm">
      <div className="text-clay-700">{label}</div>
      <div className="tabular font-semibold">{children}</div>
    </div>
  );
}

const ROOM_TYPES = ["single", "doble", "twin", "triple", "cuadruple", "suite", "family", "otro"];
const ROOM_PAX_DEFAULT = { single: 1, doble: 2, twin: 2, triple: 3, cuadruple: 4, suite: 2, family: 4, otro: 2 };

function AccommodationsBlock({ itn, schedSave, markup, onOrient }) {
  // Total nights across a stay
  const nightsBetween = (df, dt) => {
    if (!df || !dt) return 0;
    const a = new Date(df), b = new Date(dt);
    if (isNaN(a) || isNaN(b)) return 0;
    return Math.max(0, Math.round((b - a) / 86400000));
  };

  // Sum room prices × nights → totals used by the Excel export and PVP.
  const totalsFromRooms = (acc) => {
    const nights = nightsBetween(acc.date_from, acc.date_to) || 1;
    const rooms = acc.rooms || [];
    if (rooms.length === 0) return null;
    const excl = rooms.reduce((s, r) => s + (r.price_per_night_excl || 0), 0) * nights;
    const incl = rooms.reduce((s, r) => s + (r.price_per_night_incl || r.price_per_night_excl || 0), 0) * nights;
    return { excl, incl, nights };
  };

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
      // If room type changed and pax wasn't manually overridden in this same
      // patch, sync the default pax for the new type.
      if ("room_type" in patch && !("pax" in patch)) {
        merged.pax = ROOM_PAX_DEFAULT[patch.room_type] || merged.pax;
      }
      return merged;
    });
    updateRooms(idx, rooms);
  };
  const del = (idx) => {
    schedSave({ ...itn, accommodations: (itn.accommodations || []).filter((_, i) => i !== idx) });
  };
  const fetchOrient = (idx, a) => {
    onOrient?.({
      hotelName: a.name,
      city: null,  // resolved upstream from hotel catalog or day plan
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

  // ---------------------------------------------------------------------
  // Auto-spread the accommodation across day services.
  // Behaviour (matches user's spec):
  //   - On day = date_from   → service "CHECK-IN: <hotel>"
  //   - On days BETWEEN      → service "Alojamiento: <hotel>"
  //   - On day = date_to     → service "CHECK-OUT: <hotel>"
  //   Each service is tagged with acc_id so we can clean up the previous
  //   spread before re-spreading after a name/date change.
  // ---------------------------------------------------------------------
  const spreadAccommodation = (acc, hotelRecord) => {
    if (!acc.name || !acc.date_from || !acc.date_to) return;
    const dFrom = new Date(acc.date_from);
    const dTo = new Date(acc.date_to);
    if (isNaN(dFrom) || isNaN(dTo) || dTo < dFrom) return;
    const nights = Math.max(1, Math.round((dTo - dFrom) / 86400000));
    // Per-room nightly price: rooms list wins; else catalog; else derive from total.
    const rooms = acc.rooms || [];
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
    } else if (acc.price_tax_incl) {
      // Reverse-engineer per-room/night from the saved total.
      avgIncl = acc.price_tax_incl / (nights * numRooms);
      avgExcl = (acc.price_tax_excl || acc.price_tax_incl) / (nights * numRooms);
    } else {
      avgIncl = 0; avgExcl = 0;
    }
    avgIncl = Math.round(avgIncl * 100) / 100;
    avgExcl = Math.round(avgExcl * 100) / 100;
    const totalQty = nights * numRooms;
    const newDays = (itn.days || []).map((d) => {
      const filtered = (d.services || []).filter((s) => s.acc_id !== acc.acc_id);
      if (!d.date) return { ...d, services: filtered };
      const dd = new Date(d.date);
      if (isNaN(dd) || dd < dFrom || dd > dTo) return { ...d, services: filtered };
      let label;
      if (dd.getTime() === dFrom.getTime()) label = `Check-in · ${acc.name}`;
      else if (dd.getTime() === dTo.getTime()) label = `Check-out · ${acc.name}`;
      else label = `Alojamiento · ${acc.name}`;
      const isPriceCarrier = dd.getTime() === dFrom.getTime();
      const service = {
        service_id: uid("svc"),
        acc_id: acc.acc_id,
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
      };
      return { ...d, services: [...filtered, service] };
    });
    // Update the accommodation summary totals to match qty × unit.
    const totalIncl = Math.round(avgIncl * totalQty * 100) / 100;
    const totalExcl = Math.round(avgExcl * totalQty * 100) / 100;
    schedSave({
      ...itn,
      days: newDays,
      accommodations: (itn.accommodations || []).map((x) =>
        x.acc_id === acc.acc_id
          ? { ...x, name: acc.name, price_tax_incl: totalIncl, price_tax_excl: totalExcl, price: totalIncl }
          : x
      ),
    });
  };

  // Drop any spread for this acc_id from all day services (used on delete or
  // when the user clears the name/dates).
  const unspreadAccommodation = (acc_id) => {
    const newDays = (itn.days || []).map((d) => ({
      ...d,
      services: (d.services || []).filter((s) => s.acc_id !== acc_id),
    }));
    return newDays;
  };

  const updWithSpread = (idx, patch, hotelRecord = null) => {
    const synced = { ...patch };
    if ("price_tax_incl" in synced) synced.price = synced.price_tax_incl;
    const list = [...(itn.accommodations || [])];
    const newAcc = { ...list[idx], ...synced };
    list[idx] = newAcc;
    if (newAcc.name && newAcc.date_from && newAcc.date_to) {
      // Persist the list change FIRST, then run spread (which reads the latest itn).
      // To avoid stale `itn` reads we delegate to a synchronous helper that
      // takes the next accs array as argument.
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

  // Pick a hotel from the catalogue → fills name, populates rooms with the
  // catalog nightly price, and triggers spread.
  const pickHotel = (idx, hotel) => {
    // Apply catalog price to each room, then delegate spread+totals to updWithSpread.
    const accs = [...(itn.accommodations || [])];
    const current = accs[idx] || {};
    const existing = (current.rooms && current.rooms.length > 0) ? current.rooms : buildDefaultRooms();
    const rooms = existing.map((r) => ({
      ...r,
      price_per_night_excl: hotel.price_per_night_excl || hotel.price_per_night_incl || 0,
      price_per_night_incl: hotel.price_per_night_incl || hotel.price_per_night_excl || 0,
    }));
    accs[idx] = { ...current, name: hotel.name, rooms };
    // updWithSpread will read accs from itn — but we mutated `accs` locally.
    // To keep things atomic, build the next itn snapshot directly.
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
    // Spread to the days.
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

  // Wrap delete to also remove related day services.
  const delAndUnspread = (idx) => {
    const accId = (itn.accommodations || [])[idx]?.acc_id;
    const newDays = unspreadAccommodation(accId);
    schedSave({
      ...itn,
      accommodations: (itn.accommodations || []).filter((_, i) => i !== idx),
      days: newDays,
    });
  };

  // Detect date-range overlaps between accommodations. Two stays overlap when
  // [a.date_from, a.date_to) ∩ [b.date_from, b.date_to) is non-empty.
  // Touching at check-out day is NOT a conflict (a guest checks out in the
  // morning, into the next hotel the same day).
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
            {overlaps.map((o, i) => (
              <li key={i}>
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
                    <input
                      type="number" min="0" step="0.01"
                      className={`bg-transparent text-right outline-none tabular ${usingRooms ? "text-clay-500" : ""}`}
                      value={a.price_tax_excl || 0}
                      readOnly={usingRooms}
                      title={usingRooms ? "Calculado a partir de las habitaciones" : "Editable"}
                      onChange={(e) => upd(idx, { price_tax_excl: parseFloat(e.target.value || "0") })}
                    />
                    <input
                      type="number" min="0" step="0.01"
                      className={`bg-transparent text-right outline-none tabular ${usingRooms ? "text-clay-500" : ""}`}
                      value={incl}
                      readOnly={usingRooms}
                      title={usingRooms ? "Calculado a partir de las habitaciones" : "Editable"}
                      onChange={(e) => upd(idx, { price_tax_incl: parseFloat(e.target.value || "0") })}
                    />
                    <div className="text-right tabular font-semibold">{fmtEUR(pvp)}</div>
                    <button
                      data-testid={`orient-${idx}`}
                      onClick={() => fetchOrient(idx, a)}
                      title="Buscar precio orientativo · histórico + Expedia"
                      className="text-clay-700 hover:text-terracotta hover:bg-clay-100 p-1 border border-clay-300 flex items-center justify-center"
                    ><Search size={14}/></button>
                    <button onClick={() => delAndUnspread(idx)} className="text-clay-500 hover:text-destructive p-1"><Trash2 size={14}/></button>
                  </div>
                  {/* Rooms sub-row */}
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
                          <div key={r.room_id} className="grid grid-cols-[110px_70px_1fr_90px_90px_24px] gap-2 items-center text-xs border-l-2 border-clay-200 pl-2" data-testid={`room-${r.room_id}`}>
                            <select
                              className="bg-white border border-clay-200 px-1 py-0.5 text-xs"
                              value={r.room_type}
                              onChange={(e) => patchRoom(idx, r.room_id, { room_type: e.target.value })}
                              data-testid={`room-type-${r.room_id}`}
                            >
                              {ROOM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                            <input
                              type="number" min="1" max="20"
                              className="bg-white border border-clay-200 px-1 py-0.5 text-right tabular"
                              value={r.pax || 1}
                              onChange={(e) => patchRoom(idx, r.room_id, { pax: parseInt(e.target.value || "1", 10) })}
                              title="Pax en esta habitación"
                              data-testid={`room-pax-${r.room_id}`}
                            />
                            <div className="text-clay-700">€/noche</div>
                            <input
                              type="number" min="0" step="0.01"
                              className="bg-white border border-clay-200 px-1 py-0.5 text-right tabular"
                              value={r.price_per_night_excl || 0}
                              onChange={(e) => patchRoom(idx, r.room_id, { price_per_night_excl: parseFloat(e.target.value || "0") })}
                              title="Precio por noche sin IVA"
                              data-testid={`room-excl-${r.room_id}`}
                            />
                            <input
                              type="number" min="0" step="0.01"
                              className="bg-white border border-clay-200 px-1 py-0.5 text-right tabular"
                              value={r.price_per_night_incl || 0}
                              onChange={(e) => patchRoom(idx, r.room_id, { price_per_night_incl: parseFloat(e.target.value || "0") })}
                              title="Precio por noche con IVA"
                              data-testid={`room-incl-${r.room_id}`}
                            />
                            <button
                              onClick={() => removeRoom(idx, r.room_id)}
                              className="text-clay-400 hover:text-destructive"
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

function RoomConfigEditor({ config, numTravelers, onChange }) {
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
  const add = () => onChange([...list, { room_type: "doble", pax: 2, quantity: 1 }]);
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
        {list.map((r, i) => (
          <div key={i} className="inline-flex items-center gap-1 bg-white border border-clay-300 px-2 py-1 text-xs" data-testid={`room-config-${i}`}>
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
        ))}
        <button onClick={add} className="text-[11px] inline-flex items-center gap-1 px-2 py-1 border border-dashed border-clay-400 text-clay-700 hover:text-terracotta hover:border-terracotta" data-testid="add-room-config">
          <Plus size={11}/> Tipo de habitación
        </button>
      </div>
    </div>
  );
}

function OrientationModal({ city, hotelName, checkin, checkout, adults, busy, data, onClose, onApply }) {
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
                  {td.sample_hotels.slice(0,8).map((h,i) => (<span key={i} className="px-2 py-0.5 bg-clay-100 border border-clay-300">{h.name}</span>))}
                </div>
              </div>
            )}
          </div>
        )}
        {!busy && ex && (
          <div className="border border-clay-300 p-3 text-xs">
            <div className="smallcaps mb-1">Expedia.es {ex.blocked ? "(bloqueado por anti-bot)" : (ex.ok ? "" : "(sin resultados)")}</div>
            {ex.ok && (ex.results || []).slice(0,4).map((h, i) => (
              <div key={i} className="flex items-center justify-between py-1 border-t border-clay-200">
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

        {/* Always show the Expedia deep-link, even when our scraper was blocked. */}
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


// ---------------------------------------------------------------------------
// FX converter — shows the EUR totals in USD using the daily ECB rate fetched
// from /api/fx/rate. The rate is editable; "auto" resets it to the cached one.
// ---------------------------------------------------------------------------
function FxConverter({ fx, setFx, totals }) {
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
    } catch (e) {
      // FX refresh is best-effort; we keep showing the previously cached rate.
      console.debug("FX refresh failed", e?.message);
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


// ---------------------------------------------------------------------------
// PartnerSelector — controls the Itinerary.partner field. Changing it
// auto-applies the per-partner markup % and commission % defaults defined
// in setField above, but agents can override each number afterwards.
// ---------------------------------------------------------------------------
function PartnerSelector({ itn, setField }) {
  return (
    <select
      data-testid="itin-partner"
      value={itn.partner || "kimkim"}
      onChange={(e) => setField("partner", e.target.value)}
      className="w-full bg-transparent outline-none text-sm cursor-pointer"
      title="Fuente del cliente · ajusta markup y comisión automáticamente"
    >
      {PARTNER_OPTIONS.map((p) => (
        <option key={p.value} value={p.value}>{p.label}</option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// HotelAutocomplete — minimal autocomplete that queries /api/hotels?q=…
// and surfaces library hotels first, falling back to imported_from_trip so
// the user can also recall a hotel they saw in a past trip.
// ---------------------------------------------------------------------------
function HotelAutocomplete({ value, onTextChange, onPick, placeholder = "Buscar hotel…" }) {
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
      // Library first
      const lib = await api.get("/hotels", { params: { q: t } });
      let combined = (lib.data || []).slice(0, 20);
      // Pad with imported_from_trip when library is thin
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
    } catch (e) {
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

