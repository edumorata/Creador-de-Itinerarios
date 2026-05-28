import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2, Pencil, X, ExternalLink, CheckCircle2, XCircle, Sparkles, RotateCw, Brain } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";

const OUTCOMES = [
  { v: "sold", label: "Vendido", icon: CheckCircle2, cls: "bg-pine text-white border-pine", iconCls: "text-white" },
  { v: "not_sold", label: "No vendido", icon: XCircle, cls: "bg-clay-200 text-clay-900 border-clay-300", iconCls: "text-clay-700" },
  { v: "pending", label: "Pendiente", icon: Sparkles, cls: "bg-white text-clay-900 border-clay-300", iconCls: "text-terracotta" },
];

const EMPTY = {
  client_name: "",
  client_request: "",
  itinerary_url: "",
  itinerary_text: "",
  itinerary_structured: null,
  itinerary_url_ops: "",
  itinerary_text_ops: "",
  itinerary_structured_ops: null,
  outcome: "sold",
  notes: "",
};

export default function AITrainer() {
  const [items, setItems] = useState([]);
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [stats, setStats] = useState({ training_examples: 0 });
  const navigate = useNavigate();

  const load = async () => {
    const [a, b] = await Promise.all([api.get("/training-examples"), api.get("/stats")]);
    setItems(a.data); setStats(b.data);
  };
  useEffect(() => { load(); }, []);

  const startNew = () => { setEditing({ ...EMPTY }); setShowForm(true); };
  const startEdit = (ex) => { setEditing({ ...ex }); setShowForm(true); };

  const scrape = async () => {
    if (!editing?.itinerary_url) { toast.error("Pega una URL primero"); return; }
    setScraping(true);
    try {
      const { data } = await api.post("/training-examples/scrape", { url: editing.itinerary_url });
      const next = { ...editing };
      if (data.text) next.itinerary_text = data.text;
      if (data.structured) next.itinerary_structured = data.structured;
      setEditing(next);
      if (data.ok && data.structured?.days?.length) {
        toast.success(`Itinerario parseado: ${data.structured.days.length} días, ${data.structured.trip_name || ""}`);
      } else if (data.error === "login_failed") {
        toast.error("Login en gestion.viajadverdad.com falló. Pega el contenido del itinerario manualmente.");
      } else if (!data.ok) {
        toast.warning("No se pudo extraer la información. Pégala a mano.");
      }
    } catch (e) { toast.error(e?.response?.data?.detail || "Error al hacer scrape"); }
    finally { setScraping(false); }
  };

  const save = async () => {
    if (!editing.client_request) { toast.error("El trip request es obligatorio"); return; }
    try {
      if (editing.example_id) await api.patch(`/training-examples/${editing.example_id}`, editing);
      else await api.post("/training-examples", editing);
      toast.success("Ejemplo guardado");
      setShowForm(false); setEditing(null); load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Error"); }
  };

  const del = async (id) => {
    if (!window.confirm("¿Eliminar este ejemplo?")) return;
    await api.delete(`/training-examples/${id}`); load();
  };

  return (
    <div className="px-8 py-8 max-w-7xl">
      <div className="flex items-end justify-between mb-6">
        <div>
          <div className="smallcaps">AI · Knowledge base</div>
          <h1 className="font-serif text-5xl leading-none mt-3">Entrenador del agente</h1>
          <p className="text-sm text-clay-700 mt-3 max-w-2xl">
            Alimenta el modelo con itinerarios pasados. Por cada ejemplo: el request original del cliente + el itinerario final entregado + si se vendió o no. Cuantos más ejemplos cargues, más fielmente reproduce tu estilo el agente.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button data-testid="goto-generate" onClick={() => navigate("/ai/generate")} className="inline-flex items-center gap-2 px-4 py-2 border border-clay-300 hover:bg-clay-100 text-sm">
            <Brain size={14}/> Crear desde request
          </button>
          <button data-testid="new-example-btn" onClick={startNew} className="inline-flex items-center gap-2 px-4 py-2 bg-clay-900 text-white text-sm tracking-wider uppercase hover:bg-terracotta">
            <Plus size={14}/> Añadir ejemplo
          </button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-0 mb-6 border border-clay-300 bg-white">
        {[
          { l: "Total ejemplos", v: stats.training_examples || items.length },
          { l: "Vendidos", v: items.filter((x) => x.outcome === "sold").length },
          { l: "No vendidos", v: items.filter((x) => x.outcome === "not_sold").length },
          { l: "Pendientes", v: items.filter((x) => x.outcome === "pending").length },
        ].map((s, i) => (
          <div key={s.l} className={`p-5 ${i>0 ? "border-l border-clay-300" : ""}`}>
            <div className="smallcaps">{s.l}</div>
            <div className="font-serif text-3xl tabular mt-1">{s.v}</div>
          </div>
        ))}
      </div>

      <div className="smallcaps mb-3">Historial</div>
      <div className="border border-clay-300 bg-white">
        <div className="grid grid-cols-[120px_1fr_1fr_140px_auto] bg-clay-100 text-[11px] tracking-[0.2em] uppercase text-clay-700 font-semibold">
          <div className="px-4 py-3">Estado</div>
          <div className="px-4 py-3">Cliente / Request</div>
          <div className="px-4 py-3">Itinerario final</div>
          <div className="px-4 py-3">Fecha</div>
          <div className="px-4 py-3 text-right">Acciones</div>
        </div>
        {items.length === 0 ? (
          <div className="p-10 text-center" data-testid="trn-empty">
            <div className="font-serif text-2xl mb-2">Aún no hay ejemplos</div>
            <p className="text-sm text-clay-700 mb-5">Empieza añadiendo el primer caso pasado para entrenar el agente.</p>
            <button onClick={startNew} className="px-4 py-2 bg-terracotta text-white text-sm tracking-wider uppercase hover:bg-terracotta-hover">Añadir ejemplo</button>
          </div>
        ) : items.map((ex) => {
          const oc = OUTCOMES.find((o) => o.v === ex.outcome) || OUTCOMES[2];
          const Icon = oc.icon;
          return (
            <div key={ex.example_id} className="grid grid-cols-[120px_1fr_1fr_140px_auto] border-t border-clay-300 text-sm hover:bg-clay-50" data-testid={`trn-${ex.example_id}`}>
              <div className="px-4 py-3"><span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] tracking-widest uppercase border ${oc.cls}`}><Icon size={11}/> {oc.label}</span></div>
              <div className="px-4 py-3 min-w-0">
                <div className="font-semibold truncate">{ex.client_name || "Sin nombre"}</div>
                <div className="text-[11px] text-clay-700 line-clamp-2 break-words">{ex.client_request}</div>
              </div>
              <div className="px-4 py-3 min-w-0 space-y-1">
                {ex.itinerary_url && (
                  <div className="flex items-center gap-1 text-[11px] min-w-0">
                    <span className={`px-1 py-0 text-[9px] tracking-widest uppercase ${ex.itinerary_structured?.days?.length ? "bg-pine text-white" : "bg-clay-200 text-clay-700"}`}>Travefy</span>
                    {ex.itinerary_structured?.days?.length > 0 ? (
                      <span className="text-pine font-semibold">✓ {ex.itinerary_structured.days.length}d</span>
                    ) : <span className="text-clay-500">—</span>}
                    <a href={ex.itinerary_url} target="_blank" rel="noreferrer" className="text-terracotta hover:underline truncate flex items-center gap-0.5"><ExternalLink size={10}/></a>
                  </div>
                )}
                {ex.itinerary_url_ops && (
                  <div className="flex items-center gap-1 text-[11px] min-w-0">
                    <span className={`px-1 py-0 text-[9px] tracking-widest uppercase ${ex.itinerary_structured_ops?.days?.length ? "bg-pine text-white" : "bg-clay-200 text-clay-700"}`}>Ops</span>
                    {ex.itinerary_structured_ops?.days?.length > 0 ? (
                      <span className="text-pine font-semibold">✓ {ex.itinerary_structured_ops.days.length}d</span>
                    ) : <span className="text-clay-500">—</span>}
                    <a href={ex.itinerary_url_ops} target="_blank" rel="noreferrer" className="text-terracotta hover:underline truncate flex items-center gap-0.5"><ExternalLink size={10}/></a>
                  </div>
                )}
                {!ex.itinerary_url && !ex.itinerary_url_ops && <span className="text-clay-500 text-[11px]">—</span>}
              </div>
              <div className="px-4 py-3 text-clay-700 tabular text-[11px]">{new Date(ex.created_at).toLocaleDateString("es-ES", { day:"2-digit", month:"short", year:"numeric" })}</div>
              <div className="px-4 py-3 flex justify-end gap-1">
                <button onClick={() => startEdit(ex)} className="p-1.5 hover:bg-clay-200"><Pencil size={14}/></button>
                <button onClick={() => del(ex.example_id)} className="p-1.5 hover:bg-clay-200 text-destructive"><Trash2 size={14}/></button>
              </div>
            </div>
          );
        })}
      </div>

      {showForm && editing && (
        <Modal title={editing.example_id ? "Editar ejemplo" : "Añadir ejemplo pasado"} onClose={() => { setShowForm(false); setEditing(null); }}>
          <p className="text-sm text-clay-700 mb-5">Empareja el request original del cliente con el itinerario final que entregaste y márcalo como vendido o no.</p>

          <div className="mb-4">
            <div className="smallcaps mb-2">Nombre del cliente (opcional)</div>
            <input data-testid="trn-name" placeholder="ej. John & Sarah Miller" value={editing.client_name || ""} onChange={(e) => setEditing({ ...editing, client_name: e.target.value })} className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta" />
          </div>

          <div className="mb-4">
            <div className="flex items-baseline gap-2 mb-2">
              <span className="smallcaps text-terracotta">Paso 1</span>
              <span className="font-semibold text-sm">Trip request del cliente</span>
            </div>
            <textarea data-testid="trn-request" rows={6} placeholder="Pega la solicitud original del cliente…" value={editing.client_request} onChange={(e) => setEditing({ ...editing, client_request: e.target.value })} className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta" />
          </div>

          <div className="mb-4">
            <div className="flex items-baseline gap-2 mb-2">
              <span className="smallcaps text-terracotta">Paso 2</span>
              <span className="font-semibold text-sm">Itinerario(s) final(es)</span>
              <span className="text-[11px] text-clay-700">— una URL para cliente (Travefy) y/u otra interna (gestion). El agente aprende de ambas.</span>
            </div>

            <UrlBlock
              title="A · Itinerario cliente (Travefy)"
              placeholder="https://travefy.com/trip/itinerary/…"
              url={editing.itinerary_url || ""}
              onUrlChange={(v) => setEditing({ ...editing, itinerary_url: v })}
              text={editing.itinerary_text || ""}
              onTextChange={(v) => setEditing({ ...editing, itinerary_text: v })}
              structured={editing.itinerary_structured}
              scraping={scraping === "client"}
              onScrape={() => scrape("client")}
              tidPrefix="trn-client"
            />

            <div className="mt-4" />

            <UrlBlock
              title="B · Vista interna de operaciones (gestion.viajadverdad.com)"
              placeholder="https://gestion.viajadverdad.com/trips/form/1/…"
              url={editing.itinerary_url_ops || ""}
              onUrlChange={(v) => setEditing({ ...editing, itinerary_url_ops: v })}
              text={editing.itinerary_text_ops || ""}
              onTextChange={(v) => setEditing({ ...editing, itinerary_text_ops: v })}
              structured={editing.itinerary_structured_ops}
              scraping={scraping === "ops"}
              onScrape={() => scrape("ops")}
              tidPrefix="trn-ops"
            />
          </div>

          <div className="mb-4">
            <div className="flex items-baseline gap-2 mb-2">
              <span className="smallcaps text-terracotta">Paso 3</span>
              <span className="font-semibold text-sm">¿Se vendió?</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {OUTCOMES.map((o) => {
                const Icon = o.icon;
                const active = editing.outcome === o.v;
                return (
                  <button key={o.v} data-testid={`trn-outcome-${o.v}`} onClick={() => setEditing({ ...editing, outcome: o.v })}
                    className={`inline-flex items-center justify-center gap-2 px-3 py-3 border text-sm transition-colors ${active ? o.cls : "bg-white border-clay-300 hover:bg-clay-50"}`}>
                    <Icon size={15} className={active ? o.iconCls : "text-clay-500"} />
                    <span>{o.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mb-4">
            <div className="smallcaps mb-1">Notas (opcional)</div>
            <textarea rows={2} placeholder="Comentarios internos, motivo de no-venta, particularidades…" value={editing.notes || ""} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} className="w-full bg-white border border-clay-300 px-3 py-2 text-sm" />
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={() => { setShowForm(false); setEditing(null); }} className="px-4 py-2 border border-clay-300 text-sm hover:bg-clay-100">Cancelar</button>
            <button data-testid="trn-save" onClick={save} className="inline-flex items-center gap-2 px-4 py-2 bg-terracotta text-white text-sm tracking-wider uppercase hover:bg-terracotta-hover">
              Guardar ejemplo
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function UrlBlock({ title, placeholder, url, onUrlChange, text, onTextChange, structured, scraping, onScrape, tidPrefix }) {
  return (
    <div className="border border-clay-300 bg-clay-50/40 p-3">
      <div className="smallcaps mb-2">{title}</div>
      <div className="flex gap-2">
        <input
          data-testid={`${tidPrefix}-url`}
          placeholder={placeholder}
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          className="flex-1 bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta"
        />
        <button
          data-testid={`${tidPrefix}-scrape`}
          onClick={onScrape}
          disabled={scraping || !url}
          className="inline-flex items-center gap-2 px-3 py-2 border border-clay-300 hover:bg-clay-100 text-sm disabled:opacity-50"
        >
          <RotateCw size={14} className={scraping ? "animate-spin" : ""}/> {scraping ? "Extrayendo…" : "Extraer"}
        </button>
      </div>
      <details className="mt-2">
        <summary className="text-[11px] text-clay-700 cursor-pointer hover:text-terracotta">Texto extraído / pegado manualmente {text ? `(${text.length.toLocaleString("es-ES")} chars)` : ""}</summary>
        <textarea
          data-testid={`${tidPrefix}-text`}
          rows={4}
          placeholder="Si la URL requiere login o el scraping falla, pega aquí el contenido."
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta mt-2"
        />
      </details>
      {structured?.days?.length > 0 && (
        <div className="mt-3 border border-pine bg-pine/5 p-3" data-testid={`${tidPrefix}-structured`}>
          <div className="smallcaps text-pine mb-1">El agente entiende este itinerario</div>
          <div className="text-sm font-semibold">{structured.trip_name || "Itinerario"}</div>
          <div className="text-[11px] text-clay-700 mb-2">
            {structured.start_date} → {structured.end_date} · {structured.days.length} días
          </div>
          <div className="max-h-60 overflow-auto space-y-1.5">
            {structured.days.map((d, i) => (
              <div key={i} className="border border-clay-300 bg-white px-2 py-1.5 text-[11px]">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">Day {d.day} · {d.city || "—"}</span>
                  <span className="tabular text-clay-700">{d.date || ""}</span>
                </div>
                {(d.activities || []).slice(0, 3).map((a, j) => (
                  <div key={`a${j}`} className="text-clay-700 truncate">• {a.name}{a.time ? ` · ${a.time}` : ""}</div>
                ))}
                {(d.hotels || []).map((h, j) => (
                  <div key={`h${j}`} className="text-terracotta font-semibold">🏨 {h.name}{h.nights ? ` · ${h.nights}n` : ""}</div>
                ))}
              </div>
            ))}
          </div>
          {structured.notes && (
            <div className="text-[11px] text-clay-700 italic mt-2 pl-2 border-l-2 border-pine">{structured.notes}</div>
          )}
        </div>
      )}
    </div>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 bg-clay-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white border border-clay-300 w-full max-w-3xl max-h-[92vh] overflow-auto p-7 animate-fade-up" onClick={(e) => e.stopPropagation()}>
        <div className="smallcaps mb-1">Import a past trip</div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-serif text-3xl">{title}</h2>
          <button onClick={onClose} className="p-1 hover:bg-clay-200"><X size={16}/></button>
        </div>
        {children}
      </div>
    </div>
  );
}
