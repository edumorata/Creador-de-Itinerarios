import React, { useEffect, useMemo, useState } from "react";
import { X, Plus, Copy, ExternalLink, Trash2, Sparkles, CheckCircle2, Clock, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";

const fmtEUR = (n) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n || 0);

const STATUS_BADGE = {
  draft:     { text: "Borrador",  cls: "bg-clay-100 text-clay-700",      Icon: Clock },
  sent:      { text: "Enviado",   cls: "bg-amber-100 text-amber-800",    Icon: Clock },
  paid:      { text: "Pagado",    cls: "bg-pine-soft/40 text-pine",      Icon: CheckCircle2 },
  cancelled: { text: "Cancelado", cls: "bg-clay-200 text-clay-700",      Icon: X },
};

/** Manage post-sale extra activities. Each extra has its own public
 *  payment link (/pay/extra/:token) so the client settles just the delta
 *  without touching the main invoice. */
export function ExtrasModal({ open, itineraryId, days = [], onClose, onChange }) {
  const [extras, setExtras] = useState([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState({ title: "", description: "", amount_eur: "", day_id: "", date: "" });
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/itineraries/${itineraryId}/extras`);
      setExtras(data?.extras || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "No se pudieron cargar los extras");
    } finally { setLoading(false); }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) load(); }, [open]);

  const totalExtras = useMemo(
    () => extras.filter((e) => e.status !== "cancelled").reduce((s, e) => s + (e.amount_eur || 0), 0),
    [extras]
  );
  const paidExtras = useMemo(
    () => extras.filter((e) => e.status === "paid").reduce((s, e) => s + (e.amount_eur || 0), 0),
    [extras]
  );

  if (!open) return null;

  const create = async () => {
    if (!draft.title.trim()) { toast.error("Título obligatorio"); return; }
    const amt = parseFloat(draft.amount_eur);
    if (isNaN(amt) || amt <= 0) { toast.error("Importe inválido"); return; }
    setCreating(true);
    try {
      const day = days.find((d) => d.day_id === draft.day_id);
      const payload = {
        title: draft.title.trim(),
        description: draft.description.trim(),
        amount_eur: amt,
        day_id: draft.day_id || undefined,
        date: draft.date || day?.date || undefined,
      };
      await api.post(`/itineraries/${itineraryId}/extras`, payload);
      setDraft({ title: "", description: "", amount_eur: "", day_id: "", date: "" });
      await load();
      if (onChange) onChange();
      toast.success("Extra añadido");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "No se pudo crear el extra");
    } finally { setCreating(false); }
  };

  const remove = async (extra) => {
    if (!window.confirm(`¿Eliminar el extra "${extra.title}"?${extra.status === "paid" ? " (Ya está pagado — se marcará como cancelado; abre un reembolso aparte para devolver el dinero)" : ""}`)) return;
    try {
      await api.delete(`/itineraries/${itineraryId}/extras/${extra.extra_id}`);
      await load();
      if (onChange) onChange();
      toast.success("Extra eliminado");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "No se pudo eliminar");
    }
  };

  const copyLink = (extra) => {
    const url = `${window.location.origin}/pay/extra/${extra.payment_token}`;
    navigator.clipboard.writeText(url).then(
      () => toast.success("Enlace copiado"),
      () => toast.error("No se pudo copiar")
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-clay-900/50 flex items-center justify-center p-4"
         data-testid="extras-modal-backdrop"
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white border border-clay-300 w-full max-w-3xl max-h-[92vh] overflow-auto shadow-xl"
           data-testid="extras-modal">
        <div className="flex items-center justify-between px-6 py-4 border-b border-clay-300 sticky top-0 bg-white z-10">
          <div>
            <div className="smallcaps text-clay-700 inline-flex items-center gap-2"><Sparkles size={12}/> Post-venta</div>
            <div className="font-serif text-2xl mt-1">Extras del itinerario</div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-clay-100" data-testid="extras-modal-close">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* Summary */}
          {extras.length > 0 && (
            <div className="grid grid-cols-3 gap-0 border border-clay-300">
              <div className="p-3 border-r border-clay-300">
                <div className="text-[10px] uppercase tracking-[0.2em] text-clay-700">Extras totales</div>
                <div className="font-serif text-xl tabular mt-1">{extras.length}</div>
              </div>
              <div className="p-3 border-r border-clay-300">
                <div className="text-[10px] uppercase tracking-[0.2em] text-clay-700">Importe activo</div>
                <div className="font-serif text-xl tabular mt-1">{fmtEUR(totalExtras)}</div>
              </div>
              <div className="p-3">
                <div className="text-[10px] uppercase tracking-[0.2em] text-clay-700">Ya cobrado</div>
                <div className="font-serif text-xl tabular mt-1 text-pine">{fmtEUR(paidExtras)}</div>
              </div>
            </div>
          )}

          {/* Existing extras list */}
          <div>
            <div className="smallcaps mb-2">Extras existentes ({extras.length})</div>
            {loading && extras.length === 0 && (
              <div className="text-sm text-clay-700 py-8 text-center">Cargando…</div>
            )}
            {!loading && extras.length === 0 && (
              <div className="text-xs text-clay-500 italic px-3 py-4 border border-dashed border-clay-300">
                Aún no hay extras. Añade uno más abajo cuando el cliente quiera sumar una actividad después del pago.
              </div>
            )}
            <div className="space-y-2">
              {extras.map((e) => {
                const badge = STATUS_BADGE[e.status] || STATUS_BADGE.sent;
                const Icon = badge.Icon;
                const publicUrl = `${window.location.origin}/pay/extra/${e.payment_token}`;
                return (
                  <div key={e.extra_id}
                       data-testid={`extra-row-${e.extra_id}`}
                       className="border border-clay-300 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="font-medium text-sm">{e.title}</div>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-widest ${badge.cls}`}>
                            <Icon size={11}/> {badge.text}
                          </span>
                        </div>
                        {e.description && (
                          <div className="text-xs text-clay-700 mt-1 line-clamp-2">{e.description}</div>
                        )}
                        {e.date && (
                          <div className="text-[11px] text-clay-500 mt-1">Fecha: {e.date}</div>
                        )}
                      </div>
                      <div className="text-right">
                        <div className="font-serif tabular text-lg">{fmtEUR(e.amount_eur)}</div>
                        {e.paid_at && (
                          <div className="text-[10px] text-pine">{e.paid_at.slice(0, 10)}</div>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <input
                        readOnly value={publicUrl}
                        onClick={(ev) => ev.target.select()}
                        data-testid={`extra-url-${e.extra_id}`}
                        className="flex-1 bg-clay-50 border border-clay-300 px-2 py-1.5 text-[11px] font-mono outline-none"
                      />
                      <button onClick={() => copyLink(e)}
                              data-testid={`copy-extra-${e.extra_id}`}
                              className="inline-flex items-center gap-1 px-2 py-1.5 border border-clay-300 hover:bg-clay-100 text-[11px]">
                        <Copy size={11}/> Copiar
                      </button>
                      <a href={publicUrl} target="_blank" rel="noreferrer"
                         data-testid={`open-extra-${e.extra_id}`}
                         className="inline-flex items-center gap-1 px-2 py-1.5 border border-clay-300 hover:bg-clay-100 text-[11px]">
                        <ExternalLink size={11}/> Abrir
                      </a>
                      {e.status !== "cancelled" && (
                        <button onClick={() => remove(e)}
                                data-testid={`delete-extra-${e.extra_id}`}
                                className="inline-flex items-center gap-1 px-2 py-1.5 border border-clay-300 hover:bg-red-50 hover:border-red-300 text-[11px] text-red-700">
                          <Trash2 size={11}/> Eliminar
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* New-extra composer */}
          <div className="border border-clay-300">
            <div className="px-4 py-3 border-b border-clay-300 bg-clay-50">
              <div className="smallcaps inline-flex items-center gap-2"><Plus size={12}/> Nuevo extra</div>
            </div>
            <div className="px-4 py-3 grid gap-3 md:grid-cols-2">
              <div className="md:col-span-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-[0.2em] text-clay-700 block mb-1">Título</span>
                  <input
                    value={draft.title}
                    onChange={(ev) => setDraft({ ...draft, title: ev.target.value })}
                    data-testid="new-extra-title"
                    className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta"
                    placeholder="e.g. Private wine tasting"
                  />
                </label>
              </div>
              <div className="md:col-span-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-[0.2em] text-clay-700 block mb-1">Descripción (opcional)</span>
                  <textarea
                    rows={2}
                    value={draft.description}
                    onChange={(ev) => setDraft({ ...draft, description: ev.target.value })}
                    data-testid="new-extra-description"
                    className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta resize-y"
                    placeholder="Details the client will see on the payment page…"
                  />
                </label>
              </div>
              <label className="block">
                <span className="text-[10px] uppercase tracking-[0.2em] text-clay-700 block mb-1">Importe (€)</span>
                <input
                  type="number" step="0.01" min="0"
                  value={draft.amount_eur}
                  onChange={(ev) => setDraft({ ...draft, amount_eur: ev.target.value })}
                  data-testid="new-extra-amount"
                  className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta tabular"
                  placeholder="0.00"
                />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-[0.2em] text-clay-700 block mb-1">Día (opcional)</span>
                <select
                  value={draft.day_id}
                  onChange={(ev) => setDraft({ ...draft, day_id: ev.target.value })}
                  data-testid="new-extra-day"
                  className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta">
                  <option value="">Sin asignar</option>
                  {days.map((d, i) => (
                    <option key={d.day_id} value={d.day_id}>
                      Día {i + 1}{d.date ? ` · ${d.date}` : ""}{d.city ? ` — ${d.city}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="md:col-span-2 flex items-center justify-end pt-1">
                <button
                  onClick={create}
                  disabled={creating}
                  data-testid="create-extra-btn"
                  className="inline-flex items-center gap-2 px-4 py-2 bg-pine hover:bg-pine-hover text-white text-sm disabled:opacity-60">
                  <Plus size={14}/> {creating ? "Creando…" : "Crear extra y generar enlace"}
                </button>
              </div>
            </div>
          </div>

          <div className="text-[11px] text-clay-500 border-l-2 border-clay-300 pl-3 italic">
            <AlertCircle size={11} className="inline mr-1"/>
            Cada extra tiene su propio enlace de pago. El cliente paga sólo ese importe, sin afectar a la factura principal del viaje.
          </div>
        </div>
      </div>
    </div>
  );
}
