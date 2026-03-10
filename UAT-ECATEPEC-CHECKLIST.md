# UAT Checklist — Ecatepec 50 Rep Pilot

## Accounts
- [ ] Manager can log in with seeded credentials
- [ ] At least 5 test reps can log in before scaling to 50
- [ ] Manager can list users and confirm active `field_rep` accounts

## Data Bootstrap
- [ ] Ecatepec pharmacies can be read from `blackprint_db_prd.ingestion.ing_poi_farmacias_ecatepec`
- [ ] `npm run check:external` completes with `ok: true`
- [ ] Pharmacies expose valid lat/lng in the manager map
- [ ] No obvious duplicate clusters block distribution

## Assignment Flow
- [ ] Manager can create a manual polygon assignment
- [ ] Manager can create a click-select assignment
- [ ] Manager can run `Auto Distribute Wave`
- [ ] Auto distribution creates one or more assignments in the UI and writes current rows to `ingestion.field_survey_pharmacy`
- [ ] Pharmacies assigned in the wave show active owner through the external operational table

## Rep Visit Flow
- [ ] Rep can open an assignment and see ordered stops
- [ ] Rep can check in to a stop
- [ ] Distance warning appears when check-in is far from the pharmacy
- [ ] Rep can submit a visit with outcome, notes, and photo
- [ ] Rep can skip a stop with a reason
- [ ] Optional skip photo uploads correctly

## Evidence Flow
- [ ] Photo uploads to GCS
- [ ] `photo_url` is stored in `ingestion.field_survey_pharmacy`
- [ ] Manager sees the photo in the pharmacy drawer
- [ ] Manager sees the latest evidence for a rep
- [ ] Evidence exports include the latest photo URL and comment
- [ ] Signed/private access works if `GCS_MAKE_OBJECTS_PUBLIC=false`

## Tracking Flow
- [ ] GPS ping is sent every 30 seconds while tracking is on
- [ ] Manager sees latest positions in the `Reps` tab
- [ ] Manager can open breadcrumb trails
- [ ] Tracking points land in `ingestion.device_locations`

## Reporting
- [ ] Manager dashboard loads
- [ ] Rep productivity shows assigned, completed, photo, and comment counts
- [ ] Export CSV works
- [ ] Export XLSX works

## Security and Ops
- [ ] `JWT_SECRET` is not using the development default
- [ ] External table credentials are injected securely
- [ ] GCS bucket credentials are loaded correctly
- [ ] HTTPS is enabled in the target environment
- [ ] Location-tracking consent is documented
- [ ] Bucket/object access policy is confirmed
- [ ] Service account exposure has been remediated before launch

## Rollout Recommendation
### Wave 1
- [ ] 5–10 reps tested for 2–3 days
- [ ] Photo uploads stable
- [ ] Tracking stable
- [ ] Manager can supervise evidence without manual DB intervention

### Wave 2
- [ ] Expand to all 50 reps only after Wave 1 passes
- [ ] Re-run auto distribution if ownership needs to be reset
- [ ] Freeze changes to data model during live field days
