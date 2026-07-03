import React, { useEffect, useMemo, useState } from "react";
import { X, Plus, Undo2, CheckCircle2, XCircle, Clock, AlertCircle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";
import { useAuth } from "@/lib/auth";

const fmtEUR = (n) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n || 0);

const STATUS_BADGE = {
  pending:  { text: "Pendiente",  cls: "bg-amber-100 text-amber-800",   Icon: Clock },
  approved: { text: "Aprobado",   cls: "bg-blue-50 text-blue-700",      Icon: CheckCircle2 },
  executed: { text: "Reembolsado",cls: "bg-pine-soft/40 text-pine",     Icon: CheckCircle2 },
  rejected: { text: "Rechazado",  cls: "bg-clay-200 text-clay-700",     Icon: XCircle },
  failed:   { text: "Fallido",    cls: "bg-red-100 text-red-700",       Icon: AlertCircle },
};

/**
 * Refund workflow modal.
 * - Any agent can FILE a request (pending).
 * - Only managers (Bea, Marina) can APPROVE — which triggers a PayPal
 *   Refund API call — or REJECT the request.
 * - Rejected/failed requests can be retried by filing a new one.
 */
export function RefundsModal({ open, itineraryId, onClose, onChange }) {
  const { user } = useAuth();
  const [refunds, setRefunds] = useState([]);
  const [payments, setPayments] = useState([]);
  const [isApprover, setIsApprover] = useState(false);
  const [approverEmails, setApproverEmails] = useState([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState({ payment_id: "", amount_eur: "", reason: "" });
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [refundResp, linkResp] = await Promise.all([
        api.get(`/itineraries/${itineraryId}/refund-requests`),
        api.post(`/itineraries/${itineraryId}/payments/create-link`, { origin: window.location.origin }),
      ]);
      setRefunds(refundResp.data?.refund_requests || []);
      setIsApprover(!!refundResp.data?.is_approver);
      setApproverEmails(refundResp.data?.approver_emails || []);
      setPayments((linkResp.data?.payments || []).filter((p) => p.status === "captured"));
    } catch (e) {
      toast.error(e?.response?.data?.detail || "No se pudieron cargar los reembolsos");
    } finally { setLoading(false); }
  };

  useEffect(() => { if (open) load(); }, [open]);

  // Hook must run before any early return (React rules).
  const selectedPayment = payments.find((p) => p.payment_id === draft.payment_id);
  const alreadyRefunded = useMemo(() => {
    if (!selectedPayment) return 0;
    return refunds
      .filter((r) => r.payment_id === selectedPayment.payment_id && r.status === "executed")
      .reduce((s, r) => s + (r.amount_eur || 0), 0);
  }, [refunds, selectedPayment]);
  const maxRefundable = selectedPayment
    ? Math.max(0, (selectedPayment.paid_amount || selectedPayment.amount_eur || 0) - alreadyRefunded)
    : 0;

  if (!open) return null;

  const create = async () => {
    if (!draft.payment_id) { toast.error("Selecciona un pago origen"); return; }
    const amt = parseFloat(draft.amount_eur);
    if (isNaN(amt) || amt <= 0) { toast.error("Importe inválido"); return; }
    setCreating(true);
    try {
      await api.post(`/itineraries/${itineraryId}/refund-requests`, {
        payment_id: draft.payment_id,
        amount_eur: amt,
        reason: draft.reason.trim(),
      });
      setDraft({ payment_id: "", amount_eur: "", reason: "" });
      await load();
      if (onChange) onChange();
      toast.success("Reembolso solicitado — esperando aprobación de manager");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "No se pudo crear la solicitud");
    } finally { setCreating(false); }
  };

  const approve = async (refund) => {
    if (!window.confirm(`¿Aprobar reembolso de ${fmtEUR(refund.amount_eur)}? Se ejecutará el reembolso en PayPal ahora.`)) return;
    try {
      const r = await api.post(
        `/itineraries/${itineraryId}/refund-requests/${refund.refund_id}/approve`,
        { note_to_payer: refund.reason || "Trip adjustment" },
      );
      await load();
      if (onChange) onChange();
      toast.success(`Reembolso ${r.data?.status === "executed" ? "ejecutado en PayPal" : "iniciado"}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "No se pudo aprobar el reembolso");
    }
  };

  const reject = async (refund) => {
    const reason = window.prompt("Motivo del rechazo (opcional):", "");
    if (reason === null) return; // cancelled
    try {
      await api.post(
        `/itineraries/${itineraryId}/refund-requests/${refund.refund_id}/reject`,
        { reason },
      );
      await load();
      if (onChange) onChange();
      toast.success("Reembolso rechazado");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "No se pudo rechazar");
    }
  };

  // Compute max refundable amount for the selected payment.

  return (
    <div className="fixed inset-0 z-50 bg-clay-900/50 flex items-center justify-center p-4"
         data-testid="refunds-modal-backdrop"
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white border border-clay-300 w-full max-w-3xl max-h-[92vh] overflow-auto shadow-xl"
           data-testid="refunds-modal">
        <div className="flex items-center justify-between px-6 py-4 border-b border-clay-300 sticky top-0 bg-white z-10">
          <div>
            <div className="smallcaps text-clay-700 inline-flex items-center gap-2"><Undo2 size={12}/> Cancelaciones</div>
            <div className="font-serif text-2xl mt-1">Reembolsos</div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-clay-100" data-testid="refunds-modal-close">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* Approver status */}
          <div className={`text-xs px-3 py-2 border-l-4 ${isApprover ? "bg-pine-soft/20 border-pine text-pine" : "bg-clay-50 border-clay-300 text-clay-700"}`}
               data-testid="approver-status">
            {isApprover ? (
              <span className="inline-flex items-center gap-2"><ShieldCheck size={13}/> Eres manager: puedes aprobar o rechazar reembolsos.</span>
            ) : (
              <>Los reembolsos deben ser aprobados por: <strong>{approverEmails.join(", ") || "—"}</strong>. Tú puedes solicitarlos.</>
            )}
          </div>

          {/* Existing refunds */}
          <div>
            <div className="smallcaps mb-2">Solicitudes ({refunds.length})</div>
            {loading && refunds.length === 0 && (
              <div className="text-sm text-clay-700 py-8 text-center">Cargando…</div>
            )}
            {!loading && refunds.length === 0 && (
              <div className="text-xs text-clay-500 italic px-3 py-4 border border-dashed border-clay-300">
                Aún no hay reembolsos. Solicita uno abajo si necesitas devolver dinero al cliente.
              </div>
            )}
            <div className="space-y-2">
              {refunds.map((r) => {
                const badge = STATUS_BADGE[r.status] || STATUS_BADGE.pending;
                const Icon = badge.Icon;
                const canDecide = isApprover && (r.status === "pending" || r.status === "failed");
                return (
                  <div key={r.refund_id}
                       data-testid={`refund-row-${r.refund_id}`}
                       className="border border-clay-300 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="font-serif tabular text-lg">{fmtEUR(r.amount_eur)}</div>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-widest ${badge.cls}`}>
                            <Icon size={11}/> {badge.text}
                          </span>
                        </div>
                        {r.reason && (
                          <div className="text-xs text-clay-700 mt-1">Motivo: {r.reason}</div>
                        )}
                        <div className="text-[11px] text-clay-500 mt-1">
                          Solicitado por {r.requested_by} · {(r.requested_at || "").slice(0, 10)}
                        </div>
                        {r.approved_by && (
                          <div className="text-[11px] text-clay-500">
                            {r.status === "rejected" ? "Rechazado" : "Decidido"} por {r.approved_by} · {(r.decided_at || "").slice(0, 10)}
                          </div>
                        )}
                        {r.paypal_refund_id && (
                          <div className="text-[10px] text-pine font-mono mt-1">
                            PayPal refund: {r.paypal_refund_id}
                          </div>
                        )}
                        {r.error_message && (
                          <div className="text-[11px] text-red-700 mt-1 italic">
                            {r.error_message}
                          </div>
                        )}
                      </div>
                    </div>
                    {canDecide && (
                      <div className="mt-3 flex items-center gap-2">
                        <button onClick={() => approve(r)}
                                data-testid={`approve-refund-${r.refund_id}`}
                                className="inline-flex items-center gap-1 px-3 py-1.5 bg-pine text-white hover:bg-pine-hover text-xs">
                          <CheckCircle2 size={12}/> Aprobar y reembolsar
                        </button>
                        <button onClick={() => reject(r)}
                                data-testid={`reject-refund-${r.refund_id}`}
                                className="inline-flex items-center gap-1 px-3 py-1.5 border border-clay-300 hover:bg-clay-100 text-xs">
                          <XCircle size={12}/> Rechazar
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* New refund request */}
          {payments.length === 0 ? (
            <div className="text-xs text-clay-500 italic px-3 py-4 border border-dashed border-clay-300">
              Sin pagos capturados aún — no se puede solicitar un reembolso todavía.
            </div>
          ) : (
            <div className="border border-clay-300">
              <div className="px-4 py-3 border-b border-clay-300 bg-clay-50">
                <div className="smallcaps inline-flex items-center gap-2"><Plus size={12}/> Nueva solicitud de reembolso</div>
              </div>
              <div className="px-4 py-3 grid gap-3 md:grid-cols-2">
                <label className="block md:col-span-2">
                  <span className="text-[10px] uppercase tracking-[0.2em] text-clay-700 block mb-1">Pago a reembolsar</span>
                  <select
                    value={draft.payment_id}
                    onChange={(ev) => {
                      const p = payments.find((x) => x.payment_id === ev.target.value);
                      setDraft({ ...draft, payment_id: ev.target.value, amount_eur: p ? String(p.paid_amount || p.amount_eur || 0) : "" });
                    }}
                    data-testid="new-refund-payment"
                    className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta">
                    <option value="">Selecciona el pago origen</option>
                    {payments.map((p) => (
                      <option key={p.payment_id} value={p.payment_id}>
                        {p.kind} · {fmtEUR(p.paid_amount || p.amount_eur)} · {(p.paid_at || p.created_at || "").slice(0, 10)}
                        {p.payer_name ? ` · ${p.payer_name}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-[0.2em] text-clay-700 block mb-1">
                    Importe (€) {selectedPayment && ` — max ${fmtEUR(maxRefundable)}`}
                  </span>
                  <input
                    type="number" step="0.01" min="0" max={maxRefundable || undefined}
                    value={draft.amount_eur}
                    onChange={(ev) => setDraft({ ...draft, amount_eur: ev.target.value })}
                    data-testid="new-refund-amount"
                    className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta tabular"
                    placeholder="0.00"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-[0.2em] text-clay-700 block mb-1">Motivo (opcional)</span>
                  <input
                    value={draft.reason}
                    onChange={(ev) => setDraft({ ...draft, reason: ev.target.value })}
                    data-testid="new-refund-reason"
                    className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta"
                    placeholder="e.g. Cancelled winery tour"
                  />
                </label>
                <div className="md:col-span-2 flex items-center justify-end pt-1">
                  <button
                    onClick={create}
                    disabled={creating}
                    data-testid="create-refund-btn"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-terracotta hover:bg-terracotta-hover text-white text-sm disabled:opacity-60">
                    <Undo2 size={14}/> {creating ? "Enviando…" : "Solicitar reembolso"}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="text-[11px] text-clay-500 border-l-2 border-clay-300 pl-3 italic">
            <AlertCircle size={11} className="inline mr-1"/>
            Los reembolsos se ejecutan en PayPal automáticamente al aprobarlos. Sólo pueden aprobar Beatriz o Marina — el resto del equipo puede solicitarlos.
          </div>
        </div>
      </div>
    </div>
  );
}

// Fallback for the auth import: some builds don't expose { useAuth }.
// Re-exporting via the same @/lib/auth path — see lib/auth.js.
