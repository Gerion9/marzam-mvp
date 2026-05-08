# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Marzam Pharmacy Market Capture Platform — a Node.js/Express backend + static-served frontend (`src/public/*.html`) for managing independent-pharmacy field sales: territory assignment, ordered route execution, GPS tracking, structured visit forms with photo evidence, and a manager review queue. See `PRD.md` for product scope and `docs/ROADMAP-PRODUCTION.md` for deployment state.

The codebase is **CommonJS Node 18+**, deployed on **Vercel** (`api/index.js` → `src/app.js`), with **Vercel Cron** triggering background jobs (see `vercel.json`).

## Commands

```bash
npm run dev              # nodemon src/index.js — local dev server on PORT (default 4000)
npm start                # production: node src/index.js
npm run lint             # eslint src/
npm test                 # node --test tests/  (node:test, no Jest/Mocha)
node --test tests/visits/stateMachine.test.js   # run a single test file

# Knex migrations (against the app DB; uses unpooled connection — see knexfile.js)
npm run migrate          # knex migrate:latest
npm run migrate:rollback
npm run seed

# Marzam Source sync (Postgres → Postgres, despite the "bq" naming — see docs/bq-sync.md)
npm run bq:inspect       # schema diff between source tables and the job mappings
npm run bq:dry-run       # transactional ROLLBACK preview
npm run bq:sync          # commit
npm run bq:sample        # bq-sync-dry-run.js --limit 50

# Excel/CSV import validation (parser-only OR full DB dry-run with rollback)
npm run validate:import -- --kind employees --file ./inicial/x.xlsx --db
# kinds: employees | marzam-clients | daily-sales | sales-targets

# Auth directory (virtual user JSON for AUTH_DIRECTORY_PROVIDER=virtual)
npm run auth:summary     # human-readable summary
npm run auth:generate    # emits AUTH_DIRECTORY_JSON=... line for .env

# Pilot bootstrap / data
npm run bootstrap:ecatepec-pilot
npm run import:ecatepec
npm run import:colonias
npm run seed:territories
npm run check:external   # connectivity probe to external Postgres / GCS / BQ
```

Knex CLI uses the `migrations` environment from `knexfile.js`, which intentionally bypasses the pooler (PgBouncer transaction-mode is incompatible with migration session features).

## High-level architecture

### Single Express app, modular routers

`src/app.js` wires Helmet, CORS, JSON, request-context, soft-auth, and three rate limiters (`/api/auth/login`, `/api/tracking/ping*`, and a global `/api/` limiter — all keyed by user id when authenticated, IP otherwise). It then mounts ~30 module routers under `/api/*`. Each module under `src/modules/<name>/` follows the `<name>.routes.js` → `<name>.controller.js` → `<name>.service.js` convention.

A **boot-time refusal** in `src/app.js` exits if `NODE_ENV=production` and `SCOPE_FILTERING_ENABLED=false` — the safety net that keeps "demo accidentally became prod" from shipping.

### Two data backends, controlled by `DATA_BACKEND`

`config.dataBackend === 'local'` uses the app Postgres via `src/config/database.js` (Knex). `config.dataBackend === 'external'` reads POI/visits/locations from a separate external Postgres via `src/config/externalDatabase.js` and `src/repositories/external/*`, with a JSON file fallback (`src/public/data/ecatepec-demo.json`). The `marzam-readonly` module reads the Marzam source DB directly via `src/integrations/marzamSource/client.js` — see "current production state" below.

### App schema lives in `marzam_app`

`knexfile.js` pins `searchPath = ['marzam_app', 'public']` and stores `knex_migrations` inside `marzam_app`, because the available DB user has no `CREATE` in `public`. PostGIS extensions stay in `public`. There are 76+ migrations; never edit a committed migration — add a new one.

### Authentication: JWT + virtual directory + soft-auth

Three layers:
- `src/middleware/softAuth.js` runs on every request — populates `req.authUserId` if a valid Bearer token is present, otherwise no-ops. This exists so rate limiters can key by user id even on routes that don't strictly require auth.
- `src/middleware/auth.js` (`authenticate`) is the hard gate — verifies JWT, builds `req.user` and `req.scope`, and translates legacy virtual ids (e.g. `u-dir-001`) to canonical UUIDs via `accessDirectory.toCanonicalId`. Also accepts `?token=` because EventSource (SSE) cannot set headers.
- `AUTH_DIRECTORY_PROVIDER=virtual` pulls users from `AUTH_DIRECTORY_JSON` env var (181 Marzam employees materialized from the source DB). Switch to `database` once the `users` table is migrated. See `docs/auth-directory.md`.

### Roles, RBAC, and scope filtering — the three things that gate every endpoint

- **Roles** (`src/constants/roles.js`): `admin` › `director_sucursal` › `gerente_ventas` › `supervisor` › `representante`. Many legacy aliases (`manager`, `national_admin`, `regional_manager`, `area_coordinator`, `field_rep`, plus Spanish forms from RH) are normalized via `normalizeRole()`. **Always** call `normalizeRole()` before comparing roles.
- **RBAC** (`src/middleware/rbac.js`, function `authorize`): two call signatures — legacy `authorize('role1', 'role2')` and modern `authorize({ roles: [...], check: req => bool, adminOnly: false })`. `admin` is implicitly allowed on every non-empty gate; use `adminOnly: true` to invert that.
- **Scope filter** (`src/middleware/scopeFilter.js`): every territory-aware query must pipe through `applyTerritoryFilter(qb, column, scope)` or, for in-memory rows, `filterByScope(rows, scope)`. Globals (`is_global`) bypass; otherwise it filters by `accessibleTerritoryIds` (or `whereRaw('1=0')` if empty). Disabled only when `SCOPE_FILTERING_ENABLED=false` AND `NODE_ENV !== 'production'` — the boot guard enforces this in prod.

### Demo write-blocker

`src/middleware/demoReadonly.js` is mounted globally on `/api/` after `softAuth`. Any user with `data_scope === 'demo'` or email `@demo.marzam.mx` has writes (POST/PUT/PATCH/DELETE) short-circuited with synthetic responses — the DB is never touched. Reads pass through. Always-allowed paths: `/api/auth/login|me|logout|impersonate*` and `/api/health`.

### Cron-triggered background jobs

Vercel Cron (`vercel.json`) hits these endpoints. Each is gated by `adminOrCron` — accepts an `x-cron-secret` header matching `CRON_SECRET`, OR a logged-in admin. Adding a new cron requires both the `vercel.json` entry AND a `GET` handler (Vercel Cron only sends GET; we expose POST as an admin-invocation alias).

| Path | Schedule | Owner module |
|---|---|---|
| `/api/admin/imports/_worker` | `*/2 * * * *` | `imports/` (Excel/CSV → DB) |
| `/api/admin/bq-sync/_worker` | `0 */6 * * *` | `bq-sync/` (5 jobs in fixed order) |
| `/api/alerts/_evaluate` | `*/5 * * * *` | `alerts/` |
| `/api/admin/cron/purge-route-cache` | `30 9 * * *` | `services/routesMatrix.js` |
| `/api/admin/cron/purge-tracking` | `0 9 * * *` | tracking retention (`TRACKING_RETENTION_DAYS`) |
| `/api/admin/cron/geocode-backfill` | `0 10 * * *` | `services/geocoder.js` |
| `/api/admin/quadrants/snapshot` | `0 8 * * 0` | weekly Pareto snapshot |
| `/api/admin/cron/purge-live-outbox` | `15 9 * * *` | live SSE outbox retention |
| `/api/admin/cron/parse-opening-hours` | `0 3 * * *` | nightly opening-hours parse |

Each cron writes to `cron_runs` (migration 067) for `/api/admin/scheduler/health`.

### bq-sync — Postgres-to-Postgres sync (NOT BigQuery)

Naming is historical. The 5 jobs in `src/modules/bq-sync/jobs/` run in **fixed order**, each tolerant of partial state, each emitting non-fatal warnings to `bq_sync_warnings`:

```
syncCuadroBasico → syncProspectScored → syncDetalleMostrador → syncHierarchy → syncClientsEcatepec
```

Order matters: `cuadroBasico` creates `users`, `detalleMostrador` creates `marzam_clients` referencing them, `hierarchy` derives the rep→supervisor→gerencia chain that doesn't exist explicitly in source, and `clientsEcatepec` matches `marzam_clients.pharmacy_id ↔ pharmacies.dataplor_id`. Read `docs/bq-sync.md` before touching this — the email synthesis (`<clave>@marzam.mx`), gerente code synthesis (`GER_<APELLIDO>`), and token-based name matching are load-bearing.

### Visit outcomes: data not state machine

`src/modules/visits/visits.stateMachine.js` exports outcome lists, not transitions. Photo evidence is required for **every** outcome (Marzam Execution Doc §6.3 — see `tests/visits/stateMachine.test.js` which asserts `OUTCOMES_REQUIRING_PHOTO === VISIT_OUTCOMES`). Specific outcomes trigger side-effects: `interested` → commercial lead, `needs_follow_up` → followup row, skip outcomes (`closed/duplicate/moved/wrong_category/chain_not_independent/invalid`) → review-queue flag.

### Frontend: server-rendered static HTML, no SPA build

`src/public/{manager,manager-live,rep,app}.html` are served directly by Express and statically by `@vercel/static` in production. There is **no bundler, no build step, no JSX**. Editing a file under `src/public/` is the deploy. The `vercel.json` route block routes `/manager`, `/manager-live`, `/rep`, `/app` through the API (so they get the static-fallback served by `app.js`), and everything else from `src/public/`.

### Tests

Plain `node:test`. Tests live in `tests/<area>/*.test.js` and import from `src/...` directly — no test DB or fixtures harness; tests are pure-logic only. Anything DB-touching is exercised through `validate:import --db` (rollback) or `bq:dry-run`.

## Production state and current constraints

**Updated 2026-05-06.** Empirical probe (see `scripts/probe-create-permission.js`, `scripts/probe-migration-readiness.js`, `scripts/probe-data-presence.js`) shows the migrations blocker described in earlier revisions is **resolved**:

- All **78 migrations** (001..078, including the new 077 import-jobs heartbeat and 078 audit-events archive) are applied in `35.211.253.113:5432/blackprint_db_prd` inside the schema `marzam_app`. `ingestion_user` is the schema owner.
- Extensions: PostGIS 3.6.1 (in `public`), `uuid-ossp`, `pgcrypto` (both in `marzam_app`).
- `ingestion_user` empirically has `CREATE` on `ingestion` and on `marzam_app`. It still lacks `CREATE` on `public` — that's why `knex_migrations` lives inside `marzam_app`. PostGIS in `public` was installed by a superuser; the app does not need to recreate it.
- Master data is loaded: 181 `users` (157 reps + 17 supervisores + 6 gerentes + 1 director), 180 `employee_profiles`, 3 121 `pharmacies` (Ecatepec pilot), 32 `marzam_clients`, 1 `branch` ("Sucursal Ecatepec").

Operational tables are still empty (`visit_plans`, `territory_assignments`, `gps_pings`, `audit_events`, `cron_runs`, `import_jobs`, `visit_reports`, `pharmacy_onboardings`) — the system is in a **pre-launch** state, not a degraded one. Cron jobs aren't yet writing to `cron_runs`, so either Vercel Cron isn't pointed at this deployment, or the cron secret isn't aligned.

Two follow-ups still tracked in `docs/qa-production-readiness.md`:

- `AUTH_DIRECTORY_PROVIDER` is still `virtual` in env even though `users` has the 181 rows. Flip to `database` once login flow is validated against the table.
- `marzam-readonly` module (`src/app.js:31`) is still mounted. Decide whether to retire it now that `marzam_app` has its own data, or keep it as a fallback.

For the original migrations narrative (the historical "data team has not granted CREATE" story) see `docs/qa-production-readiness.md` Section 1, which preserves both the pre- and post-resolution context.

## Conventions worth knowing

- Always quote tracking sensitivity. `rep_tracking_points` is purged daily; preserve that retention behavior unless asked.
- Don't add `console.log` for debugging in committed code; the project uses `src/utils/logger.js` and Morgan for HTTP. ESLint has `no-console: off` so existing logs aren't flagged.
- Audit-relevant writes go through `auditLog('event.name')` middleware (see visits routes for examples).
- The `tmp_*.js` smoke/E2E throwaways live under `scripts/smoke/` (gitignored). Don't import from them; don't add new ones to the build. Repo root must stay clean of `tmp_*` files.
- Frontend JS at `src/public/js/*.js` is shipped raw — no bundle/minify step. Audit P8 deferred until after launch; if a `npm run build:public` is added, gate it on `NODE_ENV=production` and emit to `src/public/js/dist/`. Don't rewire HTML loaders without verifying mobile/3G UX in browser.
- `accessDirectory.toCanonicalId` (`src/services/accessDirectory.js:176-194`) translates legacy virtual ids like `u-dir-001` to UUIDs via `uuidv5(id, NAMESPACE)` with a fixed namespace. Theoretically a forged virtual id could collide with a real user UUID; probability is astronomically low (~2^-122 per derivation), but if you ever introduce a new virtual-id format, prefer per-format namespaces over reusing the existing one. Audit S13.
- `inicial/`, `docs/`, `scripts/`, `.cursor/` are all gitignored — content there is local-only or generated.
