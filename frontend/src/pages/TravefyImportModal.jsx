import React, { useState, useEffect, useRef } from "react";
import { Link2, Check, AlertTriangle, X, Loader2, MapPin, Bed, Wand2, Search, Pencil, Link } from "lucide-react";
import { useNavigate } from "react-router-dom";
import api from "@/lib/api";
import { toast } from "sonner";

// 3-step flow:
//  1. url       — agent pastes a Travefy URL
//  2. running   — backend job is reading the page + matching against BBDD
//  3. preview   — agent reviews matched items, excludes any, then confirms
//
// Inside step 3, every item exposes a "Cambiar/Vincular" button that opens
// an inline search dropdown (limited to that day's city + the item's type)
// so the agent can fix a wrong match or attach an experience to a row the
// automated matcher missed.

const CONFIDENCE_LABEL = {
  high:   { txt: "Match alto",  cls: "bg-pine text-white" },
  medium: { txt: "Match medio", cls: "bg-clay-300 text-clay-900" },
  low:    { txt: "Match dudoso", cls: "bg-amber-200 text-amber-900" },
  manual: { txt: "Manual",      cls: "bg-terracotta text-white" },
};

/** "[(doble,2),(doble,1)]" → "2× doble" — collapses identical types. */
function layoutSummary(layout) {
  if (!layout || layout.length === 0) return "";
  const counts = new Map();
  for (const r of layout) counts.set(r.room_type, (counts.get(r.room_type) || 0) + 1);
  return [...counts.entries()].map(([t, n]) => (n > 1 ? `${n}× ${t}` : t)).join(" + ");
}

/** Inline search for vinculating an unmatched item (or replacing a wrong match).
 *  Renders below the item row, search results inline (no absolute popover that
 *  would get clipped by the scrollable modal body). */
function InlineMatchPicker({ initialQuery, dayCity, type, pax, onPick, onClose }) {
  const isHotel = type === "alojamiento";
  const [q, setQ] = useState(initialQuery || "");
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(true);

  // Debounced search effect — fires on mount (initial query) and on every
  // change to `q` / pre-filters. Cancelled cleanly on unmount or rapid typing.
  useEffect(() => {
    let cancelled = false;
    const handler = setTimeout(async () => {
      const params = { q: (q || "").trim(), type, limit: 8 };
      if (dayCity) params.city = dayCity;
      if (pax) params.pax = pax;
      try {
        const { data } = await api.get("/experiences/autocomplete", { params });
        if (!cancelled) { setResults(data || []); setBusy(false); }
      } catch (_e) {
        if (!cancelled) { setResults([]); setBusy(false); }
      }
    }, 220);
    return () => { cancelled = true; clearTimeout(handler); };
  }, [q, dayCity, type, pax]);

  const onQ = (e) => setQ(e.target.value);

  return (
    <div className="border-t border-clay-300 bg-clay-50 px-3 py-2 col-span-full" data-testid="match-picker">
      <div className="flex items-center gap-2 mb-2">
        <Search size={13} className="text-clay-500"/>
        <input
          autoFocus
          data-testid="match-picker-input"
          value={q}
          onChange={onQ}
          placeholder={dayCity ? `Buscar en ${dayCity}…` : "Buscar en la BBDD…"}
          className="flex-1 bg-white border border-clay-300 px-2 py-1 text-sm outline-none focus:border-terracotta"
        />
        <button onClick={onClose} className="text-clay-500 hover:text-clay-900 text-xs uppercase tracking-wider" data-testid="match-picker-close">
          Cerrar
        </button>
      </div>
      {busy && <div className="text-xs text-clay-500 py-2">Buscando…</div>}
      {!busy && results.length === 0 && (
        <div className="text-xs text-clay-500 py-2 italic">
          Sin resultados. Prueba con menos palabras o quita el filtro de ciudad.
        </div>
      )}
      {!busy && results.length > 0 && (
        <div className="space-y-1 max-h-56 overflow-y-auto">
          {results.map((r) => {
            const id = isHotel ? r.hotel_id : r.experience_id;
            const price = isHotel
              ? (r.price_per_night_incl ?? r.price_tax_incl ?? 0)
              : (r.price_tax_incl ?? r.price ?? 0);
            return (
              <button
                key={id}
                data-testid={`match-pick-${id}`}
                onClick={() => onPick(r)}
                className="w-full text-left bg-white border border-clay-200 hover:border-terracotta hover:bg-terracotta/5 px-2.5 py-1.5 text-sm flex items-center gap-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-semibold truncate">{r.title}</div>
                  <div className="text-[11px] text-clay-700 truncate">
                    {[r.provider_name, r.city, r.country].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <div className="text-right shrink-0 tabular text-xs">
                  <div className="font-semibold">€ {Number(price).toLocaleString("es-ES", {maximumFractionDigits: 2})}{isHotel ? "/n" : ""}</div>
                  {!isHotel && r.pax ? <div className="text-[10px] text-clay-700">{r.pax} pax</div> : null}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TravefyImportModal({ onClose }) {
  const [step, setStep] = useState("url");
  const [url, setUrl] = useState("");
  const [jobId, setJobId] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  // Tracks which row is currently being re-matched. Strings:
  //   "day:{di}:{ii}"  → an activity row
  //   "hotel:{hi}"     → a hotel row
  const [pickerOpen, setPickerOpen] = useState(null);
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

  // Build a "match" payload from an /experiences/autocomplete result.
  // The autocomplete endpoint returns experiences or hotels (when type=alojamiento)
  // — we normalize both into the same {match} shape the confirm endpoint expects.
  const pickItemMatch = (dayIdx, itemIdx, result) => {
    setPreview((p) => {
      const days = [...p.days];
      const items = [...days[dayIdx].items];
      const newMatch = {
        experience_id: result.experience_id,
        title: result.title,
        type: result.type || items[itemIdx].type,
        pax: result.pax,
        city: result.city,
        provider_name: result.provider_name,
        price_tax_excl: result.price_tax_excl || 0,
        price_tax_incl: result.price_tax_incl || result.price || 0,
        currency: result.currency || "EUR",
        confidence: "manual",
      };
      items[itemIdx] = { ...items[itemIdx], match: newMatch, type: newMatch.type };
      days[dayIdx] = { ...days[dayIdx], items };
      return { ...p, days };
    });
    setPickerOpen(null);
    toast.success("Match vinculado");
  };

  const unlinkItemMatch = (dayIdx, itemIdx) => {
    setPreview((p) => {
      const days = [...p.days];
      const items = [...days[dayIdx].items];
      items[itemIdx] = { ...items[itemIdx], match: null };
      days[dayIdx] = { ...days[dayIdx], items };
      return { ...p, days };
    });
  };

  const pickHotelMatch = (hotelIdx, result) => {
    setPreview((p) => {
      const hotels = [...p.hotels];
      const newMatch = {
        hotel_id: result.hotel_id,
        name: result.title,  // autocomplete returns hotel name in `title`
        city: result.city,
        tier: result.tier,
        price_per_night_excl: result.price_tax_excl || 0,
        price_per_night_incl: result.price_tax_incl || 0,
        currency: result.currency || "EUR",
        confidence: "manual",
      };
      hotels[hotelIdx] = { ...hotels[hotelIdx], match: newMatch };
      return { ...p, hotels };
    });
    setPickerOpen(null);
    toast.success("Hotel vinculado");
  };

  const unlinkHotelMatch = (hotelIdx) => {
    setPreview((p) => {
      const hotels = [...p.hotels];
      hotels[hotelIdx] = { ...hotels[hotelIdx], match: null };
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
                      const pickerKey = `day:${di}:${ii}`;
                      const isPickerOpen = pickerOpen === pickerKey;
                      return (
                        <React.Fragment key={ii}>
                          <div
                            className={`grid grid-cols-[22px_70px_1fr_auto_auto] gap-2 items-center px-3 py-2 border-t border-clay-200 ${it.excluded ? "opacity-40" : ""}`}
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
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                onClick={() => setPickerOpen(isPickerOpen ? null : pickerKey)}
                                className="p-1.5 hover:bg-clay-200 text-clay-700"
                                title={m ? "Cambiar match" : "Vincular a la BBDD"}
                                data-testid={`travefy-item-pick-${di}-${ii}`}
                              >
                                {m ? <Pencil size={13}/> : <Link size={13}/>}
                              </button>
                              {m && (
                                <button
                                  onClick={() => unlinkItemMatch(di, ii)}
                                  className="p-1.5 hover:bg-clay-200 text-clay-400 hover:text-destructive"
                                  title="Quitar match"
                                  data-testid={`travefy-item-unlink-${di}-${ii}`}
                                >
                                  <X size={13}/>
                                </button>
                              )}
                            </div>
                          </div>
                          {isPickerOpen && (
                            <InlineMatchPicker
                              initialQuery={it.travefy_name}
                              dayCity={day.city}
                              type={it.type}
                              pax={preview.num_travelers}
                              onPick={(r) => pickItemMatch(di, ii, r)}
                              onClose={() => setPickerOpen(null)}
                            />
                          )}
                        </React.Fragment>
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
                      const pickerKey = `hotel:${hi}`;
                      const isPickerOpen = pickerOpen === pickerKey;
                      return (
                        <React.Fragment key={hi}>
                          <div
                            className={`grid grid-cols-[22px_1fr_auto_auto_auto] gap-2 items-center px-3 py-2 border-t border-clay-200 ${h.excluded ? "opacity-40" : ""}`}
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
                                  <span>Sin match · Vincúlalo manualmente o créalo en el builder</span>
                                </div>
                              )}
                              {(h.room_type || h.room_type_raw) && (
                                <div className="text-[10px] text-clay-700 mt-0.5 flex items-center gap-1.5 truncate">
                                  <Bed size={10} className="shrink-0 text-clay-500"/>
                                  <span className="uppercase tracking-wider font-semibold text-pine">
                                    {h.rooms_layout && h.rooms_layout.length > 0
                                      ? layoutSummary(h.rooms_layout)
                                      : h.room_type}
                                  </span>
                                  {h.room_type_raw && (
                                    <span className="text-clay-500 italic truncate">· &ldquo;{h.room_type_raw}&rdquo;</span>
                                  )}
                                </div>
                              )}
                            </div>
                            <div className="text-xs text-clay-700 tabular whitespace-nowrap">{h.check_in} → {h.check_out}</div>
                            <div className="text-right tabular text-sm font-semibold whitespace-nowrap">
                              {m ? `€ ${(m.price_per_night_incl || 0).toLocaleString("es-ES", {maximumFractionDigits: 2})}/n` : "—"}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                onClick={() => setPickerOpen(isPickerOpen ? null : pickerKey)}
                                className="p-1.5 hover:bg-clay-200 text-clay-700"
                                title={m ? "Cambiar hotel" : "Vincular a la BBDD"}
                                data-testid={`travefy-hotel-pick-${hi}`}
                              >
                                {m ? <Pencil size={13}/> : <Link size={13}/>}
                              </button>
                              {m && (
                                <button
                                  onClick={() => unlinkHotelMatch(hi)}
                                  className="p-1.5 hover:bg-clay-200 text-clay-400 hover:text-destructive"
                                  title="Quitar match"
                                  data-testid={`travefy-hotel-unlink-${hi}`}
                                >
                                  <X size={13}/>
                                </button>
                              )}
                            </div>
                          </div>
                          {isPickerOpen && (
                            <InlineMatchPicker
                              initialQuery={h.travefy_name}
                              dayCity={h.city}
                              type="alojamiento"
                              onPick={(r) => pickHotelMatch(hi, r)}
                              onClose={() => setPickerOpen(null)}
                            />
                          )}
                        </React.Fragment>
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
