# QA Checklist — Marzam MVP PRD Compliance

## Go/No-Go Gates (from PRD/ROADMAP)

### Phase 1 Gate
- [ ] Manager can log in, view all pharmacies on map and table
- [ ] Manager can draw polygon and assign 20+ pharmacies to a rep
- [ ] Rep can log in, see assigned pharmacies, submit visit form with photo
- [ ] Visit submission creates audit event, updates pharmacy record, enqueues flag if applicable
- [ ] Review queue shows pending items; manager can approve/reject
- [ ] KPI dashboard shows funnel totals and per-rep counts

### Phase 2 Gate
- [ ] Assignment detail includes ordered stop list and Google Maps URL
- [ ] Rep can open full route in Google Maps with single tap
- [ ] Pings recorded at configurable interval; visible as breadcrumb on manager map
- [ ] Check-in records distance to pharmacy; distances > 500m flagged visually
- [ ] Manager sees real-time-enough rep positions on map overlay

### Phase 3 Gate
- [ ] "Interested" visit auto-creates lead; visible in pharmacy profile
- [ ] Dashboard shows potential sales total, conversion funnel, coverage %
- [ ] Manager can export full enriched pharmacy dataset as XLSX
- [ ] Lead lifecycle transitions work (interested -> follow_up -> contact_captured -> converted/lost)

## Functional Test Scenarios

### Authentication & Authorization
- [ ] Login with manager credentials -> manager.html
- [ ] Login with rep credentials -> rep.html
- [ ] Invalid credentials show error
- [ ] JWT expiry -> redirect to login
- [ ] Rep cannot access manager-only endpoints (403)
- [ ] Rep cannot see unassigned pharmacies by direct ID access
- [ ] Manager impersonation: start -> view as rep -> return
- [ ] Impersonation creates audit trail

### Map & Pharmacies (Manager)
- [ ] Map loads with pharmacy markers
- [ ] Search filters pharmacies in list and map
- [ ] Status filter works (active/pending/closed)
- [ ] Municipality filter works
- [ ] Visit outcome filter works
- [ ] Sort by name/potential/last visit works
- [ ] Click pharmacy marker opens drawer with details
- [ ] Drawer shows visit history, leads, notes
- [ ] Bulk select + assign selected works
- [ ] Export CSV downloads file
- [ ] Export XLSX downloads file

### Polygon Assignment (Manager)
- [ ] Draw polygon on map with clicks, double-click to finish
- [ ] Pharmacies inside polygon are auto-selected
- [ ] Overlap warning shown when polygon intersects active assignment
- [ ] Can proceed after overlap warning
- [ ] Can deselect individual pharmacies before assignment
- [ ] Assignment form: objective, rep, priority, due date, visit goal
- [ ] Assignment creates successfully with ordered route
- [ ] Google Maps URL included in assignment

### Visit Flow (Rep)
- [ ] Assignment selector shows only assigned assignments
- [ ] Selecting assignment renders stops on map and list
- [ ] Route line connects stops in order
- [ ] Google Maps link opens correct route
- [ ] Click stop -> Visit -> form opens
- [ ] Visit form: outcome, notes, potential, competitors, stock, contact, photo
- [ ] "needs_follow_up" shows follow-up date/reason fields
- [ ] Flag outcomes show flag reason field
- [ ] Photo required (enforced in UI)
- [ ] Submit visit -> stop marked completed
- [ ] Skip stop -> reason required -> stop marked skipped
- [ ] Cannot silently skip (must provide outcome + reason)
- [ ] Auto-complete assignment when all stops resolved

### GPS Tracking (Rep)
- [ ] Toggle GPS tracking on/off
- [ ] Pings sent at 60s interval when active
- [ ] Check-in captures distance to pharmacy
- [ ] Distance > 500m shows warning toast
- [ ] Rep position shown on own map

### Review Queue (Manager)
- [ ] Pending items listed with flag type and pharmacy info
- [ ] Severity ordering: new_pharmacy/chain highest, wrong_category lowest
- [ ] Approve item -> pharmacy status updated
- [ ] Reject item -> no change to pharmacy
- [ ] Batch select all checkbox
- [ ] Batch approve/reject multiple items
- [ ] Review badge shows pending count
- [ ] Review markers shown on map in review tab

### Breadcrumbs & Rep Monitoring (Manager)
- [ ] Reps tab shows rep positions on map
- [ ] "Show Trail" button loads breadcrumb polyline on map
- [ ] "View as Rep" impersonates selected rep
- [ ] Rep productivity stats shown (visits, interested, unique)

### Reporting (Manager)
- [ ] Dashboard shows all PRD KPIs (total, assigned, visited, interested, follow-up, invalid/closed, coverage %, leads, sales potential, active reps)
- [ ] Coverage by municipality with progress bars
- [ ] Rep productivity ranking
- [ ] Assignment progress with completion %
- [ ] Export CSV and XLSX from reporting tab

### Commercial Leads (Manager)
- [ ] Lead auto-created when visit outcome = interested
- [ ] Lead shown in pharmacy drawer with status and potential
- [ ] Lead lifecycle buttons advance status correctly
- [ ] Invalid transitions blocked with error
- [ ] Leads list accessible from pharmacy profile

### Audit Trail (Manager)
- [ ] Activity tab shows chronological events
- [ ] Events include: assignment created, visit submitted, review resolved, pharmacy created
- [ ] Each event shows user, entity, timestamp

### New Pharmacy (Rep)
- [ ] FAB button opens new pharmacy form
- [ ] Name required, photo required
- [ ] GPS location captured automatically
- [ ] Submit creates pharmacy in pending_review status
- [ ] Review queue item auto-created

## Non-Functional Requirements

### Performance Targets
- [ ] Map + table response < 2s for 5000 pharmacies
- [ ] Assignment creation < 3s including route ordering
- [ ] Photo upload < 5s over 4G for 5MB image
- [ ] Data export < 10s for full CDMX dataset

### Concurrent Users
- [ ] 1 manager + 20 reps simultaneous

### Data Integrity
- [ ] Spatial indexes exist and are used (GIST on coordinates, polygon)
- [ ] Assignment stops sync assigned_rep_id on pharmacies
- [ ] Materialized views refresh correctly
- [ ] Audit events captured for all key operations

## Demo Mode Verification
- [ ] Demo Manager login works without database
- [ ] Demo Rep login works without database
- [ ] All tabs functional in demo (pharmacies, assignments, review, reps, reporting, audit)
- [ ] Impersonation works in demo mode
- [ ] Breadcrumbs visible in demo mode
- [ ] Visit submission updates demo state correctly
- [ ] Lead lifecycle works in demo
- [ ] Batch review works in demo
- [ ] Export works in demo
- [ ] New pharmacy creation works in demo
