import React, { useMemo, useState } from "react";
import {
  Sparkles, Undo2, ExternalLink, Copy, Send, CheckCircle2, Clock,
  AlertCircle, XCircle, Plus, ArrowUpRight,
} from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";

const fmtEUR = (n) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n || 0);

const EXTRA_BADGE = {
  draft:     { text: "Borrador",  cls: "bg-clay-100 text-clay-700", Icon: Clock },
  sent:      { text: "Pendiente", cls: "bg-amber-100 text-amber-800", Icon: Clock },
  paid:      { text: "Cobrado",   cls: "bg-pine-soft/40 text-pine",  Icon: CheckCircle2 },
  cancelled: { text: "Cancelado", cls: "bg-clay-200 text-clay-700",  Icon: XCircle },
};

const REFUND_BADGE = {
  pending:  { text: "Pendiente",   cls: "bg-amber-100 text-amber-800", Icon: Clock },
  approved: { text: "Aprobado",    cls: "bg-blue-50 text-blue-700",    Icon: CheckCircle2 },
  executed: { text: "Reembolsado", cls: "bg-pine-soft/40 text-pine",   Icon: CheckCircle2 },
  rejected: { text: "Rechazado",   cls: "bg-clay-200 text-clay-700",   Icon: XCircle },
  failed:   { text: "Fallido",     cls: "bg-red-100 text-red-700",     Icon: AlertCircle },
};

/**
 * Inline post-sale accounting section that lives at the bottom of the
 * ItineraryBuilder — under Days + Accommodations. Renders two lists
 * (extras / refunds) with totals so the agent can see the audit trail
 * without opening a modal. All CRUD lives in the modals; this is
 * read-mostly with a "sync to Sofi" action per row when the trip has
 * already been pushed.
 */
export function PostSaleSection({
  itineraryId, extras, refunds, payments, sofiTripId,
  onOpenExtras, onOpenRefunds, onChange,
}) {
  const paidExtras = useMemo(
    () => extras.filter((e) => e.status === "paid"),
    [extras]
  );
  const pendingExtras = useMemo(
    () => extras.filter((e) => e.status === "sent" || e.status === "draft"),
    [extras]
  );
  const executedRefunds = useMemo(
    () => refunds.filter((r) => r.status === "executed"),
    [refunds]
  );
  const pendingRefunds = useMemo(
    () => refunds.filter((r) => r.status === "pending" || r.status === "failed"),
    [refunds]
  );

  const totalExtrasPaid = paidExtras.reduce(
    (s, e) => s + (e.paid_amount ?? e.amount_eur ?? 0), 0
  );
  const totalExtrasPending = pendingExtras.reduce(
    (s, e) => s + (e.amount_eur ?? 0), 0
  );
  const totalRefundsExecuted = executedRefunds.reduce(
    (s, r) => s + (r.amount_eur ?? 0), 0
  );

  return (
    <section className="mt-12 border-t-2 border-clay-300 pt-6" data-testid="post-sale-section">
      <div className="flex items-baseline justify-between mb-5">
        <div>
          <div className="smallcaps text-clay-700 inline-flex items-center gap-2">
            <Sparkles size={12}/> Post-venta · reservas y cancelaciones
          </div>
          <div className="font-serif text-2xl mt-1">Ajustes tras la venta</div>
          <div className="text-xs text-clay-500 mt-1">
            Extras cobrados suman al PVP · reembolsos ejecutados restan · ambos se sincronizan a Sofi{" "}
            {sofiTripId ? <>(trip <code className="font-mono">#{sofiTripId}</code>)</> : "cuando el viaje esté pusheado"}.
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* EXTRAS */}
        <div className="border border-clay-300">
          <div className="px-4 py-3 border-b border-clay-300 bg-clay-50 flex items-center justify-between">
            <div className="smallcaps inline-flex items-center gap-2">
              <Sparkles size={11}/> Extras post-venta ({extras.length})
            </div>
            <button onClick={onOpenExtras}
                    data-testid="post-sale-open-extras"
                    className="inline-flex items-center gap-1 text-xs text-clay-700 hover:text-terracotta">
              <Plus size={12}/> Nuevo extra
            </button>
          </div>
          {extras.length === 0 ? (
            <div className="px-4 py-5 text-xs text-clay-500 italic">
              Aún no hay extras. Añade uno cuando el cliente quiera sumar una actividad después de la venta.
            </div>
          ) : (
            <div className="divide-y divide-clay-200">
              {extras.map((e) => (
                <ExtraRow key={e.extra_id}
                          itineraryId={itineraryId}
                          extra={e}
                          sofiTripId={sofiTripId}
                          onChange={onChange}/>
              ))}
            </div>
          )}
          {(totalExtrasPaid > 0 || totalExtrasPending > 0) && (
            <div className="px-4 py-2 border-t-2 border-clay-300 bg-clay-50 text-xs flex flex-wrap items-center justify-between gap-2">
              <span className="text-clay-700">
                {totalExtrasPending > 0 && <>Pendiente de cobro: <strong className="tabular">{fmtEUR(totalExtrasPending)}</strong></>}
              </span>
              <span className="tabular font-serif text-lg text-pine" data-testid="post-sale-extras-paid">
                + {fmtEUR(totalExtrasPaid)} cobrados
              </span>
            </div>
          )}
        </div>

        {/* REFUNDS */}
        <div className="border border-clay-300">
          <div className="px-4 py-3 border-b border-clay-300 bg-clay-50 flex items-center justify-between">
            <div className="smallcaps inline-flex items-center gap-2">
              <Undo2 size={11}/> Reembolsos ({refunds.length})
            </div>
            <button onClick={onOpenRefunds}
                    data-testid="post-sale-open-refunds"
                    className="inline-flex items-center gap-1 text-xs text-clay-700 hover:text-terracotta">
              <Plus size={12}/> Solicitar
            </button>
          </div>
          {refunds.length === 0 ? (
            <div className="px-4 py-5 text-xs text-clay-500 italic">
              Sin reembolsos. Solicita uno cuando canceles una actividad para devolver el importe al cliente vía PayPal.
            </div>
          ) : (
            <div className="divide-y divide-clay-200">
              {refunds.map((r) => (
                <RefundRow key={r.refund_id}
                           itineraryId={itineraryId}
                           refund={r}
                           payments={payments}
                           sofiTripId={sofiTripId}
                           onChange={onChange}/>
              ))}
            </div>
          )}
          {(totalRefundsExecuted > 0 || pendingRefunds.length > 0) && (
            <div className="px-4 py-2 border-t-2 border-clay-300 bg-clay-50 text-xs flex flex-wrap items-center justify-between gap-2">
              <span className="text-clay-700">
                {pendingRefunds.length > 0 && <>Pendientes: <strong>{pendingRefunds.length}</strong></>}
              </span>
              <span className="tabular font-serif text-lg text-red-700" data-testid="post-sale-refunds-executed">
                − {fmtEUR(totalRefundsExecuted)} devueltos
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ExtraRow({ itineraryId, extra, sofiTripId, onChange }) {
  const badge = EXTRA_BADGE[extra.status] || EXTRA_BADGE.sent;
  const Icon = badge.Icon;
  const publicUrl = `${window.location.origin}/pay/extra/${extra.payment_token}`;
  const [pushing, setPushing] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(publicUrl).then(
      () => toast.success("Enlace copiado"),
      () => toast.error("No se pudo copiar")
    );
  };

  const pushToSofi = async () => {
    if (!sofiTripId) { toast.error("El viaje aún no está en Sofi — publícalo primero."); return; }
    if (!window.confirm(`¿Añadir "${extra.title}" (${fmtEUR(extra.paid_amount ?? extra.amount_eur)}) como reserva extra en Sofi #${sofiTripId}?`)) return;
    setPushing(true);
    try {
      await api.post(`/itineraries/${itineraryId}/extras/${extra.extra_id}/push-to-sofi`);
      toast.success("Extra sincronizado a Sofi");
      if (onChange) await onChange();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "No se pudo sincronizar");
    } finally { setPushing(false); }
  };

  return (
    <div className="px-4 py-3" data-testid={`post-sale-extra-${extra.extra_id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-medium text-sm truncate">{extra.title}</div>
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-widest ${badge.cls}`}>
              <Icon size={10}/> {badge.text}
            </span>
            {extra.synced_to_sofi && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-widest bg-blue-50 text-blue-700"
                    title="Ya está en Sofi">
                <CheckCircle2 size={10}/> Sofi ✓
              </span>
            )}
          </div>
          {extra.date && (
            <div className="text-[11px] text-clay-500 mt-1">Fecha: {extra.date}</div>
          )}
          {extra.paid_at && (
            <div className="text-[11px] text-pine mt-1">Cobrado el {extra.paid_at.slice(0, 10)}</div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className={`font-serif tabular text-lg ${extra.status === "paid" ? "text-pine" : ""}`}>
            {fmtEUR(extra.paid_amount ?? extra.amount_eur)}
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        {extra.status !== "cancelled" && (
          <>
            <button onClick={copy}
                    data-testid={`post-sale-extra-copy-${extra.extra_id}`}
                    className="inline-flex items-center gap-1 px-2 py-1 border border-clay-300 hover:bg-clay-100 text-[11px]">
              <Copy size={10}/> Copiar enlace
            </button>
            <a href={publicUrl} target="_blank" rel="noreferrer"
               data-testid={`post-sale-extra-open-${extra.extra_id}`}
               className="inline-flex items-center gap-1 px-2 py-1 border border-clay-300 hover:bg-clay-100 text-[11px]">
              <ExternalLink size={10}/> Abrir
            </a>
          </>
        )}
        {extra.status === "paid" && sofiTripId && !extra.synced_to_sofi && (
          <button onClick={pushToSofi}
                  disabled={pushing}
                  data-testid={`post-sale-extra-push-sofi-${extra.extra_id}`}
                  className="inline-flex items-center gap-1 px-2 py-1 border border-clay-300 hover:bg-clay-100 text-[11px] text-blue-700 disabled:opacity-60">
            <ArrowUpRight size={10}/> {pushing ? "Enviando…" : "Push a Sofi"}
          </button>
        )}
      </div>
    </div>
  );
}

function RefundRow({ itineraryId, refund, payments, sofiTripId, onChange }) {
  const badge = REFUND_BADGE[refund.status] || REFUND_BADGE.pending;
  const Icon = badge.Icon;
  const [pushing, setPushing] = useState(false);
  const sourcePayment = payments.find((p) => p.payment_id === refund.payment_id);

  const pushToSofi = async () => {
    if (!sofiTripId) { toast.error("El viaje aún no está en Sofi — publícalo primero."); return; }
    if (!window.confirm(`¿Registrar reembolso de ${fmtEUR(refund.amount_eur)} en Sofi #${sofiTripId}?`)) return;
    setPushing(true);
    try {
      await api.post(`/itineraries/${itineraryId}/refund-requests/${refund.refund_id}/push-to-sofi`);
      toast.success("Reembolso registrado en Sofi");
      if (onChange) await onChange();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "No se pudo sincronizar");
    } finally { setPushing(false); }
  };

  return (
    <div className="px-4 py-3" data-testid={`post-sale-refund-${refund.refund_id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-serif tabular text-base">− {fmtEUR(refund.amount_eur)}</div>
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-widest ${badge.cls}`}>
              <Icon size={10}/> {badge.text}
            </span>
            {refund.synced_to_sofi && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-widest bg-blue-50 text-blue-700"
                    title="Ya está en Sofi">
                <CheckCircle2 size={10}/> Sofi ✓
              </span>
            )}
          </div>
          {refund.reason && (
            <div className="text-xs text-clay-700 mt-1 line-clamp-2">{refund.reason}</div>
          )}
          {sourcePayment && (
            <div className="text-[10px] text-clay-500 mt-1">
              De {sourcePayment.kind} · {(sourcePayment.paid_at || sourcePayment.created_at || "").slice(0,10)}
              {sourcePayment.payer_name && <> · {sourcePayment.payer_name}</>}
            </div>
          )}
          {refund.error_message && (
            <div className="text-[11px] text-red-700 italic mt-1">{refund.error_message}</div>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        {refund.paypal_refund_id && (
          <span className="text-[10px] font-mono text-clay-500">PayPal: {refund.paypal_refund_id}</span>
        )}
        {refund.status === "executed" && sofiTripId && !refund.synced_to_sofi && (
          <button onClick={pushToSofi}
                  disabled={pushing}
                  data-testid={`post-sale-refund-push-sofi-${refund.refund_id}`}
                  className="inline-flex items-center gap-1 px-2 py-1 border border-clay-300 hover:bg-clay-100 text-[11px] text-blue-700 disabled:opacity-60">
            <ArrowUpRight size={10}/> {pushing ? "Enviando…" : "Push a Sofi"}
          </button>
        )}
      </div>
    </div>
  );
}
