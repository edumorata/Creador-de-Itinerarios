import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles, Wand2, ArrowLeft, Brain } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";

export default function AIGenerate() {
  const [clientName, setClientName] = useState("");
  const [request, setRequest] = useState("");
  const [partner, setPartner] = useState("kimkim");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const navigate = useNavigate();

  const generate = async () => {
    if (request.trim().length < 30) { toast.error("Pega un request más detallado"); return; }
    setBusy(true);
    setResult(null);
    try {
      const { data } = await api.post("/ai/generate-itinerary", {
        client_request: request,
        client_name: clientName,
        partner,
        save: true,
      });
      setResult(data);
      toast.success("Itinerario generado. Puedes editarlo a continuación.");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Error al generar");
    } finally { setBusy(false); }
  };

  return (
    <div className="px-8 py-8 max-w-5xl">
      <button onClick={() => navigate("/ai/trainer")} className="inline-flex items-center gap-2 text-xs smallcaps hover:text-terracotta">
        <ArrowLeft size={14}/> Entrenador
      </button>

      <div className="mt-3 mb-6">
        <div className="smallcaps inline-flex items-center gap-2"><Brain size={12}/> AI assistant</div>
        <h1 className="font-serif text-5xl leading-none mt-3">Crear desde request</h1>
        <p className="text-sm text-clay-700 mt-3 max-w-2xl">
          Pega el request del cliente y el agente construirá un primer borrador usando tu librería de experiencias, tus hoteles y los patrones aprendidos de los itinerarios pasados.
        </p>
      </div>

      <div className="border border-clay-300 bg-white p-6">
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <div className="smallcaps mb-1">Nombre del cliente (opcional)</div>
            <input data-testid="gen-name" placeholder="ej. John & Sarah Miller" value={clientName} onChange={(e) => setClientName(e.target.value)} className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta" />
          </div>
          <div>
            <div className="smallcaps mb-1">Partner / Source <span className="text-clay-500 normal-case tracking-normal">— afecta a la comisión y al markup</span></div>
            <select
              data-testid="gen-partner"
              value={partner}
              onChange={(e) => setPartner(e.target.value)}
              className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta"
            >
              <option value="kimkim">KimKim (+15% encima)</option>
              <option value="zicasso">Zicasso (cobra 10,5% de nuestro precio)</option>
              <option value="responsible_travel">Responsible Travel (cobra 10% de nuestro precio)</option>
              <option value="direct">Direct (sin comisión)</option>
              <option value="other">Otro</option>
            </select>
          </div>
        </div>
        <div>
          <div className="flex items-baseline gap-2 mb-1">
            <span className="smallcaps text-terracotta">Client trip request</span>
            <span className="text-[11px] text-clay-700">— pega el email o briefing del cliente tal cual</span>
          </div>
          <textarea data-testid="gen-request" rows={10} placeholder="Hi, planning a 7-day trip to Portugal in October for 2 adults…" value={request} onChange={(e) => setRequest(e.target.value)} className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta font-mono" />
          <div className="text-[11px] text-clay-700 mt-1">{request.length.toLocaleString("es-ES")} caracteres</div>
        </div>
        <div className="flex justify-end mt-4">
          <button data-testid="gen-btn" onClick={generate} disabled={busy} className="inline-flex items-center gap-2 px-5 py-3 bg-clay-900 text-white text-sm tracking-wider uppercase hover:bg-terracotta disabled:opacity-50">
            {busy ? <Sparkles size={16} className="animate-pulse"/> : <Wand2 size={16}/>}
            {busy ? "Generando…" : "Generar borrador"}
          </button>
        </div>
      </div>

      {result?.itinerary && (
        <div className="mt-8 border border-pine bg-white p-6 animate-fade-up" data-testid="gen-result">
          <div className="smallcaps inline-flex items-center gap-1 text-pine"><Sparkles size={12}/> Borrador generado</div>
          <h2 className="font-serif text-3xl mt-2">{result.itinerary.name}</h2>
          {result.ai_summary && <p className="text-sm text-clay-700 mt-2 italic">"{result.ai_summary}"</p>}

          <div className="grid grid-cols-4 gap-0 my-4 border border-clay-300">
            <Stat label="Días" v={result.itinerary.duration_days} />
            <Stat label="Pax" v={result.itinerary.num_travelers} />
            <Stat label="Servicios" v={result.itinerary.days?.reduce((acc, d) => acc + (d.services?.length || 0), 0)} />
            <Stat label="Alojamientos" v={result.itinerary.accommodations?.length || 0} />
          </div>

          <div className="space-y-3 mb-5">
            {(result.itinerary.days || []).map((d, i) => (
              <div key={d.day_id} className="border border-clay-300">
                <div className="px-3 py-2 bg-clay-100 text-sm flex items-center justify-between">
                  <div className="font-semibold">{d.label} · {d.city || "—"}</div>
                  <div className="text-clay-700 tabular text-[11px]">{d.date}</div>
                </div>
                <div className="grid-borders">
                  {(d.services || []).map((s) => (
                    <div key={s.service_id} className="grid grid-cols-[110px_1fr_80px_100px] gap-2 px-3 py-2 text-sm items-center">
                      <span className="text-[10px] tracking-widest uppercase text-clay-700">{s.type}</span>
                      <div className="min-w-0">
                        <div className="font-semibold truncate">{s.name}</div>
                        {s.provider_name && <div className="text-[10px] text-clay-700">{s.provider_name}{s.experience_id ? " · librería" : " · freeform"}</div>}
                      </div>
                      <div className="text-right tabular text-clay-700">{s.quantity}x</div>
                      <div className="text-right tabular font-semibold">€ {Number(s.unit_price_tax_incl || 0).toLocaleString("es-ES")}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {(result.itinerary.accommodations || []).length > 0 && (
            <div className="border border-clay-300 mb-5">
              <div className="px-3 py-2 bg-clay-100 smallcaps">Alojamientos</div>
              {(result.itinerary.accommodations || []).map((a) => (
                <div key={a.acc_id} className="px-3 py-2 border-t border-clay-300 text-sm grid grid-cols-[1fr_140px_140px_100px]">
                  <div className="font-semibold truncate">{a.name}</div>
                  <div className="text-clay-700 tabular text-[11px]">{a.date_from}</div>
                  <div className="text-clay-700 tabular text-[11px]">{a.date_to}</div>
                  <div className="text-right tabular font-semibold">€ {Number(a.price_tax_incl || 0).toLocaleString("es-ES")}</div>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button data-testid="gen-open" onClick={() => navigate(`/itineraries/${result.itinerary.itinerary_id}`)} className="inline-flex items-center gap-2 px-5 py-3 bg-terracotta text-white text-sm tracking-wider uppercase hover:bg-terracotta-hover">
              Abrir en el constructor → editar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, v }) {
  return (
    <div className="p-3 border-r last:border-r-0 border-clay-300">
      <div className="smallcaps">{label}</div>
      <div className="font-serif text-2xl tabular mt-1">{v ?? 0}</div>
    </div>
  );
}
