import React, { useState, useEffect, useRef } from "react";
import { Link2, Check, AlertTriangle, X, Loader2, MapPin, Bed, Wand2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import api from "@/lib/api";
import { toast } from "sonner";

// 3-step flow:
//  1. url       — agent pastes a Travefy URL
//  2. running   — backend job is reading the page + matching against BBDD
//  3. preview   — agent reviews matched items, excludes any, then confirms

const CONFIDENCE_LABEL = {
  high:   { txt: "Match alto",  cls: "bg-pine text-white" },
  medium: { txt: "Match medio", cls: "bg-clay-300 text-clay-900" },
  low:    { txt: "Match dudoso", cls: "bg-amber-200 text-amber-900" },
};

export function TravefyImportModal({ onClose }) {
  const [step, setStep] = useState("url");
  const [url, setUrl] = useState("");
  const [jobId, setJobId] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const navigate = useNavigate();
  const pollRef = useRef(null);

  // Cleanup poll interval on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const start = async () => {
    if (!url.includes("travefy.com")) {
      toast.error("La URL debe ser de travefy.com");
      return;
    }
    setError(null);
    setStep("running");
    try {
      const { data } = await api.post("/itineraries/import-travefy/preview", { url });
      setJobId(data.job_id);
      // Begin polling
      pollRef.current = setInterval(() => poll(data.job_id), 2500);
    } catch (e) {
      setError(e?.response?.data?.detail || e.message || "Error iniciando importación");
      setStep("url");
    }
  };

  const poll = async (jid) => {
    try {
      const { data } = await api.get(`/itineraries/import-travefy/preview/${jid}`);
      if (data.status === "done") {
        clearInterval(pollRef.current);
        pollRef.current = null;
        // Annotate every item with included=true by default
        const annotated = {
          ...data.preview,
          days: (data.preview.days || []).map((d) => ({
            ...d,
            items: (d.items || []).map((it) => ({ ...it, excluded: false })),
          })),
          hotels: (data.preview.hotels || []).map((h) => ({ ...h, excluded: false })),
        };
        setPreview(annotated);
        setStep("preview");
      } else if (data.status === "error") {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setError(data.error || "Error desconocido");
        setStep("url");
      }
    } catch (e) {
      // Transient error, keep polling unless 404
      if (e?.response?.status === 404) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setError("Job not found");
        setStep("url");
      }
    }
  };

  const toggleItem = (dayIdx, itemIdx) => {
    setPreview((p) => {
      const days = [...p.days];
      const items = [...days[dayIdx].items];
      items[itemIdx] = { ...items[itemIdx], excluded: !items[itemIdx].excluded };
      days[dayIdx] = { ...days[dayIdx], items };
      return { ...p, days };
    });
  };
  const toggleHotel = (hotelIdx) => {
    setPreview((p) => {
      const hotels = [...p.hotels];
      hotels[hotelIdx] = { ...hotels[hotelIdx], excluded: !hotels[hotelIdx].excluded };
      return { ...p, hotels };
    });
  };

  const confirm = async () => {
    setConfirming(true);
    try {
      const { data } = await api.post("/itineraries/import-travefy/confirm", preview);
      toast.success("Itinerario creado desde Travefy");
      onClose();
      navigate(`/itineraries/${data.itinerary_id}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Error creando itinerario");
    } finally {
      setConfirming(false);
    }
  };

  // Counters for the preview summary bar
  const stats = preview ? (() => {
    let matched = 0, unmatched = 0;
    (preview.days || []).forEach((d) => (d.items || []).forEach((it) => {
      if (it.excluded) return;
      if (it.match) matched++; else unmatched++;
    }));
    const hMatched = (preview.hotels || []).filter((h) => !h.excluded && h.match).length;
    const hMissing = (preview.hotels || []).filter((h) => !h.excluded && !h.match).length;
    return { matched, unmatched, hMatched, hMissing };
  })() : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose} data-testid="travefy-modal">
      <div className="bg-white border border-clay-300 max-w-4xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-clay-300 sticky top-0 bg-white z-10">
          <div className="flex items-center gap-3">
            <Wand2 size={20} className="text-terracotta" />
            <div>
              <div className="smallcaps">Importar desde Travefy</div>
              <div className="font-serif text-xl">
                {step === "url" && "Pega el link del itinerario"}
                {step === "running" && "Leyendo y matcheando con tu BBDD…"}
                {step === "preview" && "Revisa antes de crear"}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="text-clay-500 hover:text-clay-900" data-testid="travefy-close">
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5">
          {step === "url" && (
            <div className="space-y-4">
              <p className="text-sm text-clay-700">
                Lee un itinerario publicado de Travefy y monta una base con las experiencias y hoteles que ya tienes en la BBDD. Lo que no esté en la BBDD aparece como &quot;Sin precio · Revisar&quot; para que lo completes después.
              </p>
              <div className="relative">
                <Link2 size={14} className="absolute left-3 top-3 text-clay-500" />
                <input
                  data-testid="travefy-url-input"
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://travefy.com/trip/itinerary/…"
                  className="w-full pl-9 pr-3 py-2.5 border border-clay-300 text-sm outline-none focus:border-terracotta"
                  onKeyDown={(e) => e.key === "Enter" && url && start()}
                />
              </div>
              {error && (
                <div className="border border-destructive bg-destructive/5 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={onClose} className="px-4 py-2 text-sm border border-clay-300 hover:bg-clay-100" data-testid="travefy-cancel">
                  Cancelar
                </button>
                <button
                  data-testid="travefy-start"
                  onClick={start}
                  disabled={!url}
                  className="px-5 py-2 bg-clay-900 text-white text-sm tracking-wider uppercase hover:bg-terracotta disabled:opacity-40"
                >
                  Importar
                </button>
              </div>
            </div>
          )}

          {step === "running" && (
            <div className="py-16 text-center">
              <Loader2 className="animate-spin mx-auto mb-4 text-terracotta" size={36} />
              <div className="font-serif text-lg">Procesando…</div>
              <div className="text-sm text-clay-700 mt-2 max-w-md mx-auto">
                Estoy abriendo Travefy, leyendo cada día y matcheando cada actividad y hotel con tu BBDD. Esto puede tardar entre <span className="font-semibold">20 y 60 segundos</span>.
              </div>
            </div>
          )}

          {step === "preview" && preview && (
            <div className="space-y-4">
              {/* Summary bar */}
              <div className="grid grid-cols-4 gap-0 border border-clay-300 text-sm">
                <div className="p-3 border-r border-clay-300">
                  <div className="smallcaps text-xs">Cliente</div>
                  <div className="font-semibold truncate" title={preview.main_traveler}>{preview.main_traveler || "—"}</div>
                </div>
                <div className="p-3 border-r border-clay-300">
                  <div className="smallcaps text-xs">Fechas</div>
                  <div className="font-semibold tabular text-xs">{preview.start_date} → {preview.end_date}</div>
                  <div className="text-xs text-clay-700">{(preview.days||[]).length} días · {preview.num_travelers} pax</div>
                </div>
                <div className="p-3 border-r border-clay-300">
                  <div className="smallcaps text-xs">Actividades</div>
                  <div className="font-semibold">
                    <span className="text-pine">{stats.matched}</span>
                    {stats.unmatched > 0 && <span className="text-amber-700"> · {stats.unmatched} sin match</span>}
                  </div>
                </div>
                <div className="p-3">
                  <div className="smallcaps text-xs">Hoteles</div>
                  <div className="font-semibold">
                    <span className="text-pine">{stats.hMatched}</span>
                    {stats.hMissing > 0 && <span className="text-amber-700"> · {stats.hMissing} sin match</span>}
                  </div>
                </div>
              </div>

              {/* Days */}
              <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
                {(preview.days || []).map((day, di) => (
                  <div key={di} className="border border-clay-300">
                    <div className="bg-clay-100 px-3 py-2 flex items-center gap-2 text-sm">
                      <span className="smallcaps">Day {day.day}</span>
                      <span className="text-clay-700 tabular">{day.date}</span>
                      {day.city && (
                        <span className="text-clay-700 inline-flex items-center gap-1">
                          <MapPin size={12}/>{day.city}
                        </span>
                      )}
                    </div>
                    {(day.items || []).length === 0 ? (
                      <div className="px-3 py-2 text-xs text-clay-500 italic">Sin actividades en este día.</div>
                    ) : (day.items || []).map((it, ii) => {
                      const m = it.match;
                      const conf = m ? CONFIDENCE_LABEL[m.confidence] : null;
                      return (
                        <div
                          key={ii}
                          className={`grid grid-cols-[22px_70px_1fr_auto] gap-2 items-center px-3 py-2 border-t border-clay-200 ${it.excluded ? "opacity-40" : ""}`}
                          data-testid={`travefy-item-${di}-${ii}`}
                        >
                          <input
                            type="checkbox"
                            checked={!it.excluded}
                            onChange={() => toggleItem(di, ii)}
                            className="cursor-pointer"
                            data-testid={`travefy-item-toggle-${di}-${ii}`}
                          />
                          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 bg-clay-200 text-clay-900 text-center">
                            {it.type}
                          </span>
                          <div className="min-w-0">
                            <div className="text-sm truncate" title={it.travefy_name}>{it.travefy_name}</div>
                            {m ? (
                              <div className="text-xs text-clay-700 truncate flex items-center gap-2">
                                <Check size={11} className="text-pine shrink-0"/>
                                <span className="truncate">{m.title}</span>
                                <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 ${conf.cls}`}>{conf.txt}</span>
                              </div>
                            ) : (
                              <div className="text-xs text-amber-700 truncate flex items-center gap-2">
                                <AlertTriangle size={11} className="shrink-0"/>
                                <span>Sin match · Revisar precio después</span>
                              </div>
                            )}
                          </div>
                          <div className="text-right tabular text-sm font-semibold whitespace-nowrap">
                            {m ? `€ ${(m.price_tax_incl || 0).toLocaleString("es-ES", {maximumFractionDigits: 2})}` : "—"}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}

                {/* Hotels */}
                {(preview.hotels || []).length > 0 && (
                  <div className="border border-clay-300">
                    <div className="bg-pine text-white px-3 py-2 smallcaps flex items-center gap-2">
                      <Bed size={13}/> Alojamientos
                    </div>
                    {(preview.hotels || []).map((h, hi) => {
                      const m = h.match;
                      const conf = m ? CONFIDENCE_LABEL[m.confidence] : null;
                      return (
                        <div
                          key={hi}
                          className={`grid grid-cols-[22px_1fr_auto_auto] gap-2 items-center px-3 py-2 border-t border-clay-200 ${h.excluded ? "opacity-40" : ""}`}
                          data-testid={`travefy-hotel-${hi}`}
                        >
                          <input
                            type="checkbox"
                            checked={!h.excluded}
                            onChange={() => toggleHotel(hi)}
                            className="cursor-pointer"
                          />
                          <div className="min-w-0">
                            <div className="text-sm truncate font-semibold" title={h.travefy_name}>{h.travefy_name}</div>
                            {m ? (
                              <div className="text-xs text-clay-700 truncate flex items-center gap-2">
                                <Check size={11} className="text-pine shrink-0"/>
                                <span className="truncate">{m.name}</span>
                                <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 ${conf.cls}`}>{conf.txt}</span>
                              </div>
                            ) : (
                              <div className="text-xs text-amber-700 truncate flex items-center gap-2">
                                <AlertTriangle size={11} className="shrink-0"/>
                                <span>Sin match · Lo creas o eliges hotel en el builder</span>
                              </div>
                            )}
                          </div>
                          <div className="text-xs text-clay-700 tabular whitespace-nowrap">{h.check_in} → {h.check_out}</div>
                          <div className="text-right tabular text-sm font-semibold whitespace-nowrap">
                            {m ? `€ ${(m.price_per_night_incl || 0).toLocaleString("es-ES", {maximumFractionDigits: 2})}/n` : "—"}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center justify-between pt-3 border-t border-clay-300">
                <div className="text-xs text-clay-700">
                  Después podrás afinar precios, añadir habitaciones por hotel y completar lo que falte en el builder.
                </div>
                <div className="flex gap-2">
                  <button onClick={onClose} className="px-4 py-2 text-sm border border-clay-300 hover:bg-clay-100">
                    Cancelar
                  </button>
                  <button
                    data-testid="travefy-confirm"
                    onClick={confirm}
                    disabled={confirming}
                    className="px-5 py-2 bg-clay-900 text-white text-sm tracking-wider uppercase hover:bg-terracotta disabled:opacity-40 inline-flex items-center gap-2"
                  >
                    {confirming && <Loader2 className="animate-spin" size={14}/>}
                    Crear itinerario
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
