# PRD — Travel Itinerary Builder

## 🚀 Production status (2026-07-06)
- **Live URL**: https://trips.espiritutravel.com
- **Deploy unblocker (Jul 6, 2026)**: Added `/app/.dockerignore` excluding `/app/artifacts/` (580 MB of one-shot import files). Previous K8sDeployNotRetryable timeouts were caused by the oversized deploy package, not by application code. Backend was already fine (seed loader in background task, FastAPI starts in <1s).
- **PayPal**: Live mode, brand_name="Espíritu Travel", Guest Checkout enabled, webhook configured.
- **Auth**: Emergent Google Auth on custom domain (trips.espiritutravel.com) working.
- **Client-facing UX**: 100% US English (emails, payment pages, T&C).
- **Compliance**: Mandatory Terms & Conditions checkbox on every payment; IP + timestamp + version stored per payment row.
- **Payment deadlines**: 60 days before trip start (deposit-or-full allowed >60d; full-only ≤60d).

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

### Iteration 11 (2026-05-31) — VAT outside Spain bug fix
- **Bug**: 160 experiences + 22 hotels outside España (Portugal, Italia,
  Marruecos) had `price_tax_excl ≠ price_tax_incl` due to legacy import logic.
  These countries don't apply Spanish IVA so both fields must match.
- **Backfill**: aggregation update aligned both fields using the non-zero
  one (incl preferred) for every non-Spain row.
- **Server-side guard**: `_force_no_vat_outside_spain()` helper applied to
  `POST/PATCH /api/experiences` and `POST/PATCH /api/hotels`. If the item's
  country is not Spain, the server forces `excl = incl` on every write
  (regardless of what the client sends). Verified:
  - Portugal item: PATCH excl=100 incl=150 → server normalises both to 150
  - España item: PATCH excl=100 incl=110 → server preserves IVA differential

### Iteration 12 (2026-05-31) — Hotel auto-spread + autocomplete + Expedia always available
- **`ItineraryService.acc_id` field added** to persist the back-link from
  auto-spread day services to their parent Accommodation row.
- **Auto-spread accommodation across days**: in `AccommodationsBlock`, when an
  accommodation row has `name + date_from + date_to`, the system writes one
  day-service per matching day:
  - `date == date_from` → "Check-in · <hotel>"  (price carrier, qty = nights)
  - `date_from < date < date_to` → "Alojamiento · <hotel>"
  - `date == date_to` → "Check-out · <hotel>"
  Previous services for the same `acc_id` are removed before re-spreading, so
  editing the hotel name or dates updates the day plan idempotently.
- **HotelAutocomplete component**: the name field of every Accommodation row
  is now a typeahead that queries `/api/hotels` (library first, then imported
  fallback). Picking a result loads name + €/night + spread in one click.
- **Expedia deep-link always visible**: `OrientationModal` now renders a
  prominent dark pine button "Abrir Expedia con <hotel> y fechas" at the
  bottom even when the in-app Expedia scrape was blocked. The URL bundles
  the hotel name, city, check-in/out dates and adult count so Expedia.es
  opens the right SERP with all filters pre-applied.
- **Fixed double-URL-encoding bug** in the Hotels-page Expedia link (was
  producing `%2520` from a `encodeURIComponent` over a string that
  `URLSearchParams` was about to encode again).
- Verified end-to-end: typing "Pestana" → selecting "Pestana Churchill Bay"
  on a 2027-09-11 → 2027-09-18 itinerary correctly created:
  Check-in (Day 1) → Alojamiento (Days 2-7) → Check-out (Day 8).

### Iteration 13 (2026-05-31) — Accommodation overlap detection
- **Banner de aviso** en `AccommodationsBlock`: si dos o más alojamientos
  tienen rangos `[date_from, date_to]` que se solapan, aparece un panel rojo
  destructivo con icono `AlertTriangle` listando cada conflicto con el número
  exacto de días en disputa.
- Lógica O(n²) sobre `itn.accommodations` con `useMemo`. Detecta el solape
  estricto (`aFrom < bTo && bFrom < aTo`) y descarta el caso "check-out de A
  = check-in de B" porque no es conflicto (mismo día, mañana vs tarde).
- Verificado: Pestana Overlap (10-26→10-30) en un itinerario con H10
  Palazzo Galla (10-25→10-27) y Maison Kalea (10-28→10-31) produce dos
  filas: "1 día en conflicto" + "2 días en conflicto".

### Iteration 15 (2026-06-03) — Mutation-in-place + Expedia via Google
- **Bug fix**: "Aplicar a estancia" desde un servicio de día ya no duplica el row.
  La matriz (el row creado por el usuario, identificado por `service_id`) se
  **muta in-place** convirtiéndose en el carrier "Check-in", y solo los demás
  días reciben servicios nuevos.
- **Expedia deep-link cambia a Google con `site:expedia.es "HotelName"`**:
  Expedia.es no resolvía correctamente nombres de hotel propios y caía siempre
  a la ciudad. Ahora abrimos Google con la consulta site-filtered y el
  primer resultado lleva al usuario directo a la página del hotel en Expedia.
  Funciona para 1908 Lisboa Hotel, 7 Islas Hotel, Pestana Churchill Bay, etc.
- Verificado: 7 Islas Hotel + check-out manual → Día 1 muestra "Check-in · 7
  Islas Hotel" (un solo row, 3 noches × 200€); Días 2-3 muestran "Alojamiento
  · 7 Islas Hotel"; Día 4 muestra "Check-out · 7 Islas Hotel".

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


### Iteration 8 (2026-06-03) — Pax-aware Experiences catalog
- **NEW**: every Experience now stores a `pax` field (int, default 2) representing the
  number of pax the price is quoted for. Same service for 2 vs 4 vs 5 pax → separate
  rows with their own prices. Pax is capped at 20 to filter corrupted source data
  (the CSV had one row with CH=740 — a data-entry mistake).
- **CSV import endpoint upgrade**:
  - `POST /api/catalog/import-operators-csv` (admin) accepts a fresh
    `app_operators.csv` upload, persists it to `/app/artifacts/catalog_db/`, then
    rebuilds the experiences catalog (preserves curated hotels by default).
  - Underlying `POST /api/catalog/import-from-trips-csv` now keys dedup by
    `(service, provider, city, pax)` and stores the latest non-zero price by
    `Fecha_venta` (was: median over all occurrences).
- **Experiences page UI**:
  - New "Pax" column in the listing.
  - New "Pax: todos" filter (1–12 pax).
  - New "Pax" field in the create/edit modal.
  - New "Subir CSV operadores" button (admin only) opens a modal with file picker
    + checkboxes to wipe experiences and/or imported-from-trip hotels.
- **Itinerary Builder**:
  - Autocomplete `GET /api/experiences/autocomplete?pax=N` now ranks
    exact-pax matches first, then closest pax, then the rest. Pax mismatch
    warnings shown in amber.
  - Sidebar experience cards display the pax count alongside the price.
- **AI Generator**:
  - `_summ_experience` includes pax in the context passed to the LLM.
  - System prompt rule added: "CATALOG pax FIELD" — the AI is instructed to
    pick the variant matching `num_travelers`, and is told NOT to scale group
    services (private tours, transfers) linearly with pax because they price
    per group, not per person.
- **Seed snapshot** (`backend/data/seed.json.gz`) regenerated — production
  deploys will load 2430 pax-tagged experiences + 568 providers + 848 hotels.
- **Regression test**: `python -m backend.tests.test_pax_field` covers DB
  state, list endpoint exposure, and autocomplete ranking. All passing.

Stats after import:
- 3144 source rows → 2430 unique (service, provider, city, pax) experiences.
- Pax distribution: 1→109, 2→1340, 3→196, 4→456, 5→189, 6→67, 7→12, 8→31,
  9→19, 11→9, 14→1, 20→1.

### Iteration 9 (2026-06-03) — Smart pax-quantity + multi-room accommodations
- **Service-type taxonomy refactored** (Pydantic `Literal`):
  - Removed: `restaurante`, `transporte`, `otro` (legacy DB rows migrated).
  - Added: `entradas` (entry-only tickets, distinct from guided activities).
  - Final set: `alojamiento, actividad, entradas, transfer, tren, vuelo` (+ `hotel`
    internal). CSV importer's `classify()` updated to match.
- **Smart quantity in the Itinerary Builder**:
  - `addServiceToDay(...)` and the autocomplete `onPickExperience(...)` now
    compute `qty = max(1, ceil(num_travelers / experience.pax))` for any
    pax-scalable type. Concrete behaviour:
    `tapas-for-2 + couple → qty=1`,
    `tapas-for-2 + 4 travelers → qty=2`,
    `transfer-for-3 + 4 travelers → qty=2`.
    Per-pax services (`pax=1`) still scale linearly to num_travelers.
  - Each service row shows a small badge "precio para N pax" (amber when
    `num_travelers` isn't a clean multiple, neutral when it is).
- **Multi-room accommodations**:
  - `Accommodation.rooms[]` (new `Room` model): type (single/doble/twin/triple/
    cuadruple/suite/family/otro), pax, price_per_night_excl, price_per_night_incl.
  - `Itinerary.room_config[]` (new `RoomConfig` model): default room layout
    applied when adding a new accommodation; editable per-hotel afterwards.
  - Aggregate price = `Σ(rooms.price_per_night_incl) × nights`. When rooms
    exist the flat `price_tax_excl/incl` become read-only and reflect the sum.
  - The spread-across-days logic (Check-in / mid / Check-out service rows)
    now uses the room sum when present, and the catalog-flat price otherwise.
- **AI prompt** updated to document the new taxonomy and the accommodation
  `rooms` block in the expected JSON schema.
- **Migration script** `backend/scripts/migrate_service_types.py` patched
  2430 experiences + 15 services in 6 itineraries to the new taxonomy.
- **Seed snapshot** regenerated.
- **Regression tests** added at `backend/tests/test_pax_taxonomy.py` (6 cases,
  all passing) covering: taxonomy strictness, pax defaults, smart qty math,
  Room/RoomConfig models, and a full Itinerary roundtrip.

Files touched:
- `backend/models.py` — ServiceType literal, RoomType literal, Room, RoomConfig,
  Itinerary.room_config, Accommodation.rooms, ItineraryService.pax.
- `backend/server.py` — CSV importer `classify()` updated, autocomplete still ranks by pax.
- `backend/prompts.py` — taxonomy + rooms documented in the JSON schema.
- `backend/scripts/migrate_service_types.py` (new).
- `backend/tests/test_pax_taxonomy.py` (new).
- `backend/tests/batch_eval_v2.py` — old `transporte` literal updated to `tren`.
- `frontend/src/pages/ItineraryBuilder.jsx` — TYPES list, TYPE_BADGE, SCALES_WITH_PAX,
  smart qty in addServiceToDay & onPickExperience, AccommodationsBlock fully
  rewritten to render rooms + default config; new `RoomConfigEditor` component.
- `frontend/src/pages/Experiences.jsx` — TYPES list and TYPE_BADGE updated.

### Iteration 16 (2026-06-23) — Sofi push (gestion.viajadverdad.com) automation
- **Goal**: replace the manual copy-paste from the builder into the agency's
  internal management system (Sofi/Joomla+Fabrik) with a one-click headless
  Playwright submission.
- **Two operating modes** wired via the same backend pair of endpoints:
  - `POST /api/itineraries/{id}/push-to-sofi {dry_run: true}` → opens Sofi,
    logs in, navigates to `/trips/form/1/`, fills 16+ trip-header + summary
    fields, captures a full-page screenshot, returns WITHOUT clicking submit.
  - `{dry_run: false}` → identical flow + clicks Submit + reads back the new
    Sofi `trip_id`. Stamps the itinerary doc with `sofi_trip_id`,
    `sofi_url`, `sofi_pushed_at`.
- **Polling pattern**: same async background-job model as the Travefy
  importer. Job rows in `db.sofi_push_jobs`, TTL=7 days on `created_at_dt`.
  `GET /api/itineraries/push-to-sofi/{job_id}` polls for status.
- **Robustness against Fabrik markup quirks**:
  - YesNo radios (`paypal_fee`, `trip_sold_in_euro`, `status`) have the
    `<input type=radio>` hidden behind a styled `<label>`; standard
    `el.click()` times out. Fallback chain: `label[for=id]` click → native
    click → JS-level `dispatchEvent('click'+'change')`.
  - Override inputs (e.g. `customer_price_euro_override`) ship with
    `size="0"`, breaking Playwright `fill()`. Fallback: direct
    `el.value = val` + dispatch `input/change/blur`.
- **Mappings**: internal partner enum → Sofi's `Source` and `Partner`
  selects. `_CITY_TO_COUNTRY` (~80 entries) maps day cities to Spain /
  Italy / Portugal / Morocco / France / Cuba / RD for the destination
  multi-select; falls back to "Spain".
- **Pricing**: `_compute_pricing_totals(itn)` mirrors the frontend's PVP
  math (sub_excl/sub_incl → markup → commission → optional PayPal 3%) and
  ships EUR + EUR×fx_rate USD into Sofi's override fields.
- **Frontend UX**:
  - New `SofiPushModal` (`builder/SofiPushModal.jsx`): dry-run done →
    filled-fields table + screenshot accordion + "Enviar de verdad" CTA;
    real-push done → trip_id + Sofi link; error → red banner + filled
    fields for debug.
  - Itinerary Builder header gained 3 mutually-exclusive slots next to
    "Exportar Excel": **(a)** "Vista previa Sofi" + "Enviar a Sofi" buttons
    when not yet pushed; **(b)** green pill "En Sofi #1234 ↗" after success
    (buttons hidden → prevents duplicate creates).
  - "Vista previa → Enviar de verdad" is a continuous flow: clicking the
    CTA fires a `confirm()` and swaps the modal to `dry_run=false` mode
    with a fresh job (key-based remount).
- **Concurrency guards**: re-uses the global Playwright semaphore from
  `scraper.py` (one Chromium at a time). Backend refuses a new job for the
  same itinerary_id while a previous one is still running (409). Also 409
  if the itinerary already has `sofi_trip_id` (real push only; dry-run
  still allowed for re-validation).
- **Auth**: both endpoints use `current_user` (any agent), per user
  request. `_can_access(doc, user)` enforces ownership.
- **Tests**: `backend/tests/test_sofi_push.py` — 8 cases · `7 passed + 1
  skipped` (the skipped one creates a real Sofi trip, gated by
  `SOFI_RUN_REAL_PUSH=1`).
- **Verified end-to-end** against the live Sofi instance in dry-run mode:
  16 fields filled, 0 errors, ~28-45s per job.

Files touched:
- `backend/models.py` — Itinerary now has `sofi_trip_id` + `sofi_url` + `sofi_pushed_at`.
- `backend/sofi.py` — full rewrite: dry-run support + 3-layer Fabrik
  fallbacks for radios and override inputs.
- `backend/server.py` — `_compute_pricing_totals()`, the two new endpoints,
  background runner, TTL index startup, per-itinerary one-job guard,
  structured INFO logging.
- `frontend/src/pages/builder/SofiPushModal.jsx` (new).
- `frontend/src/pages/ItineraryBuilder.jsx` — header buttons + modal mount.
- `backend/tests/test_sofi_push.py` (new, by testing agent).




### Iteration 17 (2026-06-24) — Sofi bookings direct POST (Opción B) end-to-end working
- **Context**: iter-16's Opción A (Playwright UI for every booking) took ~5min
  for 10 bookings — unacceptable for daily use. We pivoted to Opción B: keep
  Playwright for login + trip-header (Fabrik's JS calc fields are too complex
  to recreate), then POST each booking directly via `page.request.post()`
  using the authenticated cookie jar.
- **First Opción B attempt** failed with MySQL errors: `Incorrect integer value: ''
  for column 'product'`, then `'producto_2'`, then `1064 SQL syntax error
  near ''`. The previous agent left the fix in progress.
- **Root cause** (captured by intercepting a real browser-driven submit):
  1. Fabrik `<select>` elements that belong to a database-join group still
     emit `name="…[]"`. Sending `app_bookings___product` (without `[]`) made
     MySQL receive `''` for the INT NOT NULL column.
  2. 6 YesNo radio columns (`contactado`, `flag`, `factura_solicitada`,
     `status_conciliado`, `status_proforma_voucher`, `status_pago`) are
     INT NOT NULL and need explicit `"0"` on POST — Fabrik's JS default
     hadn't run.
  3. The booking form embeds a sub-group `app_notes` (notes/reminders). The
     browser always submits a 10-field placeholder row even when the user
     hasn't added a note. Omitting it triggered the 1064 syntax error
     on Fabrik's join INSERT.
  4. `hiddenElements` JSON list (which fields come from JS state vs the form)
     was missing.
  5. `Submit` value must be empty (`""`), not the literal `"Submit"`.
  6. `date_entry` / `date_exit` must be sent as full `YYYY-MM-DD HH:MM:SS`
     DATETIMEs, not just dates.
- **Fix** (`backend/sofi.py::_booking_form_data`): all six gaps closed.
- **End-to-end verified**: Sofi trip #2311 created with 10 bookings
  (IDs 46995-47004) linked, total time ~51 seconds (~5s/booking, includes
  trip header creation).
- **Regression suite**: `backend/tests/test_booking_form_data.py` — 10 unit
  cases that lock in the captured-browser payload contract (join-group `[]`
  suffix, YesNo defaults, app_notes placeholder, `hiddenElements`, Submit='',
  datetime format). Runs in 40ms with no network.
- **Sofi cleanup**: trips #2302, #2303, #2304, #2305, #2306, #2308, #2309,
  #2310 are empty orphans from the previous debug attempts and need to be
  manually deleted by the owner from Sofi's admin UI.

Files touched (iter-17):
- `backend/sofi.py` — `_booking_form_data` rewritten with `[]` suffix on
  join-group selects, YesNo defaults, app_notes placeholder, hiddenElements
  JSON, datetime format for dates. New helper `_to_sofi_datetime()`.
- `backend/tests/test_booking_form_data.py` (new — 10 unit tests, no
  network, run in 40ms).
- `backend/tests/test_sofi_push.py` (updated by testing agent for the new
  pushed-itinerary fixture — 12 passed + 1 explicit skip).

## P0 backlog (next)

### Iteration 18 (2026-06-24) — Operator (proveedor) FK resolution
- **Issue spotted by owner**: bookings pushed via the new direct-POST flow
  saved the typed provider name only in `operator-auto-complete` (display
  label). The FK column `operator[]` stayed empty, so Sofi listed the
  booking as "without provider".
- **Solution (Option A — exact match)**:
  1. Captured Fabrik's databasejoin autocomplete endpoint via Playwright
     interception:
     `POST /index.php?option=com_fabrik&task=pluginAjax&{csrf}=1&element_id=52&formid=3&plugin=databasejoin&method=autocomplete_options&package=fabrik`
     with form body `value=<provider_name>`. Returns JSON
     `[{value:<id>, text:"<id> - <short> - <legal>"}, …]`.
  2. Added `_resolve_operator_id(page, csrf_token, provider_name, cache)`
     in `backend/sofi.py`. Strategy: POST, parse JSON, find exact
     case-insensitive match on the short_name segment. Result cached
     per push job so the same provider in N bookings = 1 AJAX call.
  3. Added `_extract_csrf_token(hidden)` — the Joomla token is the only
     32-hex-char hidden input with value="1".
  4. `_booking_form_data` now takes `resolved_operator_id` and stamps it
     onto `app_bookings___operator[]` (the FK column). Misses fall back
     to empty string + `_push_one_booking_fast` prepends a
     `"[Proveedor: NAME]"` sentinel to the booking notes so the human
     agent can fix it inside Sofi.
- **Verified live**:
  - `_resolve_operator_id("Renfe") → 236`
  - `_resolve_operator_id("Iberia") → 134`
  - `_resolve_operator_id("renfe"|"RENFE") → 236` (case-insensitive ✅)
  - `_resolve_operator_id("Civitatis") → None` (not in Sofi → notes
    sentinel added)
  - Trip #2311 booking #47006: `operator = "236 - Renfe - Renfe Viajeros
    SME SA"` (FK linked ✅).
  - Trip #2311 booking #47007: operator empty, note =
    `"[Proveedor: Civitatis] Note original"` ✅.
- **Regression coverage**: 5 new unit tests in
  `backend/tests/test_booking_form_data.py` (CSRF extraction, name
  normalization, FK stamping when resolved, empty fallback). Total
  15/15 pass in 50ms with no network.

Files touched (iter-18):
- `backend/sofi.py` — added `json` import, `_OPERATOR_ELEMENT_ID` const,
  `_extract_csrf_token`, `_norm_provider`, `_resolve_operator_id`. Extended
  `_booking_form_data(b, hidden, resolved_operator_id=None)` and
  `_push_one_booking_fast(page, b, hidden, operator_cache)` to thread the
  cache. Main push loop seeds `operator_cache: dict[str, int|None] = {}`.
- `backend/tests/test_booking_form_data.py` — 5 new test cases.


- (none — main Sofi integration goal is now complete)

### Iteration 21 (2026-06-30) — Espíritu Travel branding + flexible payments + traveler-info form + email notifications
- **Branding** of the public payment page (`/pay/:token`) refreshed to
  match the official Espíritu Travel brand book (PDF + AI logos):
  - Real logo (`/espiritu/logo-horizontal.png`) extracted from the .ai
    files, plus 3 derived variants (isotipo, stacked, tag) in
    `/app/frontend/public/espiritu/`.
  - Color palette as CSS-defined Tailwind tokens
    (`espiritu.{deep,sand,sand-deep,terra,terra-hover,olive,magenta}`).
  - Typography: Kanit (italic-bold display) + Raleway (body) loaded from
    Google Fonts.
- **Welcome paragraph** trimmed:
  - "Approve Proposal" sentence removed.
  - 3 contextual branches based on state: initial+60d (deposit option),
    initial+≤60d (full only), and post-payment (paid X / remaining Y).
- **Flexible payments** — after the deposit is captured the client can
  pay any custom amount between 10% of the total and the remaining
  balance, any number of times:
  - Backend `_compute_payment_options` returns `partial_bounds`
    `{min_eur, max_eur}` and `monthly_suggested_eur`
    `{amount_eur, months, days_to_trip}` after a captured payment.
  - `Payment.kind` Literal now includes `partial`.
  - `create-order` accepts `kind="partial"` with `amount_eur`,
    re-validates against live bounds (defense-in-depth).
  - Frontend `PartialPaymentCard` with editable input + chips
    ("Monthly · €X" + "Half remaining · €Y"), CTA reflects entered amount
    and is disabled outside [min, max].
- **Public 403 bug fix** — backend was using
  `request.headers["origin"]` which the K8s ingress rewrites to the
  internal cluster hostname (`*.cluster-5.preview.emergentcf.cloud`,
  returns 403 externally). Solutions:
  - `create-link` and `create-order` now accept an explicit
    `origin` field in the body and prefer it over the request header.
  - The chosen origin is persisted on the Payment doc as
    `client_origin` so the post-capture redirect bounces back to the
    SAME host the client came from.
  - Frontend sends `window.location.origin` on every call.
- **Traveler-info form** on the public page (`POST
  /api/payments/{token}/traveler-info`) — collects full names, passport
  numbers, dates of birth (1..10 travelers), arrival/departure flight,
  phone, client email, allergies/notes. Last-submit-wins. Surfaces in
  the agent's `PaymentLinkModal` ("Datos del cliente" block) with
  timestamp.
- **Email notification** — when the client submits the form, the agent
  who created the trip (`Itinerary.created_by`) receives an HTML+text
  email via Resend. Implementation:
  - `/app/backend/email_service.py` — thin async wrapper, fire-and-forget,
    never raises (returns False if not configured).
  - Resend domain `espiritutravel.com` is already verified — sender
    `Espíritu Travel <noreply@espiritutravel.com>` reaches any recipient.
  - Verified live via `testing_agent_v3_fork`: msg ids
    `9077140a-…` and `ae76f524-…` reached eduardo@viajadverdad.com.

### P0 remaining: none for this scope.

### P1 backlog (next)
- Auto-inject the submitted passport/flight info into Sofi when the
  agent pushes the trip (currently the agent has to copy/paste).
- Configure PayPal Webhook in PayPal Developer dashboard once production
  URL is live (`PAYPAL_WEBHOOK_ID` env).
- Migrate Preview DB → Production DB.

Files touched in iter-21:
- `backend/models.py` — `Payment.kind` adds `partial`, `Payment.client_origin`,
  `TravelerInfo` + `TravelerInfoPerson`, `Itinerary.traveler_info`.
- `backend/server.py` — `_compute_payment_options` rewrite, `create-link`
  & `create-order` accept `origin`, `submit_traveler_info` endpoint with
  Resend notification, `_redirect_to_payment_page` uses `client_origin`.
- `backend/email_service.py` (new).
- `backend/.env` — RESEND_API_KEY + RESEND_SENDER_EMAIL.
- `backend/requirements.txt` — `resend==2.32.2`.
- `frontend/public/index.html` — Google Fonts: Kanit + Raleway.
- `frontend/tailwind.config.js` — `espiritu.*` color tokens + kanit/raleway.
- `frontend/src/pages/PublicPayment.jsx` (new, then full rebrand + form +
  PartialPaymentCard).
- `frontend/src/pages/builder/PaymentLinkModal.jsx` — added
  `TravelerInfoBlock` showing what the client submitted.
- `frontend/src/pages/ItineraryBuilder.jsx` — header "Enlace de pago"
  button next to "Compartir con".
- `frontend/src/App.js` — public `/pay/:token` route.
- `frontend/public/espiritu/` — 4 official PNG logos.
- `backend/tests/test_flex_payments_and_traveler_info.py` (new, 12 cases).

### Iteration 20 (2026-06-30) — PayPal payment-link flow (end-to-end)
- **Backend**: complete in iteration 19 (this fork extended it):
  - `POST /api/itineraries/{id}/payments/create-link` (auth, idempotent on
    `payment_token`)
  - `GET  /api/payments/{token}` (public landing data)
  - `POST /api/payments/{token}/create-order` (public, creates PayPal Order
    and returns approval_url)
  - `GET  /api/payments/{token}/return` (PayPal redirect → capture → bounce
    back to `/pay/{token}?success=1&kind=…&amount=…` or `?error=…`)
  - `POST /api/paypal/webhook` (signed verification + idempotent mirror)
- **Pricing rules**: deposit (30%) only when `days_to_trip > 60` and no
  captured deposit/full; balance only after deposit captured; full always
  available otherwise. Defense-in-depth: `create-order` re-checks live
  options on POST and 400s on disallowed kinds.
- **Frontend builder UI**: new button `data-testid=payment-link-btn` in the
  ItineraryBuilder header, next to "Compartir con". Opens
  `PaymentLinkModal` (was created last iteration) that surfaces the public
  URL, the pre-filled email/WhatsApp instructions, and the payment history.
- **Public page** (`/app/frontend/src/pages/PublicPayment.jsx` — NEW):
  no-auth `/pay/:token` route registered before ProtectedRoute. Renders
  trip summary, totals (total/paid/remaining), deposit + full payment
  options with PayPal sandbox redirect. Handles success/cancelled/error
  banners from PayPal return redirect.
- **Routing**: `App.js` adds `<Route path="/pay/:token" element={<PublicPayment/>} />`
  before the protected layout so the client never sees the login screen.
- **Tests**: testing_agent_v3_fork covered 11 backend cases + 5 frontend
  steps — 100% pass. Sandbox redirect to `sandbox.paypal.com/checkoutnow`
  verified.

Files touched (iter-20):
- `backend/server.py` — return handler now appends `kind` and `amount` to
  the success redirect querystring so the public page can show a precise
  banner.
- `frontend/src/pages/PublicPayment.jsx` (new — client-facing page).
- `frontend/src/pages/ItineraryBuilder.jsx` — header button + modal mount.
- `frontend/src/App.js` — public `/pay/:token` route.
- `backend/tests/test_paypal_payment_link.py` (new — by testing agent).

## P1 backlog (next)
- Configure PayPal Webhook in PayPal Developer dashboard once production URL
  is live (`PAYPAL_WEBHOOK_ID` env). `verify_webhook` currently returns
  False on missing config (defensive).
- Migrate Preview DB → Production DB (mongodump/mongorestore, coordinated
  with the owner).

### Iteration 19 (2026-06-24) — Sales agent ("Agente de ventas") gets the trip owner
- **Bug from prod**: every trip pushed to Sofi was showing Eduardo as the
  "Agente de ventas" even when Marina, Anita, etc. were the actual owners
  of the itinerary. Cause: the trip header creation code never touched the
  `app_trips___agent` field, so Joomla defaulted it to whoever was logged
  in via `GESTION_VIAJADVERDAD_USER` (Eduardo's credentials).
- **Fix** (`backend/sofi.py`):
  1. Added `EMAIL_TO_SOFI_AGENT_ID` constant mapping each viajadverdad
     agent email → Sofi user_id (extracted from the
     `#app_trips___agent` dropdown options on the live trip form):
     ```
     eduardo → 53, marina → 39, beatriz → 40, anita → 56, raquel → 44,
     rita → 45, hector → 60, janelle → 66, giorgia → 58, karin → 54
     ```
  2. In `push_itinerary_to_sofi`, before submitting the trip header, look
     up `(itn.created_by or "").strip().lower()` against the map and call
     `_safe_select("#app_trips___agent", [str(id)])` so the right agent
     gets stamped on the trip.
  3. Defensive fallback: if `created_by` is missing or not in the map,
     log a warning + append a `filled` entry "sin mapeo para {email}" so
     the operator sees something in the modal preview, but the push still
     succeeds (Sofi falls back to the logged-in user).
- **End-to-end verified**: dry-run with overridden
  `created_by=marina@viajadverdad.com` produced
  `filled = [..., {label: "Agente de ventas (marina@viajadverdad.com)",
  selector: "#app_trips___agent", value: "39"}, ...]` ✅.
- **Regression coverage** (`backend/tests/test_booking_form_data.py`):
  3 new unit tests asserting (a) all 10 known agents are mapped, (b) no
  duplicate Sofi user_ids, (c) keys are lower-cased so the lookup
  matches. Total 18/18 pass in 50ms.

Files touched (iter-19):
- `backend/sofi.py` — `EMAIL_TO_SOFI_AGENT_ID` constant + 16 LOC inside
  `push_itinerary_to_sofi` to stamp the agent FK.
- `backend/tests/test_booking_form_data.py` — 3 new test cases.


### Iteration 22 — Cashflow avanzado (2026-07-03)

**User request (Eduardo)**: 4 new cashflow features on top of the Fora-style
public payment page + Resend notifications from iteration 21:
 1. Hide the traveler-info popup until AFTER the client has paid.
 2. Split payments — several travelers pay their share, ONE invoice.
 3. Sell EXTRA activities post-sale with a separate payment link.
 4. Refund workflow with manager approval (Bea / Marina).

**Implemented**

1. **Traveler-info popup timing** (`frontend/src/pages/PublicPayment.jsx`)
   - `showInfoDialog = paid > 0 || justPaid` — the dialog only auto-opens
     when there is at least one captured payment OR the user just came
     back from PayPal with `?success=1`. Pre-payment the page is a clean
     conversion funnel; the "Complete my details" button is still there
     if the client wants to fill it early.

2. **Split payments** (single invoice, multiple payers)
   - `Payment` model got `payer_name`, `payer_email`, `share_label`,
     `extra_id`. Same `payment_token` = same invoice; multiple Payment
     rows contribute independently.
   - `POST /api/payments/{token}/create-order` accepts the payer fields
     and stores them (also passed to PayPal as payer_email).
   - `GET /api/payments/{token}` exposes a redacted
     `captured_payments[]` list (kind, amount, payer_name, share_label,
     paid_at) so late-arriving travelers see who already paid.
   - `PublicPayment.jsx` — new toggle "Splitting with fellow travelers?"
     (`data-testid=toggle-split`) with `payer-name` + `payer-email`
     inputs. Payment cards recompute the per-share amount (`o.amount /
     N`) and emit `kind="partial"` for the share so multiple PayPal
     orders build up to the same balance. Pay button disabled until
     `payer_name` is filled.

3. **Post-sale extras** (separate payment link per extra)
   - New `PostSaleExtra` model with its own `payment_token` and status
     machine (`draft` → `sent` → `paid` / `cancelled`).
   - `Itinerary.extras: List[PostSaleExtra]` added.
   - `Payment.kind` extended with `"extra"` for standalone captures.
   - Endpoints (all `/api`-prefixed):
     - `POST/GET/DELETE /itineraries/{id}/extras`
     - `GET /payments/extra/{token}` (public)
     - `POST /payments/extra/{token}/create-order` (public)
     - `GET /payments/extra/{token}/return` (public PayPal return)
   - New public page `frontend/src/pages/PublicExtraPayment.jsx` mounted
     at `/pay/extra/:token` (route order matters — placed before
     `/pay/:token`).
   - Builder gets a new `ExtrasModal.jsx` (data-testid=`extras-modal`)
     with title/description/amount/day/date inputs; copy-link button.
   - Deletes of a paid extra are soft-cancelled (audit trail preserved),
     the agent is nudged to file a refund via the Refunds modal.

4. **Refund workflow with manager approval**
   - New `RefundRequest` model (payment_id, service_id, amount_eur,
     reason, requested_by, requested_at, approved_by, decided_at,
     status ∈ {pending, approved, executed, rejected, failed},
     paypal_refund_id, error_message).
   - Approver whitelist hardcoded in `server.py`:
     `REFUND_APPROVERS = {"beatriz@viajadverdad.com",
     "marina@viajadverdad.com"}`.
   - Endpoints:
     - `POST /itineraries/{id}/refund-requests` (any agent) — validates
       amount ≤ captured − already_refunded.
     - `GET  /itineraries/{id}/refund-requests` — returns list +
       `is_approver` flag + `approver_emails`.
     - `POST .../refund-requests/{rid}/approve` — manager-only, calls
       new `paypal.refund_capture()` → hits
       `POST /v2/payments/captures/{cap}/refund`. Marks source Payment
       as `refunded` if fully refunded.
     - `POST .../refund-requests/{rid}/reject` — manager-only, 404 if
       target refund isn't in `pending` state.
   - PayPal client (`paypal.py`) got a new `refund_capture(capture_id,
     amount_eur, note, invoice_id)` helper — supports partial refunds by
     including `amount.value` in the body.
   - Builder gets a new `RefundsModal.jsx` (data-testid=`refunds-modal`)
     that shows the approver-status banner (green if the current user is
     Bea or Marina), lists all refunds with status badges, and only
     renders Approve/Reject buttons for approvers.

**Testing** — `/app/test_reports/iteration_9.json`
- Backend: 19/19 pytest cases pass
  (`backend/tests/test_iteration22_cashflow.py`).
- Frontend: all 4 features verified via Playwright (popup hidden on
  clean itinerary, auto-opens on paid; split toggle reveals payer
  fields and per-share amounts; extras CRUD + copy-link works; refunds
  modal shows approver banner correctly; non-approver → 403).
- Design polish applied post-report: sticky close button on
  TravelerInfoDialog; reject-refund now returns 404 when nothing
  matches.

Files touched (iter-22):
- `backend/models.py` — new `PostSaleExtra`, `RefundRequest`; extended
  `Payment` (payer_name/email/share_label/extra_id, kind="extra");
  `Itinerary` got `extras` and `refund_requests` lists.
- `backend/paypal.py` — new `refund_capture()` helper.
- `backend/server.py` — 10 new endpoints (extras CRUD + public extra
  landing + refund CRUD + manager approve/reject); `captured_payments`
  in the public payment landing; payer_email forwarded to PayPal.
- `frontend/src/pages/PublicPayment.jsx` — popup timing fix; split
  payment section (toggle + payer_name/email + per-share amounts);
  captured_payments ledger.
- `frontend/src/pages/PublicExtraPayment.jsx` — NEW.
- `frontend/src/pages/builder/ExtrasModal.jsx` — NEW.
- `frontend/src/pages/builder/RefundsModal.jsx` — NEW.
- `frontend/src/pages/ItineraryBuilder.jsx` — 3 header buttons wired.
- `frontend/src/App.js` — `/pay/extra/:token` route.


### Iteration 22.1 — Booking-threshold + share-with-next-traveler (2026-07-03)

Follow-up after Eduardo tested split payments end-to-end (1 of 2 paid in
sandbox for 1210,32 €). Two feedback items addressed:

1. **Communication path to the 2nd/3rd payer** — previously the first
   payer had to manually forward the same `/pay/:token` link. Now:
   - After a successful capture (return from PayPal), a
     "Share with the next traveler" card appears on the public page
     with **3 built-in channels**:
     - WhatsApp deeplink (`wa.me/?text=…`) with the trip name, share
       amount and payment URL pre-filled.
     - Copy-to-clipboard button.
     - Send-directly-by-email form (Resend transactional email with
       "Your share of {trip}" — subject, hero, share amount, deposit
       progress line, big "Pay my share" CTA).
   - New endpoint `POST /api/payments/{token}/invite-share` (public)
     that renders + sends via Resend. Body:
     `{email, name?, share_eur?, from_name?}`. The recipient lands on
     the SAME payment_token, so the smart-detect logic added earlier
     auto-populates split.enabled + split.count from the ledger.
   - New template `email_service.render_split_invite_email()` produces
     a Fora-styled HTML+text email (cream background, serif hero,
     terra accent).

2. **"Booking is only reserved at 30%"** — regardless of how many
   travelers split the payment. Made this the single source of truth:
   - Public API now returns `deposit_threshold_eur` and
     `booking_secured: bool` in every `GET /api/payments/{token}`
     response.
   - The `_compute_payment_options` helper computes threshold =
     `full_amount` when trip ≤ 60 days away (deposit isn't offered) or
     `deposit_amount` (30%) otherwise, and secured = paid ≥ threshold.
   - New `BookingProgress` component on the public page renders a
     progress bar (`paid / threshold`) with two states:
     - `secured=false`: terra accent, "Booking reserved when
       {threshold} is collected — {gap} to go · {paid} paid so far"
       plus a small caption explaining that split payments still need
       to cross the threshold together.
     - `secured=true`: olive accent, "Booking reserved · deposit
       collected ({threshold})".
   - The success banner post-capture now also references the
     threshold: "Booking is confirmed once {threshold} of the deposit
     is collected" until the threshold is crossed.

**Files touched** (iter-22.1):
- `backend/server.py` — 2 new fields on the public payment response;
  `POST /api/payments/{token}/invite-share` endpoint + Pydantic body.
- `backend/email_service.py` — `render_split_invite_email()` template.
- `frontend/src/pages/PublicPayment.jsx` — `BookingProgress` component;
  `ShareWithNextTravelerCard` component; conditional rendering after a
  ?success=1 capture; lucide `MessageCircle`, `Copy`, `Mail` icons
  imported.


- Migrate Preview DB → Production DB (mongodump/mongorestore, coordinated
  with the owner).

## P2 backlog
- Rebalance AI Trainer prompt (remove strict budget reliance, focus on
  structural patterns) + admin endpoint to flag experiences with €0 /
  abnormal prices.
- Import "Not Sold" (No vendido) trips for comparative training.
- Comparative analysis: Sold vs Not Sold trips → derive new system-prompt
  rules.
- `server.py` carve-out: routers/sofi.py + services/sofi_push.py before
  adding more integrations (file is 4866 lines).


### Iteration 22.2 — Manual Sofi bookkeeping for post-sale movements (2026-07-03)

**Owner decision**: automation of extras/refunds sync to Sofi is REMOVED.
The trip header + initial bookings push (`POST /api/itineraries/{id}/push-to-sofi`)
stays as-is — that flow is battle-tested and saves the biggest amount of
copy-paste. Post-sale movements (new extras, refund line edits) will be
entered manually by the agent inside Sofi.

**Removed**
- Backend `sofi.py`: `push_extra_to_sofi_as_booking()` +
  `push_refund_to_sofi_as_booking()` helpers (≈240 LOC).
- Backend `server.py`: `POST /api/itineraries/{id}/extras/{extra_id}/push-to-sofi`
  and `POST /api/itineraries/{id}/refund-requests/{refund_id}/push-to-sofi`
  endpoints.
- Frontend `PostSaleSection.jsx`: "Push a Sofi" buttons per extra/refund row,
  "Sofi ✓" green pill, and the `pushToSofi` handlers. Also dropped the
  `itineraryId` and `onChange` props from the component's signature
  (no longer needed since the component is now read-only).

**Kept for audit**
- `extras[].sofi_booking_id` and `refund_requests[].sofi_booking_id` fields
  on the Itinerary doc still exist (never referenced from the UI now).
  Harmless — the DB schema is not migrated so historical rows keep their
  legacy `synced_to_sofi=true` markers.

**Caption update**
- The post-sale section header now reads: "Extras cobrados suman al PVP ·
  reembolsos ejecutados restan del total. Estos movimientos se introducen
  **manualmente** en Sofi (trip #NNNN)."

Files touched (iter-22.2):
- `backend/sofi.py` — deleted 240 LOC (both helpers).
- `backend/server.py` — deleted 2 endpoints (≈95 LOC).
- `frontend/src/pages/builder/PostSaleSection.jsx` — rewrite: removed
  `pushToSofi` handlers, buttons, "Sofi ✓" badges, `useState`, `api`,
  `Send`, `ArrowUpRight`, `CheckCircle2` (kept for status badges).
- `frontend/src/pages/ItineraryBuilder.jsx` — dropped `itineraryId` +
  `onChange` props from `<PostSaleSection>`.


### Iteration 22.3 — Refund approval email notifications (2026-07-03)

**Owner request**: agregar notificaciones por email al flujo de aprobación
de reembolsos para que Bea, Marina y Eduardo se enteren en tiempo real
cuando hay una petición pendiente, y para que el agente que la solicitó
sepa el resultado.

**Backend (`email_service.py`)** — dos templates nuevos:
- `render_refund_request_email(trip_name, main_traveler, amount_eur,
  reason, requested_by, itinerary_url)` — HTML+text en castellano con la
  estética Espíritu Travel (cream `#f4ebd7` + terra accent). Botón grande
  "Revisar y aprobar →" que abre el itinerario en el builder.
- `render_refund_decision_email(trip_name, main_traveler, amount_eur,
  reason, approved, approver_email, decision_note, paypal_refund_id,
  itinerary_url)` — reutilizable para aprobación (verde `#3d7d5b`) y
  rechazo (rojo `#c94433`). Incluye el `paypal_refund_id` cuando aplica.

**Backend (`server.py`)** — 3 endpoints extendidos:
- `POST /itineraries/{id}/refund-requests` → tras guardar, dispara con
  `asyncio.create_task(send_email(...))` un correo a cada dirección en
  `REFUND_APPROVERS` (Beatriz, Marina, Eduardo). Fire-and-forget: si
  Resend falla el endpoint sigue devolviendo 200. `reply_to` = agente
  solicitante para que los aprobadores puedan responder directamente.
- `POST .../refund-requests/{rid}/approve` → tras completar el PayPal
  refund exitoso, envía email a `refund.requested_by` con el
  `paypal_refund_id` y la nota del aprobador. Un fallo en el envío no
  revierte el refund.
- `POST .../refund-requests/{rid}/reject` → envía email al solicitante
  con el motivo del rechazo. Mismo patrón fire-and-forget.

**E2E verificado en sandbox** (2026-07-03):
- 3 emails de petición → `ccb6e8d8-…` (Marina), `ed57d5a6-…` (Eduardo),
  `fc251efe-…` (Beatriz).
- 1 email de rechazo → `014c94fd-…` (a Eduardo, solicitante).
- 1 email de aprobación → `ee31ec1d-…` (a Eduardo, solicitante) tras
  ejecutar refund real en PayPal sandbox (`0MR865132S288554N`).

**No mocks**: usa Resend con dominio `espiritutravel.com` ya verificado.

Files touched (iter-22.3):
- `backend/email_service.py` — 2 helpers nuevos (~150 LOC).
- `backend/server.py` — 3 bloques try/except en los endpoints de
  create/approve/reject para disparar emails (~65 LOC).


### Iteration 22.4 — Cashflow visibility + reminders (2026-07-03)

**Owner request**: dar visibilidad al agente sobre los cobros del viaje —
tanto por email al capturarse un pago como con un widget en el builder,
y añadir un recordatorio automático 5 días antes de que venza el saldo.

**Regla de negocio confirmada**:
- Depósito 30% disponible sólo si `start_date − hoy > 60 días`. Si el
  cliente reserva dentro de esos 60 días, obligatorio pagar full.
- El saldo (o el full si no hubo depósito) debe estar cobrado
  **45 días antes** de la salida.

**Backend**
1. `email_service.py` — dos templates nuevos:
   - `render_payment_captured_email(...)` — cubre deposit, full, balance,
     partial (con `share_label`) y extras post-venta.
   - `render_balance_reminder_email(...)` — recordatorio 5 días antes.
2. `server.py` — hooks fire-and-forget al `created_by`:
   - `payment_return_handler` (línea 2366): tras un capture COMPLETED,
     envía email con importe, tipo (deposit/full/balance/partial), estado
     del cobro global (paid/remaining), booking secured sí/no y link.
   - `extra_return_handler` (línea 2821): mismo comportamiento para
     pagos de extras post-venta.
3. `server.py::balance_reminder_loop()` — task async lanzada en startup:
   - Corre cada hora
   - Busca itinerarios con `start_date = hoy + 50 días`, con al menos un
     `payments[].status='captured'` y `remaining_eur > 0`
   - Envía email al `created_by` y stampa `balance_reminder_sent_on=hoy`
     para no duplicar. Idempotente aunque el backend reinicie varias veces.

**Frontend**
- `CashflowStatus.jsx` (nuevo) — widget compacto en el aside derecho,
  bajo el bloque "PVP final". Muestra:
  - Cobrado / Falta / barra de progreso (verde=asegurado, terra=pendiente)
  - Badge "Reserva asegurada" o "Reserva al llegar a X €"
  - Vencimiento del saldo (start_date − 45d) + countdown en días
    (rojo si vencido, terra si <=5 días, gris en otro caso)
  - Últimos 3 pagos capturados (kind, share_label, fecha, importe)
- 100% cálculo client-side sobre `itn.payments` y `totals.pvp_adjusted`,
  sin llamadas API extra.
- Click sobre la cabecera abre el `PaymentLinkModal` para ver el histórico
  completo y compartir el enlace.
- `ItineraryBuilder.jsx`: import + render bajo el bloque PVP.

**Testing E2E**:
- Widget visible con datos reales en 2 itinerarios (deposit único y
  split 2-of-2), screenshots confirman los valores.
- Email de pago capturado enviado via Resend a eduardo@viajadverdad.com
  (subject `[Pago recibido] Test Cashflow — Autumn Trip · 1840.38 EUR`).
- Email de recordatorio enviado via Resend a eduardo@viajadverdad.com
  (subject `[Recordatorio] En 5 días vence el saldo…`).

**Deployment prep** (misma iteración):
- `backend/.env`: entradas con caracteres especiales entrecomilladas
  (`GESTION_VIAJADVERDAD_PASS`, `RESEND_SENDER_EMAIL`) — fix requerido
  por deployment_agent.
- `FRONTEND_PUBLIC_URL` ya configurado al preview actual; cuando pase a
  prod el owner debe actualizarlo al dominio real.

Files touched (iter-22.4):
- `backend/email_service.py` — 2 helpers nuevos (~170 LOC).
- `backend/server.py` — `balance_reminder_loop` + 2 hooks de captura
  (~110 LOC).
- `backend/.env` — quoted values.
- `frontend/src/pages/builder/CashflowStatus.jsx` (nuevo).
- `frontend/src/pages/ItineraryBuilder.jsx` — import + render.


### Iteration 22.5 — Pre-deploy cleanup (2026-07-03)

**Ready for Monday deploy**:
- `eduardo@viajadverdad.com` **removed** from `REFUND_APPROVERS` (only Beatriz & Marina remain).
- `test.admin@example.com`'s TEST_Trip (John Doe) itinerary deleted from Mongo.
- 3 refund_requests marcadas como "Prueba…" limpiadas del itinerario `itn_19663b2186ae`.
- `backend/.env` values with special chars quoted (`GESTION_VIAJADVERDAD_PASS`, `RESEND_SENDER_EMAIL`).
- deployment_agent scan: **PASS** — no blockers.
- Sticky cotizador con scroll interno para muchos pagos, orden PVP € → PVP $ → Cobros.

**Post-deploy checklist for the owner**:
1. Cambiar `PAYPAL_MODE=live` + credenciales reales (guía abajo).
2. Actualizar `FRONTEND_PUBLIC_URL` al dominio real de producción.
3. Registrar el webhook PayPal en producción y rellenar `PAYPAL_WEBHOOK_ID`.
4. Migrar datos de preview a producción si aplica (mongodump/mongorestore).


### Iteration 22.6 — T&C on payment page + 45→60 day balance fix (2026-07-06)

**Regulatory fix**: the public T&C on espiritutravel.com say "remaining
payments must be paid at least **60 days prior to arrival**", not 45.
Corrected everywhere:
- `backend/server.py::balance_reminder_loop`: `FULL_PAYMENT_DUE_DAYS_BEFORE_TRIP = 60`, offset = 65.
- `backend/server.py::_compute_payment_options`: deposit description now
  reads "El resto se paga al menos 60 días antes del inicio del viaje."
- `email_service.py::render_balance_reminder_email`: docstring 45→60.
- `CashflowStatus.jsx`: `FULL_PAYMENT_DUE_DAYS_BEFORE = 60` + caption.

**T&C block on public payment pages** (English, per owner request):
- `frontend/src/pages/public/TermsAcceptance.jsx` (nuevo, 160 LOC):
  reusable component with collapsible accordion (Proposals, Booking &
  Payments 30% + 60d, Passport 48h, Cancellation, Insurance, Liability),
  external link to `espiritutravel.com/terms-and-conditions/`, and
  mandatory checkbox.
- `PublicPayment.jsx` + `PublicExtraPayment.jsx`: hooked TermsAcceptance
  before CTA. Pay buttons disabled while checkbox unchecked. Acceptance
  stored per-tab in `sessionStorage` so returning payer isn't asked twice.
- Backend legal audit trail: `CreatePayPalOrderBody` + `CreateExtraOrderBody`
  now accept `tos_accepted` + `tos_version`. Endpoint rejects with 400
  "You must accept the Terms & Conditions before paying" if unchecked.
  On success, payment doc stores `tos_accepted_at`, `tos_version`,
  `tos_accepted_ip` (X-Forwarded-For fallback). Added those 3 fields to
  `models.Payment`.

**Verified E2E**:
- `curl -X POST create-order` w/o `tos_accepted` → HTTP 400 with English
  error message.
- `curl -X POST create-order` w/ `tos_accepted=true` → creates PayPal
  order successfully.
- Screenshot on live preview: accordion expands, checkbox toggles,
  buttons enable correctly.

Files touched (iter-22.6):
- `backend/server.py`, `backend/models.py`, `backend/email_service.py`
- `frontend/src/pages/public/TermsAcceptance.jsx` (new)
- `frontend/src/pages/PublicPayment.jsx`, `frontend/src/pages/PublicExtraPayment.jsx`
- `frontend/src/pages/builder/CashflowStatus.jsx`


### Iteration 22.7 — TOS audit badge + deploy safety confirmed (2026-07-06)

- `PaymentLinkModal.jsx`: each payment row now shows a small green
  "T&C aceptados YYYY-MM-DD · IP X.X.X.X" indicator (with the version
  in the tooltip) when the payment has `tos_accepted_at`. Legacy
  payments (pre-TOS) omit the block cleanly — verified via screenshot
  with 6 pre-existing payments (0 badges) and a manually stamped
  payment (1 badge rendered correctly).
- `deployment_agent`: full audit PASS. No blockers, no migration
  needed. New TOS fields on Payment are `Optional[str] = None` so
  existing docs deserialize cleanly. Backend rejects orders without
  `tos_accepted=True` with a clean 400 error message (no crash on
  cached old JS). CORS `*` is fine for Emergent deploy. `load_dotenv`
  has no `override=True`. Supervisor config valid.

**Ready for Monday deploy — no impact to production data.**


### Iteration 22.8 — Root-cause fix for k8s deploy timeout (2026-07-06)

**Root cause identified**: `@app.on_event("startup") seed_database_if_empty()`
was blocking startup. Seed contains ~4 MB of JSON (568 providers, 2430
experiences, 848 hotels, 167 training_examples, 10 allowed_emails, 5
fx_rates). On production MongoDB Atlas (network round-trip per
`insert_many`) the seed took >30-60 s on a fresh DB — longer than the
k8s readiness probe timeout, so the pod never became "ready" and both
deploys (Jul 6 11:20 and 12:21 UTC) failed.

**Fix**: Wrap `seed_if_empty` in an `asyncio.create_task` via the
existing `_spawn_bg()` helper so it runs in the background. Backend now
answers `/api/*` in <1 s. Bootstrap-first-admin logic in
`/auth/session` covers the (brief) window where `allowed_emails` is
still empty; the catalog collections (hotels/experiences/providers)
populate in the seconds while the agent completes the Google OAuth
flow and reaches the dashboard — so the "empty DB visible to user" gap
is effectively zero.

**Verified**: local backend restart with the fix now shows
`Application startup complete` in <1 s while the seed continues to log
in the background. `HTTP 200 in 0.25 s` on `/api/`.

Files touched (iter-22.8):
- `backend/server.py::seed_database_if_empty` — non-blocking via `_spawn_bg`.


### Iteration 22.9 — REAL root-cause of deploy timeout: CI build failing (2026-07-06)

**Root cause finally identified**: Emergent's production build step runs
`yarn build` with `CI=true`, which makes CRA treat ESLint warnings as
errors. Six `react-hooks/exhaustive-deps` warnings across
`AITrainer.jsx`, `PublicPayment.jsx`, `ExtrasModal.jsx`,
`PaymentLinkModal.jsx`, `RefundsModal.jsx` were causing
`yarn build` to fail with exit code 1 during production build. The pod
never got the compiled frontend assets → readiness probe never passed
→ k8s timeout → deploy failed.

Symptoms hid this because:
- `yarn build` without `CI=true` succeeded locally.
- Emergent's deploy logs only reported the k8s timeout, not the build
  failure that caused it.

**Fix**: added `// eslint-disable-next-line react-hooks/exhaustive-deps`
above each of the 6 affected `useEffect` calls. Adding `load` as a real
dep would cause infinite render loops (the function is recreated on
every render).

**Verified**: `cd /app/frontend && CI=true yarn build` now completes in
10 s with no errors. Bundle 184 KB gzipped.


### Iteration 22.10 — All customer-facing communications in English (2026-07-06)

**Owner request**: everything a client sees must be in English (US),
since the target market is US travelers. Agents' internal tools + emails
stay in Spanish.

**Customer-facing pages** (frontend):
- `PublicPayment.jsx` — was already 99% English; changed currency
  format from `es-ES` (`€1.234,56`) to `en-US` (`€1,234.56`).
- `PublicExtraPayment.jsx` — same currency format switch.
- `TripView.jsx` — already 100% English, no changes.

**Customer-facing errors** (backend HTTPException details translated):
- "Enlace de itinerario no válido" → "Invalid itinerary link"
- "Enlace de pago no válido" → "Invalid payment link" (4 occurrences)
- "Enlace de extra no válido" → "Invalid extra link" (4 occurrences)
- "Esta opción de pago no está disponible…" → "This payment option is
  not available for this trip right now"
- "Introduce un email válido." → "Please enter a valid email."
- "Indica la cantidad a pagar" → "Please enter the amount to pay"
- "No se pudo crear la orden en PayPal" → "Could not create the PayPal
  order" (both `/payments` and `/payments/extra`)
- "Importe inválido" → "Invalid amount"
- "La cantidad debe estar entre X y Y €" → "Amount must be between X
  and Y €"

**Emails to CLIENTS**: only `render_split_invite_email()` sends to a
client (the next traveler in a split invoice), and was already in
English. Agent-facing emails (payment received, refund
approval/decision, balance reminder, traveler info) stay in Spanish.

**PayPal receipt**: client automatically receives PayPal's own receipt
email in English because `application_context.locale = "en-US"` in
`paypal.py::create_order`.

Files touched (iter-22.10):
- `backend/server.py` — 10 HTTPException detail strings translated.
- `frontend/src/pages/PublicPayment.jsx` — `Intl.NumberFormat` locale.
- `frontend/src/pages/PublicExtraPayment.jsx` — `Intl.NumberFormat` locale.

**Verified**: backend restarts cleanly, `CI=true yarn build` compiles
in 10.13s.

