import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, FileDown, Plus } from "lucide-react";
import { toast } from "sonner";
import api, { API_BASE } from "@/lib/api";

import {
  PARTNER_LABELS, PARTNER_DEFAULTS, PAYPAL_FEE_PCT,
  fmtEUR, uid, daysBetween, dateAdd,
} from "./builder/utils";
import { Field, Row } from "./builder/atoms";
import { AccommodationsBlock, RoomConfigEditor } from "./builder/AccommodationsBlock";
import { DayBlock } from "./builder/DayBlock";
import { OrientationModal } from "./builder/OrientationModal";
import { FxConverter } from "./builder/FxConverter";
import { PartnerSelector } from "./builder/PartnerSelector";
import { SofiPushModal } from "./builder/SofiPushModal";
import { ShareItineraryModal } from "./builder/ShareItineraryModal";
import { RotateCw, ExternalLink, Eye, Send, Users, Moon } from "lucide-react";

export default function ItineraryBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [itn, setItn] = useState(null);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef(null);

  const [facets, setFacets] = useState({ countries: [], cities: [], types: [] });
  const [activeDayId, setActiveDayId] = useState(null);
  const dragRef = useRef(null);

  // Sofi push modal state. `dryRun` flag controls whether the modal opens in
  // preview mode (fills the form, captures screenshot, no submit) or real-push
  // mode. Closed by default.
  const [sofiModal, setSofiModal] = useState({ open: false, dryRun: true });
  // Share-with-agent modal state. Owner of the itinerary + any current
  // collaborator can open it to manage the `shared_with` list.
  const [shareModalOpen, setShareModalOpen] = useState(false);

  // FX rate for EUR↔USD conversion. Starts from the daily ECB feed, but if
  // the itinerary already has a `fx_rate` value saved on the doc, that value
  // overrides the live feed once the itinerary loads. Agents can change the
  // rate inline (it gets persisted), or click "Auto" to clear the override
  // and revert to the live feed.
  const [fx, setFx] = useState({ rate: 1.10, source: "loading", date: "" });
  useEffect(() => {
    let alive = true;
    api.get("/fx/rate").then(({ data }) => {
      // RACE GUARD: the itinerary loader (other useEffect) may resolve first
      // and set source="manual" from the saved fx_rate. If that happened, we
      // must NOT stomp on the manual value with today's live ECB rate.
      if (alive && data && data.rate) {
        setFx((prev) => prev.source === "manual"
          ? prev
          : { rate: Number(data.rate), source: data.source, date: data.date });
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Initial itinerary load + legacy data cleanup (dash-separated cities).
  useEffect(() => {
    (async () => {
      const { data } = await api.get(`/itineraries/${id}`);
      if ((!data.days || data.days.length === 0) && data.start_date && data.end_date) {
        const n = daysBetween(data.start_date, data.end_date);
        data.days = Array.from({ length: n }).map((_, i) => ({
          day_id: uid("day"),
          date: dateAdd(data.start_date, i),
          label: `Día ${i + 1}`,
          city: "",
          services: [],
        }));
      }
      // Multi-city is now expressed with commas — legacy dash values returned 0 results.
      let cleaned = false;
      (data.days || []).forEach((d) => {
        if (typeof d.city === "string" && d.city.includes("-")) {
          d.city = ""; cleaned = true;
        }
      });
      if (cleaned) toast.message("Limpieza automática de filtros antiguos de ciudad (formato con guión).");
      setItn(data);
      setActiveDayId(data.days?.[0]?.day_id || null);
      // Honour a manually-saved FX rate if present — overrides the live feed.
      if (typeof data.fx_rate === "number" && data.fx_rate > 0) {
        setFx({ rate: Number(data.fx_rate), source: "manual", date: "" });
      }
    })();
  }, [id]);

  useEffect(() => {
    (async () => {
      const { data } = await api.get("/experiences/facets");
      setFacets(data);
    })();
  }, []);

  // Global orientation modal state.
  const [orient, setOrient] = useState(null);
  const openOrient = useCallback(async (opts) => {
    const { hotelName, city: cityHint, checkin, checkout, adults, onApply } = opts;
    let city = cityHint;
    if (!city && hotelName) {
      try {
        const { data } = await api.get("/hotels", { params: { q: hotelName, include_imported: true } });
        const hit = (data || []).find((h) => (h.name || "").toLowerCase() === hotelName.toLowerCase())
                 || (data || [])[0];
        if (hit && hit.city) city = hit.city;
      } catch (_e) {
        // best-effort
      }
    }
    if (!city) {
      city = window.prompt(`¿Ciudad para buscar precio orientativo${hotelName ? ' de "' + hotelName + '"' : ""}?`, "");
      if (!city) return;
    }
    setOrient({ hotelName, city, busy: true, data: null, onApply });
    try {
      const { data } = await api.get("/hotels/price-orientation", {
        params: { city, checkin, checkout, adults: adults || 2 },
        timeout: 45000,
      });
      setOrient((prev) => prev ? { ...prev, data, busy: false } : prev);
    } catch (_e) {
      toast.error("Error consultando precio orientativo");
      setOrient(null);
    }
  }, []);

  // Debounced save with the latest itinerary snapshot.
  // Save the current itinerary immediately, cancelling any pending debounce.
  // Used by `onBlur` handlers on critical fields (name, dates) so a focus
  // change always persists the edit before the user can lose context.
  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    // Re-trigger save with 0ms delay (uses the latest state in setItn closure)
    setItn((cur) => {
      if (!cur) return cur;
      (async () => {
        setSaving(true);
        try {
          await api.patch(`/itineraries/${id}`, {
            name: cur.name, main_traveler: cur.main_traveler,
            start_date: cur.start_date, end_date: cur.end_date,
            duration_days: cur.duration_days, num_travelers: cur.num_travelers,
            num_adults: cur.num_adults, num_children: cur.num_children,
            children_ages: cur.children_ages,
            travelers: cur.travelers, days: cur.days, accommodations: cur.accommodations,
            markup_pct: cur.markup_pct, commission_pct: cur.commission_pct,
            partner: cur.partner, paypal_fee: cur.paypal_fee, currency: cur.currency, status: cur.status,
            room_config: cur.room_config, fx_rate: cur.fx_rate, notes: cur.notes,
          });
        } finally { setSaving(false); }
      })();
      return cur;
    });
  }, [id]);

  const schedSave = useCallback((next) => {
    setItn(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await api.patch(`/itineraries/${id}`, {
          name: next.name, main_traveler: next.main_traveler,
          start_date: next.start_date, end_date: next.end_date,
          duration_days: next.duration_days, num_travelers: next.num_travelers,
          num_adults: next.num_adults, num_children: next.num_children,
          children_ages: next.children_ages,
          travelers: next.travelers, days: next.days, accommodations: next.accommodations,
          markup_pct: next.markup_pct, commission_pct: next.commission_pct,
          partner: next.partner, paypal_fee: next.paypal_fee, currency: next.currency, status: next.status,
          room_config: next.room_config, fx_rate: next.fx_rate, notes: next.notes,
        });
      } finally { setSaving(false); }
    }, 600);
  }, [id]);

  const totals = useMemo(() => {
    if (!itn) return { sub_excl: 0, sub_incl: 0, sub_with_markup: 0, commission_eur: 0, markup_eur: 0, paypal_eur: 0, pvp: 0, iva: 0 };
    let excl = 0, incl = 0;
    (itn.days || []).forEach((d) => (d.services || []).forEach((s) => {
      // Services tied to an accommodation (`acc_id` set) are derived
      // read-only chips, NOT separate cost items. The accommodation
      // itself contributes its price in the loop below, so counting
      // the carrier service here would double-bill the hotel.
      if (s.acc_id) return;
      excl += (s.unit_price_tax_excl || 0) * (s.quantity || 0);
      incl += (s.unit_price_tax_incl || s.unit_price || 0) * (s.quantity || 0);
    }));
    (itn.accommodations || []).forEach((a) => {
      excl += a.price_tax_excl || 0;
      incl += a.price_tax_incl || a.price || 0;
    });
    const mk = (itn.markup_pct || 0) / 100;
    const com_pct = (itn.commission_pct || 0);
    const markup_eur = incl * mk;
    const sub_with_markup = incl + markup_eur;
    // Gross-up: the partner deducts com_pct from the FINAL sale price, so to
    // net `sub_with_markup` on our side we sell at:
    //   pvp_pre_paypal = sub_with_markup / (1 - com_pct/100)
    // which is equivalent to:
    //   commission_eur = sub_with_markup × com_pct / (100 − com_pct)
    //   pvp_pre_paypal = sub_with_markup + commission_eur
    // The older naive `sub_with_markup × com_pct/100` formula made the
    // agency net less than the desired markup on every Zicasso / RT / Baboo
    // trip because the partner cut was applied to the final price, not the
    // markup.
    const commission_eur = com_pct ? (sub_with_markup * com_pct / (100 - com_pct)) : 0;
    const pvp_pre_paypal = sub_with_markup + commission_eur;
    // PayPal processing fee: +3% on the otherwise final PVP, paid by the
    // client to cover PayPal's cut. Toggleable per itinerary.
    const paypal_eur = itn.paypal_fee ? pvp_pre_paypal * (PAYPAL_FEE_PCT / 100) : 0;
    const pvp = pvp_pre_paypal + paypal_eur;
    return { sub_excl: excl, sub_incl: incl, sub_with_markup, markup_eur, commission_eur, paypal_eur, pvp, iva: incl - excl };
  }, [itn]);

  if (!itn) return <div className="p-10 text-sm text-clay-700">Cargando itinerario…</div>;

  // Re-apply the partner's default markup + commission to the current itinerary.
  // Triggered by the ↻ Auto button next to the partner selector. Manual edits
  // to either field stay untouched UNTIL the agent explicitly clicks this.
  const applyPartnerDefaults = () => {
    const d = PARTNER_DEFAULTS[itn.partner];
    if (!d) { toast.error("Partner desconocido"); return; }
    schedSave({ ...itn, markup_pct: d.markup_pct, commission_pct: d.commission_pct });
    toast.success(`Markup ${d.markup_pct}% · Comisión ${d.commission_pct}% aplicados`);
  };

  const setField = (k, v) => {
    const next = { ...itn, [k]: v };
    // NOTE: changing `partner` deliberately does NOT touch markup_pct or
    // commission_pct anymore — agents complained that their manual override
    // was silently overwritten when they revisited an itinerary. To re-apply
    // the partner's default markup+commission, use the ↻ Auto button next to
    // the partner selector (calls `applyPartnerDefaults()` below).
    if (k === "start_date" || k === "end_date") {
      const newStart = k === "start_date" ? v : next.start_date;
      const newEnd = k === "end_date" ? v : next.end_date;
      const n = daysBetween(newStart, newEnd);
      const current = [...(next.days || [])];
      // GUARD: when only ONE of the two dates is set (typical right after a
      // Travefy import that came without dates) `daysBetween` returns 0 and
      // the old code happily truncated `current.length = 0`, deleting every
      // service the agent had already added. We now NEVER auto-resize the
      // days array unless BOTH dates are present and produce a positive n.
      if (n > 0) {
        next.duration_days = n;
        if (n > current.length) {
          for (let i = current.length; i < n; i++) {
            current.push({ day_id: uid("day"), date: dateAdd(newStart, i), label: `Día ${i + 1}`, city: "", services: [] });
          }
        } else if (n < current.length) {
          current.length = n;
        }
        if (k === "start_date") current.forEach((d, i) => { d.date = dateAdd(v, i); d.label = `Día ${i + 1}`; });
      } else if (k === "start_date" && newStart && current.length > 0) {
        // Single-date case: user typed start_date on an itinerary whose end
        // is still empty. Re-stamp the existing days' dates without resizing
        // so the user's services and city assignments are preserved. The
        // length will be reconciled later when end_date is filled in.
        current.forEach((d, i) => { d.date = dateAdd(v, i); d.label = `Día ${i + 1}`; });
      }
      next.days = current;
    }
    schedSave(next);
  };

  const updateDay = (dayId, patch) =>
    schedSave({ ...itn, days: itn.days.map((d) => d.day_id === dayId ? { ...d, ...patch } : d) });

  const addDay = () => {
    const next = { ...itn };
    const i = (next.days || []).length;
    next.days = [...(next.days || []), { day_id: uid("day"), date: dateAdd(next.start_date, i), label: `Día ${i + 1}`, city: "", services: [] }];
    schedSave(next);
    setActiveDayId(next.days[next.days.length - 1].day_id);
  };

  const removeDay = (dayId) => {
    const next = { ...itn };
    next.days = (next.days || []).filter((d) => d.day_id !== dayId);
    next.days.forEach((d, i) => { d.label = `Día ${i + 1}`; if (next.start_date) d.date = dateAdd(next.start_date, i); });
    schedSave(next);
  };

  // SERVICE pricing rule:
  //   For experiences: qty = num_travelers, unit_price = catalog_total / catalog_pax (= €/pax).
  //   For lodging: handled separately by upsertAccommodationFromService.
  const addServiceToDay = (dayId, partial = {}) => {
    const trav = itn.num_travelers || 1;
    const expPax = Math.max(1, parseInt(partial.pax || 1, 10));
    const type = partial.type || "actividad";
    const isLodging = type === "alojamiento";
    const incl = partial.unit_price_tax_incl ?? 0;
    const excl = partial.unit_price_tax_excl ?? incl;
    const perPaxIncl = isLodging ? incl : (incl / expPax);
    const perPaxExcl = isLodging ? excl : (excl / expPax);
    const svc = {
      service_id: uid("svc"),
      experience_id: partial.experience_id || null,
      type,
      name: partial.name || "",
      provider_name: partial.provider_name || "",
      quantity: partial.quantity ?? (isLodging ? 1 : trav),
      pax: expPax,
      unit_price_tax_excl: Math.round(perPaxExcl * 100) / 100,
      unit_price_tax_incl: Math.round(perPaxIncl * 100) / 100,
      unit_price: Math.round(perPaxIncl * 100) / 100,
      currency: partial.currency || "EUR",
    };
    schedSave({ ...itn, days: itn.days.map((d) => d.day_id === dayId ? { ...d, services: [...(d.services || []), svc] } : d) });
    setActiveDayId(dayId);
  };

  const updateService = (dayId, sid, patch) => {
    const synced = { ...patch };
    if ("unit_price_tax_incl" in synced) synced.unit_price = synced.unit_price_tax_incl;
    schedSave({
      ...itn,
      days: itn.days.map((d) =>
        d.day_id === dayId
          ? { ...d, services: d.services.map((s) => s.service_id === sid ? { ...s, ...synced } : s) }
          : d),
    });
  };

  // LODGING pricing rule (from in-day service):
  //   qty = nights × num_rooms, unit_price = avg(rooms.price_per_night)
  // so qty × unit = total. See builder/AccommodationsBlock.jsx for the parallel
  // implementation triggered from the summary panel.
  // Promote a free-text service row (e.g. "Hotel Eden · 200€/noche") to a
  // proper Accommodation entry. The original service row is REMOVED from
  // the day timeline because the stay will now appear automatically as a
  // read-only chip on every overlapping day (DayBlock derives those chips
  // from `accommodations[]`). This avoids the old double-counting where
  // both the service AND the accommodation contributed to the total.
  const upsertAccommodationFromService = (dayId, service, dateFrom, dateTo) => {
    if (!service.name || !dateFrom || !dateTo) return;
    const dFrom = new Date(dateFrom);
    const dTo = new Date(dateTo);
    if (isNaN(dFrom) || isNaN(dTo) || dTo < dFrom) return;
    const accId = service.acc_id || uid("acc");
    const nights = Math.max(1, Math.round((dTo - dFrom) / 86400000));
    const typedNightlyIncl = service.unit_price_tax_incl || service.unit_price || 0;
    const typedNightlyExcl = service.unit_price_tax_excl || typedNightlyIncl;

    const accsBefore = itn.accommodations || [];
    const existingAcc = accsBefore.find((a) => a.acc_id === accId);
    const cfg = itn.room_config || [];
    const seedRooms = (existingAcc && existingAcc.rooms && existingAcc.rooms.length > 0)
      ? existingAcc.rooms
      : (cfg.length > 0 ? cfg : [{ room_type: "doble", pax: 2, quantity: 1 }])
          .flatMap((rc) => Array.from({ length: rc.quantity || 1 }, () => ({
            room_id: uid("room"),
            room_type: rc.room_type, pax: rc.pax,
            price_per_night_excl: 0, price_per_night_incl: 0, currency: "EUR",
          })));
    const roomsHaveAnyPrice = seedRooms.some((r) => (r.price_per_night_incl || 0) > 0 || (r.price_per_night_excl || 0) > 0);
    const rooms = seedRooms.map((r) => ({
      ...r,
      price_per_night_excl: roomsHaveAnyPrice ? r.price_per_night_excl : typedNightlyExcl,
      price_per_night_incl: roomsHaveAnyPrice ? r.price_per_night_incl : typedNightlyIncl,
    }));
    const numRooms = Math.max(1, rooms.length);
    const sumIncl = rooms.reduce((s, r) => s + (r.price_per_night_incl || r.price_per_night_excl || 0), 0);
    const sumExcl = rooms.reduce((s, r) => s + (r.price_per_night_excl || r.price_per_night_incl || 0), 0);
    const avgIncl = Math.round((sumIncl / numRooms) * 100) / 100;
    const avgExcl = Math.round((sumExcl / numRooms) * 100) / 100;
    const totalQty = nights * numRooms;
    const totalIncl = Math.round(avgIncl * totalQty * 100) / 100;
    const totalExcl = Math.round(avgExcl * totalQty * 100) / 100;
    const baseName = (service.name || "").replace(/^Check-in · |^Check-out · |^Alojamiento · /, "");

    // Strip BOTH the source service and any stale carriers for this acc_id
    // from EVERY day. The new chips will be re-derived from accommodations.
    const newDays = (itn.days || []).map((d) => ({
      ...d,
      services: (d.services || []).filter((s) =>
        s.service_id !== service.service_id && s.acc_id !== accId
      ),
    }));

    const accs = [...accsBefore];
    const existingIdx = accs.findIndex((a) => a.acc_id === accId);
    const accRow = {
      acc_id: accId, name: baseName,
      date_from: dateFrom, date_to: dateTo,
      rooms,
      price_tax_excl: totalExcl, price_tax_incl: totalIncl, price: totalIncl,
      currency: "EUR",
    };
    if (existingIdx === -1) accs.push(accRow);
    else accs[existingIdx] = { ...accs[existingIdx], ...accRow };

    schedSave({ ...itn, days: newDays, accommodations: accs });
  };

  // Drag & drop: move a service between days or reorder within a day.
  const onDragStart = (srcDayId, srcServiceId) => { dragRef.current = { srcDayId, srcServiceId }; };
  const onDropService = (targetDayId, targetIndex) => {
    const src = dragRef.current;
    dragRef.current = null;
    if (!src) return;
    const { srcDayId, srcServiceId } = src;
    if (srcDayId === targetDayId && targetIndex === -1) return;
    let dragged = null;
    const days = itn.days.map((d) => {
      if (d.day_id !== srcDayId) return d;
      const services = [];
      for (const s of d.services || []) {
        if (s.service_id === srcServiceId) dragged = s;
        else services.push(s);
      }
      return { ...d, services };
    });
    if (!dragged) return;
    const finalDays = days.map((d) => {
      if (d.day_id !== targetDayId) return d;
      const services = [...(d.services || [])];
      if (targetIndex < 0 || targetIndex >= services.length) services.push(dragged);
      else services.splice(targetIndex, 0, dragged);
      return { ...d, services };
    });
    schedSave({ ...itn, days: finalDays });
    setActiveDayId(targetDayId);
  };
  const removeService = (dayId, sid) =>
    schedSave({ ...itn, days: itn.days.map((d) => d.day_id === dayId
      ? { ...d, services: d.services.filter((s) => s.service_id !== sid) } : d) });

  const exportXlsx = async () => {
    try {
      const res = await fetch(`${API_BASE}/itineraries/${id}/export`, { credentials: "include" });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${(itn.name || "itinerario").replace(/\s+/g, "_")}.xlsx`;
      link.click(); URL.revokeObjectURL(link.href);
      toast.success("Excel descargado");
    } catch (_e) { toast.error("No se pudo exportar"); }
  };

  return (
    <div className="min-h-screen">
      {/* Full-width header — name, status, action buttons, trip metadata, notes */}
      <div className="px-8 pt-6 pb-2">
        <button onClick={() => navigate("/dashboard")} className="inline-flex items-center gap-2 text-xs smallcaps hover:text-terracotta" data-testid="back-dashboard">
          <ArrowLeft size={14} /> Itinerarios
        </button>

        <div className="mt-3 flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <input
              data-testid="itn-name-input"
              className="font-serif text-4xl leading-none bg-transparent border-b border-clay-200 outline-none w-full px-1 py-1 hover:border-clay-400 focus:border-terracotta transition-colors"
              value={itn.name || ""}
              placeholder="Nombre del itinerario…"
              onChange={(e) => setField("name", e.target.value)}
              onBlur={flushSave}
            />
            <div className="smallcaps mt-2 flex items-center gap-3 flex-wrap">
              <span data-testid="save-state">{saving ? "Guardando…" : "Guardado"}</span>
              <span>·</span>
              <select data-testid="itn-status" value={itn.status} onChange={(e) => setField("status", e.target.value)} className="bg-transparent border border-clay-300 px-2 py-0.5 text-[10px] uppercase tracking-widest">
                <option value="draft">Borrador</option>
                <option value="sold">Vendido</option>
                <option value="not_sold">No vendido</option>
              </select>
              {(itn.shared_with || []).length > 0 && (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1 normal-case tracking-normal text-clay-700"
                        data-testid="shared-with-summary"
                        title={(itn.shared_with || []).join(", ")}>
                    <Users size={12} />
                    Compartido con {(itn.shared_with || []).map((e) => {
                      const local = e.split("@")[0];
                      return local.charAt(0).toUpperCase() + local.slice(1);
                    }).join(", ")}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setShareModalOpen(true)}
                    data-testid="share-btn"
                    className="inline-flex items-center gap-2 px-4 py-2 border border-clay-300 hover:bg-clay-100 text-sm">
              <Users size={14} /> Compartir con
            </button>
            {/* "Exportar Excel" + "Vista previa Sofi" are hidden for now — the
                team works directly off Sofi's UI. Keep the handlers/imports
                wired so we can re-enable them with a single line if needed.
            <button onClick={exportXlsx} data-testid="export-xlsx" className="inline-flex items-center gap-2 px-4 py-2 border border-clay-300 hover:bg-clay-100 text-sm">
              <FileDown size={14} /> Exportar Excel
            </button>
            */}
            {itn.sofi_trip_id ? (
              <a
                href={itn.sofi_url || `https://gestion.viajadverdad.com/trips/details/1/${itn.sofi_trip_id}`}
                target="_blank" rel="noreferrer"
                data-testid="sofi-already-pushed-link"
                title={`Enviado a Sofi el ${itn.sofi_pushed_at?.slice(0, 10) || "(fecha no registrada)"}`}
                className="inline-flex items-center gap-2 px-4 py-2 border border-pine-soft bg-pine-soft/30 hover:bg-pine-soft/50 text-sm text-pine"
              >
                <ExternalLink size={14} /> En Sofi #{itn.sofi_trip_id}
              </a>
            ) : (
              <button onClick={() => setSofiModal({ open: true, dryRun: false })}
                      data-testid="sofi-push-btn"
                      className="inline-flex items-center gap-2 px-4 py-2 bg-pine text-white hover:bg-pine-hover text-sm">
                <Send size={14} /> Enviar a Sofi
              </button>
            )}
          </div>
        </div>

        {/* Trip metadata — Row 1: who/when (5 cols) · Row 2: pax breakdown */}
        <div className="mt-6 border border-clay-300">
          <div className="grid grid-cols-5 gap-0">
            <Field label="Viajero principal">
              <input data-testid="main-traveler" className="w-full bg-transparent outline-none text-sm" value={itn.main_traveler || ""} onChange={(e) => setField("main_traveler", e.target.value)} placeholder="Nombre Apellido" />
            </Field>
            <Field label="Fuente">
              <PartnerSelector itn={itn} setField={setField} />
            </Field>
            <Field label="Inicio">
              <input data-testid="start-date" type="date" className="w-full bg-transparent outline-none text-sm tabular" value={itn.start_date || ""} onChange={(e) => setField("start_date", e.target.value)} />
            </Field>
            <Field label="Fin">
              <input data-testid="end-date" type="date" className="w-full bg-transparent outline-none text-sm tabular" value={itn.end_date || ""} onChange={(e) => setField("end_date", e.target.value)} />
            </Field>
            <Field label="Noches">
              <div className="flex items-center gap-1.5 text-sm tabular" data-testid="nights-readout">
                <Moon size={13} className="text-clay-500" />
                <span>{itn.start_date && itn.end_date ? Math.max(0, daysBetween(itn.start_date, itn.end_date) - 1) : "—"}</span>
              </div>
            </Field>
          </div>
          {/* Row 2: PAX breakdown — adults / children / ages */}
          {(() => {
            const adults = itn.num_adults ?? itn.num_travelers ?? 2;
            const children = itn.num_children ?? 0;
            const ages = itn.children_ages || [];
            const totalPax = adults + children;
            const setAdults = (v) => {
              const a = Math.max(1, parseInt(v || "0", 10) || 0);
              schedSave({ ...itn, num_adults: a, num_travelers: a + children });
            };
            const setChildren = (v) => {
              const c = Math.max(0, parseInt(v || "0", 10) || 0);
              const nextAges = c <= ages.length
                ? ages.slice(0, c)
                : [...ages, ...Array(c - ages.length).fill(0)];
              schedSave({ ...itn, num_children: c, children_ages: nextAges, num_travelers: adults + c });
            };
            const setAge = (idx, v) => {
              const next = [...ages];
              next[idx] = Math.max(0, Math.min(17, parseInt(v || "0", 10) || 0));
              schedSave({ ...itn, children_ages: next });
            };
            return (
              <div className="grid grid-cols-[1fr_1fr_2fr_1fr] gap-0 border-t border-clay-300">
                <Field label="Adultos">
                  <input data-testid="num-adults" type="number" min={1} max={20}
                         className="w-full bg-transparent outline-none text-sm tabular"
                         value={adults}
                         onChange={(e) => setAdults(e.target.value)} />
                </Field>
                <Field label="Niños">
                  <input data-testid="num-children" type="number" min={0} max={10}
                         className="w-full bg-transparent outline-none text-sm tabular"
                         value={children}
                         onChange={(e) => setChildren(e.target.value)} />
                </Field>
                <Field label={children > 0 ? "Edades niños" : "Edades niños (sin niños)"}>
                  {children > 0 ? (
                    <div className="flex items-center gap-2 flex-wrap" data-testid="children-ages-row">
                      {Array.from({ length: children }).map((_, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <span className="text-[10px] uppercase tracking-wider text-clay-500">#{i + 1}</span>
                          <input
                            data-testid={`child-age-${i}`}
                            type="number" min={0} max={17}
                            value={ages[i] ?? 0}
                            onChange={(e) => setAge(i, e.target.value)}
                            className="w-12 bg-transparent border border-clay-300 px-1 py-0.5 text-sm tabular text-center"
                          />
                          <span className="text-[10px] text-clay-500">a.</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="text-xs text-clay-500 italic">—</span>
                  )}
                </Field>
                <Field label="Pax (total)">
                  <div className="text-sm tabular font-medium" data-testid="pax-total">{totalPax}</div>
                </Field>
              </div>
            );
          })()}
        </div>

        {/* Notes — full width */}
        <div className="mt-4 border border-clay-300">
          <div className="px-4 py-2 bg-clay-100 border-b border-clay-300 smallcaps">
            Notas internas
          </div>
          <textarea
            data-testid="itin-notes"
            value={itn.notes || ""}
            onChange={(e) => setField("notes", e.target.value)}
            placeholder="Recordatorios, preferencias del cliente, condiciones especiales, contexto para otros agentes…"
            rows={2}
            className="w-full bg-white outline-none text-sm px-4 py-3 resize-y min-h-[60px] focus:bg-amber-50/30"
          />
        </div>
      </div>

      {/* Below header: 2-col grid (left = room config + days + accommodations, right = costs panel) */}
      <div className="grid grid-cols-[1fr_380px]">
        <div className="px-8 pt-2 pb-6 border-r border-clay-300">
          {/* Default room configuration */}
          <div className="mt-2">
            <RoomConfigEditor
              config={itn.room_config || []}
              numTravelers={itn.num_travelers}
              onChange={(next) => schedSave({ ...itn, room_config: next })}
            />
          </div>

          {/* Days */}
          <div className="mt-8 space-y-6">
            {(itn.days || []).map((day, idx) => (
              <DayBlock
                key={day.day_id}
                day={day}
                idx={idx}
                active={activeDayId === day.day_id}
                numTravelers={itn.num_travelers}
                accommodations={itn.accommodations || []}
                cityFacets={facets.cities}
                markup={itn.markup_pct || 0}
                onActivate={() => setActiveDayId(day.day_id)}
                onUpdateDay={(patch) => updateDay(day.day_id, patch)}
                onAddBlank={() => addServiceToDay(day.day_id)}
                onRemoveDay={() => removeDay(day.day_id)}
                onUpdateService={(sid, patch) => updateService(day.day_id, sid, patch)}
                onRemoveService={(sid) => removeService(day.day_id, sid)}
                onDragStart={onDragStart}
                onDropService={onDropService}
                onOrient={openOrient}
                onAccommodate={(svc, dFrom, dTo) => upsertAccommodationFromService(day.day_id, svc, dFrom, dTo)}
              />
            ))}
            <button onClick={addDay} data-testid="add-day-btn" className="w-full border border-dashed border-clay-300 py-3 text-sm text-clay-700 hover:border-terracotta hover:text-terracotta transition-colors">
              <Plus size={14} className="inline mr-2"/> Añadir día
            </button>
          </div>

          <AccommodationsBlock itn={itn} schedSave={schedSave} markup={itn.markup_pct || 0} onOrient={openOrient} />
        </div>

        {/* Right: cost summary — starts BELOW the header so the trip metadata
            has the full width on top */}
        <aside className="bg-clay-50/60">
          <div className="sticky top-2 max-h-screen overflow-auto flex flex-col">
            <div className="border-b border-clay-300 p-5 bg-white">
              <div className="smallcaps">Coste</div>
              <div className="grid-borders mt-3">
                <Row label="Subtotal con IVA">{fmtEUR(totals.sub_incl)}</Row>
                <Row label={(
                  <div className="flex items-center gap-2">
                    <span>Markup</span>
                    <input data-testid="markup-input" type="number" step="0.5" min="0"
                      value={itn.markup_pct ?? 0}
                      onChange={(e) => setField("markup_pct", parseFloat(e.target.value || "0"))}
                      className="w-16 bg-transparent border border-clay-300 px-1 py-0.5 text-sm tabular text-right" />
                    <span className="text-xs text-clay-700">%</span>
                  </div>
                )}>+ {fmtEUR(totals.markup_eur)}</Row>
                <Row label="Subtotal con markup">{fmtEUR(totals.sub_with_markup)}</Row>
                {(itn.commission_pct ?? 0) > 0 && (
                  <Row label={(
                    <div className="flex items-center gap-2">
                      <span>Comisión <span className="text-clay-500 normal-case">({PARTNER_LABELS[itn.partner] || itn.partner})</span></span>
                      <input
                        data-testid="commission-input"
                        type="number" step="0.5" min="0"
                        value={itn.commission_pct ?? 0}
                        onChange={(e) => setField("commission_pct", parseFloat(e.target.value || "0"))}
                        className="w-16 bg-transparent border border-clay-300 px-1 py-0.5 text-sm tabular text-right"
                      />
                      <span className="text-xs text-clay-700">%</span>
                      <button
                        data-testid="auto-partner-defaults"
                        onClick={applyPartnerDefaults}
                        className="p-0.5 hover:bg-clay-200 text-clay-600 hover:text-terracotta inline-flex items-center gap-0.5"
                        title={`Auto: markup ${PARTNER_DEFAULTS[itn.partner]?.markup_pct}% · comisión ${PARTNER_DEFAULTS[itn.partner]?.commission_pct}%`}
                      >
                        <RotateCw size={11}/>
                        <span className="text-[9px] uppercase tracking-wider">Auto</span>
                      </button>
                    </div>
                  )}>+ {fmtEUR(totals.commission_eur)}</Row>
                )}
                {/* PayPal Fee toggle — adds 3% on top of the otherwise final PVP */}
                <div className="flex items-center justify-between py-2 px-3 text-sm">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      data-testid="paypal-fee-toggle"
                      checked={!!itn.paypal_fee}
                      onChange={(e) => setField("paypal_fee", e.target.checked)}
                      className="cursor-pointer"
                    />
                    <span>PayPal Fee <span className="text-clay-500">(+{PAYPAL_FEE_PCT}%)</span></span>
                  </label>
                  <span className="tabular text-clay-700">{itn.paypal_fee ? `+ ${fmtEUR(totals.paypal_eur)}` : "—"}</span>
                </div>
                <div className="flex items-center justify-between py-3 bg-clay-900 text-white px-3 mt-2" data-testid="final-price">
                  <div className="smallcaps text-white/70">PVP final</div>
                  <div className="font-serif text-2xl tabular">{fmtEUR(totals.pvp)}</div>
                </div>
                <FxConverter
                  fx={fx}
                  setFx={setFx}
                  totals={totals}
                  onPersist={(rate) => setField("fx_rate", rate)}
                />
              </div>
            </div>
          </div>
        </aside>
      </div>

      {orient && (
        <OrientationModal
          city={orient.city}
          hotelName={orient.hotelName}
          checkin={orient.checkin}
          checkout={orient.checkout}
          adults={orient.adults}
          busy={orient.busy}
          data={orient.data}
          onClose={() => setOrient(null)}
          onApply={(price) => { if (orient.onApply) orient.onApply(price); setOrient(null); }}
        />
      )}

      <SofiPushModal
        key={`${sofiModal.open}-${sofiModal.dryRun}`}
        open={sofiModal.open}
        dryRun={sofiModal.dryRun}
        itineraryId={id}
        onClose={() => setSofiModal({ open: false, dryRun: true })}
        onSwitchToReal={() => setSofiModal({ open: true, dryRun: false })}
        onPushed={(res) => {
          // Real push succeeded — refetch the itinerary so the badge swaps to
          // "En Sofi #N" and the Vista previa / Enviar buttons disappear.
          api.get(`/itineraries/${id}`).then(({ data }) => setItn(data)).catch(() => {});
          toast.success(`Itinerario enviado a Sofi #${res.trip_id}`);
        }}
      />

      <ShareItineraryModal
        open={shareModalOpen}
        itineraryId={id}
        ownerEmail={itn.created_by}
        sharedWith={itn.shared_with || []}
        onClose={() => setShareModalOpen(false)}
        onChange={(nextShared) => setItn((prev) => prev ? { ...prev, shared_with: nextShared } : prev)}
      />
    </div>
  );
}
