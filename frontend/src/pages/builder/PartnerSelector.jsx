import React from "react";
import { PARTNER_OPTIONS } from "./utils";

// PartnerSelector — controls the Itinerary.partner field. Changing it
// auto-applies the per-partner markup % and commission % defaults defined
// in setField, but agents can override each number afterwards.
//
// Hidden partners (e.g. legacy KimKim) are filtered out of the dropdown
// UNLESS the current itinerary still has that partner selected — in which
// case we keep the option visible so the agent can read the value (and
// switch away from it) without the select going blank.
export function PartnerSelector({ itn, setField }) {
  const current = itn.partner || "";
  const options = PARTNER_OPTIONS.filter((p) => !p.hidden || p.value === current);
  return (
    <select
      data-testid="itin-partner"
      value={current || "zicasso"}
      onChange={(e) => setField("partner", e.target.value)}
      className="w-full bg-transparent outline-none text-sm cursor-pointer"
      title="Fuente del cliente · ajusta markup y comisión automáticamente"
    >
      {options.map((p) => (
        <option key={p.value} value={p.value}>{p.label}</option>
      ))}
    </select>
  );
}
