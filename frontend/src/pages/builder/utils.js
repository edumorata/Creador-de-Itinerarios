// Shared atoms used across the itinerary builder modules.
// Pure constants + tiny helpers, no React, no side effects.

export const TYPE_BADGE = {
  alojamiento: "bg-pine text-white",
  actividad: "bg-terracotta text-white",
  entradas: "bg-[#8C5A2B] text-white",
  transfer: "bg-clay-500 text-white",
  tren: "bg-clay-700 text-white",
  vuelo: "bg-[#3C5A78] text-white",
  rental_car: "bg-[#5C7B3F] text-white",
};
export const TYPES = ["actividad", "entradas", "transfer", "tren", "vuelo", "rental_car"];
// Types that scale with group size — for these, quantity = ceil(num_travelers / pax).
// Rental cars are billed per car (capacity 4-5 pax), so they DON'T scale with
// group size out of the box — agent decides quantity manually.
export const SCALES_WITH_PAX = new Set(["actividad", "entradas", "transfer", "tren", "vuelo"]);
// Visual fallback for any unexpected legacy type strings
export const BADGE_FALLBACK = "bg-clay-400 text-white";

export const ROOM_TYPES = ["single", "doble", "twin", "triple", "cuadruple", "suite", "family", "otro"];
export const ROOM_PAX_DEFAULT = { single: 1, doble: 2, twin: 2, triple: 3, cuadruple: 4, suite: 2, family: 4, otro: 2 };

// Partner labels used by the cost summary + selector.
// `commission_pct` is the partner's cut; `markup_pct` is the agency's own
// margin on top of cost. Travel-agent tiers are pre-negotiated rates.
export const PARTNER_OPTIONS = [
  { value: "kimkim",             label: "KimKim",             hint: "+15% sobre coste · markup 33%",  markup_pct: 33,   commission_pct: 15 },
  { value: "zicasso",            label: "Zicasso",            hint: "10.5% deductivo · markup 30%",   markup_pct: 30,   commission_pct: 10.5 },
  { value: "responsible_travel", label: "Responsible Travel", hint: "7% deductivo · markup 30%",      markup_pct: 30,   commission_pct: 7 },
  { value: "baboo",              label: "Baboo",              hint: "15% deductivo · markup 30%",     markup_pct: 30,   commission_pct: 15 },
  { value: "travel_agent_10",    label: "Travel Agent 10%",   hint: "10% comisión · markup 30%",      markup_pct: 30,   commission_pct: 10 },
  { value: "travel_agent_12",    label: "Travel Agent 12%",   hint: "12% comisión · markup 30%",      markup_pct: 30,   commission_pct: 12 },
  { value: "travel_agent_15",    label: "Travel Agent 15%",   hint: "15% comisión · markup 30%",      markup_pct: 30,   commission_pct: 15 },
  { value: "direct",             label: "Directo",            hint: "sin comisión · markup 35%",      markup_pct: 35,   commission_pct: 0 },
  { value: "other",              label: "Otro",               hint: "manual",                         markup_pct: 30,   commission_pct: 0 },
];
export const PARTNER_LABELS = Object.fromEntries(PARTNER_OPTIONS.map((p) => [p.value, p.label]));
export const PARTNER_DEFAULTS = Object.fromEntries(
  PARTNER_OPTIONS.map((p) => [p.value, { markup_pct: p.markup_pct, commission_pct: p.commission_pct }])
);

// PayPal processing fee — applied on top of the final PVP when toggled on.
export const PAYPAL_FEE_PCT = 3;

export const fmtEUR = (n) => `€${Number(n || 0).toLocaleString("es-ES", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
export const fmtUSD = (n) => `$${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0, minimumFractionDigits: 0 })}`;
export const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 12)}`;

export const fmt = (d) => {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString("es-ES", { day: "2-digit", month: "short" }); }
  catch { return d; }
};

export const daysBetween = (a, b) => {
  if (!a || !b) return 0;
  return Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000) + 1);
};

export const dateAdd = (start, n) => {
  if (!start) return "";
  const d = new Date(start); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

// Nights between two ISO dates (excluding the check-out day).
export const nightsBetween = (df, dt) => {
  if (!df || !dt) return 0;
  const a = new Date(df), b = new Date(dt);
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
};
