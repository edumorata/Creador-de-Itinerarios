import React, { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import axios from "axios";
import {
  CreditCard, ShieldCheck, Sun, CheckCircle2,
  AlertCircle, Loader2, MapPin, Plane, FileText,
  Users, Plus, Trash2, Send, X, Edit3,
  MessageCircle, Copy, Mail as MailIcon,
} from "lucide-react";
import { TermsAcceptance, TOS_VERSION } from "./public/TermsAcceptance";

const API_BASE = `${process.env.REACT_APP_BACKEND_URL}/api`;

const fmtEUR = (n) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n || 0);

const fmtDate = (iso) => {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return iso; }
};

const KIND_DESCRIPTOR = {
  deposit: { tag: "Deposit", pct: "30%", helper: "Confirm your trip today. The remaining balance is paid 45 days before departure." },
  complete_deposit: { tag: "Complete deposit", pct: null, helper: "This last bit finishes the 30% deposit and confirms the booking. Ideal for the second traveler in a split payment.", highlight: true },
  balance: { tag: "Remaining balance", pct: null, helper: "Final payment to complete your booking." },
  full:    { tag: "Full payment", pct: "100%", helper: "Single full payment to confirm your trip." },
  partial: { tag: "Custom amount", pct: null, helper: "Pay any amount you want. Come back to this same link whenever you'd like to pay another instalment." },
};

const emptyPerson = () => ({ full_name: "", passport_number: "", date_of_birth: "" });

export default function PublicPayment() {
  const { token } = useParams();
  const [search] = useSearchParams();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submittingKind, setSubmittingKind] = useState(null);

  // Traveler-info form state
  const [form, setForm] = useState({
    people: [emptyPerson()],
    arrival_flight: "",
    departure_flight: "",
    phone: "",
    notes: "",
    submitted_by_email: "",
  });
  const [formSaving, setFormSaving] = useState(false);
  const [formSavedAt, setFormSavedAt] = useState(null);
  // Popup state — the traveler-info form is presented as a mandatory-feeling
  // modal that auto-opens whenever the client lands on the page WITHOUT
  // having submitted their details, and again right after a successful
  // payment. Once submitted, it stays closed unless the client explicitly
  // hits "Update my details".
  const [showInfoDialog, setShowInfoDialog] = useState(false);

  const successKind = search.get("success") ? search.get("kind") : null;
  const successAmount = search.get("amount");
  const cancelled = search.get("cancelled");
  const apiError = search.get("error");

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const { data: d } = await axios.get(`${API_BASE}/payments/${token}`);
      setData(d);
      // Initialise the partial-amount input from the suggested monthly
      // (preferred) or the partial minimum, so the input is never empty
      // when the option becomes available.
      const seed =
        d?.monthly_suggested_eur?.amount_eur ||
        d?.partial_bounds?.min_eur ||
        "";
      setPartialAmount(seed ? String(seed) : "");
      // Pre-populate the form from any previous submission, or size `people`
      // to match num_travelers (default to 1 row).
      const prev = d?.traveler_info;
      const paid = d?.paid_eur || 0;
      // Post-payment surprise from PayPal capture return
      const justPaid = !!(new URLSearchParams(window.location.search).get("success"));
      if (prev) {
        setForm({
          people: prev.people?.length ? prev.people : [emptyPerson()],
          arrival_flight: prev.arrival_flight || "",
          departure_flight: prev.departure_flight || "",
          phone: prev.phone || "",
          notes: prev.notes || "",
          submitted_by_email: prev.submitted_by_email || "",
        });
        setFormSavedAt(prev.submitted_at || null);
        setShowInfoDialog(false);
      } else {
        const count = Math.max(1, Math.min(10, d?.num_travelers || 1));
        setForm((f) => ({ ...f, people: Array.from({ length: count }, emptyPerson) }));
        // Traveler-info popup: ONLY auto-open after the client actually
        // paid something (deposit / full / partial captured, or just
        // came back from PayPal with ?success=1). Pre-payment we don't
        // want to block the client with a form — the goal is conversion,
        // not paperwork. They can still open it manually below.
        setShowInfoDialog(paid > 0 || justPaid);
      }
    } catch (e) {
      setError(e?.response?.data?.detail || "We couldn't load this payment link. It may have expired.");
    } finally { setLoading(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [token]);

  // Partial-amount input state. Initialised from the suggested monthly
  // payment when the API returns one (otherwise the partial minimum).
  const [partialAmount, setPartialAmount] = useState("");

  // Split-payment state. When the client toggles this on we compute a
  // per-share amount so each traveler can pay their part with their name.
  // All shares land on the SAME payment_token/invoice — the total stays
  // the same, just multiple PayPal orders contribute to the same balance.
  const [split, setSplit] = useState({ enabled: false, count: 2 });
  const [payerName, setPayerName] = useState("");
  const [payerEmail, setPayerEmail] = useState("");
  // Terms & Conditions acceptance — the client must tick this before the
  // pay buttons can be clicked. Stored per-session so a returning payer
  // (e.g. coming back for a balance payment) is asked once.
  const [tosAccepted, setTosAccepted] = useState(() => {
    try { return sessionStorage.getItem("vdv_tos_accepted") === "1"; } catch { return false; }
  });
  const handleTosChange = (v) => {
    setTosAccepted(v);
    try { sessionStorage.setItem("vdv_tos_accepted", v ? "1" : "0"); } catch { /* ignore */ }
  };

  // Auto-detect split-count from the ledger of captured payments: if
  // someone already paid a share labelled "1 of 4", subsequent travelers
  // land with split.count=4 pre-filled and split.enabled=true.
  useEffect(() => {
    const list = data?.captured_payments || [];
    if (!list.length) return;
    let detectedN = 0;
    for (const p of list) {
      const m = /(\d+)\s*of\s*(\d+)/i.exec(p?.share_label || "");
      if (m) detectedN = Math.max(detectedN, parseInt(m[2]));
    }
    if (detectedN >= 2) {
      setSplit((s) => (s.enabled ? s : { enabled: true, count: detectedN }));
    }
  }, [data?.captured_payments]);

  const onPay = async (kind, customAmount, meta = {}) => {
    if (!tosAccepted) {
      setError("Please accept the Terms & Conditions to proceed.");
      return;
    }
    setSubmittingKind(kind);
    try {
      const body = {
        kind, origin: window.location.origin,
        tos_accepted: true,
        tos_version: TOS_VERSION,
      };
      if (kind === "partial") body.amount_eur = customAmount;
      if (meta.payer_name) body.payer_name = meta.payer_name;
      if (meta.payer_email) body.payer_email = meta.payer_email;
      if (meta.share_label) body.share_label = meta.share_label;
      const { data: res } = await axios.post(`${API_BASE}/payments/${token}/create-order`, body);
      if (res?.approval_url) { window.location.href = res.approval_url; return; }
      throw new Error("PayPal didn't return an approval URL");
    } catch (e) {
      const detail = e?.response?.data?.detail || e?.message || "Could not start the payment. Please try again.";
      setError(detail); setSubmittingKind(null);
    }
  };

  const submitForm = async () => {
    setFormSaving(true);
    try {
      const { data: res } = await axios.post(`${API_BASE}/payments/${token}/traveler-info`, form);
      setFormSavedAt(res.submitted_at);
      // Close the modal — the client can still edit later via the inline
      // section or the "Update my details" button.
      setShowInfoDialog(false);
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not save your details. Please try again.");
    } finally { setFormSaving(false); }
  };

  const showInitialBanner = useMemo(
    () => successKind || cancelled || apiError,
    [successKind, cancelled, apiError]
  );
  const firstName = useMemo(() => {
    const t = (data?.main_traveler || "").trim();
    return t ? t.split(/\s+/)[0] : "there";
  }, [data]);
  const hasDepositOption = useMemo(
    () => (data?.options || []).some((o) => o.kind === "deposit"),
    [data]
  );
  const depositAmount = useMemo(
    () => Math.round((data?.total_eur || 0) * 0.30 * 100) / 100,
    [data]
  );

  if (loading) {
    return (
      <Shell token={token}>
        <div className="text-center py-24 inline-flex items-center gap-2 justify-center w-full text-espiritu-deep/70 font-raleway">
          <Loader2 size={16} className="animate-spin" /> Loading your trip…
        </div>
      </Shell>
    );
  }

  if (error && !data) {
    return (
      <Shell token={token}>
        <div className="border border-espiritu-magenta/30 bg-white px-6 py-8 text-espiritu-deep" data-testid="payment-error">
          <div className="font-kanit font-bold text-2xl mb-2 inline-flex items-center gap-2"><AlertCircle size={20} className="text-espiritu-magenta"/> Link unavailable</div>
          <div className="font-raleway">{error}</div>
          <div className="text-sm mt-4 text-espiritu-deep/70 font-raleway">
            Please get in touch with your travel specialist at Espíritu Travel if you think this is a mistake.
          </div>
        </div>
      </Shell>
    );
  }

  const options = data?.options || [];
  const fullyPaid = data?.fully_paid;
  const total = data?.total_eur || 0;
  const paid = data?.paid_eur || 0;
  const remaining = data?.remaining_eur || 0;

  // Form helpers
  const setPerson = (idx, field, value) => {
    setForm((f) => ({
      ...f,
      people: f.people.map((p, i) => (i === idx ? { ...p, [field]: value } : p)),
    }));
    setFormSavedAt(null);
  };
  const addPerson = () =>
    setForm((f) => (f.people.length >= 10 ? f : { ...f, people: [...f.people, emptyPerson()] }));
  const removePerson = (idx) =>
    setForm((f) => (f.people.length <= 1 ? f : { ...f, people: f.people.filter((_, i) => i !== idx) }));
  const setField = (field, value) => {
    setForm((f) => ({ ...f, [field]: value }));
    setFormSavedAt(null);
  };

  return (
    <Shell token={token}>
      {/* Return-from-PayPal banners */}
      {showInitialBanner && (
        <div className="mb-10">
          {successKind && (
            <PostPaymentBanner
              amount={successAmount ? parseFloat(successAmount) : null}
              kindLabel={KIND_DESCRIPTOR[successKind]?.tag.toLowerCase()}
              bookingSecured={!!data?.booking_secured}
              depositThreshold={data?.deposit_threshold_eur || 0}
              depositPaid={data?.paid_eur || 0}
              // Share-with-next-traveler is only offered when we're clearly
              // in a split flow (ledger has an "X of N" label AND there's
              // still remaining balance).
              showShare={
                remaining > 0.5 &&
                (data?.captured_payments || []).some((p) => /\d+\s*of\s*\d+/i.test(p?.share_label || ""))
              }
              token={token}
              tripName={data?.trip_name}
              captured={data?.captured_payments || []}
              total={data?.total_eur || 0}
              remaining={remaining}
            />
          )}
          {cancelled && !successKind && (
            <div className="border-l-4 border-espiritu-terra bg-white px-5 py-4 font-raleway text-espiritu-deep/80 text-sm"
                 data-testid="paypal-cancelled-banner">
              You closed the PayPal checkout — no charge was made. You can try again below whenever you&apos;re ready.
            </div>
          )}
          {apiError && !successKind && (
            <div className="border-l-4 border-espiritu-magenta bg-white px-5 py-4 text-espiritu-deep" data-testid="paypal-error-banner">
              <div className="font-kanit font-bold mb-1 inline-flex items-center gap-2"><AlertCircle size={16}/> Payment couldn&apos;t be completed</div>
              <div className="font-raleway text-sm">{decodeURIComponent(apiError)}</div>
            </div>
          )}
        </div>
      )}

      {/* HERO */}
      <section className="mb-14">
        <div className="kicker mb-4">Trip confirmation</div>
        <h1 className="font-serif text-espiritu-deep leading-[1.02] text-5xl sm:text-6xl lg:text-7xl"
            data-testid="trip-name">
          Hi {firstName},<br/>
          <span className="italic text-espiritu-terra">your trip is ready</span>
        </h1>
        {data?.trip_name && (
          <div className="mt-6 font-raleway text-espiritu-deep/70 text-lg">
            {data.trip_name}
          </div>
        )}
      </section>

      {/* Welcome paragraph */}
      <Prose>
        {paid > 0 ? (
          <p>
            You&apos;ve already paid <strong>{fmtEUR(paid)}</strong> towards this trip — thank you!
            The remaining <strong>{fmtEUR(remaining)}</strong> can be settled in one go, in
            smaller instalments, or at the suggested monthly pace below. Whenever you&apos;d like
            to pay the next instalment, just come back to this same link.
          </p>
        ) : (
          <p>
            Here&apos;s the info regarding the next steps &amp; payment to fully confirm your trip.
            On this page, you can see the invoice for the total of your trip. You can pay with a
            credit/debit card using the PayPal platform (<em>you do not need a PayPal account to do so</em>), and{" "}
            {hasDepositOption ? (
              <>as we are <strong>+60 days before your arrival</strong>, you can pay just the deposit amount
                (<strong>30% = {fmtEUR(depositAmount)}</strong> of the total {fmtEUR(total)}).</>
            ) : (
              <>the full amount of <strong>{fmtEUR(total)}</strong> is required to confirm the trip
                (we are within 60 days of departure).</>
            )}
          </p>
        )}
      </Prose>

      {/* Trip details strip */}
      <section className="mt-12 mb-2">
        <SectionTitle icon={<MapPin size={14}/>}>Your trip at a glance</SectionTitle>
        <div className="grid grid-cols-2 sm:grid-cols-4 bg-white border border-espiritu-sand-deep">
          <Meta icon={<Plane size={14}/>}   label="Departure" value={fmtDate(data?.start_date) || "—"} testid="trip-start"/>
          <Meta icon={<Plane size={14}/>}   label="Return"    value={fmtDate(data?.end_date) || "—"} testid="trip-end"/>
          <Meta icon={<Sun size={14}/>}     label="Duration"  value={data?.duration_days ? `${data.duration_days} days` : "—"} testid="trip-duration"/>
          <Meta icon={<Users size={14}/>}   label="Travelers" value={data?.num_travelers || "—"} testid="trip-travelers"/>
        </div>
      </section>

      {/* Invoice totals */}
      <section className="mt-10">
        <SectionTitle icon={<FileText size={14}/>}>Invoice summary</SectionTitle>
        <div className="grid grid-cols-3 bg-white border border-espiritu-sand-deep">
          <Total label="Total" value={fmtEUR(total)} testid="total-eur"/>
          <Total label="Already paid" value={fmtEUR(paid)} accent="olive" testid="paid-eur"/>
          <Total label="Remaining" value={fmtEUR(remaining)} accent="terra" testid="remaining-eur"/>
        </div>
        {/* Booking-secured progress bar. The trip is only considered
            reserved (booking confirmed) once the cumulative captured
            payments reach the 30% deposit threshold — regardless of how
            many travelers are splitting the payment. */}
        {!fullyPaid && (data?.deposit_threshold_eur || 0) > 0 && (
          <BookingProgress
            paid={paid}
            threshold={data.deposit_threshold_eur}
            secured={!!data.booking_secured}
          />
        )}
      </section>

      {/* Split-payment section — always visible when there's remaining
          balance. If enabled, replaces the standard cards with per-share
          cards each carrying the payer's name so the invoice can be
          reconciled traveler-by-traveler. */}
      {!fullyPaid && (options.length > 0) && (
        <section className="mt-12">
          <SectionTitle icon={<Users size={14}/>}>Splitting with fellow travelers?</SectionTitle>
          <div className="bg-white border border-espiritu-sand-deep px-5 py-5">
            <label className="inline-flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={split.enabled}
                onChange={(e) => setSplit({ ...split, enabled: e.target.checked })}
                data-testid="toggle-split"
                className="w-4 h-4 accent-espiritu-terra"
              />
              <span className="font-raleway text-sm text-espiritu-deep">
                Yes — several of us will each pay our own share (single invoice, one link).
              </span>
            </label>
            {split.enabled && (
              <div className="mt-4 grid gap-3 sm:grid-cols-[auto_1fr] items-end">
                <Field label="Number of travelers paying">
                  <input
                    type="number" min={2} max={20}
                    value={split.count}
                    onChange={(e) => setSplit({ ...split, count: Math.max(2, Math.min(20, parseInt(e.target.value || 2))) })}
                    data-testid="split-count"
                    className="brand-input tabular w-24 text-center"
                  />
                </Field>
                <div className="font-raleway text-xs text-espiritu-deep/70 leading-relaxed">
                  Everyone pays into the same invoice. Each traveler enters their name below,
                  picks their share, and pays with credit/debit card via PayPal.
                  <br/>You&apos;ll see who has paid what as it happens.
                </div>
              </div>
            )}
          </div>

          {/* Captured-so-far ledger — visible only in split mode, once at
              least one share has been paid. */}
          {split.enabled && (data?.captured_payments || []).length > 0 && (
            <div className="mt-4 bg-white border border-espiritu-sand-deep">
              <div className="px-5 py-3 border-b border-espiritu-sand-deep kicker inline-flex items-center gap-2">
                <CheckCircle2 size={12} className="text-espiritu-olive normal-case"/> Paid so far
              </div>
              <div className="divide-y divide-espiritu-sand-deep">
                {(data.captured_payments || []).map((p, i) => (
                  <div key={i} className="px-5 py-2.5 flex items-center justify-between text-sm"
                       data-testid={`captured-payment-${i}`}>
                    <div className="font-raleway text-espiritu-deep">
                      {p.payer_name || <em className="text-espiritu-deep/50">Anonymous</em>}
                      {p.share_label && <span className="text-espiritu-deep/60 ml-2">· {p.share_label}</span>}
                    </div>
                    <div className="font-serif tabular text-espiritu-olive text-lg">
                      {fmtEUR(p.amount_eur)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Payment cards */}
      <section className="mt-12">
        <SectionTitle icon={<CreditCard size={14}/>}>Choose how to pay</SectionTitle>
        {fullyPaid && (
          <div className="border-l-4 border-espiritu-olive bg-white px-5 py-5 font-kanit font-bold text-espiritu-deep inline-flex items-center gap-3 w-full"
               data-testid="fully-paid-banner">
            <CheckCircle2 size={22} className="text-espiritu-olive"/> This trip is fully paid — thank you!
          </div>
        )}
        {!fullyPaid && options.length === 0 && (
          <div className="bg-white border border-espiritu-sand-deep px-5 py-5 font-raleway text-espiritu-deep/70 text-sm" data-testid="no-options">
            No payment options are available right now. Please get in touch with your travel specialist.
          </div>
        )}
        {!fullyPaid && options.length > 0 && (
          <div>
            {split.enabled && (
              <div className="bg-white border border-espiritu-sand-deep px-5 py-5 mb-5 grid gap-3 md:grid-cols-2">
                <Field label="Your full name (for this share)">
                  <input
                    value={payerName}
                    onChange={(e) => setPayerName(e.target.value)}
                    data-testid="payer-name"
                    className="brand-input"
                    placeholder="e.g. Alice Rodriguez"
                  />
                </Field>
                <Field label="Your email (optional, receipt)">
                  <input
                    value={payerEmail}
                    onChange={(e) => setPayerEmail(e.target.value)}
                    data-testid="payer-email"
                    type="email"
                    className="brand-input"
                    placeholder="alice@example.com"
                  />
                </Field>
              </div>
            )}
          <div className={`grid gap-5 ${options.length > 1 ? "sm:grid-cols-2" : ""}`}>
            {options.map((o) => {
              // Auto-increment share position based on how many split
              // shares have already been captured under this same
              // invoice — so Ana=1of3, Beatriz=2of3, Carla=3of3.
              const alreadySplit = (data?.captured_payments || []).filter(
                (p) => /\d+\s*of\s*\d+/i.test(p?.share_label || "")
              ).length;
              const sharePos = Math.min(alreadySplit + 1, split.count);
              const shareMeta = split.enabled ? {
                payer_name: payerName || undefined,
                payer_email: payerEmail || undefined,
                share_label: `${sharePos} of ${split.count}`,
              } : {};
              // Per-share amount in split mode. Two phases apply:
              //  (1) Deposit phase (booking NOT secured yet):
              //      • complete_deposit → gap ÷ remaining payers
              //      • balance / full   → total ÷ N (traveler pays their
              //        WHOLE share of the trip in one go — deposit + final
              //        balance combined). Uses total so paid-so-far by
              //        other travelers doesn't shrink this payer's share.
              //  (2) Balance phase (booking secured, deposit already met):
              //      • balance / full   → (total - deposit) ÷ N (each
              //        traveler pays their share of just the final balance
              //        that remains after the deposit).
              // We derive the phase from `booking_secured` returned by the
              // backend so the split maths stays a pure function of the
              // ledger.
              const remainingPayers = Math.max(1, split.count - alreadySplit);
              const bookingSecured = !!data?.booking_secured;
              const depositThreshold = data?.deposit_threshold_eur || 0;
              const finalPhaseShareTotal = bookingSecured
                ? Math.round(((total - depositThreshold) / split.count) * 100) / 100
                : Math.round((total / split.count) * 100) / 100;
              const perShare = split.enabled && o.amount_eur
                ? (o.kind === "complete_deposit"
                    ? Math.round((o.amount_eur / remainingPayers) * 100) / 100
                    : (o.kind === "balance" || o.kind === "full")
                      ? finalPhaseShareTotal
                      : Math.round((o.amount_eur / split.count) * 100) / 100)
                : null;
              if (o.kind === "partial") {
                return (
                  <PartialPaymentCard
                    key="partial"
                    bounds={data?.partial_bounds}
                    monthly={data?.monthly_suggested_eur}
                    remaining={remaining}
                    total={total}
                    depositGap={
                      (!data?.booking_secured && data?.deposit_threshold_eur)
                        ? Math.max(0, data.deposit_threshold_eur - paid)
                        : 0
                    }
                    bookingSecured={!!data?.booking_secured}
                    depositThreshold={data?.deposit_threshold_eur || 0}
                    amount={partialAmount}
                    onAmountChange={setPartialAmount}
                    onPay={(amt) => onPay("partial", amt, shareMeta)}
                    isSubmitting={submittingKind === "partial"}
                    submitDisabled={submittingKind !== null || !tosAccepted || (split.enabled && !payerName.trim())}
                    splitCount={split.enabled ? split.count : 0}
                    remainingPayers={split.enabled ? Math.max(1, split.count - alreadySplit) : 0}
                  />
                );
              }
              const d = KIND_DESCRIPTOR[o.kind] || { tag: o.kind, pct: "", helper: o.description };
              return (
                <div key={o.kind}
                     data-testid={`payment-option-${o.kind}`}
                     className={`p-7 flex flex-col ${d.highlight ? "bg-espiritu-sand-deep/40 border-2 border-espiritu-olive" : "bg-white border border-espiritu-sand-deep"}`}>
                  <div className="flex items-baseline justify-between">
                    <div className="kicker">{d.tag}</div>
                    {d.pct && (
                      <div className="font-serif italic text-espiritu-terra text-2xl leading-none">{d.pct}</div>
                    )}
                  </div>
                  {split.enabled && perShare ? (
                    <>
                      <div className="font-serif tabular text-5xl mt-3 text-espiritu-deep">
                        {fmtEUR(perShare)}
                      </div>
                      <div className="mt-1.5 font-raleway text-[11px] text-espiritu-deep/60">
                        {o.kind === "complete_deposit" ? (
                          <>Your share ({sharePos} of {split.count}) · Deposit gap {fmtEUR(o.amount_eur)}</>
                        ) : (o.kind === "balance" || o.kind === "full") ? (
                          bookingSecured ? (
                            <>Your share of the final balance ({sharePos} of {split.count}) · Deposit already paid</>
                          ) : (
                            <>Your full share of the trip ({sharePos} of {split.count}) · Total {fmtEUR(total)}</>
                          )
                        ) : (
                          <>Your share ({sharePos} of {split.count}) · Full amount {fmtEUR(o.amount_eur)}</>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="font-serif tabular text-5xl mt-3 text-espiritu-deep">{fmtEUR(o.amount_eur)}</div>
                  )}
                  <div className="font-raleway text-sm text-espiritu-deep/70 mt-3 flex-1 leading-relaxed">
                    {d.helper}
                    {split.enabled && (
                      (o.kind === "balance" || o.kind === "full") ? (
                        bookingSecured ? (
                          <> Deposit is already covered. Each of the {split.count} travelers now pays
                            their share of the final balance ({fmtEUR(total - (data?.deposit_threshold_eur || 0))} in total).</>
                        ) : (
                          <> This is one traveler&apos;s <em>full</em> portion of the trip (deposit + final balance combined).
                            Each of the {split.count} travelers pays this once.</>
                        )
                      ) : (
                        <> Each of the {split.count} travelers pays this amount separately.</>
                      )
                    )}
                  </div>
                  <button
                    onClick={() => {
                      if (split.enabled) {
                        // Emit a partial for the per-share amount so multiple
                        // travelers can each pay ~ (total × ratio) / N.
                        onPay("partial", perShare, shareMeta);
                      } else {
                        onPay(o.kind, undefined, shareMeta);
                      }
                    }}
                    disabled={submittingKind !== null || !tosAccepted || (split.enabled && !payerName.trim())}
                    data-testid={`pay-btn-${o.kind}`}
                    className="mt-6 inline-flex items-center justify-center gap-2 bg-espiritu-deep hover:bg-black disabled:opacity-60 disabled:cursor-not-allowed text-white px-5 py-3.5 rounded-full text-sm font-medium transition-colors">
                    {submittingKind === o.kind || (split.enabled && submittingKind === "partial") ? (
                      <><Loader2 size={14} className="animate-spin"/> Redirecting to PayPal…</>
                    ) : (
                      <><CreditCard size={14}/> Pay {fmtEUR(split.enabled && perShare ? perShare : o.amount_eur)}</>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
          {split.enabled && !payerName.trim() && (
            <div className="mt-3 font-raleway text-xs text-espiritu-magenta"
                 data-testid="payer-name-required">
              Enter your full name above so we can log your share.
            </div>
          )}
          <TermsAcceptance accepted={tosAccepted} onChange={handleTosChange}/>
          {!tosAccepted && (
            <div className="mt-2 font-raleway text-xs text-espiritu-deep/60 flex items-center gap-1"
                 data-testid="tos-required-hint">
              <AlertCircle size={12} className="text-espiritu-magenta"/> Please accept the Terms & Conditions to continue.
            </div>
          )}
          </div>
        )}

        <div className="mt-5 font-raleway text-xs text-espiritu-deep/60 inline-flex items-center gap-2">
          <ShieldCheck size={14}/> Secure checkout via PayPal — credit/debit cards accepted, no PayPal account required.
        </div>

        {error && data && (
          <div className="mt-5 border-l-4 border-espiritu-magenta bg-white px-4 py-3 text-sm font-raleway text-espiritu-deep" data-testid="payment-inline-error">
            {error}
          </div>
        )}
      </section>

      {/* What happens next */}
      <section className="mt-16">
        <SectionTitle icon={<Sun size={14}/>}>What happens next</SectionTitle>
        <Prose>
          <p>
            Once the booking is confirmed, our Operations Team will start booking all your services.
            Around <strong>15 days before your arrival</strong> you will receive your travel documents
            with all the detailed information about your trip — exact directions, meeting points,
            schedules, guides&apos; contacts — so you have everything you need to follow your trip,
            sent online via a mobile app.
          </p>
          <p>
            These travel documents also include our handpicked suggestions of places to visit and
            restaurants to try for each city you&apos;ll be visiting.
          </p>
        </Prose>
      </section>

      {/* Traveler info form — inline. Visible only AFTER the client has
          submitted at least once, so they can edit any field. Before the
          first submission the popup carries the workflow (single source
          of truth, avoids duplicate DOM elements). */}
      <section className="mt-16 mb-10">
        <SectionTitle icon={<FileText size={14}/>}>Your booking details</SectionTitle>
        {formSavedAt ? (
          <>
            <Prose>
              <p>
                Your details are saved. You can update any field below and hit
                <em> Send my details</em> again — the last submission wins.
              </p>
            </Prose>
            <TravelerInfoFormBody
              form={form}
              setPerson={setPerson}
              addPerson={addPerson}
              removePerson={removePerson}
              setField={setField}
              formSaving={formSaving}
              formSavedAt={formSavedAt}
              submitForm={submitForm}
            />
          </>
        ) : (
          <Prose>
            <p>
              To confirm your services we&apos;ll need the following information from each traveler.
              You can save partial info now and complete it later from the same link.
            </p>
            <p>
              <button
                onClick={() => setShowInfoDialog(true)}
                data-testid="open-info-dialog"
                className="inline-flex items-center gap-2 bg-espiritu-terra hover:bg-espiritu-terra-hover text-white px-4 py-2.5 font-kanit font-bold tracking-wider uppercase text-xs">
                <Edit3 size={13}/> Complete my details
              </button>
            </p>
          </Prose>
        )}

        <div className="mt-7 font-kanit italic text-espiritu-deep/80 text-lg">
          Let me know if you have any questions :)
        </div>
      </section>

      {/* Traveler info modal — auto-opens when the client hasn't submitted
          yet (including right after a successful payment). Not dismissable
          by backdrop click; the client can close via the X but the popup
          will re-open on their next visit until submitted. */}
      {showInfoDialog && (
        <TravelerInfoDialog
          onClose={() => setShowInfoDialog(false)}
          form={form}
          setPerson={setPerson}
          addPerson={addPerson}
          removePerson={removePerson}
          setField={setField}
          formSaving={formSaving}
          formSavedAt={formSavedAt}
          submitForm={submitForm}
        />
      )}
    </Shell>
  );
}

/* -- Brand layout primitives ----------------------------------------------- */

function Shell({ children, token }) {
  return (
    <div className="min-h-screen bg-espiritu-sand text-espiritu-deep">
      <style>{`
        .brand-input {
          width: 100%;
          background: #ffffff;
          border: 1px solid #ead9b8;
          color: #121b28;
          font-family: Raleway, system-ui, sans-serif;
          font-size: 14px;
          padding: 10px 12px;
          outline: none;
          transition: border-color 120ms ease;
        }
        .brand-input:focus { border-color: #e37e5e; }
        .brand-input::placeholder { color: #121b2870; }
        .kicker {
          font-family: Raleway, system-ui, sans-serif;
          font-size: 10px;
          letter-spacing: 0.25em;
          text-transform: uppercase;
          color: #B08749;
        }
      `}</style>
      <header className="border-b border-espiritu-sand-deep bg-espiritu-sand">
        <div className="max-w-3xl mx-auto px-6 py-5 flex items-center justify-between gap-4">
          <a href={token ? `/trip/${token}` : "#"} className="shrink-0" title="Back to your trip">
            <img
              src="/espiritu/logo-horizontal.png"
              alt="Espíritu Travel"
              className="h-10 sm:h-12 w-auto"
              data-testid="brand-logo"
            />
          </a>
          <div className="flex items-center gap-5">
            {token && (
              <a
                href={`/trip/${token}`}
                data-testid="back-to-trip"
                className="hidden sm:inline-flex items-center gap-1.5 text-espiritu-deep/60 hover:text-espiritu-deep text-xs font-raleway"
              >
                ← Back to your trip
              </a>
            )}
            <div className="font-raleway text-[10px] tracking-[0.25em] uppercase text-espiritu-deep/60 inline-flex items-center gap-1.5">
              <ShieldCheck size={12}/> Secure payment
            </div>
          </div>
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-6 py-12 sm:py-16">{children}</main>
      <footer className="border-t border-espiritu-sand-deep mt-16">
        <div className="max-w-3xl mx-auto px-6 py-6 font-raleway text-[11px] text-espiritu-deep/60 flex flex-wrap items-center justify-between gap-2">
          <div>© Espíritu Travel · All rights reserved</div>
          <div>Need help? Reply to the email you received with this link.</div>
        </div>
      </footer>
    </div>
  );
}

function SectionTitle({ icon, children }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className="text-espiritu-terra">{icon}</div>
      <div className="kicker">{children}</div>
      <div className="flex-1 h-px bg-espiritu-sand-deep" />
    </div>
  );
}

function Prose({ children }) {
  return (
    <div className="font-raleway text-espiritu-deep/85 text-[15px] leading-[1.75] space-y-4 max-w-prose">
      {children}
    </div>
  );
}

function Meta({ icon, label, value, testid }) {
  return (
    <div className="px-5 py-4 border-r border-espiritu-sand-deep last:border-r-0 sm:[&:nth-child(2)]:border-r-0 sm:[&:nth-child(2)]:border-r">
      <div className="kicker inline-flex items-center gap-1.5">
        <span className="text-espiritu-terra normal-case">{icon}</span>{label}
      </div>
      <div className="mt-1.5 font-serif text-espiritu-deep tabular text-xl" data-testid={testid}>{value}</div>
    </div>
  );
}

function Total({ label, value, accent, testid }) {
  const accentCls = accent === "olive" ? "text-espiritu-olive" : accent === "terra" ? "text-espiritu-terra" : "text-espiritu-deep";
  return (
    <div className="px-5 py-5 border-r border-espiritu-sand-deep last:border-r-0">
      <div className="kicker">{label}</div>
      <div className={`font-serif tabular text-3xl mt-1 ${accentCls}`} data-testid={testid}>{value}</div>
    </div>
  );
}

/**
 * Unified post-payment banner — combines "Payment received" and (when
 * we're in a split flow) "Share with the next traveler" into a single
 * elegant card. Sits above the hero, so it's kept tight and
 * scannable rather than dominating the page.
 */
function PostPaymentBanner({
  amount, kindLabel, bookingSecured, depositThreshold, depositPaid,
  showShare, token, tripName, captured, total, remaining,
}) {
  // Derive the next-traveler share amount using the SAME logic as the
  // payment cards, so the WhatsApp / email invite carries the exact
  // figure Beatriz will see when she opens the link.
  const lastLabel = [...captured].reverse().find((p) => /\d+\s*of\s*\d+/i.test(p?.share_label || ""));
  const m = lastLabel ? /(\d+)\s*of\s*(\d+)/i.exec(lastLabel.share_label) : null;
  const totalShares = m ? parseInt(m[2]) : 2;
  const alreadyPaidCount = captured.filter((p) => /\d+\s*of\s*\d+/i.test(p?.share_label || "")).length;
  const remainingPayers = Math.max(1, totalShares - alreadyPaidCount);
  const nextPos = Math.min(totalShares, alreadyPaidCount + 1);
  // Phase-aware share amount:
  //  • If booking not secured yet → next payer completes the deposit gap
  //    (their share of what's missing to reach the threshold).
  //  • If booking secured → each remaining payer covers their share of
  //    the FINAL BALANCE only (total − deposit_threshold) / N.
  const depositGap = Math.max(0, depositThreshold - depositPaid);
  const suggestedShare = bookingSecured
    ? Math.round(((total - depositThreshold) / totalShares) * 100) / 100
    : Math.round((depositGap / remainingPayers) * 100) / 100;
  const myName = captured[captured.length - 1]?.payer_name || "your fellow traveler";
  const publicUrl = `${window.location.origin}/pay/${token}`;

  const [nextEmail, setNextEmail] = useState("");
  const [nextName, setNextName] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [emailError, setEmailError] = useState(null);

  const waText = encodeURIComponent(
    `Hi! I just paid my share of our trip "${tripName || ""}". `
    + `Your share is ${fmtEUR(suggestedShare)}. `
    + `Pay securely with credit/debit card via PayPal (no account needed):\n\n${publicUrl}`
    + (bookingSecured
        ? " Deposit is already covered — this is the final balance."
        : ` So far ${fmtEUR(depositPaid)} paid — booking confirms at ${fmtEUR(depositThreshold)}.`)
  );
  const waHref = `https://wa.me/?text=${waText}`;

  const copy = () => {
    navigator.clipboard.writeText(publicUrl).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
      () => setEmailError("Couldn't copy — long-press the link and copy manually.")
    );
  };

  const sendEmail = async () => {
    if (!nextEmail.trim() || !nextEmail.includes("@")) {
      setEmailError("Enter a valid email."); return;
    }
    setSending(true); setEmailError(null);
    try {
      const { data: res } = await axios.post(
        `${API_BASE}/payments/${token}/invite-share`,
        {
          email: nextEmail.trim(),
          name: nextName.trim() || undefined,
          share_eur: suggestedShare,
          from_name: myName,
        },
      );
      if (res?.ok) setSent(true);
      else setEmailError("Couldn't send — try WhatsApp or copy the link instead.");
    } catch (e) {
      setEmailError(e?.response?.data?.detail || "Couldn't send.");
    } finally { setSending(false); }
  };

  return (
    <div className="border-l-4 border-espiritu-olive bg-white"
         data-testid="paypal-success-banner">
      {/* Compact success header */}
      <div className="flex items-start gap-3 px-5 py-4">
        <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-espiritu-olive"/>
        <div className="flex-1 min-w-0">
          <div className="font-raleway font-semibold text-espiritu-deep text-[15px]">
            {amount ? `${fmtEUR(amount)} received` : "Payment received"}
            {kindLabel && <span className="font-normal text-espiritu-deep/60"> · {kindLabel}</span>}
          </div>
          <div className="mt-1 font-raleway text-[13px] text-espiritu-deep/75 leading-relaxed">
            {bookingSecured
              ? "Booking confirmed — our team will be in touch shortly with the next steps."
              : depositThreshold > 0
                ? <>Booking confirms once {fmtEUR(depositThreshold)} of the deposit is collected. <span className="text-espiritu-terra font-medium">{fmtEUR(depositPaid)} paid so far.</span></>
                : "Our team will be in touch shortly with the next steps."}
          </div>
        </div>
      </div>

      {showShare && suggestedShare > 0 && (
        <div className="border-t border-espiritu-sand-deep px-5 py-4"
             data-testid="share-next-traveler-card">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="min-w-0">
              <div className="kicker inline-flex items-center gap-1.5 mb-1">
                <Users size={11}/>
                {bookingSecured
                  ? <>Next traveler — final-balance share</>
                  : <>Next traveler — deposit share {nextPos} of {totalShares}</>}
              </div>
              <div className="font-raleway text-[13px] text-espiritu-deep/80">
                Their share: <strong className="tabular font-serif text-espiritu-deep text-base">{fmtEUR(suggestedShare)}</strong>
                <span className="text-espiritu-deep/60">
                  {bookingSecured
                    ? " · deposit already paid, they cover the final balance"
                    : " · same secure link, split auto-detected"}
                </span>
              </div>
            </div>
            <div className="inline-flex flex-wrap items-center gap-1.5">
              <a href={waHref} target="_blank" rel="noreferrer"
                 data-testid="share-whatsapp-btn"
                 className="inline-flex items-center gap-1.5 bg-espiritu-olive hover:bg-espiritu-olive/90 text-white px-3 py-1.5 text-[12px] font-medium rounded-full transition-colors">
                <MessageCircle size={12}/> WhatsApp
              </a>
              <button onClick={copy}
                      data-testid="share-copy-btn"
                      className="inline-flex items-center gap-1.5 bg-espiritu-deep hover:bg-black text-white px-3 py-1.5 text-[12px] font-medium rounded-full transition-colors">
                <Copy size={12}/> {copied ? "Copied!" : "Copy link"}
              </button>
              <a href={`mailto:?subject=${encodeURIComponent(`Your share of ${tripName || "our trip"}`)}&body=${waText}`}
                 data-testid="share-mailto-btn"
                 className="inline-flex items-center gap-1.5 border border-espiritu-deep hover:bg-espiritu-sand-deep/40 text-espiritu-deep px-3 py-1.5 text-[12px] font-medium rounded-full transition-colors">
                <MailIcon size={12}/> Mail
              </a>
            </div>
          </div>

          {/* Inline email invite — hidden until the user clicks "or send
              directly" to keep the banner tight. */}
          <details className="mt-3">
            <summary className="cursor-pointer inline-flex items-center gap-1.5 font-raleway text-[11px] text-espiritu-deep/70 hover:text-espiritu-deep list-none select-none">
              <Send size={11}/> Or send it by email directly
            </summary>
            <div className="mt-3">
              {sent ? (
                <div className="text-[13px] text-espiritu-olive font-raleway inline-flex items-center gap-2"
                     data-testid="invite-sent">
                  <CheckCircle2 size={13}/> Email sent to {nextEmail}
                </div>
              ) : (
                <div className="flex flex-wrap items-end gap-2">
                  <input
                    type="email"
                    value={nextEmail}
                    onChange={(e) => setNextEmail(e.target.value)}
                    data-testid="next-payer-email"
                    className="brand-input flex-1 min-w-[220px] py-2 text-[13px]"
                    placeholder="beatriz@example.com"
                  />
                  <input
                    value={nextName}
                    onChange={(e) => setNextName(e.target.value)}
                    data-testid="next-payer-name"
                    className="brand-input w-40 py-2 text-[13px]"
                    placeholder="Beatriz"
                  />
                  <button onClick={sendEmail} disabled={sending}
                          data-testid="send-invite-btn"
                          className="inline-flex items-center gap-1.5 bg-espiritu-deep hover:bg-black text-white disabled:opacity-60 px-3 py-2 text-[12px] font-medium rounded-full transition-colors">
                    {sending ? <><Loader2 size={12} className="animate-spin"/> Sending…</> : <><Send size={12}/> Send</>}
                  </button>
                </div>
              )}
              {emailError && (
                <div className="mt-1.5 text-[11px] text-espiritu-magenta font-raleway" data-testid="invite-error">{emailError}</div>
              )}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="font-raleway text-[10px] uppercase tracking-[0.22em] text-espiritu-deep/60 block mb-1.5">{label}</span>
      {children}
    </label>
  );
}

/**
 * Progress bar tying every share-payment back to the 30% deposit
 * threshold. The booking is only "confirmed / reserved" when cumulative
 * captures cross that line — regardless of how many travelers split the
 * payment. This is the single source of truth surfaced to the client.
 */
function BookingProgress({ paid, threshold, secured }) {
  const pct = Math.min(100, Math.max(0, threshold > 0 ? (paid / threshold) * 100 : 0));
  const gap = Math.max(0, threshold - paid);
  return (
    <div className={`mt-3 border-l-4 ${secured ? "border-espiritu-olive" : "border-espiritu-terra"} bg-white px-5 py-4`}
         data-testid="booking-progress">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-raleway text-sm text-espiritu-deep">
          {secured ? (
            <span className="inline-flex items-center gap-2 text-espiritu-olive font-medium">
              <CheckCircle2 size={14}/> Booking reserved · deposit collected ({fmtEUR(threshold)})
            </span>
          ) : (
            <>
              <strong>Booking reserved when {fmtEUR(threshold)} is collected</strong>
              <span className="text-espiritu-deep/70">
                {" — "}{fmtEUR(gap)} to go
                {paid > 0 && <> · {fmtEUR(paid)} paid so far</>}
              </span>
            </>
          )}
        </div>
        <div className="font-raleway tabular text-[11px] text-espiritu-deep/60">
          {Math.round(pct)}% of deposit
        </div>
      </div>
      <div className="mt-2.5 h-2 bg-espiritu-sand-deep/60 overflow-hidden">
        <div
          className={`h-full transition-all duration-500 ${secured ? "bg-espiritu-olive" : "bg-espiritu-terra"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {!secured && (
        <div className="mt-2 font-raleway text-[11px] text-espiritu-deep/60 leading-relaxed">
          Whether one traveler pays the full deposit or several travelers split it,
          the booking is only confirmed once the {fmtEUR(threshold)} threshold is crossed.
        </div>
      )}
    </div>
  );
}

/** The traveler-info form fields + submit footer, reused both inline and
 *  inside the popup so we never diverge on validation or styling. */
function TravelerInfoFormBody({ form, setPerson, addPerson, removePerson, setField, formSaving, formSavedAt, submitForm, compact = false }) {
  return (
    <div className={`${compact ? "" : "mt-6"} bg-white border border-espiritu-sand-deep`}>
      {/* Travelers list */}
      <div className="px-5 py-4 border-b border-espiritu-sand-deep flex items-center justify-between">
        <div className="font-raleway text-[11px] uppercase tracking-[0.25em] text-espiritu-deep/70 inline-flex items-center gap-2">
          <Users size={13} className="text-espiritu-terra"/> Travelers ({form.people.length})
        </div>
        <button
          onClick={addPerson}
          data-testid="add-traveler"
          type="button"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-espiritu-sand-deep hover:bg-espiritu-sand text-espiritu-deep font-raleway text-xs">
          <Plus size={12}/> Add traveler
        </button>
      </div>

      <div className="divide-y divide-espiritu-sand-deep">
        {form.people.map((p, i) => (
          <div key={i} className="px-5 py-4 grid gap-3 md:grid-cols-[1.5fr_1fr_1fr_auto] items-end"
               data-testid={`traveler-row-${i}`}>
            <Field label={`Traveler ${i + 1} · Full name (as per passport)`}>
              <input value={p.full_name} onChange={(e) => setPerson(i, "full_name", e.target.value)}
                     data-testid={`traveler-name-${i}`}
                     className="brand-input" placeholder="e.g. Amy Jennings"/>
            </Field>
            <Field label="Passport number">
              <input value={p.passport_number} onChange={(e) => setPerson(i, "passport_number", e.target.value)}
                     data-testid={`traveler-passport-${i}`}
                     className="brand-input" placeholder="AB1234567"/>
            </Field>
            <Field label="Date of birth">
              <input type="date" value={p.date_of_birth} onChange={(e) => setPerson(i, "date_of_birth", e.target.value)}
                     data-testid={`traveler-dob-${i}`}
                     className="brand-input tabular"/>
            </Field>
            <div>
              {form.people.length > 1 && (
                <button onClick={() => removePerson(i)}
                        data-testid={`remove-traveler-${i}`}
                        type="button"
                        title="Remove traveler"
                        className="p-2 text-espiritu-deep/60 hover:text-espiritu-magenta">
                  <Trash2 size={15}/>
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Trip-level fields */}
      <div className="px-5 py-4 border-t border-espiritu-sand-deep grid gap-3 md:grid-cols-2">
        <Field label="Arrival flight number">
          <input value={form.arrival_flight} onChange={(e) => setField("arrival_flight", e.target.value)}
                 data-testid="arrival-flight"
                 className="brand-input" placeholder="e.g. IB6234 — landing in Madrid"/>
        </Field>
        <Field label="Departure flight number">
          <input value={form.departure_flight} onChange={(e) => setField("departure_flight", e.target.value)}
                 data-testid="departure-flight"
                 className="brand-input" placeholder="e.g. IB6172 — from Barcelona"/>
        </Field>
        <Field label="Phone number">
          <input value={form.phone} onChange={(e) => setField("phone", e.target.value)}
                 data-testid="phone"
                 className="brand-input" placeholder="+34 600 000 000"/>
        </Field>
        <Field label="Your email (so we can keep in touch)">
          <input value={form.submitted_by_email} onChange={(e) => setField("submitted_by_email", e.target.value)}
                 data-testid="email"
                 type="email" className="brand-input" placeholder="you@example.com"/>
        </Field>
        <div className="md:col-span-2">
          <Field label="Allergies, food restrictions or anything else we should consider">
            <textarea value={form.notes} onChange={(e) => setField("notes", e.target.value)}
                      data-testid="notes" rows={4}
                      className="brand-input resize-y"
                      placeholder="e.g. lactose intolerant, vegetarian, mobility considerations…"/>
          </Field>
        </div>
      </div>

      {/* Submit footer */}
      <div className="px-5 py-4 border-t border-espiritu-sand-deep flex items-center justify-between flex-wrap gap-3">
        <div className="font-raleway text-xs text-espiritu-deep/70">
          {formSavedAt ? (
            <span className="inline-flex items-center gap-1.5 text-espiritu-olive">
              <CheckCircle2 size={13}/> Saved {fmtDate(formSavedAt)} — you can update any field and submit again.
            </span>
          ) : (
            <span>Save your details whenever you&apos;re ready. You can come back later to update them.</span>
          )}
        </div>
        <button
          onClick={submitForm}
          disabled={formSaving}
          data-testid="submit-traveler-info"
          type="button"
          className="inline-flex items-center justify-center gap-2 bg-espiritu-deep hover:bg-black disabled:opacity-60 text-white px-5 py-3 font-kanit font-bold tracking-wider uppercase text-sm">
          {formSaving ? (
            <><Loader2 size={14} className="animate-spin"/> Saving…</>
          ) : (
            <><Send size={14}/> Send my details</>
          )}
        </button>
      </div>
    </div>
  );
}

/** Modal wrapper — bg overlay + centered card, non-dismissable by backdrop
 *  click on purpose (the client can only close via the X button, which
 *  won't prevent it from re-opening on the next visit until they submit). */
function TravelerInfoDialog({ onClose, ...formProps }) {
  // Lock body scroll while the modal is open.
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = original; };
  }, []);
  return (
    <div
      className="fixed inset-0 z-[100] bg-espiritu-deep/70 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto py-6 px-4"
      data-testid="traveler-info-dialog"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-3xl bg-espiritu-sand border-l-4 border-espiritu-terra">
        <button
          onClick={onClose}
          data-testid="close-info-dialog"
          type="button"
          aria-label="Close"
          title="Close — you can complete this later, we'll remind you next time you visit"
          className="sticky top-3 sm:top-4 float-right mr-3 sm:mr-4 z-20 inline-flex items-center gap-1.5 px-3 py-2 bg-espiritu-deep text-white hover:bg-black font-raleway text-xs font-bold uppercase tracking-wider shadow-lg"
        >
          <X size={14}/> Close
        </button>
        <div className="px-6 sm:px-10 pt-8 sm:pt-10 pb-6">
          <div className="font-raleway text-[10px] tracking-[0.3em] uppercase text-espiritu-terra mb-3 inline-flex items-center gap-2">
            <FileText size={12}/> Booking details
          </div>
          <h2 className="font-kanit italic font-extrabold text-espiritu-deep leading-[1.1] text-3xl sm:text-4xl">
            One quick step to finish
          </h2>
          <p className="mt-4 font-raleway text-espiritu-deep/85 text-[15px] leading-relaxed max-w-prose">
            <strong>Completing this information is key to making your trip bookings.</strong>{" "}
            Please fill in the details below so our Operations Team can start reserving your services.
            You can save partial info now and update it later — the last submission is the one we&apos;ll use.
          </p>
        </div>
        <div className="px-6 sm:px-10 pb-6">
          <TravelerInfoFormBody {...formProps} compact />
        </div>
        <div className="px-6 sm:px-10 pb-8 flex items-center justify-center">
          <button
            onClick={onClose}
            data-testid="skip-info-dialog"
            type="button"
            className="font-raleway text-sm text-espiritu-deep/60 hover:text-espiritu-terra underline underline-offset-4">
            Skip for now — I&apos;ll complete this later
          </button>
        </div>
      </div>
    </div>
  );
}

/** Card for custom-amount payments. The client either types an amount or
 *  picks one of the suggested chips. CTA disabled until the amount is
 *  within the bounds returned by the API. */
function PartialPaymentCard({ bounds, monthly, remaining, total, depositGap, bookingSecured, depositThreshold, amount, onAmountChange, onPay, isSubmitting, submitDisabled, splitCount = 0, remainingPayers = 0 }) {
  const min = parseFloat(bounds?.min_eur || 0);
  const max = parseFloat(bounds?.max_eur || remaining || 0);
  const num = parseFloat(amount);
  const valid = !isNaN(num) && num >= min - 0.01 && num <= max + 0.01;

  const chips = [];
  // Split-mode chips are phase-aware:
  //  • Deposit phase: prompt to finish deposit + option to pay full share
  //  • Balance phase (booking secured): prompt to pay share of final balance
  if (splitCount >= 2) {
    if (!bookingSecured && depositGap > 0 && remainingPayers >= 1) {
      const share = Math.round((depositGap / remainingPayers) * 100) / 100;
      if (share >= min - 0.01 && share <= max + 0.01) {
        chips.push({
          label: `Complete deposit · ${fmtEUR(share)}`,
          sublabel: `deposit gap ${fmtEUR(depositGap)} · ${remainingPayers} payer${remainingPayers > 1 ? 's' : ''} left`,
          value: share,
        });
      }
    }
    if (bookingSecured && depositThreshold > 0) {
      const finalTotal = total - depositThreshold;
      const share = Math.round((finalTotal / splitCount) * 100) / 100;
      if (share >= min - 0.01 && share <= max + 0.01) {
        chips.push({
          label: `Final-balance share · ${fmtEUR(share)}`,
          sublabel: `${fmtEUR(finalTotal)} final balance split ${splitCount} ways`,
          value: share,
        });
      }
    } else if (total && total > 0) {
      const share = Math.round((total / splitCount) * 100) / 100;
      if (share >= min - 0.01 && share <= max + 0.01) {
        chips.push({
          label: `My full share · ${fmtEUR(share)}`,
          sublabel: `${fmtEUR(total)} split ${splitCount} ways — covers deposit + balance`,
          value: share,
        });
      }
    }
  }
  if (monthly?.amount_eur) {
    chips.push({
      label: `Monthly · ${fmtEUR(monthly.amount_eur)}`,
      sublabel: monthly.months > 1 ? `${monthly.months} payments until departure` : "one payment before departure",
      value: monthly.amount_eur,
    });
  }
  const halfRemaining = Math.round(remaining * 0.5 * 100) / 100;
  if (halfRemaining >= min - 0.01 && Math.abs(halfRemaining - (monthly?.amount_eur || 0)) > 1) {
    chips.push({
      label: `Half remaining · ${fmtEUR(halfRemaining)}`,
      sublabel: "split what's left into two",
      value: halfRemaining,
    });
  }

  return (
    <div data-testid="payment-option-partial"
         className="bg-white border border-espiritu-sand-deep p-7 flex flex-col">
      <div className="flex items-baseline justify-between">
        <div className="kicker">
          {KIND_DESCRIPTOR.partial.tag}
        </div>
        <div className="font-serif italic text-espiritu-terra text-lg leading-none">
          You choose
        </div>
      </div>

      <div className="mt-3">
        <div className="kicker mb-1.5">
          Amount to pay now
        </div>
        <div className="relative">
          <input
            value={amount}
            onChange={(e) => onAmountChange(e.target.value)}
            inputMode="decimal"
            data-testid="partial-amount-input"
            placeholder={`${min.toFixed(2)} – ${max.toFixed(2)}`}
            className="brand-input font-serif text-4xl tabular pl-3 pr-10"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 font-serif text-2xl text-espiritu-deep/40">€</span>
        </div>
        <div className="mt-1.5 font-raleway text-[11px] text-espiritu-deep/60">
          Between <span className="tabular">{fmtEUR(min)}</span> and <span className="tabular">{fmtEUR(max)}</span>.
        </div>
      </div>

      {chips.length > 0 && (
        <div className="mt-4 grid gap-2">
          {chips.map((c) => (
            <button
              key={c.label}
              onClick={() => onAmountChange(String(c.value))}
              data-testid={`partial-chip-${c.label.split(" ")[0].toLowerCase()}`}
              type="button"
              className="text-left px-3 py-2 border border-espiritu-sand-deep hover:border-espiritu-terra hover:bg-espiritu-sand transition-colors">
              <div className="font-raleway font-semibold text-sm text-espiritu-deep">{c.label}</div>
              <div className="font-raleway text-[11px] text-espiritu-deep/60">{c.sublabel}</div>
            </button>
          ))}
        </div>
      )}

      <div className="font-raleway text-xs text-espiritu-deep/70 mt-4 flex-1 leading-relaxed">
        {KIND_DESCRIPTOR.partial.helper}
      </div>

      <button
        onClick={() => onPay(num)}
        disabled={submitDisabled || !valid}
        data-testid="pay-btn-partial"
        className="mt-5 inline-flex items-center justify-center gap-2 bg-espiritu-deep hover:bg-black disabled:opacity-50 disabled:cursor-not-allowed text-white px-5 py-3.5 rounded-full text-sm font-medium transition-colors">
        {isSubmitting ? (
          <><Loader2 size={14} className="animate-spin"/> Redirecting to PayPal…</>
        ) : (
          <><CreditCard size={14}/> Pay {valid ? fmtEUR(num) : "—"}</>
        )}
      </button>
    </div>
  );
}
