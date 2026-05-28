import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Calendar, Users as UsersIcon, FileDown, Trash2, Pencil } from "lucide-react";
import api, { API_BASE } from "@/lib/api";
import { toast } from "sonner";

const STATUS_LABEL = {
  draft: { text: "Borrador", color: "bg-clay-200 text-clay-900" },
  sold: { text: "Vendido", color: "bg-pine text-white" },
  not_sold: { text: "No vendido", color: "bg-clay-400 text-white" },
};

function fmt(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return d; }
}

function calcTotals(itn) {
  let subtotal = 0;
  (itn.days || []).forEach((day) => {
    (day.services || []).forEach((s) => {
      subtotal += (s.unit_price || 0) * (s.quantity || 0);
    });
  });
  (itn.accommodations || []).forEach((a) => { subtotal += a.price || 0; });
  const markup = subtotal * (itn.markup_pct || 0) / 100.0;
  return { subtotal, final: subtotal + markup };
}

export default function Dashboard() {
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState({ providers: 0, experiences: 0, itineraries: 0 });
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    try {
      const [a, b] = await Promise.all([api.get("/itineraries"), api.get("/stats")]);
      setItems(a.data); setStats(b.data);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    const today = new Date();
    const { data } = await api.post("/itineraries", {
      name: "Nuevo itinerario",
      start_date: today.toISOString().slice(0,10),
      end_date: new Date(today.getTime() + 6*86400000).toISOString().slice(0,10),
      num_travelers: 2,
      markup_pct: 15,
      days: [],
    });
    navigate(`/itineraries/${data.itinerary_id}`);
  };

  const del = async (id) => {
    if (!window.confirm("¿Eliminar este itinerario?")) return;
    await api.delete(`/itineraries/${id}`);
    toast.success("Itinerario eliminado");
    load();
  };

  const exportXlsx = async (id, name) => {
    const url = `${API_BASE}/itineraries/${id}/export`;
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${name || "itinerario"}.xlsx`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (e) { toast.error("No se pudo exportar"); }
  };

  return (
    <div className="px-8 py-8 max-w-7xl">
      <div className="flex items-end justify-between mb-8">
        <div>
          <div className="smallcaps">Centro de operaciones</div>
          <h1 className="font-serif text-5xl leading-none mt-3">Itinerarios</h1>
          <p className="text-sm text-clay-700 mt-3 max-w-lg">
            Diseña, calcula y exporta viajes para tus travel specialists.
            Combina experiencias de tu librería en días y márgenes en segundos.
          </p>
        </div>
        <button
          data-testid="new-itinerary-btn"
          onClick={create}
          className="inline-flex items-center gap-2 px-5 py-3 bg-clay-900 text-white text-sm tracking-wider uppercase hover:bg-terracotta transition-colors"
        >
          <Plus size={16} /> Nuevo itinerario
        </button>
      </div>

      <div className="grid grid-cols-3 gap-0 mb-10 border border-clay-300">
        {[
          { l: "Itinerarios", v: stats.itineraries, t: "stat-itineraries" },
          { l: "Experiencias", v: stats.experiences, t: "stat-experiences" },
          { l: "Proveedores", v: stats.providers, t: "stat-providers" },
        ].map((s, i) => (
          <div key={s.l} className={`p-6 ${i>0 ? "border-l border-clay-300" : ""}`} data-testid={s.t}>
            <div className="smallcaps">{s.l}</div>
            <div className="font-serif text-4xl tabular mt-2">{s.v}</div>
          </div>
        ))}
      </div>

      <div className="smallcaps mb-3">Tus viajes</div>
      <div className="border border-clay-300 bg-white">
        <div className="grid grid-cols-[1.4fr_1fr_1fr_0.8fr_1fr_auto] gap-0 bg-clay-100 text-[11px] tracking-[0.2em] uppercase text-clay-700 font-semibold">
          <div className="px-4 py-3">Nombre</div>
          <div className="px-4 py-3">Viajero</div>
          <div className="px-4 py-3">Fechas</div>
          <div className="px-4 py-3">Pax</div>
          <div className="px-4 py-3 text-right">Precio final</div>
          <div className="px-4 py-3 text-right">Acciones</div>
        </div>
        {loading ? (
          <div className="p-6 text-sm text-clay-700">Cargando…</div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center" data-testid="empty-state">
            <div className="font-serif text-2xl mb-2">Aún no hay itinerarios</div>
            <p className="text-sm text-clay-700 mb-5">Crea tu primer viaje y empieza a sumar experiencias.</p>
            <button onClick={create} className="px-4 py-2 bg-terracotta text-white text-sm tracking-wider uppercase hover:bg-terracotta-hover">
              Crear itinerario
            </button>
          </div>
        ) : items.map((itn) => {
          const t = calcTotals(itn);
          const st = STATUS_LABEL[itn.status] || STATUS_LABEL.draft;
          return (
            <div key={itn.itinerary_id} className="grid grid-cols-[1.4fr_1fr_1fr_0.8fr_1fr_auto] gap-0 border-t border-clay-300 hover:bg-clay-50 transition-colors text-sm" data-testid={`itn-row-${itn.itinerary_id}`}>
              <div className="px-4 py-3 flex items-center gap-3">
                <span className={`inline-block px-2 py-0.5 text-[10px] tracking-widest uppercase ${st.color}`}>{st.text}</span>
                <button className="text-left font-semibold hover:text-terracotta" onClick={() => navigate(`/itineraries/${itn.itinerary_id}`)}>
                  {itn.name}
                </button>
              </div>
              <div className="px-4 py-3 text-clay-700">{itn.main_traveler || "—"}</div>
              <div className="px-4 py-3 text-clay-700 tabular flex items-center gap-2"><Calendar size={13}/>{fmt(itn.start_date)} → {fmt(itn.end_date)}</div>
              <div className="px-4 py-3 text-clay-700 tabular flex items-center gap-1"><UsersIcon size={13}/>{itn.num_travelers}</div>
              <div className="px-4 py-3 text-right font-semibold tabular">€ {t.final.toLocaleString("es-ES", { maximumFractionDigits: 2 })}</div>
              <div className="px-4 py-3 flex items-center justify-end gap-1">
                <button onClick={() => navigate(`/itineraries/${itn.itinerary_id}`)} className="p-1.5 hover:bg-clay-200" title="Editar" data-testid={`edit-${itn.itinerary_id}`}>
                  <Pencil size={14} />
                </button>
                <button onClick={() => exportXlsx(itn.itinerary_id, itn.name)} className="p-1.5 hover:bg-clay-200" title="Exportar Excel" data-testid={`export-${itn.itinerary_id}`}>
                  <FileDown size={14} />
                </button>
                <button onClick={() => del(itn.itinerary_id)} className="p-1.5 hover:bg-clay-200 text-destructive" title="Eliminar" data-testid={`del-${itn.itinerary_id}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
