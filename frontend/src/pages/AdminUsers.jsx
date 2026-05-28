import React, { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";

export default function AdminUsers() {
  const [allowed, setAllowed] = useState([]);
  const [users, setUsers] = useState([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("agent");

  const load = async () => {
    const [a, b] = await Promise.all([api.get("/admin/allowed-emails"), api.get("/admin/users")]);
    setAllowed(a.data); setUsers(b.data);
  };
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!email.includes("@")) { toast.error("Email inválido"); return; }
    try {
      await api.post("/admin/allowed-emails", { email: email.trim().toLowerCase(), role });
      toast.success("Email autorizado");
      setEmail(""); setRole("agent"); load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Error"); }
  };

  const remove = async (em) => {
    if (!window.confirm(`Revocar acceso a ${em}?`)) return;
    try { await api.delete(`/admin/allowed-emails/${encodeURIComponent(em)}`); load(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Error"); }
  };

  return (
    <div className="px-8 py-8 max-w-5xl">
      <div className="mb-6">
        <div className="smallcaps">Administración</div>
        <h1 className="font-serif text-5xl leading-none mt-3">Usuarios &amp; acceso</h1>
        <p className="text-sm text-clay-700 mt-3 max-w-lg">Sólo los emails autorizados aquí pueden iniciar sesión con Google.</p>
      </div>

      <div className="border border-clay-300 bg-white p-5 mb-8">
        <div className="smallcaps mb-3">Añadir email autorizado</div>
        <div className="grid grid-cols-[1fr_180px_auto] gap-2">
          <input
            data-testid="allow-email-input"
            placeholder="agente@empresa.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta"
          />
          <select data-testid="allow-role-select" value={role} onChange={(e) => setRole(e.target.value)} className="bg-white border border-clay-300 px-3 py-2 text-sm">
            <option value="agent">Agente</option>
            <option value="admin">Administrador</option>
          </select>
          <button data-testid="allow-add-btn" onClick={add} className="inline-flex items-center gap-2 px-4 py-2 bg-clay-900 text-white text-sm tracking-wider uppercase hover:bg-terracotta">
            <Plus size={14}/> Autorizar
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div>
          <div className="smallcaps mb-3">Whitelist ({allowed.length})</div>
          <div className="border border-clay-300 bg-white">
            {allowed.length === 0 ? <div className="p-4 text-sm text-clay-700">Lista vacía.</div> :
              allowed.map((a) => (
                <div key={a.email} className="flex items-center justify-between px-4 py-3 border-t first:border-t-0 border-clay-300 text-sm" data-testid={`allowed-${a.email}`}>
                  <div>
                    <div className="font-semibold">{a.email}</div>
                    <div className="smallcaps">{a.role}</div>
                  </div>
                  <button onClick={() => remove(a.email)} className="p-1.5 hover:bg-clay-200 text-destructive" title="Revocar"><Trash2 size={14}/></button>
                </div>
              ))
            }
          </div>
        </div>
        <div>
          <div className="smallcaps mb-3">Usuarios registrados ({users.length})</div>
          <div className="border border-clay-300 bg-white">
            {users.length === 0 ? <div className="p-4 text-sm text-clay-700">Sin usuarios todavía.</div> :
              users.map((u) => (
                <div key={u.user_id} className="flex items-center gap-3 px-4 py-3 border-t first:border-t-0 border-clay-300 text-sm">
                  {u.picture ? <img src={u.picture} alt="" className="w-8 h-8 rounded-sm border border-clay-300 object-cover" /> :
                    <div className="w-8 h-8 rounded-sm bg-clay-200 grid place-items-center text-xs">{(u.name || u.email).slice(0,1).toUpperCase()}</div>}
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate">{u.name}</div>
                    <div className="text-[11px] text-clay-700 truncate">{u.email}</div>
                  </div>
                  <span className="smallcaps">{u.role}</span>
                </div>
              ))
            }
          </div>
        </div>
      </div>
    </div>
  );
}
