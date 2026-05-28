// REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function AuthCallback() {
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const processed = useRef(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (processed.current) return;
    processed.current = true;

    const hash = window.location.hash || "";
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const sessionId = params.get("session_id");
    if (!sessionId) {
      navigate("/login", { replace: true });
      return;
    }

    (async () => {
      try {
        const { data } = await api.post("/auth/session", { session_id: sessionId });
        if (data?.user) setUser(data.user);
        // clean hash
        window.history.replaceState({}, document.title, window.location.pathname);
        navigate("/dashboard", { replace: true });
      } catch (e) {
        const detail = e?.response?.data?.detail || "No se pudo iniciar sesión";
        setError(detail);
      }
    })();
  }, [navigate, setUser]);

  return (
    <div className="min-h-screen flex items-center justify-center topo-bg" data-testid="auth-callback">
      <div className="text-center max-w-md p-8 bg-white/70 backdrop-blur-xl border border-clay-300">
        {error ? (
          <>
            <h2 className="font-serif text-2xl mb-3">Acceso denegado</h2>
            <p className="text-sm text-clay-700 mb-6">{error}</p>
            <button
              data-testid="back-to-login"
              className="px-4 py-2 bg-terracotta text-white text-sm tracking-wider uppercase hover:bg-terracotta-hover transition-colors"
              onClick={() => navigate("/login", { replace: true })}
            >
              Volver
            </button>
          </>
        ) : (
          <>
            <div className="smallcaps mb-2">Autenticando</div>
            <h2 className="font-serif text-2xl">Validando sesión…</h2>
          </>
        )}
      </div>
    </div>
  );
}
