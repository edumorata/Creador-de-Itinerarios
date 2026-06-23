/**
 * Sandbox-safe confirmation dialog.
 *
 * Why this exists: Emergent's preview environment serves the app inside a
 * sandboxed iframe that drops the `allow-modals` keyword. As a result
 * `window.confirm()` is silently ignored (returns `undefined`) and any flow
 * gated on `if (!window.confirm(...))` becomes a no-op — agents see "the
 * delete button doesn't work" with no feedback at all.
 *
 * Implementation: build a tiny modal in pure DOM (so it works regardless of
 * where it's called from — no React tree dependency) and resolve a promise
 * when the user clicks. We always use this path; trying to fall back to
 * `window.confirm` first adds latency and noise and provides no benefit
 * over a styled dialog.
 *
 * Usage:
 *     if (!(await confirmAsync("¿Eliminar este itinerario?"))) return;
 */
export function confirmAsync(message, {
  confirmLabel = "Aceptar",
  cancelLabel = "Cancelar",
  destructive = false,
} = {}) {
  return new Promise((resolve) => {
    const escapeHtml = (s) => String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

    const overlay = document.createElement("div");
    overlay.setAttribute("data-testid", "confirm-overlay");
    overlay.className =
      "fixed inset-0 z-[9999] bg-black/40 flex items-center justify-center p-4";
    const confirmClasses = destructive
      ? "bg-red-600 hover:bg-red-700 text-white"
      : "bg-clay-900 hover:bg-terracotta text-white";
    overlay.innerHTML = `
      <div class="bg-white border border-clay-300 max-w-md w-full p-6 shadow-xl">
        <p class="text-sm text-clay-900 mb-5 whitespace-pre-line">${escapeHtml(message)}</p>
        <div class="flex justify-end gap-2">
          <button data-act="no" data-testid="confirm-cancel"
                  class="px-4 py-2 text-sm border border-clay-300 hover:bg-clay-100">
            ${escapeHtml(cancelLabel)}
          </button>
          <button data-act="yes" data-testid="confirm-yes"
                  class="px-4 py-2 text-sm ${confirmClasses}">
            ${escapeHtml(confirmLabel)}
          </button>
        </div>
      </div>`;

    const close = (val) => {
      window.removeEventListener("keydown", onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(false);
      if (e.key === "Enter") close(true);
    };

    overlay.addEventListener("click", (e) => {
      const act = e.target?.dataset?.act;
      if (act === "yes") close(true);
      else if (act === "no" || e.target === overlay) close(false);
    });
    window.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    // Focus the confirm button for keyboard-only operation
    setTimeout(() => overlay.querySelector('[data-act=yes]')?.focus(), 0);
  });
}
