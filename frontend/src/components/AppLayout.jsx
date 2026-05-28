import React from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Compass, LayoutDashboard, MapPinned, Sparkles, Building2, Users, LogOut } from "lucide-react";
import { useAuth } from "@/lib/auth";

const navItems = [
  { to: "/dashboard", label: "Itinerarios", icon: LayoutDashboard, tid: "nav-itineraries" },
  { to: "/experiences", label: "Experiencias", icon: Sparkles, tid: "nav-experiences" },
  { to: "/providers", label: "Proveedores", icon: Building2, tid: "nav-providers" },
];
const adminItems = [
  { to: "/admin/users", label: "Usuarios & Acceso", icon: Users, tid: "nav-admin" },
];

export default function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <aside className="w-60 shrink-0 border-r border-clay-300 bg-clay-50/60 flex flex-col" data-testid="app-sidebar">
        <div className="px-5 py-5 border-b border-clay-300 flex items-center gap-2">
          <Compass size={18} className="text-terracotta" />
          <div>
            <div className="font-serif text-lg leading-none">Cartografía</div>
            <div className="smallcaps text-[10px] mt-1">Travel Suite</div>
          </div>
        </div>

        <nav className="flex-1 py-4">
          <div className="smallcaps px-5 mb-2">Trabajo</div>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              data-testid={item.tid}
              className={({ isActive }) =>
                `flex items-center gap-3 px-5 py-2.5 text-sm transition-colors border-l-2 ${
                  isActive
                    ? "border-terracotta bg-clay-100 text-clay-900 font-semibold"
                    : "border-transparent text-clay-700 hover:bg-clay-100 hover:text-clay-900"
                }`
              }
            >
              <item.icon size={16} />
              <span>{item.label}</span>
            </NavLink>
          ))}

          {user?.role === "admin" && (
            <>
              <div className="smallcaps px-5 mt-6 mb-2">Administración</div>
              {adminItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  data-testid={item.tid}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-5 py-2.5 text-sm transition-colors border-l-2 ${
                      isActive
                        ? "border-terracotta bg-clay-100 text-clay-900 font-semibold"
                        : "border-transparent text-clay-700 hover:bg-clay-100 hover:text-clay-900"
                    }`
                  }
                >
                  <item.icon size={16} />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </>
          )}
        </nav>

        <div className="border-t border-clay-300 p-4 flex items-center gap-3">
          {user?.picture ? (
            <img src={user.picture} alt="" className="w-9 h-9 object-cover rounded-sm border border-clay-300" />
          ) : (
            <div className="w-9 h-9 rounded-sm bg-clay-200 grid place-items-center text-xs font-semibold">
              {(user?.name || "?").slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate" data-testid="user-name">{user?.name}</div>
            <div className="text-[11px] text-clay-700 truncate">{user?.email}</div>
            <div className="smallcaps mt-1" data-testid="user-role">{user?.role}</div>
          </div>
          <button
            data-testid="logout-btn"
            onClick={handleLogout}
            className="p-2 hover:bg-clay-200 transition-colors"
            title="Salir"
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0">
        <Outlet />
      </main>
    </div>
  );
}
