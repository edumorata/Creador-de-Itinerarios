import React, { useEffect, useState } from "react";
import { Plus, Search, Trash2, Pencil, Upload, X, Server } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";
import { useAuth } from "@/lib/auth";

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

const EMPTY = { title: "", description: "", provider_id: "", country: "", city: "", type: "actividad", price_tax_excl: 0, price_tax_incl: 0, currency: "EUR", pax: 2 };

export default function Experiences() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [providers, setProviders] = useState([]);
  const [facets, setFacets] = useState({ countries: [], cities: [], types: [] });
  const [q, setQ] = useState("");
  const [filterCountry, setFilterCountry] = useState("");
  const [filterCity, setFilterCity] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterPax, setFilterPax] = useState("");
  const [editing, setEditing] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [csvUploadOpen, setCsvUploadOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = {};
      if (q) params.q = q;
      if (filterCountry) params.country = filterCountry;
      if (filterCity) params.city = filterCity;
      if (filterType) params.type = filterType;
      const [a, b, c] = await Promise.all([
        api.get("/experiences", { params }),
        api.get("/providers"),
        api.get("/experiences/facets"),
      ]);
      let rows = a.data;
      if (filterPax) rows = rows.filter((r) => String(r.pax || 2) === filterPax);
      setItems(rows); setProviders(b.data); setFacets(c.data);
    } finally { setLoading(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [q, filterCountry, filterCity, filterType, filterPax]);

  const save = async () => {
    if (!editing.provider_id) { toast.error("El proveedor es obligatorio"); return; }
    if (!editing.title) { toast.error("El título es obligatorio"); return; }
    try {
      if (editing.experience_id) {
        await api.patch(`/experiences/${editing.experience_id}`, editing);
        toast.success("Experiencia actualizada");
      } else {
        await api.post("/experiences", editing);
        toast.success("Experiencia creada");
      }
      setEditing(null); load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Error al guardar"); }
  };

  const del = async (id) => {
    if (!window.confirm("¿Eliminar esta experiencia?")) return;
    await api.delete(`/experiences/${id}`); load();
  };

  return (
    <div className="px-8 py-8 max-w-7xl">
      <div className="flex items-end justify-between mb-6">
        <div>
          <div className="smallcaps">Librería</div>
          <h1 className="font-serif text-5xl leading-none mt-3">Experiencias</h1>
          <p className="text-sm text-clay-700 mt-3 max-w-lg">
            Catálogo de servicios disponibles para construir itinerarios. Cada experiencia tiene un proveedor que define el precio.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {user?.role === "admin" && (
            <>
              <button
                data-testid="csv-upload-btn"
                disabled={bulkBusy}
                onClick={() => setCsvUploadOpen(true)}
                className="inline-flex items-center gap-2 px-4 py-2 border border-clay-300 hover:bg-clay-100 text-sm disabled:opacity-50"
              >
                <Upload size={14}/> Subir CSV operadores
              </button>
              <button
                data-testid="bulk-import-btn"
                disabled={bulkBusy}
                onClick={async () => {
                  if (!window.confirm("Importar TODOS los Excel de proveedores almacenados en el servidor (~94 archivos)?")) return;
                  setBulkBusy(true);
                  try {
                    const { data } = await api.post("/experiences/import-all-server");
                    toast.success(`${data.total_created} experiencias añadidas (${data.files_scanned} archivos, ${data.total_skipped} duplicadas saltadas)`);
                    load();
                  } catch (e) { toast.error(e?.response?.data?.detail || "Error en la importación masiva"); }
                  finally { setBulkBusy(false); }
                }}
                className="inline-flex items-center gap-2 px-4 py-2 border border-clay-300 hover:bg-clay-100 text-sm disabled:opacity-50"
              >
                <Server size={14}/> Tarifas proveedores
              </button>
            </>
          )}
          <button data-testid="import-btn" onClick={() => setImportOpen(true)} className="inline-flex items-center gap-2 px-4 py-2 border border-clay-300 hover:bg-clay-100 text-sm">
            <Upload size={14}/> Importar desde Excel
          </button>
          <button data-testid="new-experience-btn" onClick={() => setEditing({ ...EMPTY })} className="inline-flex items-center gap-2 px-4 py-2 bg-clay-900 text-white text-sm tracking-wider uppercase hover:bg-terracotta">
            <Plus size={14}/> Nueva experiencia
          </button>
        </div>
      </div>

      {/* filters */}
      <div className="grid grid-cols-[1fr_160px_160px_140px_110px] gap-3 mb-4">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-3 text-clay-500" />
          <input data-testid="exp-search-input" className="w-full pl-9 pr-3 py-2 bg-white border border-clay-300 text-sm outline-none focus:border-terracotta" placeholder="Buscar (palabras separadas, busca en cualquier orden)…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select data-testid="filter-country" className="bg-white border border-clay-300 px-3 py-2 text-sm" value={filterCountry} onChange={(e) => setFilterCountry(e.target.value)}>
          <option value="">País: todos</option>
          {facets.countries.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select data-testid="filter-city" className="bg-white border border-clay-300 px-3 py-2 text-sm" value={filterCity} onChange={(e) => setFilterCity(e.target.value)}>
          <option value="">Ciudad: todas</option>
          {facets.cities.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select data-testid="filter-type" className="bg-white border border-clay-300 px-3 py-2 text-sm" value={filterType} onChange={(e) => setFilterType(e.target.value)}>
          <option value="">Todos los tipos</option>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select data-testid="filter-pax" className="bg-white border border-clay-300 px-3 py-2 text-sm" value={filterPax} onChange={(e) => setFilterPax(e.target.value)}>
          <option value="">Pax: todos</option>
          {[1,2,3,4,5,6,7,8,9,10,11,12].map((n) => <option key={n} value={n}>{n} pax</option>)}
        </select>
      </div>

      <div className="border border-clay-300 bg-white">
        <div className="grid grid-cols-[1.5fr_1fr_0.7fr_1fr_0.5fr_0.6fr_0.6fr_auto] bg-clay-100 text-[11px] tracking-[0.2em] uppercase text-clay-700 font-semibold">
          <div className="px-4 py-3">Título</div>
          <div className="px-4 py-3">Proveedor</div>
          <div className="px-4 py-3">Tipo</div>
          <div className="px-4 py-3">Ciudad / País</div>
          <div className="px-4 py-3 text-center">Pax</div>
          <div className="px-4 py-3 text-right">Sin IVA</div>
          <div className="px-4 py-3 text-right">Con IVA</div>
          <div className="px-4 py-3 text-right">Acciones</div>
        </div>
        {loading ? (
          <div className="p-6 text-sm text-clay-700">Cargando…</div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center text-sm text-clay-700" data-testid="exp-empty">No hay experiencias. Crea una nueva o importa un Excel de proveedor.</div>
        ) : items.map((e) => (
          <div key={e.experience_id} className="grid grid-cols-[1.5fr_1fr_0.7fr_1fr_0.5fr_0.6fr_0.6fr_auto] border-t border-clay-300 text-sm hover:bg-clay-50 transition-colors" data-testid={`exp-row-${e.experience_id}`}>
            <div className="px-4 py-3">
              <div className="font-semibold truncate">{e.title}</div>
              {e.description && <div className="text-[11px] text-clay-700 truncate">{e.description}</div>}
            </div>
            <div className="px-4 py-3 text-clay-700 truncate">{e.provider_name}</div>
            <div className="px-4 py-3"><span className={`inline-block px-1.5 py-0.5 text-[9px] tracking-widest uppercase ${TYPE_BADGE[e.type] || TYPE_BADGE.otro}`}>{e.type}</span></div>
            <div className="px-4 py-3 text-clay-700">{[e.city, e.country].filter(Boolean).join(" · ") || "—"}</div>
            <div className="px-4 py-3 text-center tabular font-semibold" data-testid={`pax-${e.experience_id}`}>{e.pax || 2}</div>
            <div className="px-4 py-3 text-right tabular text-clay-700">{Number(e.price_tax_excl || 0).toLocaleString("es-ES")}</div>
            <div className="px-4 py-3 text-right tabular font-semibold">{Number(e.price_tax_incl || e.price || 0).toLocaleString("es-ES")}</div>
            <div className="px-4 py-3 flex items-center justify-end gap-1">
              <button onClick={() => setEditing({ ...e })} className="p-1.5 hover:bg-clay-200" data-testid={`edit-${e.experience_id}`}><Pencil size={14}/></button>
              <button onClick={() => del(e.experience_id)} className="p-1.5 hover:bg-clay-200 text-destructive"><Trash2 size={14}/></button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <Modal onClose={() => setEditing(null)} title={editing.experience_id ? "Editar experiencia" : "Nueva experiencia"}>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Título *" value={editing.title} onChange={(v) => setEditing({ ...editing, title: v })} tid="exp-title" />
            <Select label="Proveedor *" value={editing.provider_id} onChange={(v) => setEditing({ ...editing, provider_id: v })} tid="exp-provider">
              <option value="">Selecciona proveedor</option>
              {providers.map((p) => <option key={p.provider_id} value={p.provider_id}>{p.name}</option>)}
            </Select>
            <Select label="Tipo" value={editing.type} onChange={(v) => setEditing({ ...editing, type: v })} tid="exp-type">
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
            <Input label="Moneda" value={editing.currency} onChange={(v) => setEditing({ ...editing, currency: v })} />
            <NumberInput label="Precio sin IVA" value={editing.price_tax_excl} onChange={(v) => setEditing({ ...editing, price_tax_excl: v })} tid="exp-price-excl" />
            <NumberInput label="Precio con IVA" value={editing.price_tax_incl} onChange={(v) => setEditing({ ...editing, price_tax_incl: v, price: v })} tid="exp-price-incl" />
            <NumberInput label="Pax (nº de personas para este precio) *" value={editing.pax || 2} onChange={(v) => setEditing({ ...editing, pax: Math.max(1, Math.round(v)) })} tid="exp-pax" />
            <Input label="País" value={editing.country || ""} onChange={(v) => setEditing({ ...editing, country: v })} />
            <Input label="Ciudad" value={editing.city || ""} onChange={(v) => setEditing({ ...editing, city: v })} />
            <div className="col-span-2">
              <div className="smallcaps mb-1">Descripción</div>
              <textarea rows={3} className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta" value={editing.description || ""} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <button onClick={() => setEditing(null)} className="px-4 py-2 border border-clay-300 text-sm hover:bg-clay-100">Cancelar</button>
            <button data-testid="exp-save-btn" onClick={save} className="px-4 py-2 bg-terracotta text-white text-sm tracking-wider uppercase hover:bg-terracotta-hover">Guardar</button>
          </div>
        </Modal>
      )}

      {importOpen && <ImportModal providers={providers} onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); load(); }} />}
      {csvUploadOpen && <CsvUploadModal onClose={() => setCsvUploadOpen(false)} onDone={() => { setCsvUploadOpen(false); load(); }} />}
    </div>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 bg-clay-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white border border-clay-300 w-full max-w-2xl p-6 animate-fade-up" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-serif text-2xl">{title}</h2>
          <button onClick={onClose} className="p-1 hover:bg-clay-200"><X size={16}/></button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Input({ label, value, onChange, tid }) {
  return (<div><div className="smallcaps mb-1">{label}</div>
    <input data-testid={tid} className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta" value={value} onChange={(e) => onChange(e.target.value)} /></div>);
}
function NumberInput({ label, value, onChange, tid }) {
  return (<div><div className="smallcaps mb-1">{label}</div>
    <input data-testid={tid} type="number" step="0.01" className="w-full bg-white border border-clay-300 px-3 py-2 text-sm tabular outline-none focus:border-terracotta" value={value} onChange={(e) => onChange(parseFloat(e.target.value || "0"))} /></div>);
}
function Select({ label, value, onChange, children, tid }) {
  return (<div><div className="smallcaps mb-1">{label}</div>
    <select data-testid={tid} className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta" value={value} onChange={(e) => onChange(e.target.value)}>{children}</select></div>);
}

function ImportModal({ providers, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [country, setCountry] = useState("");
  const [city, setCity] = useState("");
  const [type, setType] = useState("actividad");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!file) { toast.error("Selecciona un archivo .xlsx"); return; }
    const form = new FormData();
    form.append("file", file);
    const params = new URLSearchParams();
    if (country) params.set("country", country);
    if (city) params.set("city", city);
    if (type) params.set("type", type);
    setBusy(true);
    try {
      const { data } = await api.post(`/experiences/import-provider-sheet?${params}`, form, { headers: { "Content-Type": "multipart/form-data" } });
      toast.success(`Importadas ${data.created} experiencias (${data.providers} proveedor/es)`);
      onDone();
    } catch (e) { toast.error(e?.response?.data?.detail || "Error al importar"); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="Importar tarifas de proveedor" onClose={onClose}>
      <p className="text-sm text-clay-700 mb-4">
        Sube un Excel con columnas <code className="text-xs bg-clay-100 px-1">name</code>, <code className="text-xs bg-clay-100 px-1">operator_name</code>, <code className="text-xs bg-clay-100 px-1">price_tax_incl</code> y <code className="text-xs bg-clay-100 px-1">currency</code>. Cada fila se importa como experiencia.
      </p>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Input label="País" value={country} onChange={setCountry} />
        <Input label="Ciudad (opcional)" value={city} onChange={setCity} />
        <Select label="Tipo por defecto" value={type} onChange={setType}>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
      </div>
      <div>
        <div className="smallcaps mb-1">Archivo</div>
        <input data-testid="import-file" type="file" accept=".xlsx,.xlsm" onChange={(e) => setFile(e.target.files?.[0] || null)} className="w-full text-sm" />
      </div>
      <div className="flex justify-end gap-2 mt-6">
        <button onClick={onClose} className="px-4 py-2 border border-clay-300 text-sm hover:bg-clay-100">Cancelar</button>
        <button data-testid="import-submit" onClick={submit} disabled={busy} className="px-4 py-2 bg-terracotta text-white text-sm tracking-wider uppercase hover:bg-terracotta-hover disabled:opacity-50">{busy ? "Importando…" : "Importar"}</button>
      </div>
    </Modal>
  );
}


function CsvUploadModal({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [wipeExperiences, setWipeExperiences] = useState(true);
  const [wipeHotels, setWipeHotels] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const submit = async () => {
    if (!file) { toast.error("Selecciona el archivo app_operators.csv"); return; }
    const form = new FormData();
    form.append("file", file);
    const params = new URLSearchParams();
    params.set("wipe_experiences", String(wipeExperiences));
    params.set("wipe_imported_hotels", String(wipeHotels));
    setBusy(true);
    try {
      const { data } = await api.post(`/catalog/import-operators-csv?${params}`, form, { headers: { "Content-Type": "multipart/form-data" } });
      setResult(data);
      toast.success(`${data.experiences_created} experiencias creadas · ${data.hotels_created} hoteles · ${data.providers_total} proveedores`);
      onDone();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Error al importar CSV");
    } finally { setBusy(false); }
  };

  return (
    <Modal title="Subir CSV de operadores" onClose={onClose}>
      <div className="text-sm text-clay-700 mb-4 space-y-2">
        <p>
          Sube el archivo <code className="text-xs bg-clay-100 px-1">app_operators.csv</code> con columnas:
          <code className="text-[10px] bg-clay-100 px-1 ml-1">ID_TRIP; Fecha_venta; Servicio; Ciudad; Proveedor; AD; CH; Sin_IVA; Con_IVA</code>
        </p>
        <p>
          Cada experiencia se guarda con su número de <b>pax (AD + CH)</b>, así una misma actividad
          para 2 pax vs 4 pax queda como filas separadas con su precio respectivo.
        </p>
      </div>
      <div className="space-y-3 mb-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={wipeExperiences} onChange={(e) => setWipeExperiences(e.target.checked)} data-testid="wipe-exp-toggle" />
          Vaciar experiencias antes de importar
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={wipeHotels} onChange={(e) => setWipeHotels(e.target.checked)} data-testid="wipe-hotels-toggle" />
          También vaciar hoteles importados de viajes (no la biblioteca curada)
        </label>
      </div>
      <div>
        <div className="smallcaps mb-1">Archivo CSV</div>
        <input data-testid="csv-file-input" type="file" accept=".csv" onChange={(e) => setFile(e.target.files?.[0] || null)} className="w-full text-sm" />
      </div>
      {result && (
        <div className="mt-4 p-3 bg-clay-100 border border-clay-300 text-xs space-y-1">
          <div>📊 <b>{result.rows_scanned}</b> filas escaneadas → <b>{result.unique_services}</b> únicas</div>
          <div>✅ <b>{result.experiences_created}</b> experiencias creadas · {result.experiences_skipped} duplicadas</div>
          <div>🏨 <b>{result.hotels_created}</b> hoteles · {result.hotels_skipped} duplicados</div>
          <div>🏢 <b>{result.providers_total}</b> proveedores procesados</div>
        </div>
      )}
      <div className="flex justify-end gap-2 mt-6">
        <button onClick={onClose} className="px-4 py-2 border border-clay-300 text-sm hover:bg-clay-100">Cerrar</button>
        <button data-testid="csv-upload-submit" onClick={submit} disabled={busy || !file} className="px-4 py-2 bg-terracotta text-white text-sm tracking-wider uppercase hover:bg-terracotta-hover disabled:opacity-50">{busy ? "Importando…" : "Importar"}</button>
      </div>
    </Modal>
  );
}
