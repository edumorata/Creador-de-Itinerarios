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

### Iteration 6 (2026-05-31) — Refactor + Currency converter + Calibration UI
- **Refactor (Phase 4 conservative)**: `server.py` shrunk from 3,598 → 2,983 lines.
  - `prompts.py` (new, 620 lines) — `SYSTEM_PROMPT_GENERATE` extracted.
  - `models.py` (new, 350 lines) — all Pydantic models + type aliases extracted.
  - Routes stayed in `server.py` to keep this refactor risk-free.
- **Currency converter** (Itinerary Builder):
  - Backend `GET /api/fx/rate?base=EUR&quote=USD` proxies the Frankfurter API
    (ECB data, free, no auth), caches per-day in `db.fx_rates`, falls back to
    last known rate on network failures.
  - Frontend `FxConverter` block under the PVP card: shows "1 € = X.XXXX USD"
    editable, "Auto" button to refresh, and PVP-in-USD on a pine pill.
- **AI Calibration card** in `/ai/trainer`:
  - Stat row: trips analysed (158/167), pending eval (9), median price ratio
    (1.26x), median composition score (0.64).
  - Composition score combines city overlap (40%) + hotel count match (20%) +
    activity count match (20%) + country hit (20%).
  - Tables: per-destination and per-sales-agent breakdown of ratio + composition.
  - "Analizar nuevos" button starts the async batch_eval subprocess; only
    processes trips without `last_learned_at`. "Reset y re-evaluar" wipes the
    markers for a full re-run (LLM-budget intensive).
  - Collapsible "54 reglas aprendidas en el system prompt" — parses A→AX rules
    directly from `SYSTEM_PROMPT_GENERATE` so the user sees what the model is
    trained on.
- **New endpoints**:
  - `GET  /api/fx/rate`
  - `GET  /api/calibration/status`
  - `GET  /api/calibration/rules`
  - `POST /api/calibration/run`
  - `GET  /api/calibration/jobs`
  - `GET  /api/calibration/jobs/{job_id}/log`

### Iteration 7 (2026-05-31) — Partner support + admin lock-down
- **All `/api/training-examples/*`, `/api/ai/*` and `/api/calibration/*` endpoints
  switched from `current_user` to `require_admin`**. Agent-role users now get
  403 on every AI/training surface.
- **Sidebar "Asistente IA" section hidden for non-admin users** (only "Trabajo"
  visible). Admin still sees Trabajo + Asistente IA + Administración.
- **`TrainingExample.partner` field added** with `Literal['kimkim','zicasso',
  'responsible_travel','direct','other']`. Pydantic rejects unknown values
  with 422.
- **Retro-tag**: 167 existing training_examples updated to `partner='kimkim'`
  (one-shot DB migration, idempotent).
- **Bulk import from gestión** now persists the partner per example. The
  existing "Source" filter (KimKim/Zicasso/…) is mapped to the partner field
  on save. ResponsibleTravel and Responsible Travel normalise to the same key.
- **Manual edit (PendingCard)**: dropdown to set partner per training-example
  when filling in the original client request — for future Travefy imports.
- **AI generation** (`POST /api/ai/generate-itinerary`) accepts `partner` in
  the payload. The system prompt now receives an explicit per-partner pricing
  block:
  - **KimKim** (additive +15%): use prices from training examples as-is,
    markup_pct=15
  - **Zicasso** (deductive 10.5%): divide KimKim PVPs by 0.895 to keep net
    revenue intact, markup_pct≈28
  - **Responsible Travel** (deductive 10%): divide by 0.90, markup_pct≈27
  - **Direct** (no commission): divide KimKim PVPs by 1.15, markup_pct=15
  - **Other**: defaults to KimKim behaviour
- **`AIGenerate` page** (`/ai/generate`) gained a "Partner / Source" dropdown
  with the four partner options + their commission semantics in labels.
- **Calibration card** gained a third "Por partner" table (the existing
  by_country and by_sales_agent are unchanged). Currently shows only
  `kimkim · 158 trips · ratio 1.26 · composition 0.64` since that's the only
  partner in the dataset.
- **Tests**: testing_agent_v3_fork ran 27 backend cases · all green · no
  critical bugs · only maintainability suggestions (server.py size, fx cache
  sweeper, calibration_run watchdog).

### Iteration 8 (2026-05-31) — Hotel library hygiene + price orientation
- **Hotel.source field added** (`Literal["library","imported_from_trip"]`).
  Library = the 521 hotels from the official Excel files (`HOTELES <PAÍS>.xlsx`).
  Imported_from_trip = the 316 auto-created from past-trip scrapes.
- **GET /api/hotels filtered to source=library by default** (`include_imported=true`
  to override). The 316 auto-imported ones are hidden in:
  - Hotels list page
  - Autocomplete in itineraries
  - AI generation context (hotel library passed to Claude)
- **Imports going forward**: `_run_bulk_import_gestion` continues creating
  trip-imported hotels but with `source="imported_from_trip"`, so they never
  leak into the library again.
- **NEW: `/app/backend/expedia_scraper.py`** — Playwright-based best-effort
  scrape of expedia.es with no login. Detects Cloudflare anti-bot challenge
  in Spanish (“¿Eres un robot?”) and returns `blocked=true` instead of crashing.
- **NEW: `GET /api/hotels/price-orientation?city=X`** — combined endpoint:
  1. PRIMARY source = aggregate over training_examples → median, p25, p75 of
     real price/night per city, plus the actual hotel names used.
  2. FALLBACK = Expedia scrape (when training data has <3 trips for the city).
  3. Returns a unified `recommendation` block with source, confidence and
     a rationale string.
  - Live results: Madrid → €303/n median over 26 trips · Lisbon → €323/n
    over 24 trips · Praiano → none (Expedia blocked, no training data).
- **NEW UI: Orientation modal** on each row of "Alojamientos (sumario)" in
  the Itinerary Builder. Search icon (lucide `Search`) per row opens the
  modal with median/p25/p75, sample hotels from historical trips, plus
  Expedia results (when not blocked). "Aplicar a este alojamiento" button
  fills in the price × nights automatically.

### Iteration 9 (2026-05-31) — Hotel orientation in /hotels page + Reset safeguard
- **Hotels management page (`/hotels`) gained**:
  - Toggle "Incluir importados del histórico" → reveals the 316 trip-imported
    hotels (otherwise hidden). Each row shows an "ORIGEN" pill: `library`
    (pine) or `histórico` (grey).
  - Per-row lupa button (`hotel-orient-<id>`) opens the same price-orientation
    modal as the Itinerary Builder. "Aplicar y guardar en este hotel" patches
    the hotel's `price_per_night_incl` directly with the recommended price.
  - Per-row "promote" button (Tag icon, only on histórico rows) lets the admin
    move an auto-imported hotel into the official `library`.
- **Itinerary Builder lupa fix**:
  - Smart city resolution: looks up the hotel by name in the catalog (incl.
    `imported_from_trip`); falls back to the day plan; finally falls back to
    a manual prompt.
  - Lupa now has a visible border + hover-fill so it's discoverable (previous
    icon-only style blended in with delete).
- **"Reset y re-evaluar" double confirmation**: clicking the button now
  triggers (1) a `window.confirm` with ⚠️ warning + cost estimate, then (2) a
  `window.prompt` requiring the literal word `RESET` to be typed. Any other
  text cancels with an "info" toast. Prevents accidental LLM-budget burns.

### Iteration 10 (2026-05-31) — Partner-based pricing on every itinerary + day-service lupa
- **Itinerary.partner + commission_pct fields added** (Pydantic `Literal`).
  Backfilled all 5 existing itineraries with `partner=kimkim, commission_pct=15`.
- **Cabecera ahora tiene 5 columnas**: Viajero · **Fuente** · Inicio · Fin · Pax.
  Cambiar la Fuente auto-aplica los defaults por partner:
  - KimKim   → markup 33% + comisión 15%
  - Zicasso  → markup 30% + comisión 10.5%
  - Resp.Tr. → markup 30% + comisión 10%
  - Directo  → markup 35% + comisión 0%
  - Otro     → markup 30% + comisión 0% (manual)
- **Bloque "Coste" reorganizado** con 5 líneas:
  1. Subtotal sin IVA
  2. Subtotal con IVA
  3. Markup (editable, %)
  4. Subtotal con markup
  5. Comisión partner (editable, % — solo se muestra si > 0)
  → PVP final = sub_with_IVA × (1 + markup/100) × (1 + commission/100)
  Both `markup_pct` and `commission_pct` are agent-editable inline at any time.
- **Lupa en servicios de día tipo `alojamiento`**: al cambiar el tipo de un
  servicio a "alojamiento" aparece automáticamente el botón 🔍 que reusa el
  mismo modal de orientación (histórico + Expedia) con la ciudad del día y
  las fechas concretas. "Aplicar" rellena el precio del servicio.
- **OrientationModal global**: el state se levantó al top-level
  `ItineraryBuilder` para que tanto `AccommodationsBlock` como `ServiceRow`
  (y futuros consumidores) compartan un único modal y resolución de ciudad.
- Verificado en UI: Amalfi Coast itinerary con partner=Zicasso →
  11.055,50€ × 1,30 × 1,105 = **15.881,23 €** PVP final.

## Known minor items
- Autocomplete payload returns full Experience docs (could be slimmed)
- CORS regex `.*` is permissive (lock down to frontend origin for production)
- LLM parser sometimes echoes example trip_name from the system prompt; not blocking since real client_name is captured from the listing link.

### Iteration 5 (2026-05-31) — Second-pass AI calibration (158 sold trips)
- **`training_examples.last_learned_at` field added**: every trip evaluated by the batch
  script gets a timestamp so future runs only analyse new imports (no more re-processing).
  Populated for 158 trips after this iteration.
- **Batch eval v2 run over 167 trips** (151 successful + 9 budget-rejected + 7 leftover).
  Results saved at `/app/memory/batch_eval_v2.jsonl` and analysed in
  `/app/memory/batch_eval_v2_report.md`.
- **Calibration result with rules A→AQ**: median draft/real ratio = **1.26x**, mean 1.39x,
  stdev 0.65. The 45 prior rules over-corrected and now systematically OVER-quote.
- **Root cause #1 — Hotel multiplier wrong**: Rule H used 0.45 (hotels = 45% of total PVP),
  but real data shows median hotel share = **27%**. Corrected REVISED H and AO formulas
  with 0.27 multiplier.
- **Root cause #2 — Geographic miss-fires** (26 trips with ZERO city overlap, 16%):
  - "Azores" requests routed to mainland Portugal
  - "Puglia / Matera / trulli" routed to Sicily
  - "Italian Lakes" routed to Amalfi / Sorrento
  - "Northern Spain wine + culture + beach" routed to Andalusia
- **6 new prompt rules added (AR–AX)**:
  - **AR** Final PVP audit BEFORE output, with hard hotel nightly caps per tier
    (Basic ≤€160, Mid-range ≤€240, Upscale ≤€360, Luxury ≤€600).
  - **AS** Azores override (São Miguel / Pico / Terceira / Flores — never mainland).
  - **AT** Puglia / Basilicata never reroutes to Sicily or Amalfi.
  - **AU** Northern Italy + lakes/active = Garda + Verona + Valpolicella.
  - **AV** Northern Spain wine route = Madrid + La Rioja + San Sebastián + Bilbao
    (Andalusia only when Moorish/flamenco/white-villages/"south" is mentioned).
  - **AW** City naming convention — always English form (Rome not Roma, Florence not Firenze).
  - **AX** Activity subtotal cap by duration (median real values from 158-trip dataset).
- **Per-agent calibration**: median ratios by sales agent — Rita 1.51x, Giorgia 1.50x,
  Hector 1.37x, Anita 1.16x, Beatriz 1.19x, Raquel 1.12x, Marina 1.07x.
  Marina-style retrievals are the most balanced.
- **Batch eval is now resumable & idempotent**: re-running `python -m tests.batch_eval_v2`
  skips trips that already have `last_learned_at` set. New imports flagged as `sold`
  (or `not_sold` when phase 2 lands) are picked up automatically on the next run.
