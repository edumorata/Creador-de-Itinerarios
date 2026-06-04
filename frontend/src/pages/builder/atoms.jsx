import React from "react";

export function Field({ label, children }) {
  return (
    <div className="px-4 py-3 border-r last:border-r-0 border-clay-300">
      <div className="smallcaps mb-1">{label}</div>
      {children}
    </div>
  );
}

export function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between py-2.5 text-sm">
      <div className="text-clay-700">{label}</div>
      <div className="tabular font-semibold">{children}</div>
    </div>
  );
}
