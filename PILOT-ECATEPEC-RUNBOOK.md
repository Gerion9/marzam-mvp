# Ecatepec Pilot Runbook

## Scope
- Pilot geography: `Ecatepec de Morelos`
- Field reps: `50`
- Manager roles: `1+`
- Source of truth for pharmacies: tabla externa `blackprint_db_prd.ingestion.ing_poi_farmacias_ecatepec`
- Source of truth for assignment + verification: tabla externa `ingestion.field_survey_pharmacy`
- Source of truth for tracking: tabla externa `ingestion.device_locations`
- Photo evidence storage: `Google Cloud Storage`
- Tracking cadence: `30 seconds` while the rep is in an active route session

## Required Infrastructure
Set these values before pilot launch:

```env
JWT_SECRET=<strong-random-secret>
DB_HOST=<postgres-host>
DB_PORT=5432
DB_NAME=marzam_mvp
DB_USER=<db-user>
DB_PASSWORD=<db-password>

DATA_BACKEND=external
EXTERNAL_DATA_PROVIDER=sql
EXTERNAL_POI_TABLE=blackprint_db_prd.ingestion.ing_poi_farmacias_ecatepec
EXTERNAL_FIELD_SURVEY_TABLE=ingestion.field_survey_pharmacy
EXTERNAL_DEVICE_LOCATIONS_TABLE=ingestion.device_locations

PHOTO_STORAGE_PROVIDER=gcs
GCP_PROJECT_ID=<gcp-project-id>
MARZAM_EVIDENCE_GCS_BUCKET=<bucket-name>
MARZAM_EVIDENCE_GCS_FOLDER=marzam/verificaciones/photos
GCS_PUBLIC_BASE_URL=https://storage.googleapis.com
GCS_MAKE_OBJECTS_PUBLIC=false
GCS_SIGNED_URL_TTL_MINUTES=20

BQ_PROJECT_ID=<bigquery-project-id-if-needed>
BQ_SERVICE_ACCOUNT_JSON=<json-inline-or-secret-injected-if-bq-or-gcs-uses-it>

GPS_PING_INTERVAL_SECONDS=30
GPS_RETENTION_DAYS=30
```

Recommended secret handling:
- rotate the exposed service account before pilot launch
- inject `BQ_SERVICE_ACCOUNT_JSON` from Secret Manager or runtime env
- do not commit credentials to the repo
- keep `GCS_MAKE_OBJECTS_PUBLIC=false` unless the pilot explicitly accepts public evidence URLs

Provider note:
- if you use the table names from this plan as-is, `EXTERNAL_DATA_PROVIDER=sql` is the safer default
- switch to `bigquery` only when the table refs are real `project.dataset.table` identifiers

## First-Time Setup
1. Install dependencies.

```bash
npm install
```

2. Run migrations for auth/support tables.

```bash
npm run migrate
```

3. Seed the default manager user.

```bash
npm run seed
```

4. Validate external connectivity before giving access to reps.

```bash
npm run check:external
```

5. Start the app.

```bash
npm run dev
```

6. Use manager UI or `POST /api/assignments/distribute` to create the first wave directly over the external operational table.

## What External Mode Does
- Reads pharmacies from the external Ecatepec source table
- Writes assignment and verification state to `field_survey_pharmacy`
- Writes rep pings to `device_locations`
- Uses local PostgreSQL only for support concerns such as auth and active users
- Resolves photo access through signed URLs when the bucket is private

## Day-0 Smoke Test
Before releasing the pilot to all reps, verify:
- Manager can log in
- Manager can see pharmacies on the map
- Manager can open the Assignments tab and use `Auto Distribute Wave`
- Rep can log in and load an assignment
- Rep can enable GPS and send a ping
- Rep can check in to a pharmacy
- Rep can submit a visit with a photo
- Manager can see the evidence photo and comment from the pharmacy drawer
- Manager can see the rep trail in the `Reps` tab
- `npm run check:external` returns `ok: true`

## Operating Model
- A pharmacy should have one active owner in the first wave
- The latest operational row per pharmacy lives in `field_survey_pharmacy`
- A visit is considered operationally valid when it has:
  - check-in coordinates
  - comment
  - photo evidence
- Exceptions such as `closed`, `duplicate`, `moved`, or `wrong_category` remain visible through visit and regularization status

## Recommended Device Policy
- Preferred devices: `Android + Chrome`
- iPhone/Safari is allowed, but tracking should be considered session-based, not guaranteed in background
- Reps should keep location permission set to precise while working

## Tracking Retention
High-resolution tracking points are written to `ingestion.device_locations`.

Operational recommendation:
- retain raw pings at least `30 days`
- define pruning/archival policy on the external platform owner side
- validate manager polling every `15-30s` under real mobile conditions

## Evidence Storage Layout
Evidence objects are stored in GCS using this path shape:

```text
marzam/verificaciones/photos/{state}/{municipality}/{assignmentOrVisit}/{pharmacyId}_{timestamp}.{ext}
```

The operational reference persisted in `field_survey_pharmacy` is `photo_url`.

Recommended access model:
- store canonical `photo_url`
- keep bucket objects private when possible
- resolve signed URLs from backend for manager evidence screens and exports

## Incident SOP
### GPS not updating
- Ask the rep to reopen the assignment and re-enable GPS
- Confirm the browser still has location permission
- Confirm mobile data is active

### Photo upload fails
- Retry from stable connectivity
- Check bucket permissions and service account access
- Confirm file size is under `10 MB`
- Confirm the evidence URL resolver can sign/read the object when bucket is private

### Pharmacy already assigned
- Use manager reassignment flow
- Do not duplicate ownership manually in the external operational table

### Rep cannot see assignment
- Confirm the user is active
- Confirm there is a current row in `field_survey_pharmacy` for that rep and pharmacy/wave
- Confirm assignment status is not `cancelled`

### Evidence visible but image broken
- Validate `photo_url`
- Validate GCS object existence
- Validate signed URL generation or object ACL/public policy

## Pilot Closure Metrics
- Total assigned pharmacies
- Completed verifications
- Verifications with photo
- Verifications with comment
- Follow-up required
- Invalid or closed points
- Rep trail coverage by day
