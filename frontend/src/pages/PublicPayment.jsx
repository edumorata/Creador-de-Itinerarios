import React, { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import axios from "axios";
import {
  CreditCard, ShieldCheck, Calendar, Users, Sun, CheckCircle2,
  AlertCircle, Loader2, MapPin, Plane, FileText,
} from "lucide-react";

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
  deposit: { tag: "Deposit", pct: "30%", helper: "Confirm your trip today. The remaining 70% is paid 45 days before departure." },
  balance: { tag: "Remaining balance", pct: "70%", helper: "Final payment to complete your booking." },
  full:    { tag: "Full payment", pct: "100%", helper: "Single full payment to confirm your trip." },
};

// What we need from the traveler before we can start booking. Kept in sync
// with `_format_payment_instructions` on the backend.
const INFO_REQUESTED = [
  "Full names (as per passport)",
  "Passport numbers",
  "Dates of birth",
  "Arrival / departure flight numbers",
  "Phone number",
  "Any allergies, food restrictions or important information",
];

// Small inline isotype evoking the brand's bird mark — a friendly geometric
// silhouette in Terracota Cálido. Used in the header next to the wordmark
// since we don't have the official SVG file yet.
function BirdMark({ className = "w-9 h-9", color = "#e37e5e" }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <path
        fill={color}
        d="M48 14c-5 0-9 3-11 7-2-1-5-2-8-2-9 0-16 7-16 16 0 8 6 14 14 15v2c0 1 1 2 2 2h2c1 0 2-1 2-2v-2c10-2 17-10 17-19 0-3-1-6-2-9 2-2 4-4 4-6 0-1-2-2-4-2zm-8 14a3 3 0 110 6 3 3 0 010-6z"
      />
    </svg>
  );
}

export default function PublicPayment() {
  const { token } = useParams();
  const [search] = useSearchParams();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submittingKind, setSubmittingKind] = useState(null);

  const successKind = search.get("success") ? search.get("kind") : null;
  const successAmount = search.get("amount");
  const cancelled = search.get("cancelled");
  const apiError = search.get("error");

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const { data: d } = await axios.get(`${API_BASE}/payments/${token}`);
      setData(d);
    } catch (e) {
      setError(e?.response?.data?.detail || "We couldn't load this payment link. It may have expired.");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [token]);

  const onPay = async (kind) => {
    setSubmittingKind(kind);
    try {
      const { data: res } = await axios.post(`${API_BASE}/payments/${token}/create-order`, { kind });
      if (res?.approval_url) { window.location.href = res.approval_url; return; }
      throw new Error("PayPal didn't return an approval URL");
    } catch (e) {
      const detail = e?.response?.data?.detail || e?.message || "Could not start the payment. Please try again.";
      setError(detail); setSubmittingKind(null);
    }
  };

  const showInitialBanner = useMemo(() => successKind || cancelled || apiError, [successKind, cancelled, apiError]);
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
      <Shell>
        <div className="text-center py-24 inline-flex items-center gap-2 justify-center w-full text-espiritu-deep/70 font-raleway">
          <Loader2 size={16} className="animate-spin" /> Loading your trip…
        </div>
      </Shell>
    );
  }

  if (error && !data) {
    return (
      <Shell>
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

  return (
    <Shell>
      {/* Return-from-PayPal banners */}
      {showInitialBanner && (
        <div className="mb-10">
          {successKind && (
            <div className="border-l-4 border-espiritu-olive bg-white px-5 py-5 flex items-start gap-3"
                 data-testid="paypal-success-banner">
              <CheckCircle2 size={22} className="mt-0.5 shrink-0 text-espiritu-olive" />
              <div>
                <div className="font-kanit font-bold text-xl text-espiritu-deep">Payment received — thank you!</div>
                <div className="text-sm mt-2 font-raleway text-espiritu-deep/80 leading-relaxed">
                  We&apos;ve captured {successAmount ? fmtEUR(parseFloat(successAmount)) : "your payment"}
                  {KIND_DESCRIPTOR[successKind] ? ` (${KIND_DESCRIPTOR[successKind].tag.toLowerCase()})` : ""}.
                  Our team will be in touch shortly with the next steps to finalise your trip.
                </div>
              </div>
            </div>
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

      {/* HERO — personal greeting + trip name */}
      <section className="mb-14">
        <div className="font-raleway text-xs tracking-[0.25em] uppercase text-espiritu-deep/60 mb-3">
          Trip confirmation
        </div>
        <h1 className="font-kanit italic font-extrabold text-espiritu-deep leading-[1.05] text-5xl sm:text-6xl"
            data-testid="trip-name">
          Hi {firstName},<br/>
          <span className="not-italic font-bold text-espiritu-terra">your trip is ready</span>
        </h1>
        {data?.trip_name && (
          <div className="mt-5 font-raleway text-espiritu-deep/80 text-lg">
            <span className="font-medium">{data.trip_name}</span>
          </div>
        )}
      </section>

      {/* Welcome paragraph — verbatim from the agent's email template */}
      <Prose>
        <p>
          Here&apos;s the info regarding the next steps &amp; payment to fully confirm your trip;
          first, you will need to click on the button <strong>&ldquo;Approve Proposal&rdquo;</strong> you
          will see in the top right corner to confirm the latest version of the itinerary with all details.
        </p>
        <p>
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
      </section>

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
          <div className={`grid gap-5 ${options.length > 1 ? "sm:grid-cols-2" : ""}`}>
            {options.map((o) => {
              const d = KIND_DESCRIPTOR[o.kind] || { tag: o.kind, pct: "", helper: o.description };
              return (
                <div key={o.kind}
                     data-testid={`payment-option-${o.kind}`}
                     className="bg-white border border-espiritu-sand-deep p-7 flex flex-col">
                  <div className="flex items-baseline justify-between">
                    <div className="font-raleway text-[11px] tracking-[0.25em] uppercase text-espiritu-deep/60">{d.tag}</div>
                    {d.pct && (
                      <div className="font-kanit italic font-extrabold text-espiritu-terra text-2xl leading-none">{d.pct}</div>
                    )}
                  </div>
                  <div className="font-kanit font-extrabold tabular text-4xl mt-3 text-espiritu-deep">{fmtEUR(o.amount_eur)}</div>
                  <div className="font-raleway text-sm text-espiritu-deep/70 mt-3 flex-1 leading-relaxed">
                    {d.helper}
                  </div>
                  <button
                    onClick={() => onPay(o.kind)}
                    disabled={submittingKind !== null}
                    data-testid={`pay-btn-${o.kind}`}
                    className="mt-6 inline-flex items-center justify-center gap-2 bg-espiritu-terra hover:bg-espiritu-terra-hover disabled:opacity-60 text-white px-5 py-3.5 font-kanit font-bold tracking-wider uppercase text-sm transition-colors">
                    {submittingKind === o.kind ? (
                      <><Loader2 size={14} className="animate-spin"/> Redirecting to PayPal…</>
                    ) : (
                      <><CreditCard size={14}/> Pay {fmtEUR(o.amount_eur)}</>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Secure-checkout trust line */}
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

      {/* Info we need from the traveler */}
      <section className="mt-14">
        <SectionTitle icon={<FileText size={14}/>}>What we&apos;ll need from you</SectionTitle>
        <Prose>
          <p>
            To confirm your services, we&apos;ll need the following information from each traveler so
            we can start booking everything on your itinerary:
          </p>
        </Prose>
        <ul className="mt-5 grid gap-2 sm:grid-cols-2">
          {INFO_REQUESTED.map((line) => (
            <li key={line}
                className="bg-white border border-espiritu-sand-deep px-4 py-3 font-raleway text-sm text-espiritu-deep flex items-start gap-2.5">
              <span className="inline-block w-1.5 h-1.5 mt-2 bg-espiritu-terra shrink-0" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
        <div className="mt-7 font-kanit italic text-espiritu-deep/80 text-lg">
          Let me know if you have any questions :)
        </div>
      </section>
    </Shell>
  );
}

/* -- Brand layout primitives ----------------------------------------------- */

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-espiritu-sand text-espiritu-deep">
      <header className="border-b border-espiritu-sand-deep bg-espiritu-sand">
        <div className="max-w-3xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BirdMark className="w-7 h-7" />
            <div className="leading-none">
              <div className="font-kanit italic font-extrabold text-espiritu-deep text-xl tracking-tight">
                espíritu <span className="font-light not-italic">travel</span>
              </div>
              <div className="font-raleway text-[10px] tracking-[0.3em] uppercase text-espiritu-deep/60 mt-1">
                Feel part of the world
              </div>
            </div>
          </div>
          <div className="font-raleway text-[10px] tracking-[0.25em] uppercase text-espiritu-deep/60 inline-flex items-center gap-1.5">
            <ShieldCheck size={12}/> Secure payment
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
      <div className="font-raleway text-[11px] tracking-[0.3em] uppercase text-espiritu-deep/70">{children}</div>
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
      <div className="font-raleway text-[10px] uppercase tracking-[0.25em] text-espiritu-deep/60 inline-flex items-center gap-1.5">
        <span className="text-espiritu-terra">{icon}</span>{label}
      </div>
      <div className="mt-1.5 font-kanit font-medium text-espiritu-deep tabular" data-testid={testid}>{value}</div>
    </div>
  );
}

function Total({ label, value, accent, testid }) {
  const accentCls = accent === "olive" ? "text-espiritu-olive" : accent === "terra" ? "text-espiritu-terra" : "text-espiritu-deep";
  return (
    <div className="px-5 py-5 border-r border-espiritu-sand-deep last:border-r-0">
      <div className="font-raleway text-[10px] uppercase tracking-[0.25em] text-espiritu-deep/60">{label}</div>
      <div className={`font-kanit font-extrabold tabular text-2xl mt-1 ${accentCls}`} data-testid={testid}>{value}</div>
    </div>
  );
}
