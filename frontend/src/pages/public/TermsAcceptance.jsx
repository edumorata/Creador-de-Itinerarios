import React, { useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";

const FULL_TOS_URL = "https://espiritutravel.com/terms-and-conditions/";

/**
 * Bilingual (mostly English) Terms & Conditions block shown before the
 * PayPal CTA on public payment pages. Renders a collapsed summary of the
 * key clauses that impact the payment (non-refundable deposit, balance
 * due 60 days before arrival, cancellation policy) plus a mandatory
 * acceptance checkbox. The parent decides how to react to `accepted`;
 * this component is 100% presentational + local UI state.
 *
 * The full contractual text lives on espiritutravel.com — we link to it
 * so we don't fork the source of truth.
 */
export function TermsAcceptance({ accepted, onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-6 border border-espiritu-deep/15 bg-white"
         data-testid="tos-block">
      <button type="button"
              onClick={() => setOpen((v) => !v)}
              data-testid="tos-toggle"
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-espiritu-cream/40 transition-colors">
        <div>
          <div className="font-tenor text-espiritu-deep text-sm">Booking Terms & Conditions</div>
          <div className="font-raleway text-[11px] text-espiritu-deep/60 mt-0.5">
            Read the payment, deposit and cancellation policy before continuing.
          </div>
        </div>
        {open ? <ChevronUp size={16} className="text-espiritu-deep/60"/> : <ChevronDown size={16} className="text-espiritu-deep/60"/>}
      </button>

      {open && (
        <div className="border-t border-espiritu-deep/10 px-4 py-4 space-y-4 font-raleway text-[13px] leading-relaxed text-espiritu-deep/85"
             data-testid="tos-content">
          <section>
            <div className="font-tenor text-espiritu-deep uppercase tracking-widest text-[11px] mb-1">
              Proposals & Quotes
            </div>
            <p>
              All quoted prices are estimates and may change until a deposit is received by
              Espíritu Travel. Once a deposit is paid, pricing is confirmed. Unless explicitly
              stated in writing, quoted prices do not include international airfare and city
              taxes.
            </p>
          </section>

          <section>
            <div className="font-tenor text-espiritu-deep uppercase tracking-widest text-[11px] mb-1">
              Booking & Payments
            </div>
            <p>
              A <strong>non-refundable deposit of 30%</strong> of the total trip cost is due
              at the time of booking. The remaining <strong>non-refundable</strong> payment
              must be received <strong>at least 60 days prior to arrival</strong>. Trip
              departures within 60 days require full payment. If final payment is not
              received by the due date, we may cancel the trip and standard cancellation
              terms will apply.
            </p>
          </section>

          <section>
            <div className="font-tenor text-espiritu-deep uppercase tracking-widest text-[11px] mb-1">
              Passport Information (48 h)
            </div>
            <p>
              To confirm flights, train tickets and certain entrance tickets (e.g., Alhambra)
              we require passport details <strong>within 48 hours</strong> of the deposit.
              Delayed submission may result in price increases or missed reservations for
              which Espíritu Travel is not responsible.
            </p>
          </section>

          <section>
            <div className="font-tenor text-espiritu-deep uppercase tracking-widest text-[11px] mb-1">
              Cancellation Policy
            </div>
            <p>
              All deposits are <strong>non-refundable</strong>. Funds paid may be eligible
              for a <strong>travel credit valid for up to one (1) year</strong>, subject to
              third-party supplier policies and the timing of cancellation. Cancellations
              must be requested in writing by email to your assigned advisor.
            </p>
            <ul className="mt-2 pl-5 list-disc space-y-1 text-[12px]">
              <li>In-country changes made more than 72 h in advance: $50 admin fee + supplier costs.</li>
              <li>Changes or cancellations within 72 h: non-refundable.</li>
              <li>Hotel bookings: non-refundable.</li>
            </ul>
          </section>

          <section>
            <div className="font-tenor text-espiritu-deep uppercase tracking-widest text-[11px] mb-1">
              Travel Insurance
            </div>
            <p>
              We strongly recommend purchasing travel insurance to protect against
              cancellation, interruption and medical expenses.
            </p>
          </section>

          <section>
            <div className="font-tenor text-espiritu-deep uppercase tracking-widest text-[11px] mb-1">
              Limitation of Liability
            </div>
            <p>
              Espíritu Travel is not responsible for injury, illness, loss or damage arising
              from independent suppliers or events beyond our control (force majeure).
              Travelers acknowledge the inherent risks of travel.
            </p>
          </section>

          <a href={FULL_TOS_URL} target="_blank" rel="noreferrer"
             data-testid="tos-full-link"
             className="inline-flex items-center gap-1 text-espiritu-magenta hover:underline text-[12px]">
            Read the full Terms & Conditions <ExternalLink size={11}/>
          </a>
        </div>
      )}

      {/* Acceptance checkbox — always visible, always required */}
      <label htmlFor="tos-checkbox"
             className={`flex items-start gap-2 px-4 py-3 border-t border-espiritu-deep/10 cursor-pointer ${disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-espiritu-cream/40"} transition-colors`}>
        <input id="tos-checkbox"
               type="checkbox"
               checked={!!accepted}
               disabled={disabled}
               onChange={(e) => onChange(e.target.checked)}
               data-testid="tos-checkbox"
               className="mt-1 cursor-pointer disabled:cursor-not-allowed"/>
        <span className="font-raleway text-[12.5px] text-espiritu-deep leading-relaxed">
          I have read and accept Espíritu Travel's{" "}
          <a href={FULL_TOS_URL} target="_blank" rel="noreferrer"
             className="text-espiritu-magenta hover:underline"
             onClick={(e) => e.stopPropagation()}>
            Terms and Conditions
          </a>
          , including the non-refundable deposit and cancellation policy.
        </span>
      </label>
    </div>
  );
}

// Export the version string so the parent can send it to the backend.
export const TOS_VERSION = "espiritutravel-tos-v1";
export { FULL_TOS_URL };
