import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Plus, Search, Trash2, GripVertical, FileDown, Bed, MapPin, Calendar } from "lucide-react";
import { toast } from "sonner";
import api, { API_BASE } from "@/lib/api";

const TYPE_BADGE = {
  alojamiento: "bg-pine text-white",
  actividad: "bg-terracotta text-white",
  transporte: "bg-clay-700 text-white",
  restaurante: "bg-[#8C5A2B] text-white",
  transfer: "bg-clay-500 text-white",
  vuelo: "bg-[#3C5A78] text-white",
  otro: "bg-clay-400 text-white",
};
const TYPES = ["alojamiento", "actividad", "transporte", "restaurante", "transfer", "vuelo", "otro"];

const fmtEUR = (n) => `€ ${Number(n || 0).toLocaleString("es-ES", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 12)}`;
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
          markup_pct: next.markup_pct, currency: next.currency, status: next.status,
        });
      } finally { setSaving(false); }
    }, 600);
  }, [id]);

  const totals = useMemo(() => {
    if (!itn) return { sub_excl: 0, sub_incl: 0, pvp: 0, iva: 0 };
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
    return { sub_excl: excl, sub_incl: incl, pvp: incl * (1 + mk), iva: incl - excl };
  }, [itn]);

  if (!itn) return <div className="p-10 text-sm text-clay-700">Cargando itinerario…</div>;

  const setField = (k, v) => {
    const next = { ...itn, [k]: v };
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
    const svc = {
      service_id: uid("svc"),
      experience_id: partial.experience_id || null,
      type: partial.type || "actividad",
      name: partial.name || "",
      provider_name: partial.provider_name || "",
      quantity: partial.quantity ?? (itn.num_travelers || 1),
      unit_price_tax_excl: partial.unit_price_tax_excl ?? 0,
      unit_price_tax_incl: partial.unit_price_tax_incl ?? 0,
      unit_price: partial.unit_price_tax_incl ?? 0,
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
  const removeService = (dayId, sid) => {
    schedSave({ ...itn, days: itn.days.map((d) => d.day_id === dayId ? { ...d, services: d.services.filter((s) => s.service_id !== sid) } : d) });
  };

  const addExperienceToActive = (exp) => {
    const targetDay = activeDayId || itn.days?.[0]?.day_id;
    if (!targetDay) { toast.error("Añade un día primero"); return; }
    addServiceToDay(targetDay, {
      experience_id: exp.experience_id, type: exp.type, name: exp.title,
      provider_name: exp.provider_name,
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
        <div className="mt-6 grid grid-cols-4 gap-0 border border-clay-300">
          <Field label="Viajero principal">
            <input data-testid="main-traveler" className="w-full bg-transparent outline-none text-sm" value={itn.main_traveler || ""} onChange={(e) => setField("main_traveler", e.target.value)} placeholder="Nombre Apellido" />
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

        {/* Days */}
        <div className="mt-8 space-y-6">
          {(itn.days || []).map((day, idx) => (
            <DayBlock
              key={day.day_id}
              day={day}
              idx={idx}
              active={activeDayId === day.day_id}
              numTravelers={itn.num_travelers}
              cityFacets={facets.cities}
              markup={itn.markup_pct || 0}
              onActivate={() => setActiveDayId(day.day_id)}
              onUpdateDay={(patch) => updateDay(day.day_id, patch)}
              onAddBlank={() => addServiceToDay(day.day_id)}
              onAddExperience={(exp) => addServiceToDay(day.day_id, {
                experience_id: exp.experience_id, type: exp.type, name: exp.title,
                provider_name: exp.provider_name,
                unit_price_tax_excl: exp.price_tax_excl ?? 0,
                unit_price_tax_incl: exp.price_tax_incl ?? exp.price ?? 0,
                currency: exp.currency,
              })}
              onRemoveDay={() => removeDay(day.day_id)}
              onUpdateService={(sid, patch) => updateService(day.day_id, sid, patch)}
              onRemoveService={(sid) => removeService(day.day_id, sid)}
            />
          ))}
          <button onClick={addDay} data-testid="add-day-btn" className="w-full border border-dashed border-clay-300 py-3 text-sm text-clay-700 hover:border-terracotta hover:text-terracotta transition-colors">
            <Plus size={14} className="inline mr-2"/> Añadir día
          </button>
        </div>

        <AccommodationsBlock itn={itn} schedSave={schedSave} markup={itn.markup_pct || 0} />
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
                  <span>Markup sobre IVA</span>
                  <input data-testid="markup-input" type="number" step="0.5" min="0"
                    value={itn.markup_pct ?? 0}
                    onChange={(e) => setField("markup_pct", parseFloat(e.target.value || "0"))}
                    className="w-16 bg-transparent border border-clay-300 px-1 py-0.5 text-sm tabular text-right" />
                  <span className="text-xs text-clay-700">%</span>
                </div>
              )}>+ {fmtEUR(totals.sub_incl * (itn.markup_pct || 0) / 100)}</Row>
              <div className="flex items-center justify-between py-3 bg-clay-900 text-white px-3 mt-2" data-testid="final-price">
                <div className="smallcaps text-white/70">PVP final</div>
                <div className="font-serif text-2xl tabular">{fmtEUR(totals.pvp)}</div>
              </div>
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
                      <div className="font-semibold tabular text-sm">{fmtEUR(e.price_tax_incl ?? e.price)}</div>
                      <div className="text-[10px] text-clay-700 tabular">sin IVA {fmtEUR(e.price_tax_excl)}</div>
                      <span className={`inline-block mt-1 px-1.5 py-0.5 text-[9px] tracking-widest uppercase ${TYPE_BADGE[e.type] || TYPE_BADGE.otro}`}>{e.type}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

function DayBlock({ day, idx, active, numTravelers, cityFacets, markup, onActivate, onUpdateDay, onAddBlank, onAddExperience, onRemoveDay, onUpdateService, onRemoveService }) {
  return (
    <div className={`border ${active ? "border-terracotta" : "border-clay-300"} bg-white transition-colors`} data-testid={`day-${idx}`} onClick={onActivate}>
      <div className="px-4 py-3 bg-clay-100 flex items-center justify-between border-b border-clay-300">
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
              placeholder="Ciudad (prefiltro)"
              onClick={(e) => e.stopPropagation()}
              className="bg-transparent outline-none border-b border-transparent focus:border-terracotta text-sm w-40"
            />
            <datalist id={`day-cities-${idx}`}>
              {(cityFacets || []).map((c) => <option key={c} value={c} />)}
            </datalist>
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
        <div className="p-6 text-center text-sm text-clay-700">
          <p>Selecciona experiencias en el panel derecho o pulsa <span className="font-semibold text-clay-900">+ servicio en blanco</span> para escribir manualmente con autocompletado.</p>
        </div>
      ) : (
        <div className="grid-borders">
          {day.services.map((s) => (
            <ServiceRow key={s.service_id} service={s} markup={markup} dayCity={day.city} numTravelers={numTravelers}
              onChange={(patch) => onUpdateService(s.service_id, patch)}
              onRemove={() => onRemoveService(s.service_id)}
              onPickExperience={(exp) => onUpdateService(s.service_id, {
                experience_id: exp.experience_id, name: exp.title, type: exp.type, provider_name: exp.provider_name,
                unit_price_tax_excl: exp.price_tax_excl ?? 0, unit_price_tax_incl: exp.price_tax_incl ?? exp.price ?? 0,
                unit_price: exp.price_tax_incl ?? exp.price ?? 0, currency: exp.currency || "EUR",
              })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ServiceRow({ service, markup, dayCity, onChange, onRemove, onPickExperience }) {
  const totalExcl = (service.unit_price_tax_excl || 0) * (service.quantity || 0);
  const totalIncl = (service.unit_price_tax_incl || service.unit_price || 0) * (service.quantity || 0);
  const totalPVP = totalIncl * (1 + (markup || 0) / 100);

  return (
    <div className="grid grid-cols-[28px_110px_1fr_60px_100px_100px_100px_30px] gap-2 items-center px-3 py-2.5 text-sm hover:bg-clay-50 transition-colors">
      <GripVertical size={14} className="text-clay-400" />
      <select className={`text-[10px] tracking-widest uppercase px-1.5 py-1 ${TYPE_BADGE[service.type] || TYPE_BADGE.otro} border-none outline-none`} value={service.type} onChange={(e) => onChange({ type: e.target.value })}>
        {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <div className="min-w-0">
        <AutocompleteInput
          value={service.name}
          dayCity={dayCity}
          serviceType={service.type}
          onTextChange={(v) => onChange({ name: v })}
          onPick={onPickExperience}
        />
        {service.provider_name && <div className="text-[11px] text-clay-700 truncate">{service.provider_name}</div>}
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
      <button onClick={onRemove} className="text-clay-500 hover:text-destructive p-1" title="Quitar"><Trash2 size={14}/></button>
    </div>
  );
}

function AutocompleteInput({ value, dayCity, serviceType, onTextChange, onPick }) {
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
    // Smart search: trigger at 3+ chars OR when there is a day city or a service type pre-filter
    if (t.length < 3 && !dayCity && !serviceType) { setResults([]); return; }
    const params = {};
    if (t) params.q = t;
    if (dayCity) params.city = dayCity;
    if (serviceType) params.type = serviceType;
    try {
      const { data } = await api.get("/experiences/autocomplete", { params });
      setResults(data); setHighlight(0);
    } catch (e) { setResults([]); }
  }, [dayCity, serviceType]);

  // Auto-refresh dropdown when user changes type or city pre-filter while it's open
  useEffect(() => {
    if (open) search(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceType, dayCity]);

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
        <div className="absolute left-0 right-0 top-full mt-1 z-40 bg-white border border-clay-300 shadow-lg max-h-72 overflow-auto" data-testid="svc-autocomplete">
          {results.map((r, i) => (
            <button
              key={r.experience_id}
              data-testid={`ac-${r.experience_id}`}
              onClick={() => { onPick(r); setOpen(false); }}
              onMouseEnter={() => setHighlight(i)}
              className={`w-full text-left px-3 py-2 text-sm border-b border-clay-200 last:border-0 ${i === highlight ? "bg-terracotta/10" : "hover:bg-clay-50"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold truncate">{r.title}</div>
                  <div className="text-[11px] text-clay-700 truncate">{r.provider_name} · {[r.city, r.country].filter(Boolean).join(" · ")}</div>
                </div>
                <div className="text-right shrink-0 text-xs">
                  <div className="tabular font-semibold">{fmtEUR(r.price_tax_incl ?? r.price)}</div>
                  <span className={`inline-block mt-0.5 px-1 py-0.5 text-[8px] tracking-widest uppercase ${TYPE_BADGE[r.type] || TYPE_BADGE.otro}`}>{r.type}</span>
                </div>
              </div>
            </button>
          ))}
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

function AccommodationsBlock({ itn, schedSave, markup }) {
  const add = () => {
    schedSave({ ...itn, accommodations: [...(itn.accommodations || []), { acc_id: uid("acc"), date_from: itn.start_date, date_to: itn.end_date, name: "", price_tax_excl: 0, price_tax_incl: 0, price: 0, currency: "EUR" }] });
  };
  const upd = (idx, patch) => {
    const synced = { ...patch };
    if ("price_tax_incl" in synced) synced.price = synced.price_tax_incl;
    const next = [...(itn.accommodations || [])];
    next[idx] = { ...next[idx], ...synced };
    schedSave({ ...itn, accommodations: next });
  };
  const del = (idx) => {
    schedSave({ ...itn, accommodations: (itn.accommodations || []).filter((_, i) => i !== idx) });
  };
  return (
    <div className="mt-10">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 smallcaps"><Bed size={13}/> Alojamientos (sumario)</div>
        <button onClick={add} className="text-xs inline-flex items-center gap-1 px-2 py-1 hover:bg-clay-200">
          <Plus size={12}/> Añadir alojamiento
        </button>
      </div>
      <div className="border border-clay-300 bg-white">
        {(itn.accommodations || []).length === 0 ? (
          <div className="p-4 text-sm text-clay-700">Opcional. Añade alojamientos resumidos por estancia.</div>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_130px_130px_100px_100px_100px_30px] gap-2 px-3 py-2 text-[10px] tracking-[0.2em] uppercase text-clay-700 font-semibold bg-clay-50 border-b border-clay-300">
              <div>Hotel / Apartamento</div><div>Desde</div><div>Hasta</div>
              <div className="text-right">Sin IVA</div><div className="text-right">Con IVA</div><div className="text-right">PVP</div><div></div>
            </div>
            {(itn.accommodations || []).map((a, idx) => {
              const incl = a.price_tax_incl || a.price || 0;
              const pvp = incl * (1 + (markup || 0) / 100);
              return (
                <div key={a.acc_id} className="grid grid-cols-[1fr_130px_130px_100px_100px_100px_30px] gap-2 px-3 py-2 items-center border-t border-clay-300 text-sm">
                  <input className="bg-transparent outline-none font-semibold" placeholder="Nombre del hotel" value={a.name} onChange={(e) => upd(idx, { name: e.target.value })} />
                  <input type="date" className="bg-transparent outline-none tabular" value={a.date_from || ""} onChange={(e) => upd(idx, { date_from: e.target.value })} />
                  <input type="date" className="bg-transparent outline-none tabular" value={a.date_to || ""} onChange={(e) => upd(idx, { date_to: e.target.value })} />
                  <input type="number" min="0" step="0.01" className="bg-transparent text-right outline-none tabular" value={a.price_tax_excl || 0} onChange={(e) => upd(idx, { price_tax_excl: parseFloat(e.target.value || "0") })} />
                  <input type="number" min="0" step="0.01" className="bg-transparent text-right outline-none tabular" value={incl} onChange={(e) => upd(idx, { price_tax_incl: parseFloat(e.target.value || "0") })} />
                  <div className="text-right tabular font-semibold">{fmtEUR(pvp)}</div>
                  <button onClick={() => del(idx)} className="text-clay-500 hover:text-destructive p-1"><Trash2 size={14}/></button>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
