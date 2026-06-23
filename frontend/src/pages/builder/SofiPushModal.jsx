import React, { useEffect, useRef, useState } from "react";
import { X, ExternalLink, Loader2, CheckCircle2, AlertTriangle, Send } from "lucide-react";
import api from "@/lib/api";

/**
 * Modal that drives a Sofi push job (dry-run or real).
 *
 * Lifecycle:
 *  1. Mount → POST /push-to-sofi {dry_run} → store job_id, start polling.
 *  2. Poll every 2s on /push-to-sofi/{job_id} until done|error.
 *  3. Show result:
 *     • dry-run done   → list of filled fields + screenshot + button to push for real
 *     • real-push done → trip_id + link to Sofi + close
 *     • error          → message + filled fields (debug context)
 */
export function SofiPushModal({ open, itineraryId, dryRun, onClose, onPushed, onSwitchToReal }) {
  const [phase, setPhase] = useState("idle"); // idle | running | done | error
  const [jobId, setJobId] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const startedRef = useRef(false);
  const startTsRef = useRef(0);

  // Reset everything when the modal closes so the next open starts clean.
  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      setPhase("idle"); setJobId(null); setResult(null);
      setError(null); setElapsed(0);
    }
  }, [open]);

  // Kick off the job once when the modal opens.
  useEffect(() => {
    if (!open || startedRef.current) return;
    startedRef.current = true;
    startTsRef.current = Date.now();
    setPhase("running");
    api.post(`/itineraries/${itineraryId}/push-to-sofi`, { dry_run: dryRun })
      .then(({ data }) => setJobId(data.job_id))
      .catch((e) => {
        setPhase("error");
        setError(e?.response?.data?.detail || e.message || "No se pudo iniciar el job");
      });
  }, [open, itineraryId, dryRun]);

  // Poll the job status while running.
  useEffect(() => {
    if (!jobId || phase !== "running") return;
    let alive = true;
    const tick = async () => {
      try {
        const { data } = await api.get(`/itineraries/push-to-sofi/${jobId}`);
        if (!alive) return;
        setElapsed(Math.round((Date.now() - startTsRef.current) / 1000));
        if (data.status === "done") {
          setPhase("done"); setResult(data.result);
          if (!dryRun && data.result?.trip_id) onPushed?.(data.result);
        } else if (data.status === "error") {
          setPhase("error"); setError(data.error || "Sofi rechazó el envío");
          setResult(data.result);
        }
      } catch (e) {
        if (!alive) return;
        setPhase("error"); setError(e?.message || "Error en polling");
      }
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => { alive = false; clearInterval(id); };
  }, [jobId, phase, dryRun, onPushed]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
         data-testid="sofi-push-modal">
      <div className="bg-white border border-clay-300 max-w-3xl w-full max-h-[90vh] overflow-y-auto shadow-xl">
        <Header dryRun={dryRun} phase={phase} onClose={onClose} />

        <div className="px-6 py-5 space-y-4">
          {phase === "running" && <RunningState elapsed={elapsed} dryRun={dryRun} />}
          {phase === "error" && <ErrorState error={error} result={result} />}
          {phase === "done" && dryRun && (
            <DryRunDoneState result={result} onCancel={onClose}
                             onConfirmReal={onSwitchToReal} />
          )}
          {phase === "done" && !dryRun && (
            <RealPushDoneState result={result} onClose={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}

function Header({ dryRun, phase, onClose }) {
  return (
    <div className="px-6 py-4 border-b border-clay-300 flex items-center justify-between bg-clay-50">
      <div className="flex items-center gap-3">
        {phase === "running" && <Loader2 size={18} className="animate-spin text-pine-700" />}
        {phase === "done" && <CheckCircle2 size={18} className="text-pine-700" />}
        {phase === "error" && <AlertTriangle size={18} className="text-red-700" />}
        <h3 className="font-serif text-xl">
          {dryRun ? "Sofi · Vista previa (dry-run)" : "Sofi · Enviar itinerario"}
        </h3>
      </div>
      <button onClick={onClose} className="p-1 hover:bg-clay-200" data-testid="sofi-modal-close">
        <X size={18} />
      </button>
    </div>
  );
}

function RunningState({ elapsed, dryRun }) {
  return (
    <div className="text-center py-8 space-y-3">
      <p className="text-sm text-clay-700">
        {dryRun
          ? "Abriendo Chromium y rellenando el formulario sin enviarlo…"
          : "Enviando el itinerario a Sofi…"}
      </p>
      <p className="text-xs smallcaps tabular text-clay-500">
        {elapsed}s · este proceso puede tardar 60-120s
      </p>
    </div>
  );
}

function ErrorState({ error, result }) {
  const filled = result?.filled_fields || [];
  const details = result?.details || [];
  return (
    <div className="space-y-3">
      <div className="border border-red-300 bg-red-50/50 px-4 py-3">
        <p className="text-sm font-medium text-red-800">Error</p>
        <p className="text-xs text-red-700 mt-1 break-words">{error}</p>
        {details.length > 0 && (
          <ul className="text-xs text-red-700 mt-2 list-disc list-inside">
            {details.map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        )}
      </div>
      {filled.length > 0 && <FilledFieldsTable fields={filled} />}
    </div>
  );
}

function DryRunDoneState({ result, onCancel, onConfirmReal }) {
  const fields = result?.filled_fields || [];
  const errored = fields.filter((f) => f.error).length;
  const screenshot = result?.screenshot_b64;

  const launchReal = () => {
    if (!window.confirm(
      "Esto va a CREAR un trip real en Sofi (gestion.viajadverdad.com).\n\n" +
      "¿Confirmas que los datos son correctos y quieres proceder?"
    )) return;
    onConfirmReal();
  };

  return (
    <div className="space-y-4">
      <div className={`border px-4 py-3 ${errored ? "border-amber-400 bg-amber-50/40" : "border-pine-300 bg-pine-50/40"}`}>
        <p className="text-sm font-medium">
          {errored
            ? `Vista previa OK con ${errored} campo${errored === 1 ? "" : "s"} que falló · Sofi quedó en el formulario relleno (sin enviar).`
            : `Vista previa OK · ${fields.length} campos rellenados · Sofi quedó en el formulario relleno (sin enviar).`}
        </p>
        <p className="text-xs text-clay-600 mt-1">
          Revisa los datos abajo. Si todo está correcto, pulsa <strong>Enviar de verdad</strong>.
        </p>
      </div>

      <FilledFieldsTable fields={fields} />

      {screenshot && (
        <details className="border border-clay-300">
          <summary className="px-4 py-2 text-xs smallcaps cursor-pointer hover:bg-clay-100">
            Ver screenshot del formulario (full-page)
          </summary>
          <img
            src={`data:image/png;base64,${screenshot}`}
            alt="Sofi form preview"
            className="w-full border-t border-clay-300"
            data-testid="sofi-dryrun-screenshot"
          />
        </details>
      )}

      <div className="flex justify-end gap-2 pt-2 border-t border-clay-300">
        <button onClick={onCancel} className="px-4 py-2 text-sm border border-clay-300 hover:bg-clay-100"
                data-testid="sofi-dryrun-cancel">
          Cancelar
        </button>
        <button onClick={launchReal}
                data-testid="sofi-dryrun-confirm-real"
                className="px-4 py-2 text-sm bg-pine-700 text-white hover:bg-pine-800 inline-flex items-center gap-2">
          <Send size={14} /> Enviar de verdad
        </button>
      </div>
    </div>
  );
}

function RealPushDoneState({ result, onClose }) {
  const tripId = result?.trip_id;
  const url = result?.url;
  return (
    <div className="space-y-4">
      <div className="border border-pine-300 bg-pine-50/40 px-4 py-4">
        <p className="text-sm font-medium text-pine-800">
          ✓ Itinerario enviado a Sofi correctamente
        </p>
        {tripId && (
          <p className="text-xs text-clay-700 mt-2">
            Trip ID en Sofi: <span className="tabular font-mono">#{tripId}</span>
          </p>
        )}
        {url && (
          <a href={url} target="_blank" rel="noreferrer"
             data-testid="sofi-pushed-link"
             className="inline-flex items-center gap-1 mt-2 text-sm text-pine-700 underline hover:text-pine-900">
            Abrir en Sofi <ExternalLink size={14} />
          </a>
        )}
      </div>

      {result?.filled_fields?.length > 0 && (
        <details className="border border-clay-300">
          <summary className="px-4 py-2 text-xs smallcaps cursor-pointer hover:bg-clay-100">
            Ver {result.filled_fields.length} campos enviados
          </summary>
          <div className="border-t border-clay-300">
            <FilledFieldsTable fields={result.filled_fields} />
          </div>
        </details>
      )}

      <div className="flex justify-end pt-2 border-t border-clay-300">
        <button onClick={onClose} className="px-4 py-2 text-sm bg-pine-700 text-white hover:bg-pine-800"
                data-testid="sofi-real-close">
          Cerrar
        </button>
      </div>
    </div>
  );
}

function FilledFieldsTable({ fields }) {
  return (
    <div className="border border-clay-300">
      <div className="px-4 py-2 bg-clay-100 border-b border-clay-300 smallcaps">
        Campos rellenados ({fields.length})
      </div>
      <ul className="divide-y divide-clay-200 max-h-72 overflow-y-auto">
        {fields.map((f, i) => (
          <li key={i} className="flex items-start justify-between gap-3 px-4 py-2 text-xs">
            <span className="text-clay-700 w-44 flex-shrink-0">{f.label}</span>
            <span className={`flex-1 break-all tabular ${f.error ? "text-red-600" : "text-clay-900"}`}>
              {f.value || "(vacío)"}
              {f.via && <span className="ml-2 text-clay-500">[{f.via}]</span>}
              {f.error && <span className="block mt-1 text-red-500">{f.error}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
