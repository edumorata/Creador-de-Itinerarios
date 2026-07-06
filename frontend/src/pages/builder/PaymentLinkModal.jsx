import React, { useEffect, useState } from "react";
import { X, Copy, RefreshCw, ExternalLink, CheckCircle2, Clock, AlertCircle, Mail, MessageSquare, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";

const fmtEUR = (n) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n || 0);

const KIND_LABEL = {
  deposit: "Depósito (30%)",
  balance: "Saldo restante (70%)",
  full: "Pago total (100%)",
};

const STATUS_BADGE = {
  pending: { text: "Pendiente",  cls: "bg-clay-100 text-clay-700",       Icon: Clock },
  created: { text: "Enviado",    cls: "bg-amber-100 text-amber-800",     Icon: Clock },
  approved:{ text: "Aprobado",   cls: "bg-blue-50 text-blue-700",        Icon: Clock },
  captured:{ text: "Pagado",     cls: "bg-pine-soft/40 text-pine",       Icon: CheckCircle2 },
  denied:  { text: "Rechazado",  cls: "bg-red-100 text-red-700",         Icon: AlertCircle },
  refunded:{ text: "Reembolsado",cls: "bg-orange-100 text-orange-700",   Icon: AlertCircle },
  cancelled:{text: "Cancelado",  cls: "bg-clay-200 text-clay-700",       Icon: X },
};

const copyToClipboard = async (text, label) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copiado al portapapeles`);
  } catch {
    toast.error("No se pudo copiar — selecciona y copia manualmente");
  }
};

/** Agent-facing modal: lazy-generate or refresh the public payment link,
 *  show the pre-formatted instructions, and surface the current payment
 *  history (deposit captured? balance pending?) for the trip.
 */
export function PaymentLinkModal({ open, itineraryId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      // Send the browser's visible origin so the public URL points at the
      // host the agent is actually on (avoids preview/cluster Origin-header
      // weirdness where the ingress rewrites Origin to an internal hostname).
      const { data: d } = await api.post(
        `/itineraries/${itineraryId}/payments/create-link`,
        { origin: window.location.origin },
      );
      setData(d);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "No se pudo generar el enlace");
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) load(); }, [open, itineraryId]);

  if (!open) return null;
  const options = data?.options || {};
  const payments = data?.payments || [];
  const paymentUrl = data?.payment_url;
  // The trip-view URL uses the SAME token as the payment link (same string
  // → different route), so we derive it locally instead of asking the
  // backend for a second URL.
  const tripViewUrl = paymentUrl ? paymentUrl.replace("/pay/", "/trip/") : "";
  const instructions = data?.instructions || "";

  return (
    <div className="fixed inset-0 z-50 bg-clay-900/50 flex items-center justify-center p-4"
         data-testid="payment-modal-backdrop"
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white border border-clay-300 w-full max-w-3xl max-h-[92vh] overflow-auto shadow-xl"
           data-testid="payment-modal">
        <div className="flex items-center justify-between px-6 py-4 border-b border-clay-300 sticky top-0 bg-white z-10">
          <div>
            <div className="smallcaps text-clay-700">Pago del cliente</div>
            <div className="font-serif text-2xl mt-1">Generar enlace de pago PayPal</div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-clay-100" data-testid="payment-modal-close">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {loading && !data && (
            <div className="text-sm text-clay-700 py-12 text-center">Generando enlace…</div>
          )}

          {data && (
            <>
              {/* Summary */}
              <div className="grid grid-cols-3 gap-0 border border-clay-300">
                <div className="p-3 border-r border-clay-300">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-clay-700">Total viaje</div>
                  <div className="font-serif text-xl tabular mt-1">{fmtEUR(options.total_eur)}</div>
                </div>
                <div className="p-3 border-r border-clay-300">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-clay-700">Pagado</div>
                  <div className="font-serif text-xl tabular mt-1 text-pine">{fmtEUR(options.paid_eur)}</div>
                </div>
                <div className="p-3">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-clay-700">Pendiente</div>
                  <div className="font-serif text-xl tabular mt-1 text-terracotta">{fmtEUR(options.remaining_eur)}</div>
                </div>
              </div>

              {/* Rule explanation */}
              <div className="text-xs text-clay-700 bg-clay-50 border border-clay-200 px-3 py-2">
                {options.days_to_trip != null && (
                  <>
                    Quedan <span className="font-semibold">{options.days_to_trip} días</span> para la salida.
                    {options.days_to_trip > 60
                      ? " El cliente puede pagar la reserva (30%) o el total (100%)."
                      : " Sólo está disponible el pago total (≤60 días para la salida)."}
                  </>
                )}
                {options.days_to_trip == null && <>No hay fecha de inicio definida. El cliente solo verá el pago total.</>}
              </div>

              {/* Client trip presentation URL (Fora-style view) — same
                  token as the payment link, different route. Agents share
                  this first, and the "Reserve" button inside routes the
                  client to the payment page. */}
              <div>
                <div className="smallcaps mb-2 flex items-center justify-between">
                  <span>Vista cliente (presentación del viaje)</span>
                  <span className="text-[10px] text-clay-500 normal-case tracking-normal">Compárteselo primero al cliente</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    data-testid="trip-view-url"
                    readOnly value={tripViewUrl}
                    onClick={(e) => e.target.select()}
                    className="flex-1 bg-clay-50 border border-clay-300 px-3 py-2 text-sm font-mono outline-none"
                  />
                  <button onClick={() => copyToClipboard(tripViewUrl, "Enlace de la vista cliente")}
                          data-testid="copy-trip-view-url"
                          className="inline-flex items-center gap-2 px-3 py-2 border border-clay-300 hover:bg-clay-100 text-xs">
                    <Copy size={13}/> Copiar URL
                  </button>
                  <a href={tripViewUrl} target="_blank" rel="noreferrer"
                     data-testid="open-trip-view-url"
                     className="inline-flex items-center gap-2 px-3 py-2 border border-clay-300 hover:bg-clay-100 text-xs">
                    <ExternalLink size={13}/> Abrir
                  </a>
                </div>
              </div>

              {/* Public URL */}
              <div>
                <div className="smallcaps mb-2 flex items-center justify-between">
                  <span>Enlace de pago directo</span>
                  <button onClick={load} disabled={loading}
                          data-testid="payment-link-refresh"
                          title="Refrescar (mismo token, totales actualizados)"
                          className="text-[10px] uppercase tracking-widest text-clay-700 hover:text-terracotta inline-flex items-center gap-1 disabled:opacity-40">
                    <RefreshCw size={11}/> Refrescar
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    data-testid="payment-link-url"
                    readOnly value={paymentUrl}
                    onClick={(e) => e.target.select()}
                    className="flex-1 bg-clay-50 border border-clay-300 px-3 py-2 text-sm font-mono outline-none"
                  />
                  <button onClick={() => copyToClipboard(paymentUrl, "Enlace")}
                          data-testid="copy-payment-url"
                          className="inline-flex items-center gap-2 px-3 py-2 border border-clay-300 hover:bg-clay-100 text-xs">
                    <Copy size={13}/> Copiar URL
                  </button>
                  <a href={paymentUrl} target="_blank" rel="noreferrer"
                     data-testid="open-payment-url"
                     className="inline-flex items-center gap-2 px-3 py-2 border border-clay-300 hover:bg-clay-100 text-xs">
                    <ExternalLink size={13}/> Abrir
                  </a>
                </div>
              </div>

              {/* Instructions textarea (pre-formatted) */}
              <div>
                <div className="smallcaps mb-2 flex items-center justify-between">
                  <span>Mensaje para el cliente</span>
                  <div className="flex items-center gap-1">
                    <button onClick={() => copyToClipboard(instructions, "Mensaje completo")}
                            data-testid="copy-instructions-email"
                            className="inline-flex items-center gap-1 px-2 py-1 border border-clay-300 hover:bg-clay-100 text-[11px]">
                      <Mail size={11}/> Copiar para email
                    </button>
                    <button onClick={() => copyToClipboard(toWhatsApp(instructions), "Mensaje (WhatsApp)")}
                            data-testid="copy-instructions-whatsapp"
                            className="inline-flex items-center gap-1 px-2 py-1 border border-clay-300 hover:bg-clay-100 text-[11px]">
                      <MessageSquare size={11}/> WhatsApp
                    </button>
                  </div>
                </div>
                <textarea
                  data-testid="payment-instructions"
                  readOnly value={instructions}
                  rows={14}
                  onClick={(e) => e.target.select()}
                  className="w-full bg-clay-50 border border-clay-300 px-3 py-2 text-sm font-mono outline-none resize-y leading-relaxed"
                />
                <div className="text-[10px] text-clay-500 mt-1">
                  El mensaje incluye el enlace, el detalle del importe a pagar, y la lista de info que necesitas del cliente.
                </div>
              </div>

              {/* Datos del cliente (formulario rellenado en el enlace público) */}
              <TravelerInfoBlock info={data?.traveler_info} />

              {/* Payment history */}
              <div>
                <div className="smallcaps mb-2">Histórico de pagos ({payments.length})</div>
                {payments.length === 0 ? (
                  <div className="text-xs text-clay-500 italic px-3 py-3 border border-dashed border-clay-300">
                    Aún no se ha intentado ningún pago. Cuando el cliente pulse el enlace y elija una opción, aparecerá aquí.
                  </div>
                ) : (
                  <div className="border border-clay-300">
                    {payments.map((p) => {
                      const badge = STATUS_BADGE[p.status] || STATUS_BADGE.pending;
                      const Icon = badge.Icon;
                      return (
                        <div key={p.payment_id}
                             data-testid={`payment-row-${p.payment_id}`}
                             className="grid grid-cols-[1fr_120px_100px_140px] gap-2 px-3 py-2 border-b border-clay-200 last:border-b-0 text-sm items-center">
                          <div>
                            <div className="font-medium">{KIND_LABEL[p.kind] || p.kind}</div>
                            {p.paypal_capture_id && (
                              <div className="text-[10px] text-clay-500 font-mono mt-0.5">PayPal: {p.paypal_capture_id}</div>
                            )}
                            {p.notes && (
                              <div className="text-[11px] text-clay-700 italic mt-0.5">{p.notes}</div>
                            )}
                            {p.tos_accepted_at && (
                              <div className="text-[10px] text-pine mt-0.5"
                                   data-testid={`payment-tos-${p.payment_id}`}
                                   title={`T&C version: ${p.tos_version || "unknown"}${p.tos_accepted_ip ? " · IP " + p.tos_accepted_ip : ""}`}>
                                <ShieldCheck size={9} className="inline mr-0.5"/>
                                T&C aceptados {p.tos_accepted_at.slice(0, 10)}
                                {p.tos_accepted_ip ? <span className="text-clay-500"> · IP {p.tos_accepted_ip}</span> : null}
                              </div>
                            )}
                          </div>
                          <div className="tabular text-right">{fmtEUR(p.amount_eur)}</div>
                          <div className="text-[10px] text-clay-500 text-right">
                            {(p.paid_at || p.created_at || "").slice(0, 10)}
                          </div>
                          <div className={`inline-flex items-center gap-1 justify-center px-2 py-0.5 text-[10px] uppercase tracking-widest ${badge.cls}`}>
                            <Icon size={11}/> {badge.text}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Reformat the email-style instructions into a WhatsApp-friendly snippet:
// shorter, less corporate, keeps the link + amount and the data list.
function toWhatsApp(emailText) {
  // Pull just the link, the intro paragraph, and the data list — the
  // travel-document paragraph is verbose for a WhatsApp message.
  const lines = emailText.split("\n");
  const hi = lines[0] || "";
  const link = lines.find((l) => l.startsWith("http")) || "";
  const introPara = lines.slice(2, 6).join(" ").replace(/\s+/g, " ").trim();
  const dataIdx = lines.findIndex((l) => l.startsWith("- Full names"));
  const dataLines = dataIdx >= 0 ? lines.slice(dataIdx, dataIdx + 6).join("\n") : "";
  return `${hi}

${introPara}

${link}

Para confirmar las reservas necesito los siguientes datos:
${dataLines}

¡Avísame si tienes cualquier duda!`;
}

/** Render the booking info the client submitted from the public page.
 *  Hidden when nothing has been submitted yet. */
function TravelerInfoBlock({ info }) {
  if (!info) {
    return (
      <div>
        <div className="smallcaps mb-2">Datos del cliente</div>
        <div className="text-xs text-clay-500 italic px-3 py-3 border border-dashed border-clay-300">
          El cliente todavía no ha rellenado el formulario. Aparecerá aquí cuando lo envíe desde el enlace.
        </div>
      </div>
    );
  }
  const people = info.people || [];
  const fmtTs = (iso) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString("es-ES", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch { return iso; }
  };
  return (
    <div data-testid="agent-traveler-info">
      <div className="smallcaps mb-2 flex items-center justify-between">
        <span>Datos del cliente</span>
        {info.submitted_at && (
          <span className="text-[10px] text-clay-500 normal-case tracking-normal">
            Enviado · {fmtTs(info.submitted_at)}
          </span>
        )}
      </div>
      <div className="border border-clay-300 divide-y divide-clay-200">
        {people.length > 0 && (
          <div className="px-3 py-2">
            <div className="text-[10px] uppercase tracking-widest text-clay-700 mb-1">
              Viajeros ({people.length})
            </div>
            <div className="grid gap-1.5">
              {people.map((p, i) => (
                <div key={i} className="grid grid-cols-[1.6fr_1fr_1fr] gap-2 text-sm">
                  <div className="truncate">{p.full_name || <em className="text-clay-500">sin nombre</em>}</div>
                  <div className="font-mono text-xs text-clay-700">{p.passport_number || "—"}</div>
                  <div className="tabular text-xs text-clay-700">{p.date_of_birth || "—"}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="px-3 py-2 grid grid-cols-2 gap-2 text-sm">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-clay-700">Vuelo llegada</div>
            <div>{info.arrival_flight || <span className="text-clay-500">—</span>}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-clay-700">Vuelo salida</div>
            <div>{info.departure_flight || <span className="text-clay-500">—</span>}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-clay-700">Teléfono</div>
            <div>{info.phone || <span className="text-clay-500">—</span>}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-clay-700">Email</div>
            <div className="truncate">{info.submitted_by_email || <span className="text-clay-500">—</span>}</div>
          </div>
        </div>
        {info.notes && (
          <div className="px-3 py-2 text-sm">
            <div className="text-[10px] uppercase tracking-widest text-clay-700 mb-0.5">Alergias / Notas</div>
            <div className="whitespace-pre-wrap">{info.notes}</div>
          </div>
        )}
      </div>
    </div>
  );
}
