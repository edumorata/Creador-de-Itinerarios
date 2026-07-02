import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import axios from "axios";
import {
  Calendar, Users, Moon, Download, Loader2, MapPin, Clock, CheckCircle2, ChevronDown,
} from "lucide-react";

const API_BASE = `${process.env.REACT_APP_BACKEND_URL}/api`;

const fmtEUR = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n || 0);

// "Mon" — three-letter month label used in the sticky day tabs, à la Fora.
const shortDay = (iso) => {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch { return iso; }
};

const longDayName = (iso) => {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { weekday: "long" });
  } catch { return ""; }
};

const longMonthDay = (iso) => {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric" });
  } catch { return iso; }
};

const rangeShort = (a, b) => {
  if (!a || !b) return "";
  try {
    const s = new Date(a).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const e = new Date(b).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return `${s} — ${e}`;
  } catch { return `${a} — ${b}`; }
};

const nightsBetween = (a, b) => {
  if (!a || !b) return null;
  try {
    const ms = new Date(b) - new Date(a);
    return Math.max(0, Math.round(ms / 86400000));
  } catch { return null; }
};

const TYPE_KICKER = {
  transfer:   "TRANSFER",
  actividad:  "EXPERIENCE",
  activity:   "EXPERIENCE",
  vuelo:      "FLIGHT",
  flight:     "FLIGHT",
  alojamiento:"HOTEL",
  restaurante:"DINNER",
  restaurant: "DINNER",
};

export default function TripView() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeDayId, setActiveDayId] = useState(null);

  const dayRefs = useRef({});
  const heroRef = useRef(null);
  const [pastHero, setPastHero] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data: d } = await axios.get(`${API_BASE}/trip/${token}`);
        setData(d);
        if (d.days?.length) setActiveDayId(d.days[0].day_id);
      } catch (e) {
        setError(e?.response?.data?.detail || "This trip link is not available.");
      } finally { setLoading(false); }
    })();
  }, [token]);

  // Track scroll — when we scroll past the hero, the sticky nav gets a
  // solid background. Also compute which day is currently in view.
  useEffect(() => {
    const onScroll = () => {
      const heroH = heroRef.current?.offsetHeight || 0;
      setPastHero(window.scrollY > heroH - 80);
      // Find the day whose section top is closest to the top of the
      // viewport (but not yet scrolled past).
      const dayEntries = Object.entries(dayRefs.current);
      let bestId = null;
      let bestOffset = -Infinity;
      for (const [id, el] of dayEntries) {
        if (!el) continue;
        const top = el.getBoundingClientRect().top - 120;
        if (top <= 0 && top > bestOffset) { bestOffset = top; bestId = id; }
      }
      if (bestId) setActiveDayId(bestId);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, [data]);

  const scrollToDay = (id) => {
    const el = dayRefs.current[id];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const cityLine = useMemo(
    () => (data?.cities || []).slice(0, 3).join(" & "),
    [data]
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center text-ink/70 font-sans">
        <Loader2 size={16} className="animate-spin mr-2"/> Loading your trip…
      </div>
    );
  }
  if (error) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h1 className="font-serif text-3xl text-ink">Trip link unavailable</h1>
          <p className="mt-4 font-sans text-ink/70">{error}</p>
        </div>
      </div>
    );
  }

  const totalNights = nightsBetween(data.start_date, data.end_date);

  return (
    <div className="bg-cream text-ink min-h-screen font-sans">
      <ForaStyles />

      {/* --- Sticky top nav --------------------------------------------- */}
      <nav
        className={`fixed top-0 inset-x-0 z-40 transition-all duration-300 ${
          pastHero ? "bg-cream/95 backdrop-blur-md border-b border-ink/10" : "bg-transparent"
        }`}
        data-testid="trip-nav"
      >
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center gap-6">
          <img
            src="/espiritu/logo-horizontal.png"
            alt="Espíritu Travel"
            className={`h-7 sm:h-8 w-auto transition ${pastHero ? "opacity-100" : "opacity-0 invisible"}`}
          />
          {/* Day tabs */}
          <div className="flex-1 hidden md:flex items-center justify-center gap-5 overflow-x-auto">
            {(data.days || []).map((d) => {
              const isActive = d.day_id === activeDayId;
              return (
                <button
                  key={d.day_id}
                  onClick={() => scrollToDay(d.day_id)}
                  data-testid={`day-tab-${d.day_id}`}
                  className={`whitespace-nowrap text-[13px] font-sans transition ${
                    isActive ? "text-ink font-semibold" : "text-ink/40 hover:text-ink/70"
                  }`}
                >
                  {shortDay(d.date)}
                </button>
              );
            })}
          </div>
          {/* CTA cluster */}
          <div className="flex items-center gap-2 shrink-0">
            <Link
              to={`/pay/${token}`}
              data-testid="reserve-btn"
              className="inline-flex items-center gap-2 bg-ink hover:bg-black text-white px-4 py-2.5 rounded-full text-sm font-sans font-medium transition-colors"
            >
              <CheckCircle2 size={14}/> Reserve · {fmtEUR(data.total_eur)}
            </Link>
            <button
              onClick={() => window.print()}
              data-testid="download-btn"
              className="hidden sm:inline-flex items-center gap-2 text-ink/70 hover:text-ink px-3 py-2.5 text-sm font-sans"
            >
              <Download size={14}/> Download PDF
            </button>
          </div>
        </div>
      </nav>

      {/* --- Hero -------------------------------------------------------- */}
      <header
        ref={heroRef}
        className="relative w-full min-h-[92vh] flex items-end overflow-hidden"
        data-testid="hero"
      >
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url("${data.hero_image}")` }}
        />
        {/* Gradient overlay so text is readable */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/25 via-black/10 to-black/60"/>

        {/* Agent pill top-right */}
        {data.agent?.name && (
          <div className="absolute top-24 right-6 sm:right-10 hidden sm:flex items-center gap-3 bg-white/12 backdrop-blur-md border border-white/20 rounded-full pl-1 pr-5 py-1">
            <div className="w-10 h-10 rounded-full bg-cream overflow-hidden flex items-center justify-center text-ink font-serif text-lg shrink-0">
              {data.agent.avatar_url ? (
                <img src={data.agent.avatar_url} alt={data.agent.name} className="w-full h-full object-cover"/>
              ) : (
                data.agent.name?.[0]?.toUpperCase() || "E"
              )}
            </div>
            <div className="text-white">
              <div className="text-[10px] uppercase tracking-[0.2em] text-white/70">Your travel designer</div>
              <div className="font-sans text-sm">{data.agent.name}</div>
            </div>
          </div>
        )}

        <div className="relative w-full max-w-[1400px] mx-auto px-6 pb-16 pt-32 text-white">
          {cityLine && (
            <div className="inline-flex items-center gap-2 text-white/85 font-sans text-sm mb-6">
              <MapPin size={14}/> {cityLine}
            </div>
          )}
          <h1 className="font-serif text-5xl sm:text-6xl lg:text-7xl leading-[1.02] max-w-4xl" data-testid="trip-title">
            {data.trip_name}
          </h1>
          <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-3 font-sans">
            <span className="inline-flex items-center gap-2 text-white/90 text-[15px]">
              <Calendar size={16}/> {rangeShort(data.start_date, data.end_date)}
            </span>
            {totalNights != null && (
              <span className="inline-flex items-center gap-2 text-white/90 text-[15px]">
                <Moon size={16}/> {totalNights} nights
              </span>
            )}
            {data.num_travelers && (
              <span className="inline-flex items-center gap-2 text-white/90 text-[15px]">
                <Users size={16}/> {data.num_travelers} travellers
              </span>
            )}
          </div>

          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 text-white/60 text-[10px] tracking-[0.3em] uppercase inline-flex flex-col items-center gap-2">
            Scroll to view
            <ChevronDown size={16} className="animate-bounce"/>
          </div>
        </div>
      </header>

      {/* --- Journey intro paragraph ------------------------------------ */}
      {(data.summary || true) && (
        <section className="max-w-3xl mx-auto px-6 py-24 sm:py-32 text-center">
          <div className="kicker mb-8">Your journey ahead</div>
          <p className="font-serif text-2xl sm:text-3xl leading-[1.35] text-ink/85">
            {data.summary ||
              `A hand-crafted journey through ${cityLine || "your chosen destinations"}. Slow mornings, private access, and dinners chosen for their soul rather than their address.`}
          </p>
        </section>
      )}

      {/* --- Days -------------------------------------------------------- */}
      <div className="border-t border-ink/10 max-w-[1400px] mx-auto">
        {(data.days || []).map((d) => (
          <DaySection
            key={d.day_id}
            day={d}
            innerRef={(el) => { dayRefs.current[d.day_id] = el; }}
            accommodations={data.accommodations}
          />
        ))}
      </div>

      {/* --- Footer CTA -------------------------------------------------- */}
      <footer className="border-t border-ink/10 mt-24">
        <div className="max-w-3xl mx-auto px-6 py-20 text-center">
          <div className="kicker mb-4">Ready to make it real?</div>
          <h2 className="font-serif text-4xl sm:text-5xl text-ink">Confirm your trip</h2>
          <p className="font-sans mt-6 text-ink/70 max-w-lg mx-auto">
            Secure your dates today. You can pay a 30% deposit or the full amount — either way,
            we start booking your services as soon as it&apos;s confirmed.
          </p>
          <Link
            to={`/pay/${token}`}
            data-testid="footer-reserve-btn"
            className="inline-flex items-center gap-2 bg-ink hover:bg-black text-white px-6 py-3.5 rounded-full text-sm font-medium mt-10"
          >
            <CheckCircle2 size={14}/> Reserve · {fmtEUR(data.total_eur)}
          </Link>
        </div>
        <div className="border-t border-ink/10">
          <div className="max-w-[1400px] mx-auto px-6 py-5 flex items-center justify-between font-sans text-[11px] text-ink/50">
            <div>© Espíritu Travel · All rights reserved</div>
            <div>Need help? Reach out to {data.agent?.name || "your travel designer"}.</div>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* --- Sub-components ------------------------------------------------- */

function DaySection({ day, innerRef, accommodations }) {
  // Find any accommodation that starts on this day (check-in) — it'll be
  // rendered under the day services as a full "Where you stay" card.
  const checkInAcc = (accommodations || []).find((a) => a.date_from === day.date);
  return (
    <section
      ref={innerRef}
      data-testid={`day-section-${day.day_id}`}
      className="py-16 sm:py-24 border-b border-ink/10 last:border-b-0"
    >
      {/* Day header — narrow left column with day-of-week + big serif date */}
      <div className="max-w-[1200px] mx-auto px-6">
        <div className="max-w-3xl mx-auto md:mx-0 md:ml-[calc(20%_+_1rem)]">
          <div className="kicker mb-2">{longDayName(day.date)}</div>
          <h2 className="font-serif text-5xl sm:text-6xl text-ink">
            {longMonthDay(day.date)}
          </h2>
          {day.city && (
            <div className="mt-3 font-sans text-ink/60 inline-flex items-center gap-2 text-sm">
              <MapPin size={14}/> {day.city}
            </div>
          )}
        </div>
      </div>

      {/* Services */}
      <div className="max-w-[1200px] mx-auto px-6 mt-12 space-y-14">
        {(day.services || []).map((s, i) => (
          <ServiceRow key={s.id || i} service={s} dayImage={i === 0 ? day.image_url : null}/>
        ))}
      </div>

      {/* Check-in card */}
      {checkInAcc && (
        <div className="max-w-[1200px] mx-auto px-6 mt-14">
          <StayCard accommodation={checkInAcc}/>
        </div>
      )}
    </section>
  );
}

function ServiceRow({ service, dayImage }) {
  const kicker = TYPE_KICKER[service.type] || service.type?.toUpperCase() || "EXPERIENCE";
  return (
    <div className="grid md:grid-cols-[20%_1fr] gap-6 md:gap-10 items-start" data-testid="service-row">
      <div>
        <div className="kicker">{kicker}</div>
        {service.time && (
          <div className="font-serif text-2xl text-ink mt-2">{service.time}</div>
        )}
        {service.duration && (
          <div className="font-sans text-ink/60 text-sm mt-1 inline-flex items-center gap-1.5">
            <Clock size={12}/> {service.duration}
          </div>
        )}
      </div>
      <div>
        <h3 className="font-serif text-2xl sm:text-3xl text-ink leading-tight">
          {service.name}
        </h3>
        {(service.meeting_point || service.time) && (
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 font-sans text-[13px] text-ink/70 max-w-lg">
            {service.meeting_point && (
              <div><span className="text-ink/50">Meeting Point:</span> <span className="text-ink">{service.meeting_point}</span></div>
            )}
            {service.time && (
              <div><span className="text-ink/50">Meeting Time:</span> <span className="text-ink">{service.time}</span></div>
            )}
            {service.duration && (
              <div><span className="text-ink/50">Duration:</span> <span className="text-ink">{service.duration}</span></div>
            )}
          </div>
        )}
        {service.description && (
          <p className="mt-5 font-sans text-[15px] text-ink/80 leading-relaxed max-w-2xl">
            {service.description}
          </p>
        )}
        {(service.image_url || dayImage) && (
          <div className="mt-6 aspect-[16/9] overflow-hidden bg-ink/5 max-w-2xl">
            <img
              src={service.image_url || dayImage}
              alt={service.name}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function StayCard({ accommodation: a }) {
  const nights = nightsBetween(a.date_from, a.date_to);
  const images = a.image_urls || [];
  const stayRange = () => {
    if (!a.date_from || !a.date_to) return "";
    try {
      const dt = (iso, opts) => new Date(iso).toLocaleDateString("en-US", opts);
      const s = dt(a.date_from, { weekday: "short", month: "short", day: "numeric" });
      const e = dt(a.date_to, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
      return `${s} — ${e}`;
    } catch { return ""; }
  };
  return (
    <div className="border border-ink/10 bg-white" data-testid="stay-card">
      <div className="px-6 sm:px-10 pt-8 pb-6 flex items-start justify-between gap-6 flex-wrap">
        <div>
          <div className="kicker mb-2">Where you stay</div>
          <h3 className="font-serif text-4xl text-ink">{a.name}</h3>
        </div>
        <div className="text-right font-sans text-sm text-ink/70 pt-2 inline-flex items-center gap-2">
          <Moon size={13}/> {stayRange()}{nights ? ` · ${nights} nights` : ""}
        </div>
      </div>
      {images.length > 0 && (
        <div className="px-6 sm:px-10 grid grid-cols-2 gap-3">
          {images.slice(0, 4).map((u, i) => (
            <div key={i} className="aspect-[4/3] overflow-hidden bg-ink/5">
              <img src={u} alt={a.name} className="w-full h-full object-cover" loading="lazy"/>
            </div>
          ))}
        </div>
      )}
      <div className="px-6 sm:px-10 py-8 grid gap-8 md:grid-cols-2 border-t border-ink/10 mt-8">
        <div>
          {a.address && (
            <div>
              <div className="kicker mb-1.5">Address</div>
              <div className="font-sans text-[14px] text-ink inline-flex items-start gap-1.5">
                <MapPin size={14} className="mt-0.5 shrink-0"/> {a.address}
              </div>
            </div>
          )}
          {a.rooms?.length > 0 && (
            <div className="mt-6">
              <div className="kicker mb-1.5">Your rooms</div>
              <ul className="font-sans text-[14px] text-ink space-y-0.5">
                {a.rooms.map((r, i) => (
                  <li key={i}>{`1 × ${r.type || "Room"}`}{r.size_sqm ? ` — ${r.size_sqm} m²` : ""}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div>
          <div className="kicker mb-1.5">As clients of Espíritu Travel, you enjoy</div>
          <ul className="font-sans text-[14px] text-ink space-y-1.5">
            {["Upgrade on arrival, subject to availability",
              "Daily breakfast for up to two guests per bedroom",
              "Complimentary hotel credit per stay",
              "Early check-in / late check-out, subject to availability"].map((line) => (
              <li key={line} className="inline-flex items-start gap-2">
                <CheckCircle2 size={14} className="text-emerald-700 mt-0.5 shrink-0"/> {line}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/* Shared brand tokens for the Fora aesthetic — kicker labels, cream bg,
   ink text. Isolated to this file so we don't touch the builder's theme. */
function ForaStyles() {
  return (
    <style>{`
      .bg-cream { background-color: #f5f1ea; }
      .text-ink { color: #12100e; }
      .border-ink\\/10 { border-color: rgba(18,16,14,0.10); }
      .border-ink\\/20 { border-color: rgba(18,16,14,0.20); }
      .text-ink\\/40 { color: rgba(18,16,14,0.40); }
      .text-ink\\/50 { color: rgba(18,16,14,0.50); }
      .text-ink\\/60 { color: rgba(18,16,14,0.60); }
      .text-ink\\/70 { color: rgba(18,16,14,0.70); }
      .text-ink\\/80 { color: rgba(18,16,14,0.80); }
      .text-ink\\/85 { color: rgba(18,16,14,0.85); }
      .bg-ink { background-color: #12100e; }
      .kicker {
        font-family: Raleway, system-ui, sans-serif;
        font-size: 10px;
        letter-spacing: 0.25em;
        text-transform: uppercase;
        color: #B08749;
      }
      /* Trip view uses the serif for display, Raleway for body */
      body { font-family: Raleway, Manrope, system-ui, sans-serif; }
      .font-serif { font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 500; }
      .font-sans { font-family: Raleway, system-ui, sans-serif; }
    `}</style>
  );
}
