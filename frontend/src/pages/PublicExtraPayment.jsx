import React, { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import axios from "axios";
import {
  CreditCard, ShieldCheck, CheckCircle2, AlertCircle, Loader2,
  MapPin, Sparkles, ArrowRight,
} from "lucide-react";
import { TermsAcceptance, TOS_VERSION } from "./public/TermsAcceptance";

const API_BASE = `${process.env.REACT_APP_BACKEND_URL}/api`;

const fmtEUR = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" }).format(n || 0);

const fmtDate = (iso) => {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return iso; }
};

/**
 * Public payment page for a POST-SALE EXTRA activity. Distinct token/URL
 * from the main trip so the client can settle just this delta without
 * touching the main invoice (which may already be fully paid). Design
 * matches the Fora aesthetic used on /pay/:token.
 */
export default function PublicExtraPayment() {
  const { token } = useParams();
  const [search] = useSearchParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [payerName, setPayerName] = useState("");
  const [payerEmail, setPayerEmail] = useState("");
  // Email is REQUIRED so we can send the client a receipt for the extra.
  const emailValid = useMemo(
    () => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((payerEmail || "").trim()),
    [payerEmail]
  );
  const [tosAccepted, setTosAccepted] = useState(() => {
    try { return sessionStorage.getItem("vdv_tos_accepted") === "1"; } catch { return false; }
  });
  const handleTosChange = (v) => {
    setTosAccepted(v);
    try { sessionStorage.setItem("vdv_tos_accepted", v ? "1" : "0"); } catch { /* ignore */ }
  };

  const successAmount = search.get("success") ? search.get("amount") : null;
  const cancelled = search.get("cancelled");
  const apiError = search.get("error");

  useEffect(() => {
    (async () => {
      setLoading(true); setError(null);
      try {
        const { data: d } = await axios.get(`${API_BASE}/payments/extra/${token}`);
        setData(d);
      } catch (e) {
        setError(e?.response?.data?.detail || "We couldn't load this extra. It may have expired.");
      } finally { setLoading(false); }
    })();
  }, [token]);

  const onPay = async () => {
    if (!tosAccepted) {
      setError("Please accept the Terms & Conditions to proceed.");
      return;
    }
    if (!emailValid) {
      setError("Please enter a valid email — we'll send your receipt there.");
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        origin: window.location.origin,
        tos_accepted: true,
        tos_version: TOS_VERSION,
      };
      if (payerName.trim()) body.payer_name = payerName.trim();
      if (payerEmail.trim()) body.payer_email = payerEmail.trim();
      const { data: res } = await axios.post(`${API_BASE}/payments/extra/${token}/create-order`, body);
      if (res?.approval_url) { window.location.href = res.approval_url; return; }
      throw new Error("PayPal didn't return an approval URL");
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not start the payment. Please try again.");
      setSubmitting(false);
    }
  };

  if (loading) {
    return <Shell><div className="text-center py-24 inline-flex items-center gap-2 justify-center w-full text-espiritu-deep/70 font-raleway">
      <Loader2 size={16} className="animate-spin"/> Loading extra…
    </div></Shell>;
  }
  if (error && !data) {
    return <Shell><div className="border border-espiritu-magenta/30 bg-white px-6 py-8 text-espiritu-deep"
                        data-testid="extra-error">
      <div className="font-kanit font-bold text-2xl mb-2 inline-flex items-center gap-2">
        <AlertCircle size={20} className="text-espiritu-magenta"/> Extra unavailable
      </div>
      <div className="font-raleway">{error}</div>
    </div></Shell>;
  }
  const isPaid = data?.status === "paid" || !!successAmount;
  const cancelledExtra = data?.status === "cancelled";

  return (
    <Shell>
      {successAmount && (
        <div className="mb-10 border-l-4 border-espiritu-olive bg-white px-5 py-5 flex items-start gap-3"
             data-testid="extra-success-banner">
          <CheckCircle2 size={22} className="mt-0.5 shrink-0 text-espiritu-olive"/>
          <div>
            <div className="font-kanit font-bold text-xl text-espiritu-deep">Payment received — thank you!</div>
            <div className="text-sm mt-2 font-raleway text-espiritu-deep/80 leading-relaxed">
              We&apos;ve captured {fmtEUR(parseFloat(successAmount))} for &ldquo;{data?.title}&rdquo;.
              Our team will confirm the booking shortly.
            </div>
          </div>
        </div>
      )}
      {cancelled && !successAmount && (
        <div className="mb-10 border-l-4 border-espiritu-terra bg-white px-5 py-4 font-raleway text-espiritu-deep/80 text-sm"
             data-testid="extra-cancelled-banner">
          You closed the PayPal checkout — no charge was made. You can try again below.
        </div>
      )}
      {apiError && !successAmount && (
        <div className="mb-10 border-l-4 border-espiritu-magenta bg-white px-5 py-4 text-espiritu-deep"
             data-testid="extra-error-banner">
          <div className="font-kanit font-bold mb-1 inline-flex items-center gap-2"><AlertCircle size={16}/> Payment couldn&apos;t be completed</div>
          <div className="font-raleway text-sm">{decodeURIComponent(apiError)}</div>
        </div>
      )}

      <section className="mb-10">
        <div className="kicker mb-3 inline-flex items-center gap-2"><Sparkles size={12}/> Add-on to your trip</div>
        <h1 className="font-serif text-espiritu-deep leading-[1.02] text-4xl sm:text-5xl" data-testid="extra-title">
          {data?.title}
        </h1>
        {data?.trip_name && (
          <div className="mt-4 font-raleway text-espiritu-deep/70 text-sm inline-flex items-center gap-2">
            <MapPin size={13}/> {data.trip_name}
          </div>
        )}
      </section>

      {data?.description && (
        <section className="mb-10 font-raleway text-espiritu-deep/85 text-[15px] leading-[1.75] max-w-prose whitespace-pre-wrap">
          {data.description}
        </section>
      )}

      <section className="mb-10">
        <div className="bg-white border border-espiritu-sand-deep px-6 py-8">
          <div className="kicker">Amount due</div>
          <div className="font-serif tabular text-6xl mt-2 text-espiritu-deep" data-testid="extra-amount">
            {fmtEUR(data?.amount_eur)}
          </div>
          {data?.date && (
            <div className="mt-3 font-raleway text-xs text-espiritu-deep/60">
              Scheduled for {fmtDate(data.date)}
            </div>
          )}
        </div>
      </section>

      {isPaid ? (
        <div className="border-l-4 border-espiritu-olive bg-white px-5 py-5 font-kanit font-bold text-espiritu-deep inline-flex items-center gap-3 w-full"
             data-testid="extra-already-paid">
          <CheckCircle2 size={22} className="text-espiritu-olive"/> This extra is already paid — thank you!
        </div>
      ) : cancelledExtra ? (
        <div className="border-l-4 border-espiritu-magenta bg-white px-5 py-5 font-kanit font-bold text-espiritu-deep inline-flex items-center gap-3 w-full"
             data-testid="extra-cancelled">
          <AlertCircle size={22} className="text-espiritu-magenta"/> This extra was cancelled by your travel specialist.
        </div>
      ) : (
        <section className="mb-8">
          <div className="grid gap-3 md:grid-cols-2 mb-5">
            <Field label="Your name (optional)">
              <input
                value={payerName}
                onChange={(e) => setPayerName(e.target.value)}
                data-testid="extra-payer-name"
                className="brand-input"
                placeholder="e.g. Alice Rodriguez"
              />
            </Field>
            <Field label="Your email (required — for your receipt)">
              <input
                value={payerEmail}
                onChange={(e) => setPayerEmail(e.target.value)}
                type="email"
                required
                data-testid="extra-payer-email"
                className="brand-input"
                placeholder="alice@example.com"
              />
            </Field>
          </div>
          <TermsAcceptance accepted={tosAccepted} onChange={handleTosChange}/>
          <button
            onClick={onPay}
            disabled={submitting || !tosAccepted || !emailValid}
            data-testid="extra-pay-btn"
            className="w-full mt-5 inline-flex items-center justify-center gap-2 bg-espiritu-deep hover:bg-black disabled:opacity-60 disabled:cursor-not-allowed text-white px-5 py-3.5 rounded-full text-sm font-medium transition-colors">
            {submitting ? (
              <><Loader2 size={14} className="animate-spin"/> Redirecting to PayPal…</>
            ) : (
              <><CreditCard size={14}/> Pay {fmtEUR(data?.amount_eur)} <ArrowRight size={14}/></>
            )}
          </button>
          {!tosAccepted && (
            <div className="mt-2 font-raleway text-xs text-espiritu-deep/60 flex items-center gap-1"
                 data-testid="extra-tos-required-hint">
              <AlertCircle size={12} className="text-espiritu-magenta"/> Please accept the Terms & Conditions to continue.
            </div>
          )}
          {!emailValid && (
            <div className="mt-2 font-raleway text-xs text-espiritu-deep/60 flex items-center gap-1"
                 data-testid="extra-email-required-hint">
              <AlertCircle size={12} className="text-espiritu-magenta"/> Please enter your email above — we&apos;ll send your receipt there.
            </div>
          )}
          <div className="mt-4 font-raleway text-xs text-espiritu-deep/60 inline-flex items-center gap-2">
            <ShieldCheck size={14}/> Secure checkout via PayPal — credit/debit cards accepted, no PayPal account required.
          </div>
          {error && (
            <div className="mt-5 border-l-4 border-espiritu-magenta bg-white px-4 py-3 text-sm font-raleway text-espiritu-deep"
                 data-testid="extra-inline-error">
              {error}
            </div>
          )}
        </section>
      )}
    </Shell>
  );
}

function Shell({ children }) {
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
          <img
            src="/espiritu/logo-horizontal.png"
            alt="Espíritu Travel"
            className="h-10 sm:h-12 w-auto"
            data-testid="brand-logo"
          />
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

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="font-raleway text-[10px] uppercase tracking-[0.22em] text-espiritu-deep/60 block mb-1.5">{label}</span>
      {children}
    </label>
  );
}
