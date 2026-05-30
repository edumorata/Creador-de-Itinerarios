# PRD — Travel Itinerary Builder

## Original problem statement
> Construir una herramienta para que mis travel specialists puedan diseñar de forma más rápida y ágil los itinerarios.
> - BBDD ordenada de experiencias vinculadas a proveedores con precio
> - Dashboard simple para elegir actividades, ver coste total + markup (comisión agencia)
> - Fase 2: agente de IA entrenado en itinerarios vendidos/no vendidos
> - Exportar a Excel para cargar en Sofi (sistema interno, sin API por ahora)

## Architecture
- **Backend**: FastAPI + Motor (MongoDB). Single `server.py` with `/api` router, Emergent Google Auth + whitelist.
- **Frontend**: React 19 + Tailwind + Shadcn primitives + sonner + lucide.
- **Auth**: Emergent-managed Google Auth + whitelist (first user = bootstrap admin).

## User personas
- **Admin (owner / lead)**: manages whitelist, can trigger bulk-import-all, sees everything.
- **Travel specialist (agent)**: builds itineraries, manages experiences & providers, exports to Excel.

## Implemented features

### Iteration 1 (2026-05-28)
- Login + AuthCallback + whitelist (bootstrap admin)
- Admin > Users page (whitelist + registered users)
- Providers CRUD
- Experiences CRUD + filter + single-file bulk import
- Dashboard with itineraries list, status, totals, export
- Itinerary Builder (3 columns): metadata, day-by-day services, accommodations, markup, cost summary, auto-save
- Excel export in Sofi format

### Iteration 2 (2026-05-28)
- **3-tier pricing**: every Experience, ItineraryService and Accommodation now stores `price_tax_excl`, `price_tax_incl`, and the UI computes `PVP = price_tax_incl × (1 + markup%)`. Cost summary shows Subtotal sin IVA + Subtotal con IVA + Markup + PVP final.
- **Excel export updated**: 9 columns (Day | Date | City | Type | Name | Quantity | Sin IVA | Con IVA | PVP) and three subtotals at the bottom.
- **City per day**: each ItineraryDay has a `city` field used as a pre-filter and emitted in the Excel export.
- **Service autocomplete**: typing in any service-name row triggers a typeahead `GET /api/experiences/autocomplete?q=…&city=…` and pre-fills the row (type, name, provider, both prices) on selection.
- **Bulk-import-all-server**: admin-only endpoint that walks `/app/artifacts/excel_creados` and imports the 94 provider Excel files. Currently 2514 experiences across 82 providers (España, Portugal, Italia). Dedup key = (provider_id, title, price_tax_incl).

## P1 backlog (next iterations)
- Itinerary duplication / templates by destination
- Per-provider margin dashboard
- Wizard for bulk import with column mapping
- Multiple Excel templates per agent/brand
- Phase 3: Automate Itinerary push into Sofi via Playwright (no API available)

## P2 backlog
- Multi-currency conversion
- Per-line markup overrides

### Iteration 3 (2026-05-29) — Bulk training import from gestion
- **`POST /api/training-examples/bulk-import-gestion`** now spawns an async background `BulkImportJob` (collection `bulk_import_jobs`) and returns immediately with a `job_id`.
- The job logs in once with `GESTION_VIAJADVERDAD_USER/PASS`, then for each requested status (`open`, `closed`, `terminado`, or any combination) applies the verified Fabrik filters, sets page size to 500, paginates if needed, harvests every trip ID + its visible link text, and scrapes each trip with the existing Playwright + LLM parser. Dedup on `itinerary_url_ops`.
- **Outcome selector per batch**: payload accepts `outcome` (`sold` / `not_sold` / `pending`).
- Resumability: jobs are interruptible by user (button "Cancelar") or by backend restart (orphan reaper + auto-resume watcher). Trip IDs persist between sessions; only un-processed trips are re-scraped.
- AI Trainer page (`/ai/trainer`) gained the bulk-import card + pending requests section.
- 166 trips successfully imported, 100% Total Imported success rate.

### Iteration 4 (2026-05-30) — AI Agent training calibration
- **70-trip batch self-evaluation**: ran the AI generate endpoint against every sold trip with a complete client_request, EXCLUDING each trip from retrieval so the system can't cheat by recalling the answer.
- Result: median draft/real ratio = **0.99x** (perfect tuning), mean = 1.10x, stdev = 0.72.
- Hotel name match rate: **64%** (167/260) — the country+city retrieval works.
- City overlap (full match): 14/67 trips; partial 42; miss 11.
- Activity over-programming: 57% of drafts have +20% more paid activities than the real sold trip.
- Long trips (>14d) systematically under-priced (ratio 0.73x) — adds free days instead of bases.
- Large groups (5+ pax) under-priced (ratio 0.63x) — single-pax-priced services for big groups.
- **27 new system-prompt rules added (A → AP)** covering: Camino timing, wishlist atomisation, hub strategy, hotel reuse, KK commission detection, "5 overnight + water = 2 hubs", tier-vs-budget reality math, family + coast = Airbnb, transit nights for elderly, self-guided for experienced hikers, ferry > driver, Dolomites for hikers, apartment for 4+ pax, reconnaissance mode, eclipse path, $X+ ≠ ceiling, contradictory tier = lower, skip-the-line = tickets only, "no Barcelona" ≠ never, multi-country = strongest signal, calibrated activities/day, free-form hotels need estimate, exact DB city names.
- Country detector now weights Morocco-specific keywords (souks, sahara, berber, balloon, riad) at 3x to break ties with English "Spain" appearing in the same request.
- Verified end-to-end: the agent now correctly handles Italy / Portugal / Spain / Morocco scope.
- The job logs in once with `GESTION_VIAJADVERDAD_USER/PASS`, then for each requested status (`open`, `closed`, or both) applies the verified Fabrik filters via element IDs:
  - `#app_trips___agentvalue` (select by visible label)
  - `#app_trips___sourcevalue` (e.g. `KimKim`)
  - `#app_trips___statusvalue` (`abierto`/`cerrado`)
  - `#app_trips___booking_date_..._filter_range_0/1_.0` (Fecha de Venta range)
- It clicks `button[name="filter"]`, paginates the result, harvests every trip ID + its visible link text (used as client_name once cleaned of the `_facturado…` suffix), then scrapes each trip with the existing Playwright + LLM parser. Dedup on `itinerary_url_ops`.
- **Outcome selector per batch**: payload accepts `outcome` (`sold` / `not_sold` / `pending`, default `sold`) so the agent can learn patterns from both winning and losing itineraries.
- Each result is stored as a `TrainingExample` with `client_request=""` (pending) and the chosen `outcome`.
- New endpoints:
  - `GET /api/training-examples/pending-request`
  - `GET /api/training-examples/bulk-import-jobs` (+ `/{job_id}` polling)
- AI Trainer page (`/ai/trainer`) gained:
  - "Importación masiva" card (agente / source / estado / **marcar como** / fechas / límite) with live progress bar and per-line message.
  - "Entrenamientos pendientes de solicitud" section with one card per pending example: link to gestion, optional structured-day summary, free textarea for the original client request, and a "Guardar y marcar entrenado" button.
- Verified end-to-end: trips imported with both `outcome=sold` and `outcome=not_sold` correctly tagged.

## Known minor items
- Autocomplete payload returns full Experience docs (could be slimmed)
- CORS regex `.*` is permissive (lock down to frontend origin for production)
- LLM parser sometimes echoes example trip_name from the system prompt; not blocking since real client_name is captured from the listing link.
