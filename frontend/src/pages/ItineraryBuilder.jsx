import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Plus, Search, Trash2, GripVertical, FileDown, Save, Bed, MapPin, Calendar, ChevronDown } from "lucide-react";
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

function uid(p) { return `${p}_${Math.random().toString(36).slice(2, 12)}`; }
function fmt(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString("es-ES", { day: "2-digit", month: "short" }); }
  catch { return d; }
}
function daysBetween(a, b) {
  if (!a || !b) return 0;
  const A = new Date(a); const B = new Date(b);
  return Math.max(0, Math.round((B - A) / 86400000) + 1);
}
function dateAdd(start, n) {
  if (!start) return "";
  const d = new Date(start); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export default function ItineraryBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [itn, setItn] = useState(null);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef(null);

  // experience search
  const [q, setQ] = useState("");
  const [filterCountry, setFilterCountry] = useState("");
  const [filterType, setFilterType] = useState("");
  const [experiences, setExperiences] = useState([]);
  const [facets, setFacets] = useState({ countries: [], types: [] });
  const [activeDayId, setActiveDayId] = useState(null);

  // load
  useEffect(() => {
    (async () => {
      const { data } = await api.get(`/itineraries/${id}`);
      // ensure days match duration
      if ((!data.days || data.days.length === 0) && data.start_date && data.end_date) {
        const n = daysBetween(data.start_date, data.end_date);
        data.days = Array.from({ length: n }).map((_, i) => ({
          day_id: uid("day"),
          date: dateAdd(data.start_date, i),
          label: `Día ${i + 1}`,
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
    if (filterType) params.type = filterType;
    const { data } = await api.get("/experiences", { params });
    setExperiences(data);
  }, [q, filterCountry, filterType]);

  useEffect(() => { searchExperiences(); }, [searchExperiences]);

  // autosave
  const schedSave = useCallback((next) => {
    setItn(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await api.patch(`/itineraries/${id}`, {
          name: next.name,
          main_traveler: next.main_traveler,
          start_date: next.start_date,
          end_date: next.end_date,
          duration_days: next.duration_days,
          num_travelers: next.num_travelers,
          travelers: next.travelers,
          days: next.days,
          accommodations: next.accommodations,
          markup_pct: next.markup_pct,
          currency: next.currency,
          status: next.status,
        });
      } finally { setSaving(false); }
    }, 600);
  }, [id]);

  const totals = useMemo(() => {
    if (!itn) return { subtotal: 0, markup: 0, final: 0 };
    let s = 0;
    (itn.days || []).forEach((d) => (d.services || []).forEach((sv) => { s += (sv.unit_price || 0) * (sv.quantity || 0); }));
    (itn.accommodations || []).forEach((a) => { s += a.price || 0; });
    const m = s * (itn.markup_pct || 0) / 100;
    return { subtotal: s, markup: m, final: s + m };
  }, [itn]);

  if (!itn) return <div className="p-10 text-sm text-clay-700">Cargando itinerario…</div>;

  const setField = (k, v) => {
    const next = { ...itn, [k]: v };
    if (k === "start_date" || k === "end_date") {
      const n = daysBetween(k === "start_date" ? v : itn.start_date, k === "end_date" ? v : itn.end_date);
      next.duration_days = n;
      // adjust days
      const current = next.days || [];
      if (n > current.length) {
        for (let i = current.length; i < n; i++) {
          current.push({ day_id: uid("day"), date: dateAdd(next.start_date, i), label: `Día ${i + 1}`, services: [] });
        }
      } else if (n < current.length) {
        current.length = n;
      }
      // refresh dates if start changed
      if (k === "start_date") current.forEach((d, i) => { d.date = dateAdd(v, i); d.label = `Día ${i + 1}`; });
      next.days = current;
    }
    schedSave(next);
  };

  const addDay = () => {
    const next = { ...itn };
    const i = (next.days || []).length;
    next.days = [...(next.days || []), { day_id: uid("day"), date: dateAdd(next.start_date, i), label: `Día ${i + 1}`, services: [] }];
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
      unit_price: partial.unit_price ?? 0,
      currency: partial.currency || "EUR",
    };
    const next = { ...itn, days: itn.days.map((d) => d.day_id === dayId ? { ...d, services: [...(d.services || []), svc] } : d) };
    schedSave(next);
    setActiveDayId(dayId);
  };

  const updateService = (dayId, sid, patch) => {
    const next = { ...itn, days: itn.days.map((d) => d.day_id === dayId ? { ...d, services: d.services.map((s) => s.service_id === sid ? { ...s, ...patch } : s) } : d) };
    schedSave(next);
  };
  const removeService = (dayId, sid) => {
    const next = { ...itn, days: itn.days.map((d) => d.day_id === dayId ? { ...d, services: d.services.filter((s) => s.service_id !== sid) } : d) };
    schedSave(next);
  };

  const addExperienceToActive = (exp) => {
    const targetDay = activeDayId || itn.days?.[0]?.day_id;
    if (!targetDay) { toast.error("Añade un día primero"); return; }
    addServiceToDay(targetDay, {
      experience_id: exp.experience_id,
      type: exp.type,
      name: exp.title,
      provider_name: exp.provider_name,
      unit_price: exp.price,
      currency: exp.currency,
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
      link.click();
      URL.revokeObjectURL(link.href);
      toast.success("Excel descargado");
    } catch (e) { toast.error("No se pudo exportar"); }
  };

  return (
    <div className="grid grid-cols-[1fr_360px] min-h-screen">
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
              <select
                data-testid="itn-status"
                value={itn.status}
                onChange={(e) => setField("status", e.target.value)}
                className="bg-transparent border border-clay-300 px-2 py-0.5 text-[10px] uppercase tracking-widest"
              >
                <option value="draft">Borrador</option>
                <option value="sold">Vendido</option>
                <option value="not_sold">No vendido</option>
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportXlsx} data-testid="export-xlsx" className="inline-flex items-center gap-2 px-4 py-2 border border-clay-300 hover:bg-clay-100 text-sm">
              <FileDown size={14} /> Exportar Excel
            </button>
          </div>
        </div>

        {/* Trip metadata */}
        <div className="mt-6 grid grid-cols-4 gap-0 border border-clay-300">
          <Field label="Viajero principal">
            <input
              data-testid="main-traveler"
              className="w-full bg-transparent outline-none text-sm"
              value={itn.main_traveler || ""}
              onChange={(e) => setField("main_traveler", e.target.value)}
              placeholder="Nombre Apellido"
            />
          </Field>
          <Field label="Inicio">
            <input
              data-testid="start-date"
              type="date"
              className="w-full bg-transparent outline-none text-sm tabular"
              value={itn.start_date || ""}
              onChange={(e) => setField("start_date", e.target.value)}
            />
          </Field>
          <Field label="Fin">
            <input
              data-testid="end-date"
              type="date"
              className="w-full bg-transparent outline-none text-sm tabular"
              value={itn.end_date || ""}
              onChange={(e) => setField("end_date", e.target.value)}
            />
          </Field>
          <Field label="Pax">
            <input
              data-testid="num-travelers"
              type="number"
              min={1}
              className="w-full bg-transparent outline-none text-sm tabular"
              value={itn.num_travelers || 1}
              onChange={(e) => setField("num_travelers", parseInt(e.target.value || "1", 10))}
            />
          </Field>
        </div>

        {/* Days */}
        <div className="mt-8 space-y-6">
          {(itn.days || []).map((day, idx) => (
            <div key={day.day_id} className={`border ${activeDayId === day.day_id ? "border-terracotta" : "border-clay-300"} bg-white transition-colors`} data-testid={`day-${idx}`}>
              <div className="px-4 py-3 bg-clay-100 flex items-center justify-between border-b border-clay-300 cursor-pointer" onClick={() => setActiveDayId(day.day_id)}>
                <div className="flex items-center gap-4">
                  <div className="smallcaps">Día {idx + 1}</div>
                  <div className="flex items-center gap-2 text-sm text-clay-700"><Calendar size={13}/>{fmt(day.date)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button data-testid={`add-blank-${idx}`} className="text-xs px-2 py-1 hover:bg-clay-200 inline-flex items-center gap-1" onClick={(e) => { e.stopPropagation(); addServiceToDay(day.day_id); }}>
                    <Plus size={12}/> servicio en blanco
                  </button>
                  <button className="text-xs px-2 py-1 hover:bg-clay-200 text-destructive" onClick={(e) => { e.stopPropagation(); removeDay(day.day_id); }}>
                    Eliminar día
                  </button>
                </div>
              </div>
              {(day.services || []).length === 0 ? (
                <div className="p-6 text-center text-sm text-clay-700">Selecciona experiencias en el panel derecho para añadir servicios a este día.</div>
              ) : (
                <div className="grid-borders">
                  {day.services.map((s) => (
                    <ServiceRow
                      key={s.service_id}
                      service={s}
                      onChange={(patch) => updateService(day.day_id, s.service_id, patch)}
                      onRemove={() => removeService(day.day_id, s.service_id)}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
          <button onClick={addDay} data-testid="add-day-btn" className="w-full border border-dashed border-clay-300 py-3 text-sm text-clay-700 hover:border-terracotta hover:text-terracotta transition-colors">
            <Plus size={14} className="inline mr-2"/> Añadir día
          </button>
        </div>

        {/* Accommodations */}
        <AccommodationsBlock itn={itn} schedSave={schedSave} />
      </div>

      {/* Right: search + cost summary */}
      <aside className="bg-clay-50/60">
        <div className="sticky top-0 max-h-screen overflow-auto flex flex-col">
          {/* Cost summary */}
          <div className="border-b border-clay-300 p-5 bg-white">
            <div className="smallcaps">Coste</div>
            <div className="grid-borders mt-3">
              <Row label="Subtotal servicios">€ {totals.subtotal.toLocaleString("es-ES", { maximumFractionDigits: 2 })}</Row>
              <Row label={(
                <div className="flex items-center gap-2">
                  <span>Markup</span>
                  <input
                    data-testid="markup-input"
                    type="number" step="0.5" min="0"
                    value={itn.markup_pct ?? 0}
                    onChange={(e) => setField("markup_pct", parseFloat(e.target.value || "0"))}
                    className="w-16 bg-transparent border border-clay-300 px-1 py-0.5 text-sm tabular text-right"
                  /><span className="text-xs text-clay-700">%</span>
                </div>
              )}>+ € {totals.markup.toLocaleString("es-ES", { maximumFractionDigits: 2 })}</Row>
              <div className="flex items-center justify-between py-3 bg-clay-900 text-white px-3 mt-2" data-testid="final-price">
                <div className="smallcaps text-white/70">Precio final</div>
                <div className="font-serif text-2xl tabular">€ {totals.final.toLocaleString("es-ES", { maximumFractionDigits: 2 })}</div>
              </div>
            </div>
          </div>

          {/* Experience library */}
          <div className="p-5">
            <div className="smallcaps mb-3">Librería de experiencias</div>
            <div className="space-y-2">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-3 text-clay-500" />
                <input
                  data-testid="exp-search"
                  placeholder="Buscar por nombre, descripción, proveedor…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 bg-white border border-clay-300 text-sm focus:border-terracotta outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select data-testid="filter-country" value={filterCountry} onChange={(e) => setFilterCountry(e.target.value)} className="bg-white border border-clay-300 px-2 py-2 text-sm">
                  <option value="">Todos los países</option>
                  {facets.countries.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <select data-testid="filter-type" value={filterType} onChange={(e) => setFilterType(e.target.value)} className="bg-white border border-clay-300 px-2 py-2 text-sm">
                  <option value="">Todos los tipos</option>
                  {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="text-[11px] text-clay-700">
                Selecciona el día activo arriba y haz click en una experiencia para añadirla.
              </div>
            </div>

            <div className="mt-4 space-y-2 max-h-[58vh] overflow-auto pr-1" data-testid="exp-results">
              {experiences.length === 0 ? (
                <div className="text-xs text-clay-700 p-4 border border-dashed border-clay-300">
                  No hay resultados. Crea experiencias desde la página <strong>Experiencias</strong>.
                </div>
              ) : experiences.map((e) => (
                <button
                  key={e.experience_id}
                  data-testid={`exp-add-${e.experience_id}`}
                  onClick={() => addExperienceToActive(e)}
                  className="w-full text-left p-3 bg-white border border-clay-300 hover:border-terracotta hover:bg-terracotta/5 transition-colors"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">{e.title}</div>
                      <div className="text-[11px] text-clay-700 mt-0.5 truncate flex items-center gap-1">
                        <MapPin size={10}/> {[e.city, e.country].filter(Boolean).join(" · ") || "—"} · {e.provider_name}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-semibold tabular text-sm">€ {Number(e.price || 0).toLocaleString("es-ES")}</div>
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

function ServiceRow({ service, onChange, onRemove }) {
  const total = (service.unit_price || 0) * (service.quantity || 0);
  return (
    <div className="grid grid-cols-[28px_120px_1fr_70px_110px_110px_30px] gap-2 items-center px-3 py-2.5 text-sm hover:bg-clay-50 transition-colors">
      <GripVertical size={14} className="text-clay-400" />
      <select
        className={`text-[10px] tracking-widest uppercase px-1.5 py-1 ${TYPE_BADGE[service.type] || TYPE_BADGE.otro} border-none outline-none`}
        value={service.type}
        onChange={(e) => onChange({ type: e.target.value })}
      >
        {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <div className="min-w-0">
        <input
          className="w-full bg-transparent outline-none font-semibold truncate"
          value={service.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Nombre del servicio"
        />
        {service.provider_name && <div className="text-[11px] text-clay-700 truncate">{service.provider_name}</div>}
      </div>
      <input
        type="number" min="0" step="1"
        className="bg-transparent text-right outline-none tabular"
        value={service.quantity || 0}
        onChange={(e) => onChange({ quantity: parseFloat(e.target.value || "0") })}
        title="Cantidad"
      />
      <div className="flex items-center gap-1 justify-end">
        <span className="text-clay-500 text-xs">€</span>
        <input
          type="number" min="0" step="0.01"
          className="bg-transparent text-right outline-none tabular w-20"
          value={service.unit_price || 0}
          onChange={(e) => onChange({ unit_price: parseFloat(e.target.value || "0") })}
        />
      </div>
      <div className="text-right tabular font-semibold">€ {total.toLocaleString("es-ES", { maximumFractionDigits: 2 })}</div>
      <button onClick={onRemove} className="text-clay-500 hover:text-destructive p-1" title="Quitar">
        <Trash2 size={14}/>
      </button>
    </div>
  );
}

function AccommodationsBlock({ itn, schedSave }) {
  const add = () => {
    schedSave({ ...itn, accommodations: [...(itn.accommodations || []), { acc_id: uid("acc"), date_from: itn.start_date, date_to: itn.end_date, name: "", price: 0, currency: "EUR" }] });
  };
  const upd = (idx, patch) => {
    const next = [...(itn.accommodations || [])];
    next[idx] = { ...next[idx], ...patch };
    schedSave({ ...itn, accommodations: next });
  };
  const del = (idx) => {
    const next = (itn.accommodations || []).filter((_, i) => i !== idx);
    schedSave({ ...itn, accommodations: next });
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
        ) : (itn.accommodations || []).map((a, idx) => (
          <div key={a.acc_id} className="grid grid-cols-[1fr_140px_140px_120px_30px] gap-2 px-3 py-2 items-center border-t first:border-t-0 border-clay-300">
            <input className="bg-transparent outline-none text-sm font-semibold" placeholder="Nombre del hotel / apartamento" value={a.name} onChange={(e) => upd(idx, { name: e.target.value })} />
            <input type="date" className="bg-transparent outline-none text-sm tabular" value={a.date_from || ""} onChange={(e) => upd(idx, { date_from: e.target.value })} />
            <input type="date" className="bg-transparent outline-none text-sm tabular" value={a.date_to || ""} onChange={(e) => upd(idx, { date_to: e.target.value })} />
            <div className="flex items-center gap-1 justify-end">
              <span className="text-clay-500 text-xs">€</span>
              <input type="number" min="0" step="0.01" className="bg-transparent text-right outline-none tabular w-24" value={a.price || 0} onChange={(e) => upd(idx, { price: parseFloat(e.target.value || "0") })} />
            </div>
            <button onClick={() => del(idx)} className="text-clay-500 hover:text-destructive p-1"><Trash2 size={14}/></button>
          </div>
        ))}
      </div>
    </div>
  );
}
