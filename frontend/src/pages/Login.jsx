// REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
import React from "react";
import { Compass, MapPin } from "lucide-react";

export default function Login() {
  const handleLogin = () => {
    const redirectUrl = window.location.origin + "/dashboard";
    window.location.href = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirectUrl)}`;
  };

  return (
    <div className="min-h-screen relative topo-bg flex items-center justify-center px-6">
      <div
        className="absolute inset-0 pointer-events-none opacity-60"
        style={{
          backgroundImage:
            "url('https://static.prod-images.emergentagent.com/jobs/d5b8c859-ab07-4947-a9d6-0adb76aa4491/images/97abf255189a56b30012d66281b0928f1d394943d6b4289e61bbfc8c0e23e5af.png')",
          backgroundSize: "cover",
          backgroundPosition: "center",
          mixBlendMode: "multiply",
        }}
        aria-hidden
      />
      <div className="relative grid md:grid-cols-2 gap-0 w-full max-w-5xl border border-clay-300 bg-white/70 backdrop-blur-xl backdrop-saturate-150 shadow-[0_1px_0_0_rgba(0,0,0,0.04)]">
        {/* left side - brand */}
        <div className="p-10 md:p-12 border-b md:border-b-0 md:border-r border-clay-300 flex flex-col justify-between min-h-[420px]">
          <div>
            <div className="flex items-center gap-2 smallcaps">
              <Compass size={14} className="text-terracotta" />
              <span>Travel Operations Suite</span>
            </div>
            <h1 className="font-serif text-5xl leading-none mt-8">Diseña itinerarios<br/>como un cartógrafo.</h1>
            <p className="text-sm text-clay-700 mt-6 max-w-sm leading-relaxed">
              Una herramienta interna para travel specialists. Construye viajes a partir
              de tu librería de experiencias, calcula coste, márgenes y exporta en el
              formato de Sofi sin tocar Excel.
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-clay-700">
            <MapPin size={14} className="text-pine" />
            <span className="tabular">España &middot; Portugal &middot; Italia</span>
          </div>
        </div>

        {/* right side - login */}
        <div className="p-10 md:p-12 flex flex-col justify-center bg-clay-50/60">
          <div className="smallcaps mb-3">Acceso</div>
          <h2 className="font-serif text-3xl mb-6">Inicia sesión</h2>
          <p className="text-sm text-clay-700 mb-8 leading-relaxed">
            Sólo cuentas autorizadas pueden acceder. Si tu correo no está en la
            whitelist, contacta con un administrador.
          </p>
          <button
            data-testid="google-login-btn"
            onClick={handleLogin}
            className="group inline-flex items-center justify-center gap-3 px-5 py-3 bg-clay-900 text-white text-sm tracking-wider uppercase hover:bg-terracotta transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.4 29.3 35.5 24 35.5c-6.4 0-11.5-5.2-11.5-11.5S17.6 12.5 24 12.5c2.9 0 5.6 1.1 7.6 2.9l5.7-5.7C33.5 6.2 28.9 4.5 24 4.5 13.2 4.5 4.5 13.2 4.5 24S13.2 43.5 24 43.5 43.5 34.8 43.5 24c0-1.2-.1-2.3-.4-3.5z"/>
              <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 16 19 13 24 13c2.9 0 5.6 1.1 7.6 2.9l5.7-5.7C33.5 6.7 28.9 5 24 5 16.4 5 9.9 9.3 6.3 14.7z"/>
              <path fill="#4CAF50" d="M24 43c4.8 0 9.2-1.6 12.6-4.4l-5.8-4.9C28.9 35 26.6 36 24 36c-5.2 0-9.6-3-11.3-7.4l-6.5 5C9.7 38.7 16.3 43 24 43z"/>
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.3 5.7l5.8 4.9c-.4.4 6.7-4.9 6.7-14.6 0-1.2-.1-2.3-.4-3.5z"/>
            </svg>
            <span>Entrar con Google</span>
          </button>
          <div className="smallcaps mt-10">Whitelist activa</div>
          <p className="text-xs text-clay-700 mt-2">
            Tu cuenta debe haber sido autorizada por un administrador para entrar.
          </p>
        </div>
      </div>
    </div>
  );
}
