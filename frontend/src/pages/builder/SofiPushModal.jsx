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
          ? "Abriendo Chromium · rellenando cabecera + previsualizando reservas (sin enviar)…"
          : "Enviando cabecera del trip + reservas a Sofi (esto puede tardar varios minutos)…"}
      </p>
      <p className="text-xs smallcaps tabular text-clay-500">
        {elapsed}s · {dryRun ? "60-120s aprox." : "puede tardar 3-6 min en itinerarios largos"}
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
  const bookings = result?.bookings_plan || [];
  const bookingsSample = result?.bookings_sample_filled || [];
  const bookingsScreenshot = result?.bookings_screenshot_b64;

  const launchReal = () => {
    if (!window.confirm(
      "Esto va a CREAR un trip real en Sofi (gestion.viajadverdad.com)\n" +
      `+ ${bookings.length} reservas asociadas.\n\n` +
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
            : `Vista previa OK · ${fields.length} campos rellenados en cabecera + ${bookings.length} reservas planificadas.`}
        </p>
        <p className="text-xs text-clay-600 mt-1">
          Revisa los datos abajo. Si todo está correcto, pulsa <strong>Enviar de verdad</strong>.
        </p>
      </div>

      <details className="border border-clay-300" open>
        <summary className="px-4 py-2 text-xs smallcaps cursor-pointer hover:bg-clay-100 bg-clay-50">
          Cabecera del trip · {fields.length} campos
        </summary>
        <FilledFieldsTable fields={fields} />
      </details>

      <BookingsPlanTable bookings={bookings} />

      {bookingsSample.length > 0 && (
        <details className="border border-clay-300">
          <summary className="px-4 py-2 text-xs smallcaps cursor-pointer hover:bg-clay-100">
            Muestra de relleno de la primera reserva ({bookingsSample.length} campos)
          </summary>
          <FilledFieldsTable fields={bookingsSample} />
        </details>
      )}

      {(screenshot || bookingsScreenshot) && (
        <details className="border border-clay-300">
          <summary className="px-4 py-2 text-xs smallcaps cursor-pointer hover:bg-clay-100">
            Ver screenshots de los formularios
          </summary>
          {screenshot && (
            <div className="border-t border-clay-300">
              <p className="px-4 py-2 text-xs text-clay-600 bg-clay-50">Cabecera del trip:</p>
              <img src={`data:image/png;base64,${screenshot}`} alt="Sofi trip form preview"
                   className="w-full" data-testid="sofi-dryrun-screenshot" />
            </div>
          )}
          {bookingsScreenshot && (
            <div className="border-t border-clay-300">
              <p className="px-4 py-2 text-xs text-clay-600 bg-clay-50">Form de reserva (primera, no enviada):</p>
              <img src={`data:image/png;base64,${bookingsScreenshot}`} alt="Sofi booking form preview"
                   className="w-full" data-testid="sofi-dryrun-bookings-screenshot" />
            </div>
          )}
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
          <Send size={14} /> Enviar de verdad ({1 + bookings.length} envíos)
        </button>
      </div>
    </div>
  );
}

function BookingsPlanTable({ bookings }) {
  if (!bookings.length) {
    return (
      <div className="border border-clay-300 px-4 py-3 text-xs text-clay-600">
        Sin reservas a crear (el itinerario no tiene servicios ni alojamientos).
      </div>
    );
  }
  const ICON = { service: "🎫", accommodation: "🏨", free_day: "☀️" };
  const KIND_LABEL = { service: "Servicio", accommodation: "Alojamiento", free_day: "Free Day" };
  return (
    <div className="border border-clay-300" data-testid="sofi-bookings-plan">
      <div className="px-4 py-2 bg-clay-100 border-b border-clay-300 smallcaps flex items-center justify-between">
        <span>Reservas a crear ({bookings.length})</span>
        <span className="text-clay-500 normal-case">
          🎫 {bookings.filter((b) => b.kind === "service").length} ·
          🏨 {bookings.filter((b) => b.kind === "accommodation").length} ·
          ☀️ {bookings.filter((b) => b.kind === "free_day").length}
        </span>
      </div>
      <table className="w-full text-xs">
        <thead className="bg-clay-50 border-b border-clay-200">
          <tr>
            <th className="text-left px-3 py-1.5 w-6"></th>
            <th className="text-left px-3 py-1.5">Fecha</th>
            <th className="text-left px-3 py-1.5">Servicio</th>
            <th className="text-left px-3 py-1.5">Ciudad</th>
            <th className="text-left px-3 py-1.5">Hab.</th>
            <th className="text-right px-3 py-1.5">Pax</th>
            <th className="text-right px-3 py-1.5">Sin IVA</th>
            <th className="text-right px-3 py-1.5">Con IVA</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-clay-200">
          {bookings.map((b, i) => {
            const dateRange = b.date_exit
              ? `${b.date_entry || "?"} → ${b.date_exit}`
              : (b.date_entry || "—");
            return (
              <tr key={i} className="hover:bg-clay-50">
                <td className="px-3 py-1.5" title={KIND_LABEL[b.kind] || b.kind}>{ICON[b.kind] || "·"}</td>
                <td className="px-3 py-1.5 tabular text-clay-700">{dateRange}</td>
                <td className="px-3 py-1.5 break-all">{b.service_name}</td>
                <td className="px-3 py-1.5 text-clay-700">{b.city || "—"}</td>
                <td className="px-3 py-1.5 text-clay-700">{b.room || "—"}</td>
                <td className="px-3 py-1.5 text-right tabular">{b.quantity}</td>
                <td className="px-3 py-1.5 text-right tabular">{Number(b.invoice_excl || 0).toFixed(2)} €</td>
                <td className="px-3 py-1.5 text-right tabular">{Number(b.invoice_incl || 0).toFixed(2)} €</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RealPushDoneState({ result, onClose }) {
  const tripId = result?.trip_id;
  const url = result?.url;
  const bookingsResults = result?.bookings_results || [];
  const bookingsOk = result?.bookings_ok ?? bookingsResults.filter((b) => b.ok).length;
  const bookingsTotal = result?.bookings_total ?? bookingsResults.length;
  const bookingsFailed = bookingsResults.filter((b) => !b.ok);
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
        {bookingsTotal > 0 && (
          <p className="text-xs text-clay-700 mt-1">
            Reservas creadas: <span className="tabular font-mono">{bookingsOk}/{bookingsTotal}</span>
            {bookingsFailed.length > 0 && (
              <span className="text-red-700"> · {bookingsFailed.length} con error</span>
            )}
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

      {bookingsFailed.length > 0 && (
        <div className="border border-red-300 bg-red-50/40 px-4 py-3">
          <p className="text-xs font-medium text-red-800 mb-2">
            ⚠ {bookingsFailed.length} reserva{bookingsFailed.length === 1 ? "" : "s"} con error:
          </p>
          <ul className="text-xs text-red-700 space-y-1">
            {bookingsFailed.map((b, i) => (
              <li key={i}>
                <strong>{b.service}</strong>: {b.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {bookingsResults.length > 0 && (
        <details className="border border-clay-300">
          <summary className="px-4 py-2 text-xs smallcaps cursor-pointer hover:bg-clay-100">
            Ver {bookingsResults.length} reservas creadas
          </summary>
          <table className="w-full text-xs">
            <thead className="bg-clay-50 border-y border-clay-200">
              <tr>
                <th className="text-left px-3 py-1.5">#</th>
                <th className="text-left px-3 py-1.5">Servicio</th>
                <th className="text-left px-3 py-1.5">Estado</th>
                <th className="text-left px-3 py-1.5">Sofi ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-clay-200">
              {bookingsResults.map((b, i) => (
                <tr key={i}>
                  <td className="px-3 py-1.5 tabular text-clay-500">{i + 1}</td>
                  <td className="px-3 py-1.5">{b.service}</td>
                  <td className="px-3 py-1.5">
                    {b.ok ? <span className="text-pine-700">✓ OK</span>
                          : <span className="text-red-700">✗ {b.error?.slice(0, 40) || "Error"}</span>}
                  </td>
                  <td className="px-3 py-1.5 tabular">
                    {b.sofi_booking_id ? (
                      <a href={b.url} target="_blank" rel="noreferrer"
                         className="text-pine-700 hover:underline">
                        #{b.sofi_booking_id}
                      </a>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {result?.filled_fields?.length > 0 && (
        <details className="border border-clay-300">
          <summary className="px-4 py-2 text-xs smallcaps cursor-pointer hover:bg-clay-100">
            Ver {result.filled_fields.length} campos de cabecera enviados
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
