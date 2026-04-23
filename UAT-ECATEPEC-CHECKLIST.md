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

## Colonias & Security Layer
- [ ] `npm run import:colonias` imports colonias from CSV without errors
- [ ] Manager can see colonias layer on map with color-coded security levels
- [ ] Manager can navigate to Colonias tab and see list of colonias
- [ ] Manager can change a colonia's security level to `acceptable`, `caution`, or `not_acceptable`
- [ ] Pharmacies inside a `not_acceptable` colonia are excluded from the pharmacy list
- [ ] `Auto Distribute Wave` skips pharmacies in `not_acceptable` colonias
- [ ] Dashboard KPI totals exclude pharmacies in `not_acceptable` colonias
- [ ] Changing a colonia back to `acceptable` re-includes its pharmacies

## Visit Form & Nomenclature
- [ ] Visit form shows "Potencial de Compra de Cliente" instead of "Potencial de Pedido"
- [ ] Visit form shows "Mayoristas con los que se Trabajan" field
- [ ] Visit form shows "Observaciones de Visita" section with general observations, competition info, prices, and offers
- [ ] Visit form shows "Datos Generales" section with Nombre and Correo fields
- [ ] Submitting a visit with Nombre and Correo updates the pharmacy master record
- [ ] New fields appear in external sync metadata JSON
- [ ] Excel export uses updated column headers

## Route Reorder
- [ ] Rep sees "Reordenar ruta" button when assignment has 2+ pending stops
- [ ] Rep can move stops up/down in reorder mode
- [ ] Saving reorder persists new order and recalculates Google Maps segments
- [ ] Reorder works in external data mode (new route_order synced to external table)
- [ ] Cancelling reorder restores original order

## Flotilla Dashboard & Visit Detail
- [ ] Reporting tab shows "Flotilla — Hoy" with visits today, skipped, pending, active reps
- [ ] Manager can see wholesalers, competition info, prices, and offers in the pharmacy drawer verification history
- [ ] `/api/reporting/visits` returns per-visit detail with new fields
- [ ] `/api/reporting/flotilla` returns today's summary metrics

## Offline & Sync
- [ ] Service worker registers on rep page load
- [ ] Rep page loads shell when device is offline (previously visited)
- [ ] Rep can submit a visit while offline — toast confirms local save
- [ ] Offline banner appears when device loses connectivity
- [ ] Pending visit count shows on offline banner
- [ ] When connectivity returns, queued visits sync automatically
- [ ] Photos queued offline are uploaded after sync
- [ ] Last loaded assignment is available from cache when offline
- [ ] GPS tracking does NOT attempt pings while offline (no error spam)

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
