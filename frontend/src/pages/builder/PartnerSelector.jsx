import React from "react";
import { PARTNER_OPTIONS } from "./utils";

// PartnerSelector — controls the Itinerary.partner field. Changing it
// auto-applies the per-partner markup % and commission % defaults defined
// in setField, but agents can override each number afterwards.
export function PartnerSelector({ itn, setField }) {
  return (
    <select
      data-testid="itin-partner"
      value={itn.partner || "kimkim"}
      onChange={(e) => setField("partner", e.target.value)}
      className="w-full bg-transparent outline-none text-sm cursor-pointer"
      title="Fuente del cliente · ajusta markup y comisión automáticamente"
    >
      {PARTNER_OPTIONS.map((p) => (
        <option key={p.value} value={p.value}>{p.label}</option>
      ))}
    </select>
  );
}
