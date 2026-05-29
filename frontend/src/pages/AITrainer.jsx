import React, { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus, Trash2, Pencil, X, ExternalLink, CheckCircle2, XCircle, Sparkles,
  RotateCw, Brain, Download, Save, FileQuestion,
} from "lucide-react";
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

const DEFAULT_BULK = {
  agent: "",
  source: "KimKim",
  status: "all_sold",
  outcome: "sold",
  date_from: "01/01/2025",
  date_to: "29/05/2026",
  limit: 500,
};

export default function AITrainer() {
  const [items, setItems] = useState([]);
  const [pending, setPending] = useState([]);
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [stats, setStats] = useState({ training_examples: 0 });
  const [bulkForm, setBulkForm] = useState(DEFAULT_BULK);
  const [activeJob, setActiveJob] = useState(null);
  const [jobsHistory, setJobsHistory] = useState([]);
  const pollRef = useRef(null);
  const navigate = useNavigate();

  const load = async () => {
    const [a, b, c, d] = await Promise.all([
      api.get("/training-examples"),
      api.get("/stats"),
      api.get("/training-examples/pending-request"),
      api.get("/training-examples/bulk-import-jobs"),
    ]);
    setItems(a.data);
    setStats(b.data);
    setPending(c.data);
    setJobsHistory(d.data);
    // If an unfinished job exists and we're not polling, resume.
    const live = (d.data || []).find((j) => j.status === "running" || j.status === "queued");
    if (live && !pollRef.current) startPolling(live.job_id);
  };

  useEffect(() => {
    load();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const startPolling = (jobId) => {
    if (pollRef.current) clearInterval(pollRef.current);
    const tick = async () => {
      try {
        const { data } = await api.get(`/training-examples/bulk-import-jobs/${jobId}`);
        setActiveJob(data);
        if (data.status === "completed" || data.status === "failed" || data.status === "cancelled") {
          clearInterval(pollRef.current);
          pollRef.current = null;
          // refresh lists
          load();
          if (data.status === "completed") {
            toast.success(`Import finalizado: +${data.scraped} · ${data.skipped} repetidos · ${data.failed} con error`);
          } else if (data.status === "failed") {
            toast.error(data.last_message || "El job falló");
          }
        }
      } catch (e) {
        console.error("poll error", e);
      }
    };
    tick();
    pollRef.current = setInterval(tick, 3000);
  };

  const startBulk = async () => {
    try {
      const { data } = await api.post("/training-examples/bulk-import-gestion", bulkForm);
      toast.info("Job lanzado · escuchando progreso");
      setActiveJob(data);
      startPolling(data.job_id);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Error al lanzar el import");
    }
  };

  const startNew = () => { setEditing({ ...EMPTY }); setShowForm(true); };
  const startEdit = (ex) => { setEditing({ ...ex }); setShowForm(true); };

  const scrape = async (which = "client") => {
    const url = which === "ops" ? editing?.itinerary_url_ops : editing?.itinerary_url;
    if (!url) { toast.error("Pega una URL primero"); return; }
    setScraping(which);
    try {
      const { data } = await api.post("/training-examples/scrape", { url });
      const next = { ...editing };
      if (which === "ops") {
        if (data.text) next.itinerary_text_ops = data.text;
        if (data.structured) next.itinerary_structured_ops = data.structured;
      } else {
        if (data.text) next.itinerary_text = data.text;
        if (data.structured) next.itinerary_structured = data.structured;
      }
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
          { l: "Pendientes solicitud", v: pending.length },
          { l: "No vendidos", v: items.filter((x) => x.outcome === "not_sold").length },
        ].map((s, i) => (
          <div key={s.l} className={`p-5 ${i>0 ? "border-l border-clay-300" : ""}`}>
            <div className="smallcaps">{s.l}</div>
            <div className="font-serif text-3xl tabular mt-1">{s.v}</div>
          </div>
        ))}
      </div>

      {/* ---------- BULK IMPORT FROM GESTION ---------- */}
      <BulkImportCard
        bulkForm={bulkForm}
        setBulkForm={setBulkForm}
        onStart={startBulk}
        activeJob={activeJob}
        jobsHistory={jobsHistory}
      />

      {/* ---------- PENDING REQUESTS ---------- */}
      {pending.length > 0 && (
        <PendingRequestsSection items={pending} onSaved={load} />
      )}

      <div className="smallcaps mb-3 mt-10">Historial completo</div>
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
          const isPending = !ex.client_request;
          return (
            <div key={ex.example_id} className="grid grid-cols-[120px_1fr_1fr_140px_auto] border-t border-clay-300 text-sm hover:bg-clay-50" data-testid={`trn-${ex.example_id}`}>
              <div className="px-4 py-3 space-y-1">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] tracking-widest uppercase border ${oc.cls}`}><Icon size={11}/> {oc.label}</span>
                {isPending && <span className="block text-[9px] tracking-widest uppercase text-terracotta">Falta request</span>}
              </div>
              <div className="px-4 py-3 min-w-0">
                <div className="font-semibold truncate">{ex.client_name || "Sin nombre"}</div>
                <div className="text-[11px] text-clay-700 line-clamp-2 break-words">{ex.client_request || <span className="italic">— pendiente de solicitud —</span>}</div>
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

/* =========================================================================
 *  BULK IMPORT CARD
 * =======================================================================*/
function BulkImportCard({ bulkForm, setBulkForm, onStart, activeJob, jobsHistory }) {
  const [showHistory, setShowHistory] = useState(false);
  const isRunning = activeJob && (activeJob.status === "running" || activeJob.status === "queued");
  const totalDone = (activeJob?.scraped || 0) + (activeJob?.skipped || 0) + (activeJob?.failed || 0);
  const progressPct = activeJob?.matched > 0
    ? Math.min(100, Math.round((totalDone / activeJob.matched) * 100))
    : (isRunning ? 5 : 0);

  return (
    <div className="border border-clay-300 bg-white mb-10" data-testid="bulk-import-card">
      <div className="flex items-start justify-between px-5 pt-5">
        <div>
          <div className="smallcaps text-terracotta">Importación masiva</div>
          <h2 className="font-serif text-2xl leading-tight mt-1">Cargar lote desde gestion.viajadverdad.com</h2>
          <p className="text-[12px] text-clay-700 mt-1.5 max-w-2xl">
            El sistema entra al gestor, aplica los filtros y trae <strong>todos</strong> los viajes que coinciden. Marca el lote como <em>vendido</em> o <em>no vendido</em> para que el agente aprenda patrones. Cada uno queda con <em>solicitud pendiente</em> abajo, listo para que pegues el request original.
          </p>
        </div>
        <Download size={18} className="text-clay-500 mt-1" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-7 gap-3 p-5">
        <Field label="Agente de Ventas" hint="vacío = todos">
          <input
            data-testid="bulk-agent"
            value={bulkForm.agent}
            onChange={(e) => setBulkForm({ ...bulkForm, agent: e.target.value })}
            placeholder="ej. Beatriz"
            disabled={isRunning}
            className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta disabled:opacity-50"
          />
        </Field>
        <Field label="Source">
          <input
            data-testid="bulk-source"
            value={bulkForm.source}
            onChange={(e) => setBulkForm({ ...bulkForm, source: e.target.value })}
            placeholder="ej. KimKim"
            disabled={isRunning}
            className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta disabled:opacity-50"
          />
        </Field>
        <Field label="Estado">
          <select
            data-testid="bulk-status"
            value={bulkForm.status}
            onChange={(e) => setBulkForm({ ...bulkForm, status: e.target.value })}
            disabled={isRunning}
            className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta disabled:opacity-50"
          >
            <option value="all_sold">Abierto + Cerrado + Terminado</option>
            <option value="both">Abierto + Cerrado</option>
            <option value="open">Solo Abierto</option>
            <option value="closed">Solo Cerrado</option>
            <option value="terminado">Solo Terminado</option>
          </select>
        </Field>
        <Field label="Marcar como" hint="resultado venta">
          <select
            data-testid="bulk-outcome"
            value={bulkForm.outcome}
            onChange={(e) => setBulkForm({ ...bulkForm, outcome: e.target.value })}
            disabled={isRunning}
            className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta disabled:opacity-50"
          >
            <option value="sold">Vendido</option>
            <option value="not_sold">No vendido</option>
            <option value="pending">Pendiente</option>
          </select>
        </Field>
        <Field label="Fecha venta · Desde" hint="DD/MM/YYYY">
          <input
            data-testid="bulk-date-from"
            value={bulkForm.date_from}
            onChange={(e) => setBulkForm({ ...bulkForm, date_from: e.target.value })}
            placeholder="01/01/2025"
            disabled={isRunning}
            className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta disabled:opacity-50"
          />
        </Field>
        <Field label="Fecha venta · Hasta" hint="DD/MM/YYYY">
          <input
            data-testid="bulk-date-to"
            value={bulkForm.date_to}
            onChange={(e) => setBulkForm({ ...bulkForm, date_to: e.target.value })}
            placeholder="29/05/2026"
            disabled={isRunning}
            className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta disabled:opacity-50"
          />
        </Field>
        <Field label="Límite" hint="máx 2000">
          <input
            data-testid="bulk-limit"
            type="number"
            value={bulkForm.limit}
            onChange={(e) => setBulkForm({ ...bulkForm, limit: Number(e.target.value) || 0 })}
            disabled={isRunning}
            className="w-full bg-white border border-clay-300 px-3 py-2 text-sm tabular outline-none focus:border-terracotta disabled:opacity-50"
          />
        </Field>
      </div>

      <div className="flex items-center justify-between px-5 pb-5">
        <button
          onClick={() => setShowHistory((v) => !v)}
          className="text-[11px] tracking-widest uppercase text-clay-700 hover:text-terracotta"
        >
          {showHistory ? "Ocultar historial de jobs" : `Historial de imports (${jobsHistory.length})`}
        </button>
        <button
          data-testid="bulk-start-btn"
          onClick={onStart}
          disabled={isRunning}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-terracotta text-white text-sm tracking-wider uppercase hover:bg-terracotta-hover disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isRunning ? <RotateCw size={14} className="animate-spin" /> : <Download size={14} />}
          {isRunning ? "Importando…" : "Iniciar importación"}
        </button>
      </div>

      {activeJob && (
        <div className="border-t border-clay-300 bg-clay-50/50 px-5 py-4" data-testid="bulk-progress">
          <div className="flex items-center justify-between text-[11px] tracking-widest uppercase text-clay-700 mb-2">
            <span>Job · {activeJob.job_id}</span>
            <span className={`px-2 py-0.5 border ${
              activeJob.status === "running" ? "bg-terracotta text-white border-terracotta" :
              activeJob.status === "completed" ? "bg-pine text-white border-pine" :
              activeJob.status === "failed" ? "bg-clay-900 text-white border-clay-900" :
              "bg-white border-clay-300"
            }`}>{activeJob.status}</span>
          </div>
          <div className="grid grid-cols-4 gap-0 border border-clay-300 bg-white text-center mb-3">
            <Stat l="Encontrados" v={activeJob.matched} />
            <Stat l="Importados" v={activeJob.scraped} cls="text-pine border-l border-clay-300" />
            <Stat l="Saltados" v={activeJob.skipped} cls="border-l border-clay-300" />
            <Stat l="Errores" v={activeJob.failed} cls="text-destructive border-l border-clay-300" />
          </div>
          <div className="h-2 bg-clay-200 overflow-hidden">
            <div
              className={`h-full transition-all ${activeJob.status === "completed" ? "bg-pine" : "bg-terracotta"}`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="text-[11px] text-clay-700 mt-2 font-mono truncate" data-testid="bulk-last-message">
            {activeJob.last_message || "—"}
          </div>
          {activeJob.errors && activeJob.errors.length > 0 && (
            <details className="mt-2">
              <summary className="text-[11px] text-destructive cursor-pointer">{activeJob.errors.length} errores</summary>
              <ul className="text-[10px] text-clay-700 mt-1 ml-3 list-disc">
                {activeJob.errors.slice(-10).map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      {showHistory && (
        <div className="border-t border-clay-300 px-5 py-3 bg-white">
          {jobsHistory.length === 0 ? (
            <div className="text-[12px] text-clay-700 italic py-2">Sin jobs anteriores.</div>
          ) : (
            <table className="w-full text-[11px]">
              <thead className="text-clay-700 uppercase tracking-widest text-[10px]">
                <tr>
                  <th className="text-left py-1.5">Inicio</th>
                  <th className="text-left py-1.5">Filtros</th>
                  <th className="text-center py-1.5">Encontrados</th>
                  <th className="text-center py-1.5">Importados</th>
                  <th className="text-center py-1.5">Errores</th>
                  <th className="text-left py-1.5">Estado</th>
                </tr>
              </thead>
              <tbody>
                {jobsHistory.slice(0, 10).map((j) => (
                  <tr key={j.job_id} className="border-t border-clay-200">
                    <td className="py-1 tabular">{new Date(j.started_at).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })}</td>
                    <td className="py-1 text-clay-700 truncate max-w-[280px]">
                      {[j.params?.agent || "Todos", j.params?.source, j.params?.status, j.params?.outcome || "sold", `${j.params?.date_from}→${j.params?.date_to}`].filter(Boolean).join(" · ")}
                    </td>
                    <td className="py-1 text-center tabular">{j.matched}</td>
                    <td className="py-1 text-center tabular text-pine font-semibold">{j.scraped}</td>
                    <td className="py-1 text-center tabular text-destructive">{j.failed}</td>
                    <td className="py-1 uppercase tracking-widest text-[10px]">{j.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="smallcaps text-[10px]">{label}</span>
        {hint && <span className="text-[9px] text-clay-500 italic">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Stat({ l, v, cls = "" }) {
  return (
    <div className={`p-3 ${cls}`}>
      <div className="smallcaps text-[9px]">{l}</div>
      <div className="font-serif text-2xl tabular leading-none mt-1">{v ?? 0}</div>
    </div>
  );
}

/* =========================================================================
 *  PENDING REQUESTS SECTION
 * =======================================================================*/
function PendingRequestsSection({ items, onSaved }) {
  return (
    <div className="mb-8" data-testid="pending-section">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-baseline gap-2">
          <FileQuestion size={16} className="text-terracotta -mb-0.5"/>
          <h3 className="font-serif text-2xl">Entrenamientos pendientes de solicitud</h3>
          <span className="text-[11px] tracking-widest uppercase text-clay-700">{items.length} pendientes</span>
        </div>
        <span className="text-[11px] text-clay-700 italic">Pega el request original del cliente para que el agente aprenda del par completo.</span>
      </div>
      <div className="space-y-3">
        {items.map((ex) => (
          <PendingCard key={ex.example_id} ex={ex} onSaved={onSaved} />
        ))}
      </div>
    </div>
  );
}

function PendingCard({ ex, onSaved }) {
  const [text, setText] = useState("");
  const [name, setName] = useState(ex.client_name || "");
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const struct = ex.itinerary_structured_ops;
  const days = struct?.days || [];

  const save = async () => {
    if (!text.trim()) { toast.error("Pega la solicitud original del cliente"); return; }
    setSaving(true);
    try {
      await api.patch(`/training-examples/${ex.example_id}`, {
        client_request: text.trim(),
        client_name: name.trim() || ex.client_name,
      });
      toast.success("Solicitud guardada · ejemplo completo");
      onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Error al guardar");
    } finally {
      setSaving(false);
    }
  };

  const dismiss = async () => {
    if (!window.confirm("¿Eliminar este entrenamiento sin solicitud?")) return;
    await api.delete(`/training-examples/${ex.example_id}`);
    toast.info("Eliminado");
    onSaved();
  };

  return (
    <div className="border border-clay-300 bg-white" data-testid={`pending-${ex.example_id}`}>
      <div className="grid grid-cols-[1fr_auto] items-start px-4 pt-3 pb-2 gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nombre del cliente"
              className="font-semibold text-sm bg-transparent border-b border-clay-300 focus:border-terracotta outline-none px-1 py-0.5 min-w-[180px]"
            />
            <span className="text-[11px] text-clay-700">
              {struct?.trip_name && <span className="italic">· {struct.trip_name}</span>}
              {days.length > 0 && <span> · {days.length} días</span>}
              {struct?.start_date && <span> · {struct.start_date} → {struct.end_date || "?"}</span>}
            </span>
          </div>
          <div className="text-[11px] text-clay-700 mt-1 flex items-center gap-2">
            <a href={ex.itinerary_url_ops} target="_blank" rel="noreferrer" className="text-terracotta hover:underline inline-flex items-center gap-1">
              <ExternalLink size={11}/> Ver viaje en gestion
            </a>
            <span className="text-clay-400">·</span>
            <button onClick={() => setExpanded((v) => !v)} className="hover:text-terracotta">
              {expanded ? "Ocultar resumen" : "Ver resumen del itinerario"}
            </button>
          </div>
        </div>
        <button onClick={dismiss} className="p-1 hover:bg-clay-200 text-clay-500 hover:text-destructive" title="Eliminar">
          <Trash2 size={14}/>
        </button>
      </div>

      {expanded && days.length > 0 && (
        <div className="border-t border-clay-200 bg-clay-50/40 px-4 py-2 max-h-60 overflow-auto">
          <div className="space-y-1">
            {days.map((d, i) => (
              <div key={i} className="text-[11px]">
                <span className="font-semibold">Day {d.day} · {d.city || "—"}</span>
                {d.date && <span className="tabular text-clay-700 ml-2">{d.date}</span>}
                {(d.activities || []).slice(0, 3).map((a, j) => (
                  <div key={`a${j}`} className="text-clay-700 pl-3">• {a.name}</div>
                ))}
                {(d.hotels || []).map((h, j) => (
                  <div key={`h${j}`} className="text-terracotta pl-3 font-semibold">🏨 {h.name}{h.nights ? ` · ${h.nights}n` : ""}</div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-clay-200 px-4 py-3">
        <div className="smallcaps text-terracotta mb-1.5 text-[10px]">Solicitud original del cliente</div>
        <textarea
          data-testid={`pending-request-${ex.example_id}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="Pega el email / brief original del cliente que dio origen a este viaje…"
          className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta"
        />
        <div className="flex justify-end mt-2">
          <button
            data-testid={`pending-save-${ex.example_id}`}
            onClick={save}
            disabled={saving || !text.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-pine text-white text-xs tracking-wider uppercase hover:bg-pine-hover disabled:opacity-40"
          >
            <Save size={13}/> {saving ? "Guardando…" : "Guardar y marcar entrenado"}
          </button>
        </div>
      </div>
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
