import React, { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import axios from "axios";
import { CreditCard, ShieldCheck, Calendar, Users, MapPin, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

const API_BASE = `${process.env.REACT_APP_BACKEND_URL}/api`;

const fmtEUR = (n) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n || 0);

const fmtDate = (iso) => {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
};

const KIND_DESCRIPTOR = {
  deposit: { tag: "Deposit", helper: "30% to confirm the trip — the balance is paid 45 days before departure." },
  balance: { tag: "Balance", helper: "Remaining amount of the trip." },
  full:    { tag: "Full payment", helper: "Single full payment for the trip." },
};

export default function PublicPayment() {
  const { token } = useParams();
  const [search] = useSearchParams();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submittingKind, setSubmittingKind] = useState(null);

  // Banners from the PayPal return redirect:
  //   /pay/:token?success=1&kind=deposit&amount=1234.56  -> success
  //   /pay/:token?cancelled=1                            -> user closed PayPal
  //   /pay/:token?error=...                              -> backend capture failed
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
      if (res?.approval_url) {
        window.location.href = res.approval_url;
        return;
      }
      throw new Error("PayPal didn't return an approval URL");
    } catch (e) {
      const detail = e?.response?.data?.detail || e?.message || "Could not start the payment. Please try again.";
      setError(detail);
      setSubmittingKind(null);
    }
  };

  const showInitialBanner = useMemo(() => successKind || cancelled || apiError, [successKind, cancelled, apiError]);

  if (loading) {
    return (
      <Page>
        <div className="text-center py-16 text-clay-700 inline-flex items-center gap-2 justify-center w-full">
          <Loader2 size={16} className="animate-spin" /> Loading payment details…
        </div>
      </Page>
    );
  }

  if (error && !data) {
    return (
      <Page>
        <div className="border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-800" data-testid="payment-error">
          <div className="font-semibold mb-1 flex items-center gap-2"><AlertCircle size={16}/> Link unavailable</div>
          <div>{error}</div>
          <div className="text-xs mt-3 text-red-700">
            Please contact your travel specialist at Viajad Verdad if you think this is a mistake.
          </div>
        </div>
      </Page>
    );
  }

  const options = data?.options || [];
  const fullyPaid = data?.fully_paid;
  const total = data?.total_eur || 0;
  const paid = data?.paid_eur || 0;
  const remaining = data?.remaining_eur || 0;

  return (
    <Page>
      {/* Return-from-PayPal banners */}
      {showInitialBanner && (
        <div className="mb-6">
          {successKind && (
            <div className="border border-pine-soft bg-pine-soft/30 text-pine px-4 py-4 flex items-start gap-3"
                 data-testid="paypal-success-banner">
              <CheckCircle2 size={18} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">Payment received — thank you!</div>
                <div className="text-sm mt-1">
                  We&apos;ve captured {successAmount ? fmtEUR(parseFloat(successAmount)) : "your payment"}
                  {KIND_DESCRIPTOR[successKind] ? ` (${KIND_DESCRIPTOR[successKind].tag.toLowerCase()})` : ""}.
                  Our team will be in touch shortly to confirm next steps.
                </div>
              </div>
            </div>
          )}
          {cancelled && !successKind && (
            <div className="border border-amber-200 bg-amber-50 text-amber-900 px-4 py-3 text-sm" data-testid="paypal-cancelled-banner">
              You cancelled the PayPal checkout. No charge was made — you can try again below.
            </div>
          )}
          {apiError && !successKind && (
            <div className="border border-red-200 bg-red-50 text-red-800 px-4 py-3 text-sm" data-testid="paypal-error-banner">
              <div className="font-semibold mb-1 inline-flex items-center gap-2"><AlertCircle size={14}/> Payment couldn&apos;t be completed</div>
              <div>{decodeURIComponent(apiError)}</div>
            </div>
          )}
        </div>
      )}

      {/* Header — trip summary */}
      <div className="border border-clay-300 bg-white">
        <div className="px-6 py-5 border-b border-clay-300">
          <div className="smallcaps text-clay-700">Trip confirmation</div>
          <h1 className="font-serif text-3xl mt-1 leading-tight" data-testid="trip-name">{data?.trip_name || "Your trip"}</h1>
          {data?.main_traveler && (
            <div className="text-clay-700 text-sm mt-1">Booking for <span className="text-clay-900">{data.main_traveler}</span></div>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-0">
          <Meta icon={<Calendar size={14}/>} label="Departure" value={fmtDate(data?.start_date) || "—"} testid="trip-start"/>
          <Meta icon={<Calendar size={14}/>} label="Return"    value={fmtDate(data?.end_date) || "—"} testid="trip-end"/>
          <Meta icon={<MapPin size={14}/>}   label="Duration"  value={data?.duration_days ? `${data.duration_days} days` : "—"} testid="trip-duration"/>
          <Meta icon={<Users size={14}/>}    label="Travelers" value={data?.num_travelers || "—"} testid="trip-travelers"/>
        </div>
      </div>

      {/* Totals */}
      <div className="mt-6 grid grid-cols-3 border border-clay-300 bg-white">
        <Total label="Total" value={fmtEUR(total)} testid="total-eur"/>
        <Total label="Already paid" value={fmtEUR(paid)} accent="pine" testid="paid-eur"/>
        <Total label="Remaining" value={fmtEUR(remaining)} accent="terracotta" testid="remaining-eur"/>
      </div>

      {/* Payment options */}
      <div className="mt-8">
        <div className="smallcaps mb-3">Choose how to pay</div>
        {fullyPaid && (
          <div className="border border-pine-soft bg-pine-soft/30 text-pine px-4 py-4 inline-flex items-center gap-2 w-full"
               data-testid="fully-paid-banner">
            <CheckCircle2 size={16}/> This trip is fully paid. Thank you!
          </div>
        )}
        {!fullyPaid && options.length === 0 && (
          <div className="border border-clay-300 bg-clay-50 text-clay-700 px-4 py-4 text-sm" data-testid="no-options">
            No payment options are available right now. Please contact your travel specialist.
          </div>
        )}
        {!fullyPaid && options.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            {options.map((o) => {
              const d = KIND_DESCRIPTOR[o.kind] || { tag: o.kind, helper: "" };
              return (
                <div key={o.kind}
                     data-testid={`payment-option-${o.kind}`}
                     className="border border-clay-300 bg-white p-5 flex flex-col">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-clay-700">{d.tag}</div>
                  <div className="font-serif text-3xl tabular mt-2">{fmtEUR(o.amount_eur)}</div>
                  <div className="text-xs text-clay-700 mt-2 flex-1">{d.helper || o.description}</div>
                  <button
                    onClick={() => onPay(o.kind)}
                    disabled={submittingKind !== null}
                    data-testid={`pay-btn-${o.kind}`}
                    className="mt-4 inline-flex items-center justify-center gap-2 bg-pine text-white hover:bg-pine-hover disabled:opacity-60 px-4 py-3 text-sm">
                    {submittingKind === o.kind ? (
                      <><Loader2 size={14} className="animate-spin"/> Redirecting to PayPal…</>
                    ) : (
                      <><CreditCard size={14}/> Pay {fmtEUR(o.amount_eur)} with PayPal</>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Trust line */}
      <div className="mt-8 text-xs text-clay-700 inline-flex items-center gap-2">
        <ShieldCheck size={14}/> Secure checkout via PayPal — credit/debit cards accepted, no PayPal account required.
      </div>

      {/* Inline error (if create-order failed but we still have data on screen) */}
      {error && data && (
        <div className="mt-4 border border-red-200 bg-red-50 text-red-800 px-3 py-2 text-sm" data-testid="payment-inline-error">
          {error}
        </div>
      )}
    </Page>
  );
}

function Page({ children }) {
  return (
    <div className="min-h-screen bg-clay-50 text-clay-900">
      <header className="border-b border-clay-300 bg-white">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="font-serif text-xl tracking-tight">Viajad Verdad</div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-clay-700">Secure payment</div>
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-6 py-10">{children}</main>
      <footer className="max-w-3xl mx-auto px-6 py-6 text-[11px] text-clay-700">
        Need help? Reply to the email you received with this link and your travel specialist will get back to you.
      </footer>
    </div>
  );
}

function Meta({ icon, label, value, testid }) {
  return (
    <div className="px-4 py-3 border-r border-clay-300 last:border-r-0 sm:[&:nth-child(2n)]:border-r-0 sm:[&:nth-child(2n)]:sm:border-r">
      <div className="text-[10px] uppercase tracking-[0.2em] text-clay-700 inline-flex items-center gap-1">{icon} {label}</div>
      <div className="mt-1 text-sm tabular" data-testid={testid}>{value}</div>
    </div>
  );
}

function Total({ label, value, accent, testid }) {
  const accentCls = accent === "pine" ? "text-pine" : accent === "terracotta" ? "text-terracotta" : "";
  return (
    <div className="px-4 py-4 border-r border-clay-300 last:border-r-0">
      <div className="text-[10px] uppercase tracking-[0.2em] text-clay-700">{label}</div>
      <div className={`font-serif text-2xl tabular mt-1 ${accentCls}`} data-testid={testid}>{value}</div>
    </div>
  );
}
