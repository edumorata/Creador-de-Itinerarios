# PRD — Travel Itinerary Builder

## Original problem statement
> Construir una herramienta para que mis travel specialists puedan diseñar de forma más rápida y ágil los itinerarios.
> - BBDD ordenada de experiencias vinculadas a proveedores con precio
> - Dashboard simple para elegir actividades, ver coste total + markup (comisión agencia)
> - Fase 2: agente de IA entrenado en itinerarios vendidos/no vendidos
> - Exportar a Excel para cargar en Sofi (sistema interno, sin API por ahora)
> Adjunto formatos Excel actuales (helensmith, terrylin, viajes directos) y zip con 94 hojas de tarifas de proveedores (España/Portugal/Italia 2025).

## Architecture
- **Backend**: FastAPI + Motor (MongoDB). Single `server.py` with `/api` router, Emergent Google Auth + whitelist.
- **Frontend**: React 19 + Tailwind 3 + Shadcn primitives + sonner toasts + lucide-react icons. Auth context with cookie-based session.
- **Auth**: Emergent-managed Google Auth. Whitelist enforced; first user is bootstrap admin. Session token stored as httpOnly cookie (7 days) and supports `Authorization: Bearer` fallback.

## User personas
- **Admin (owner / lead)**: manages allowed emails, sees everything.
- **Travel specialist (agent)**: builds itineraries, manages experiences and providers, exports to Excel.

## Core requirements (static)
1. Library of experiences linked to providers
2. Itinerary builder with day-by-day services + accommodations
3. Real-time cost summary with global markup → final selling price
4. Excel export matching the Sofi-import format used today
5. Bulk import of provider rate sheets
6. Access control via whitelist of Google accounts

## Implemented (2026-05-28)
- Login + Google OAuth + AuthCallback + whitelist enforcement (bootstrap admin = first user)
- Admin > Users page: add/remove allowed emails, view registered users
- Providers CRUD page
- Experiences CRUD page with search/country/type filters + bulk import from provider xlsx
- Dashboard: itineraries list with status, totals, edit/export/delete
- Itinerary Builder: 3-column layout (sidebar nav | timeline | search + cost summary)
  - Trip metadata (traveler, dates, pax) with auto-adjust day list
  - Per-day service rows: type, name, qty, unit price, line total
  - Accommodations sub-block
  - Markup input + live final price calc
  - Click-to-add experiences from library into the active day
  - Auto-save (debounced 600ms)
- Excel export endpoint generating Sofi-format xlsx (Trip Prices sheet with traveler section, activities by day, accommodations, subtotal/markup/final)
- Tested end-to-end: 13/13 backend tests green; UI loads cleanly

## Demo data
- 1 provider + 13 Italian experiences (Roman Road Tours) seeded by the testing agent for visual demo

## P1 backlog (next iterations)
- Drag-and-drop experiences between days (currently click-to-add)
- Bulk import wizard with column mapping (instead of fixed `name`/`operator_name`/`price_tax_incl`)
- Itinerary duplication / templates
- Sold/Not-sold dataset capture → feed Phase-2 AI
- Reports: monthly margin, top providers
- Multiple Excel export templates (one per agent/brand)

## P2 backlog
- Phase 2: AI itinerary suggestion (LLM trained on historical sold itineraries)
- Direct Sofi sync (web automation since no API)
- Currency conversion (multi-currency providers)
- Per-line markup overrides
- Versioning / change history on itineraries

## Known minor items (from testing)
- Bulk import doesn't dedupe re-uploads (creates duplicates)
- CORS regex `.*` is permissive; tighten before production
- session_token cookie requires HTTPS (works in preview/prod; not on plain HTTP local)
