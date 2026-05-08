# QA Staging — Setup runbook (lo que tú ejecutas en Vercel + GCP)

> Generado: 2026-05-07
> Este doc es el complemento operacional al plan en `~/.claude/plans/hay-un-qa-engineer-streamed-dongarra.md`.

Aquí están los pasos UI que requieren tus credenciales de Vercel y GCP. Yo no puedo automatizarlos desde la terminal — pero te dejo cada step listo para ejecutar mecánicamente.

**Pre-requisito:** Claude ya completó:
- DB Neon migrada (84 migraciones aplicadas, 59 tablas en `marzam_app`)
- 500 colonias + 2,053 farmacias Ecatepec importadas
- 4 territorios sintéticos (MX > EMX > Ecatepec)
- 5 cuentas QA + 20 pilot reps insertados
- `qa-credentials.local.md` (gitignored) — credenciales en claro
- `qa-env-vars.local.txt` (gitignored) — env vars rotadas listas para pegar
- `docs/QA-ENDPOINTS.md`, `docs/QA-RBAC-MATRIX.md`, `docs/QA-FLOWS.md`, `docs/QA-ONBOARDING.md`

---

## U1. Crear proyecto Vercel staging

1. Ir a [vercel.com/new](https://vercel.com/new) (logged in con tu cuenta).
2. **Import Git Repository** → selecciona el repo de Marzam (mismo que prod).
3. **Configure Project:**
   - **Project Name:** `marzam-qa`
   - **Framework Preset:** "Other" (Vercel detecta `vercel.json` automáticamente).
   - **Root Directory:** `./` (default).
   - **Build Command:** dejarlo vacío (no hay build).
   - **Output Directory:** dejarlo vacío.
   - **Install Command:** `npm install` (default).
4. **NO presiones "Deploy" todavía.** Click "Environment Variables" para configurarlas primero.
5. Production branch: `main` (default — o si prefieres aislar, crea un branch `qa-staging` y configúralo aquí).

> **Importante:** este proyecto NO debe deploy desde el branch `main` automáticamente si planeas seguir mergeando hotfixes a prod. Para evitar que cada merge a main toque QA, considera crear un branch `qa` y apuntar el proyecto staging ahí.

---

## U2. Setear environment variables en Vercel

1. En Vercel project `marzam-qa` → **Settings** → **Environment Variables**.
2. Abrir `qa-env-vars.local.txt` (en raíz del repo, gitignored).
3. Por cada línea `KEY=VALUE` no comentada, pegar como variable nueva:
   - **Key:** lado izquierdo del `=`
   - **Value:** lado derecho del `=`
   - **Environments:** marcar **Production** (y Preview si quieres ver previews del staging).
4. **OJO con `AUTH_DIRECTORY_JSON`** — es un JSON gigante. Pégalo como una sola línea (Vercel lo guarda OK). NO pongas saltos de línea dentro.
5. **OJO con `DATABASE_URL_POOLED`** — debe terminar en `-pooler.<host>` (Neon usa endpoints distintos para pooled vs unpooled). Si Neon te dio solo el unpooled, usa el mismo URL para ambos: la app tolera serverless con max=5 sin pooler.
6. **GCS_SERVICE_ACCOUNT_JSON queda pendiente** — la generamos en U3.

**Variables clave que NUNCA debes copiar de prod a staging:**
- `JWT_SECRET` — secretos rotados (los del paso de generación están en `qa-env-vars.local.txt`)
- `CRON_SECRET`
- `BOOTSTRAP_TOKEN`
- `DATABASE_URL` — debe ser Neon staging, NO la de prod

---

## U3. Crear bucket GCS staging + service account

### 3a. Bucket

1. GCP Console → [Cloud Storage](https://console.cloud.google.com/storage) → "Create".
2. **Name:** `marzam-qa-photos`
3. **Location:** `us-central1` (single region — más barato).
4. **Storage class:** Standard
5. **Access control:** **Uniform** (NO Fine-grained — uniform es más seguro).
6. **Public access prevention:** **Enforced** (bloquea hasta cambios IAM accidentales que lo expongan).
7. Click "Create".

### 3b. Service Account

1. GCP Console → [IAM & Admin → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts) → "Create Service Account".
2. **Name:** `marzam-qa-storage`
3. **Description:** "Acceso a marzam-qa-photos para staging QA"
4. Click "Create and continue".
5. **Grant roles a este service account:** ninguno aquí (vamos a granular en el bucket).
6. Click "Done".
7. En el listado de SAs, abre el recién creado → tab "Keys" → "Add Key" → "JSON".
8. Descarga el `.json`. **NO lo commits.** Guárdalo en lugar seguro (Bitwarden/1Password).

### 3c. Permitir SA en el bucket

1. Vuelve al bucket `marzam-qa-photos` → tab "Permissions" → "Grant Access".
2. **New principals:** email del service account (algo tipo `marzam-qa-storage@<project>.iam.gserviceaccount.com`).
3. **Role:** `Storage Object Admin` (read/write/delete dentro del bucket, NO list).
4. Click "Save".

### 3d. Pegar el JSON en Vercel

1. Abrir el archivo `.json` descargado en U3.b.7.
2. Copiar TODO el contenido (incluye los `\n` de la private key — Vercel los maneja).
3. En Vercel → Environment Variables → editar `GCS_SERVICE_ACCOUNT_JSON` → pegar.
4. Marcar Production.
5. Save.

---

## U4. Disparar primer deploy

1. Vercel project `marzam-qa` → **Deployments** → "Redeploy" (o el primer deploy si no hay ninguno).
2. Selecciona el branch deseado, click "Deploy".
3. Espera ~1-2 min.
4. Si falla, los logs en Vercel mostrarán por qué (probablemente env var faltante). Reportame en chat el error y lo desbugueamos juntos.

**Casos típicos de boot failure:**
- `[boot] refusing to start. Reasons: SCOPE_FILTERING_ENABLED=false in production` → no marcaste `SCOPE_FILTERING_ENABLED=true` o lo pusiste en otro env distinto a Production.
- `[boot] JWT_SECRET is required` → falta env var.
- `[boot] AUTH_DIRECTORY_PROVIDER is required` → falta env var.
- `connect ECONNREFUSED` → DATABASE_URL mal o Neon dormido (Neon free tier auto-suspende; el primer request despierta).

---

## U5. Smoke tests post-deploy

Una vez que el deploy reporte "Ready", dispara estos curl desde tu terminal:

```bash
# Health check (público, no auth)
curl https://marzam-qa.vercel.app/api/health | jq

# Login admin
TOKEN=$(curl -sX POST https://marzam-qa.vercel.app/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"qa-admin@marzam.test","password":"<de qa-credentials.local.md>"}' \
  | jq -r .token)
echo "Admin token: $TOKEN"

# /api/auth/me con admin
curl https://marzam-qa.vercel.app/api/auth/me -H "Authorization: Bearer $TOKEN" | jq

# RBAC test: /api/users con rep token (esperado 403)
REP_TOKEN=$(curl -sX POST https://marzam-qa.vercel.app/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"qa-rep@marzam.test","password":"<de qa-credentials.local.md>"}' \
  | jq -r .token)
curl -i https://marzam-qa.vercel.app/api/users -H "Authorization: Bearer $REP_TOKEN"
# Esperado: HTTP 403

# Cron health (admin)
curl https://marzam-qa.vercel.app/api/admin/scheduler/health -H "Authorization: Bearer $TOKEN" | jq
```

Si todo lo anterior pasa, el staging está vivo y aislado. Listo para entregarle al QA.

---

## U6. Handoff al QA

**Lo que entregas:**
1. URL: `https://marzam-qa.vercel.app`
2. Credenciales del archivo `qa-credentials.local.md` — vía canal seguro (Bitwarden/1Password/Signal). NO email plano, NO Slack en claro.
3. Docs (los que no están en repo por `.gitignore`): zippea o sube a Drive interno y comparte con el QA:
   - `docs/QA-ONBOARDING.md` (lectura obligatoria día 1)
   - `docs/QA-ENDPOINTS.md`
   - `docs/QA-RBAC-MATRIX.md`
   - `docs/QA-FLOWS.md`
   - `docs/openapi.yaml`
   - `docs/marzam-qa.postman_collection.json` (cuando esté lista)
   - `tests/UAT-ECATEPEC-CHECKLIST.md` (58 items UAT manual)
4. Walkthrough de 30-45 min con el QA cubriendo: tour del staging, auth, impersonate, primeros smoke tests, canal de bug reports.

**Canal de bug reports:** define con el QA. Sugerencias:
- Linear / Jira (si ya tienes)
- GitHub Issues (privado)
- Slack channel dedicado #qa-marzam-staging

---

## U7. Mantenimiento durante el QA

- **Re-seed staging:** si los datos se corrompen o quieres reset:
  ```powershell
  $env:DATABASE_URL = $env:NEON_TEST_CONNECTION_STRING
  # Truncate las tablas operacionales (NO users, branches, pharmacies)
  # Y re-corre solo:
  $env:AUTH_DIRECTORY_JSON = '[]'
  node scripts/seed-qa-accounts.js  # idempotente, actualiza passwords
  ```
- **Rotar passwords QA:** corre `node scripts/seed-qa-accounts.js` de nuevo y entrega el nuevo `qa-credentials.local.md`.
- **Detener staging:** en Vercel project → Settings → Pause project. Los crons dejan de disparar.
- **Eliminar staging:** Vercel → Delete project + Neon → delete branch del DB.

---

## U8. Costos estimados

- **Vercel Hobby tier:** gratis (100 GB bandwidth, 100 hours compute). Suficiente para 1 QA + smoke tests.
- **Neon Free tier:** gratis hasta 0.5 GB storage y 191 hours/mes de compute. El staging cabe holgado.
- **GCS:** Free tier 5 GB/mes. Si el QA sube ≤500 fotos de prueba, gratis.
- **GCP egress:** los smoke tests no superan los $5/mes en peor caso.

Total esperado: **$0/mes**. Si Marzam quiere pasar a Pro tier (más performance, más storage), $20/mes Vercel Pro + $19/mes Neon Pro + ~$5 GCP = **~$45/mes**.
