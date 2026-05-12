---
name: ascii-flow
description: Genera diagrama ASCII de data-flow para un área del repo de Marzam antes de codear. Cubre inputs, outputs, side-effects, decision tree y FK chain. Útil antes de tocar zonas frágiles como bq-sync (5 jobs en orden fijo), scope filter + RBAC, visits state machine, o migraciones con FK chains.
---

# /ascii-flow [area]

Genera un diagrama ASCII del data-flow para un área del repo **antes** de implementar cambios. Cubre 5 dimensiones:

1. **Inputs** — qué llega (request, fila de DB, evento de cron).
2. **Outputs** — qué se produce (response, registro insertado, side-effect en otra tabla).
3. **Side-effects** — escrituras a tablas, llamadas a servicios externos, emisión de eventos.
4. **Decision tree** — branches (if/else, switch, normalización de roles).
5. **FK chain** — qué FKs se atraviesan, en qué orden.

## Invocación

- `/ascii-flow` — sin argumento; infiere el área del contexto de la conversación actual (archivos abiertos, módulo en discusión).
- `/ascii-flow bq-sync` — plantilla pre-definida.
- `/ascii-flow scope-filter` — plantilla pre-definida.
- `/ascii-flow visits-state-machine` — plantilla pre-definida.
- `/ascii-flow migration <name>` — lee la migración y dibuja FKs introducidos + roll-back implications.
- `/ascii-flow <otra área>` — genera desde cero leyendo los archivos relevantes (targeted, no recursivo).

## Plantillas pre-definidas

### bq-sync

Los 5 jobs corren en orden fijo. Cualquier reorden rompe FKs silenciosamente.

```
External Postgres (marzam source)              marzam_app (Vercel Postgres)
  │                                              │
  │  1. syncCuadroBasico ───────────────────►   users (181 rows)
  │     (clave_cuadro_basico → role)             │
  │                                              ▼
  │  2. syncProspectScored ─────────────────►   pharmacies.score_metadata
  │                                              │
  │  3. syncDetalleMostrador ───────────────►   marzam_clients (32 rows)
  │     (FK: assigned_rep_id → users)            │
  │                                              ▼
  │  4. syncHierarchy ──────────────────────►   users.manager_id (rep→sup→ger)
  │     (synthesized from clave pattern)         │
  │                                              ▼
  │  5. syncClientsEcatepec ────────────────►   marzam_clients.pharmacy_id
  │     (match: dataplor_id ↔ pharmacy)         (FK: pharmacies)
  ▼
  bq_sync_warnings (non-fatal issues)
```

**Invariantes críticos:**
- El orden NO se puede cambiar — cada job depende de las tablas que el anterior pobló.
- `syncCuadroBasico` debe correr primero porque crea `users` que `syncDetalleMostrador` referencia.
- `syncHierarchy` se sintetiza de `clave_cuadro_basico` (3 letras + 00 = supervisor, 5 caracteres = rep). Si cambia el formato source, este job rompe en silencio.
- Cada job es tolerante a partial state y emite warnings non-fatales a `bq_sync_warnings`.

### scope-filter + rbac

```
Request → softAuth (sets req.authUserId if Bearer present)
       │
       ▼
       authenticate (hard gate)
       │  → toCanonicalId (uuidv5 for virtual ids like u-dir-001)
       │  → builds req.user + req.scope
       │
       ▼
       authorize({ roles, check, adminOnly })
       │  → normalizeRole(req.user.role)   # admin implicitly allowed unless adminOnly:true
       │
       ▼
       Controller
       │
       ▼
       applyTerritoryFilter(qb, column, req.scope)
       │  ├── is_global → bypass
       │  ├── accessibleTerritoryIds[] → .whereIn(column, ids)
       │  └── empty → whereRaw('1=0')      # explicit empty result
       │
       ▼
       Knex query

Boot guard: NODE_ENV=production && SCOPE_FILTERING_ENABLED=false → process.exit(1)
```

**Invariantes críticos:**
- `normalizeRole` debe llamarse SIEMPRE antes de comparar roles. Hay 8+ aliases legacy (`manager`, `national_admin`, `regional_manager`, `area_coordinator`, `field_rep`, plus Spanish forms).
- Si `accessibleTerritoryIds` está vacío, devolver `whereRaw('1=0')` — NO bypassear el filtro.
- Admin pasa cualquier `roles: [...]` no-vacío automáticamente. Usar `adminOnly: true` para invertirlo.

### visits-state-machine

```
Visit submitted (outcome + photo)
  │
  ├── Photo evidence ALWAYS required (Marzam Execution Doc §6.3)
  │   → OUTCOMES_REQUIRING_PHOTO === VISIT_OUTCOMES
  │   (tests/visits/stateMachine.test.js valida esta igualdad)
  │
  ▼
  Outcome dispatch:
    ├── interested ───────────────► insert commercial_lead row
    ├── needs_follow_up ──────────► insert visit_followup row
    ├── closed / duplicate /
    │   moved / wrong_category /
    │   chain_not_independent /
    │   invalid (skip outcomes) ──► insert review_queue_flag row
    │                              (manager triage required)
    └── completed / no_response ──► (no side-effect; just record)
  │
  ▼
  visits row written + audit_event emitted
```

**Invariantes críticos:**
- Foto es OBLIGATORIA para TODOS los outcomes — no hay excepción "completed without photo".
- Skip outcomes generan flag para review-queue; un manager debe actuar.

### migration <name>

Para una migración con FK nuevo:

```
ALTER TABLE child ADD COLUMN parent_id UUID
  REFERENCES parent(id) ON DELETE [CASCADE|SET NULL|RESTRICT];

Up:
  1. Add column (nullable initially)
  2. Backfill from source table
  3. Set NOT NULL if applicable

Down (roll-back impact):
  - Dropping the column drops the FK. Rows en child quedan.
  - Si backfill referenció data ya borrada: orphans.

Cron implications:
  - ¿Algún cron job (validate-import, bq-sync, alerts) referencia este FK?
  - cron_runs table records — ¿el schedule continúa?
```

## Output format

Bloque ASCII en code-fence + sección "**Invariantes críticos**" listando lo que NO debe romperse al modificar. Si la generación toma > 90 segundos, dividir en (a) diagrama y (b) invariantes en dos mensajes.
