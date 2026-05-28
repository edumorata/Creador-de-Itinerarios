import React, { useEffect, useState } from "react";
import { Plus, Trash2, Pencil, X, Search, Server } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";
import { useAuth } from "@/lib/auth";

const TIERS = ["luxury", "upscale", "comfort", "standard", "budget"];
const TIER_COLOR = {
  luxury: "bg-clay-900 text-white",
  upscale: "bg-pine text-white",
  comfort: "bg-terracotta text-white",
  standard: "bg-clay-500 text-white",
  budget: "bg-clay-400 text-white",
};
const EMPTY = { name: "", city: "", country: "", tier: "upscale", description: "", price_per_night_excl: 0, price_per_night_incl: 0, currency: "EUR", contact: "", notes: "" };

export default function Hotels() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [q, setQ] = useState("");
  const [filterTier, setFilterTier] = useState("");
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = {};
      if (q) params.q = q;
      if (filterTier) params.tier = filterTier;
      const { data } = await api.get("/hotels", { params });
      setItems(data);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [q, filterTier]);

  const save = async () => {
    if (!editing.name) { toast.error("Nombre obligatorio"); return; }
    try {
      if (editing.hotel_id) await api.patch(`/hotels/${editing.hotel_id}`, editing);
      else await api.post("/hotels", editing);
      toast.success("Hotel guardado"); setEditing(null); load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Error"); }
  };

  const del = async (id) => {
    if (!window.confirm("¿Eliminar este hotel?")) return;
    await api.delete(`/hotels/${id}`); load();
  };

  return (
    <div className="px-8 py-8 max-w-7xl">
      <div className="flex items-end justify-between mb-6">
        <div>
          <div className="smallcaps">Librería</div>
          <h1 className="font-serif text-5xl leading-none mt-3">Hoteles</h1>
          <p className="text-sm text-clay-700 mt-3 max-w-lg">Base de hoteles que el asistente de IA puede usar para construir alojamientos en los itinerarios.</p>
        </div>
        <div className="flex items-center gap-2">
          {user?.role === "admin" && (
            <button
              data-testid="bulk-import-hotels"
              disabled={bulkBusy}
              onClick={async () => {
                if (!window.confirm("Importar TODOS los archivos de hoteles del servidor (España/Portugal/Italia/Marruecos + apartamentos)?")) return;
                setBulkBusy(true);
                try {
                  const { data } = await api.post("/hotels/import-all-server");
                  toast.success(`${data.total_created} hoteles añadidos (${data.files_scanned} archivos, ${data.total_skipped} duplicados saltados)`);
                  load();
                } catch (e) { toast.error(e?.response?.data?.detail || "Error en importación masiva"); }
                finally { setBulkBusy(false); }
              }}
              className="inline-flex items-center gap-2 px-4 py-2 border border-clay-300 hover:bg-clay-100 text-sm disabled:opacity-50"
            >
              <Server size={14}/> {bulkBusy ? "Importando…" : "Importar TODO del servidor"}
            </button>
          )}
          <button data-testid="new-hotel-btn" onClick={() => setEditing({ ...EMPTY })} className="inline-flex items-center gap-2 px-4 py-2 bg-clay-900 text-white text-sm tracking-wider uppercase hover:bg-terracotta">
            <Plus size={14}/> Nuevo hotel
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_200px] gap-3 mb-4">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-3 text-clay-500" />
          <input data-testid="hotel-search" className="w-full pl-9 pr-3 py-2 bg-white border border-clay-300 text-sm outline-none focus:border-terracotta" placeholder="Buscar hotel, ciudad…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select data-testid="filter-tier" value={filterTier} onChange={(e) => setFilterTier(e.target.value)} className="bg-white border border-clay-300 px-3 py-2 text-sm">
          <option value="">Tier: todos</option>
          {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <div className="border border-clay-300 bg-white">
        <div className="grid grid-cols-[1.5fr_1fr_0.7fr_0.7fr_0.7fr_auto] bg-clay-100 text-[11px] tracking-[0.2em] uppercase text-clay-700 font-semibold">
          <div className="px-4 py-3">Nombre</div>
          <div className="px-4 py-3">Ciudad / País</div>
          <div className="px-4 py-3">Tier</div>
          <div className="px-4 py-3 text-right">€/noche sin IVA</div>
          <div className="px-4 py-3 text-right">€/noche con IVA</div>
          <div className="px-4 py-3 text-right">Acciones</div>
        </div>
        {loading ? <div className="p-6 text-sm text-clay-700">Cargando…</div> :
          items.length === 0 ? <div className="p-10 text-center text-sm text-clay-700" data-testid="hotel-empty">No hay hoteles aún. Crea uno para que la IA lo pueda usar.</div> :
          items.map((h) => (
            <div key={h.hotel_id} className="grid grid-cols-[1.5fr_1fr_0.7fr_0.7fr_0.7fr_auto] border-t border-clay-300 text-sm hover:bg-clay-50" data-testid={`hotel-${h.hotel_id}`}>
              <div className="px-4 py-3">
                <div className="font-semibold truncate">{h.name}</div>
                {h.description && <div className="text-[11px] text-clay-700 truncate">{h.description}</div>}
              </div>
              <div className="px-4 py-3 text-clay-700">{[h.city, h.country].filter(Boolean).join(" · ") || "—"}</div>
              <div className="px-4 py-3"><span className={`inline-block px-1.5 py-0.5 text-[9px] tracking-widest uppercase ${TIER_COLOR[h.tier] || ""}`}>{h.tier}</span></div>
              <div className="px-4 py-3 text-right tabular text-clay-700">{Number(h.price_per_night_excl || 0).toLocaleString("es-ES")}</div>
              <div className="px-4 py-3 text-right tabular font-semibold">{Number(h.price_per_night_incl || 0).toLocaleString("es-ES")}</div>
              <div className="px-4 py-3 flex justify-end gap-1">
                <button onClick={() => setEditing({ ...h })} className="p-1.5 hover:bg-clay-200"><Pencil size={14}/></button>
                <button onClick={() => del(h.hotel_id)} className="p-1.5 hover:bg-clay-200 text-destructive"><Trash2 size={14}/></button>
              </div>
            </div>
          ))
        }
      </div>

      {editing && (
        <div className="fixed inset-0 bg-clay-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setEditing(null)}>
          <div className="bg-white border border-clay-300 w-full max-w-2xl p-6 animate-fade-up" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-serif text-2xl">{editing.hotel_id ? "Editar hotel" : "Nuevo hotel"}</h2>
              <button onClick={() => setEditing(null)} className="p-1 hover:bg-clay-200"><X size={16}/></button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <F label="Nombre *"><input data-testid="hotel-name" className="w-full bg-white border border-clay-300 px-3 py-2 text-sm" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></F>
              <F label="Ciudad"><input className="w-full bg-white border border-clay-300 px-3 py-2 text-sm" value={editing.city || ""} onChange={(e) => setEditing({ ...editing, city: e.target.value })} /></F>
              <F label="País"><input className="w-full bg-white border border-clay-300 px-3 py-2 text-sm" value={editing.country || ""} onChange={(e) => setEditing({ ...editing, country: e.target.value })} /></F>
              <F label="Tier"><select className="w-full bg-white border border-clay-300 px-3 py-2 text-sm" value={editing.tier} onChange={(e) => setEditing({ ...editing, tier: e.target.value })}>{TIERS.map((t) => <option key={t} value={t}>{t}</option>)}</select></F>
              <F label="€/noche sin IVA"><input type="number" step="0.01" className="w-full bg-white border border-clay-300 px-3 py-2 text-sm tabular" value={editing.price_per_night_excl} onChange={(e) => setEditing({ ...editing, price_per_night_excl: parseFloat(e.target.value || "0") })} /></F>
              <F label="€/noche con IVA"><input type="number" step="0.01" className="w-full bg-white border border-clay-300 px-3 py-2 text-sm tabular" value={editing.price_per_night_incl} onChange={(e) => setEditing({ ...editing, price_per_night_incl: parseFloat(e.target.value || "0") })} /></F>
              <F label="Contacto"><input className="w-full bg-white border border-clay-300 px-3 py-2 text-sm" value={editing.contact || ""} onChange={(e) => setEditing({ ...editing, contact: e.target.value })} /></F>
              <F label="Moneda"><input className="w-full bg-white border border-clay-300 px-3 py-2 text-sm" value={editing.currency} onChange={(e) => setEditing({ ...editing, currency: e.target.value })} /></F>
              <div className="col-span-2"><F label="Descripción"><textarea rows={2} className="w-full bg-white border border-clay-300 px-3 py-2 text-sm" value={editing.description || ""} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></F></div>
              <div className="col-span-2"><F label="Notas"><textarea rows={2} className="w-full bg-white border border-clay-300 px-3 py-2 text-sm" value={editing.notes || ""} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></F></div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setEditing(null)} className="px-4 py-2 border border-clay-300 text-sm hover:bg-clay-100">Cancelar</button>
              <button data-testid="hotel-save" onClick={save} className="px-4 py-2 bg-terracotta text-white text-sm tracking-wider uppercase hover:bg-terracotta-hover">Guardar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function F({ label, children }) {
  return <div><div className="smallcaps mb-1">{label}</div>{children}</div>;
}
