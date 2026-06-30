import React, { useEffect, useState } from "react";
import { X, UserPlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";

// Helper: extract a friendly display name from an email when the agent
// hasn't logged in yet (no row in the `users` collection).
const fallbackName = (email) => {
  const local = (email || "").split("@")[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : email;
};

/** Modal: pick another viajadverdad agent to grant read+write access to
 *  this itinerary. Lists current collaborators with a quick "remove"
 *  button. Targets come from /api/agents/list (only allowed emails). */
export function ShareItineraryModal({ open, itineraryId, ownerEmail,
                                       sharedWith, onClose, onChange }) {
  const [agents, setAgents] = useState([]);
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    api.get("/agents/list")
      .then(({ data }) => { if (alive) setAgents(data.agents || []); })
      .catch(() => { if (alive) toast.error("No se pudo cargar la lista de agentes"); });
    return () => { alive = false; };
  }, [open]);

  if (!open) return null;

  const available = agents.filter((a) =>
    a.email !== ownerEmail && !(sharedWith || []).includes(a.email)
  );

  const handleShare = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/itineraries/${itineraryId}/share`, { email: picked });
      onChange?.(data.shared_with || []);
      const agent = agents.find((a) => a.email === picked);
      toast.success(`Compartido con ${agent?.name || picked}`);
      setPicked("");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "No se pudo compartir");
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (email) => {
    setBusy(true);
    try {
      const { data } = await api.delete(`/itineraries/${itineraryId}/share/${encodeURIComponent(email)}`);
      onChange?.(data.shared_with || []);
      toast.success(`Se retiró el acceso a ${fallbackName(email)}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "No se pudo retirar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-clay-900/50 flex items-center justify-center p-4"
         data-testid="share-modal-backdrop"
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white border border-clay-300 w-full max-w-lg shadow-xl"
           data-testid="share-modal">
        <div className="flex items-center justify-between px-5 py-4 border-b border-clay-300">
          <div>
            <div className="smallcaps text-clay-700">Colaboración</div>
            <div className="font-serif text-2xl mt-1">Compartir itinerario</div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-clay-100" data-testid="share-modal-close">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-5">
          {/* Current collaborators */}
          <div>
            <div className="smallcaps mb-2">Acceso actual</div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm bg-clay-50 px-3 py-2 border border-clay-200">
                <div>
                  <span className="font-medium">{fallbackName(ownerEmail)}</span>
                  <span className="text-clay-500 ml-2">· {ownerEmail}</span>
                </div>
                <span className="text-[10px] uppercase tracking-widest text-clay-600">Propietario</span>
              </div>
              {(sharedWith || []).length === 0 ? (
                <div className="text-xs text-clay-500 italic px-3 py-2">
                  Sin colaboradores. Comparte para que otros agentes puedan editar este viaje.
                </div>
              ) : (
                (sharedWith || []).map((email) => (
                  <div key={email}
                       data-testid={`shared-with-${email}`}
                       className="flex items-center justify-between text-sm bg-white px-3 py-2 border border-clay-200">
                    <div>
                      <span className="font-medium">{fallbackName(email)}</span>
                      <span className="text-clay-500 ml-2">· {email}</span>
                    </div>
                    <button onClick={() => handleRemove(email)}
                            disabled={busy}
                            data-testid={`unshare-${email}`}
                            className="p-1 text-clay-500 hover:text-destructive hover:bg-clay-100 disabled:opacity-50"
                            title="Retirar acceso">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Add new collaborator */}
          <div>
            <div className="smallcaps mb-2">Añadir colaborador</div>
            <div className="flex items-center gap-2">
              <select value={picked}
                      onChange={(e) => setPicked(e.target.value)}
                      data-testid="share-agent-picker"
                      className="flex-1 bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta">
                <option value="">Selecciona un agente…</option>
                {available.map((a) => (
                  <option key={a.email} value={a.email}>
                    {a.name} · {a.email}
                  </option>
                ))}
              </select>
              <button onClick={handleShare}
                      disabled={!picked || busy}
                      data-testid="share-confirm-btn"
                      className="inline-flex items-center gap-2 px-4 py-2 bg-clay-900 text-white text-sm tracking-wider uppercase hover:bg-terracotta disabled:opacity-50 disabled:cursor-not-allowed">
                <UserPlus size={14} /> Compartir
              </button>
            </div>
            {available.length === 0 && (sharedWith || []).length > 0 && (
              <div className="text-xs text-clay-500 mt-2">
                Ya has compartido con todos los agentes disponibles.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
