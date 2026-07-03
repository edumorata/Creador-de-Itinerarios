import React, { useMemo } from "react";
import { CreditCard, ShieldCheck, Clock, ExternalLink, CheckCircle2 } from "lucide-react";

const fmtEUR = (n) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n || 0);

const KIND_LABEL = {
  deposit: "Depósito",
  full:    "Pago total",
  balance: "Saldo",
  partial: "Pago parcial",
  extra:   "Extra",
};

// Full-payment deadline is 45 days before the trip start.
const FULL_PAYMENT_DUE_DAYS_BEFORE = 45;
// Below this window from trip start, the deposit option is NOT offered
// and the client must pay the full amount up-front (see backend rule).
const DEPOSIT_WINDOW_DAYS = 60;
const DEPOSIT_PCT = 0.30;

/**
 * Compact cashflow summary that sits right under the PVP block on the
 * itinerary builder aside. Renders ONLY when there are captured
 * payments — for drafts we hide it so the summary stays clean. Pure
 * client-side computation over the itinerary doc; no extra API calls.
 */
export function CashflowStatus({ startDate, total, payments = [], onOpenLinkModal }) {
  const captured = useMemo(
    () => (payments || []).filter((p) => p.status === "captured"),
    [payments]
  );

  const paid = useMemo(
    () => captured.reduce((s, p) => s + Number(p.paid_amount || p.amount_eur || 0), 0),
    [captured]
  );
  const remaining = Math.max(0, Number(total || 0) - paid);
  const fullyPaid = remaining < 0.01;

  const dueInfo = useMemo(() => {
    if (!startDate) return null;
    const start = new Date(startDate + "T00:00:00");
    if (isNaN(start.getTime())) return null;
    const due = new Date(start);
    due.setDate(due.getDate() - FULL_PAYMENT_DUE_DAYS_BEFORE);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const daysToStart = Math.round((start - today) / 86400000);
    const daysToDue = Math.round((due - today) / 86400000);
    return {
      dueDate: due.toISOString().slice(0, 10),
      daysToDue,
      daysToStart,
      overdue: daysToDue < 0,
    };
  }, [startDate]);

  // Booking threshold: full amount if trip <= 60d, else 30% deposit.
  const threshold = useMemo(() => {
    const t = Number(total || 0);
    if (!dueInfo) return t;
    return dueInfo.daysToStart <= DEPOSIT_WINDOW_DAYS ? t : Math.round(t * DEPOSIT_PCT * 100) / 100;
  }, [total, dueInfo]);

  const bookingSecured = threshold > 0 && paid >= threshold - 0.01;

  // Hide entirely on brand-new drafts (no total, no payments)
  if (!total && captured.length === 0) return null;

  const paidPct = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;

  const lastThree = captured
    .slice()
    .sort((a, b) => (b.paid_at || "").localeCompare(a.paid_at || ""))
    .slice(0, 3);

  return (
    <div className="mt-2 border border-clay-300" data-testid="cashflow-status">
      <button onClick={onOpenLinkModal}
              data-testid="cashflow-open-link"
              type="button"
              className="w-full px-3 py-2 border-b border-clay-300 bg-clay-50 flex items-center justify-between hover:bg-clay-100">
        <div className="smallcaps inline-flex items-center gap-2">
          <CreditCard size={11}/> Estado de cobros
        </div>
        <ExternalLink size={11} className="text-clay-500"/>
      </button>

      {/* Totales */}
      <div className="px-3 py-2 text-xs space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-clay-500">Cobrado</span>
          <span className="tabular text-pine font-medium" data-testid="cashflow-paid">{fmtEUR(paid)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-clay-500">Falta</span>
          <span className={`tabular font-medium ${fullyPaid ? "text-pine" : "text-terracotta"}`}
                data-testid="cashflow-remaining">{fmtEUR(remaining)}</span>
        </div>

        {/* Progress bar (paid vs total) */}
        <div className="pt-1">
          <div className="h-1.5 bg-clay-200 relative overflow-hidden">
            <div className={`h-full ${bookingSecured ? "bg-pine" : "bg-terracotta"}`}
                 style={{ width: `${paidPct}%` }}
                 data-testid="cashflow-progress"/>
          </div>
          <div className="flex items-center justify-between text-[10px] text-clay-500 mt-1">
            <span>0 €</span>
            <span className="tabular">{paidPct}% de {fmtEUR(total || 0)}</span>
          </div>
        </div>

        {/* Booking status */}
        <div className={`inline-flex items-center gap-1 text-[10px] mt-1 px-2 py-0.5 uppercase tracking-widest ${
          bookingSecured ? "bg-pine-soft/40 text-pine" : "bg-amber-100 text-amber-800"
        }`} data-testid="cashflow-secured-badge">
          {bookingSecured ? <ShieldCheck size={10}/> : <Clock size={10}/>}
          {bookingSecured
            ? "Reserva asegurada"
            : `Reserva al llegar a ${fmtEUR(threshold)}`}
        </div>
      </div>

      {/* Balance-due countdown */}
      {!fullyPaid && dueInfo && (
        <div className="px-3 py-2 border-t border-clay-300 bg-clay-50">
          <div className="text-[10px] uppercase tracking-widest text-clay-500 mb-0.5">Vencimiento del saldo</div>
          <div className="flex items-center justify-between text-xs">
            <span className="tabular">{dueInfo.dueDate}</span>
            <span className={`tabular text-[11px] ${
              dueInfo.overdue ? "text-red-700 font-medium"
              : dueInfo.daysToDue <= 5 ? "text-terracotta font-medium"
              : "text-clay-700"
            }`} data-testid="cashflow-days-to-due">
              {dueInfo.overdue
                ? `Vencido hace ${Math.abs(dueInfo.daysToDue)} días`
                : dueInfo.daysToDue === 0
                  ? "Hoy vence"
                  : `en ${dueInfo.daysToDue} días`}
            </span>
          </div>
          <div className="text-[10px] text-clay-500 mt-1">
            45 días antes de la salida. Recordatorio automático 5 días antes.
          </div>
        </div>
      )}

      {/* Captured payments (last 3) */}
      {lastThree.length > 0 && (
        <div className="px-3 py-2 border-t border-clay-300">
          <div className="text-[10px] uppercase tracking-widest text-clay-500 mb-1">Últimos pagos</div>
          <div className="space-y-1">
            {lastThree.map((p) => (
              <div key={p.payment_id}
                   data-testid={`cashflow-payment-${p.payment_id}`}
                   className="flex items-center justify-between text-[11px]">
                <div className="min-w-0 truncate">
                  <CheckCircle2 size={9} className="inline text-pine mr-1"/>
                  <span>{KIND_LABEL[p.kind] || p.kind}</span>
                  {p.share_label ? <span className="text-clay-500"> · {p.share_label}</span> : null}
                  <span className="text-clay-500 ml-1">
                    {(p.paid_at || p.created_at || "").slice(0, 10)}
                  </span>
                </div>
                <span className="tabular text-pine shrink-0 ml-2">+ {fmtEUR(p.paid_amount || p.amount_eur)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
