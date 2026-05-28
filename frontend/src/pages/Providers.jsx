import React, { useEffect, useState } from "react";
import { Plus, Trash2, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";

const EMPTY = { name: "", country: "", contact: "", notes: "" };

export default function Providers() {
  const [items, setItems] = useState([]);
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try { const { data } = await api.get("/providers"); setItems(data); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing.name) { toast.error("El nombre es obligatorio"); return; }
    try {
      if (editing.provider_id) {
        await api.patch(`/providers/${editing.provider_id}`, editing);
        toast.success("Proveedor actualizado");
      } else {
        await api.post("/providers", editing);
        toast.success("Proveedor creado");
      }
      setEditing(null); load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Error"); }
  };

  const del = async (id) => {
    if (!window.confirm("¿Eliminar proveedor?")) return;
    try { await api.delete(`/providers/${id}`); load(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Error"); }
  };

  return (
    <div className="px-8 py-8 max-w-7xl">
      <div className="flex items-end justify-between mb-6">
        <div>
          <div className="smallcaps">Directorio</div>
          <h1 className="font-serif text-5xl leading-none mt-3">Proveedores</h1>
          <p className="text-sm text-clay-700 mt-3 max-w-lg">Quien factura las experiencias. Los precios viven en cada experiencia.</p>
        </div>
        <button data-testid="new-provider-btn" onClick={() => setEditing({ ...EMPTY })} className="inline-flex items-center gap-2 px-4 py-2 bg-clay-900 text-white text-sm tracking-wider uppercase hover:bg-terracotta">
          <Plus size={14}/> Nuevo proveedor
        </button>
      </div>

      <div className="border border-clay-300 bg-white">
        <div className="grid grid-cols-[1.4fr_0.8fr_1.4fr_1.6fr_auto] bg-clay-100 text-[11px] tracking-[0.2em] uppercase text-clay-700 font-semibold">
          <div className="px-4 py-3">Nombre</div>
          <div className="px-4 py-3">País</div>
          <div className="px-4 py-3">Contacto</div>
          <div className="px-4 py-3">Notas</div>
          <div className="px-4 py-3 text-right">Acciones</div>
        </div>
        {loading ? <div className="p-6 text-sm text-clay-700">Cargando…</div> :
          items.length === 0 ? <div className="p-10 text-center text-sm text-clay-700" data-testid="prov-empty">No hay proveedores aún.</div> :
          items.map((p) => (
            <div key={p.provider_id} className="grid grid-cols-[1.4fr_0.8fr_1.4fr_1.6fr_auto] border-t border-clay-300 text-sm hover:bg-clay-50 transition-colors" data-testid={`prov-row-${p.provider_id}`}>
              <div className="px-4 py-3 font-semibold">{p.name}</div>
              <div className="px-4 py-3 text-clay-700">{p.country || "—"}</div>
              <div className="px-4 py-3 text-clay-700">{p.contact || "—"}</div>
              <div className="px-4 py-3 text-clay-700 truncate">{p.notes || "—"}</div>
              <div className="px-4 py-3 flex justify-end gap-1">
                <button onClick={() => setEditing({ ...p })} className="p-1.5 hover:bg-clay-200" data-testid={`edit-${p.provider_id}`}><Pencil size={14}/></button>
                <button onClick={() => del(p.provider_id)} className="p-1.5 hover:bg-clay-200 text-destructive"><Trash2 size={14}/></button>
              </div>
            </div>
          ))
        }
      </div>

      {editing && (
        <div className="fixed inset-0 bg-clay-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setEditing(null)}>
          <div className="bg-white border border-clay-300 w-full max-w-xl p-6 animate-fade-up" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-serif text-2xl">{editing.provider_id ? "Editar proveedor" : "Nuevo proveedor"}</h2>
              <button onClick={() => setEditing(null)} className="p-1 hover:bg-clay-200"><X size={16}/></button>
            </div>
            <div className="space-y-3">
              <Field label="Nombre *"><input data-testid="prov-name" className="w-full bg-white border border-clay-300 px-3 py-2 text-sm outline-none focus:border-terracotta" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
              <Field label="País"><input className="w-full bg-white border border-clay-300 px-3 py-2 text-sm" value={editing.country || ""} onChange={(e) => setEditing({ ...editing, country: e.target.value })} /></Field>
              <Field label="Contacto"><input className="w-full bg-white border border-clay-300 px-3 py-2 text-sm" value={editing.contact || ""} onChange={(e) => setEditing({ ...editing, contact: e.target.value })} /></Field>
              <Field label="Notas"><textarea rows={3} className="w-full bg-white border border-clay-300 px-3 py-2 text-sm" value={editing.notes || ""} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></Field>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setEditing(null)} className="px-4 py-2 border border-clay-300 text-sm hover:bg-clay-100">Cancelar</button>
              <button data-testid="prov-save-btn" onClick={save} className="px-4 py-2 bg-terracotta text-white text-sm tracking-wider uppercase hover:bg-terracotta-hover">Guardar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return <div><div className="smallcaps mb-1">{label}</div>{children}</div>;
}
