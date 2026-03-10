# MVP Roadmap — Marzam Pharmacy Market Capture Platform

## Phase 1 — Core Operational Backbone

**Goal:** Establish authentication, base POI browsing, polygon assignment, and the data model that everything else depends on.

### Deliverables
- JWT authentication with manager / field_rep roles.
- Manager map view with pharmacy markers (GIST-indexed spatial queries).
- Manager table with search, sort, filter, pagination, CSV export.
- Pharmacy profile page (all base POI + enrichment fields).
- Polygon drawing on map with auto-selection of pharmacies inside area.
- Overlap warning when new polygon intersects active assignments.
- Assignment creation (area + rep + campaign objective + priority + due date + quota).
- Basic rep mobile-browser view: list of assigned pharmacies.
- Universal visit form (outcome + note + order potential + photo upload).
- Assignment and visit outcome status models with validation.
- Review queue for new pharmacies and record flags.
- Manager KPI dashboard (materialized views).

### Acceptance Criteria
- Manager can log in, view all pharmacies on map and table, draw polygon, assign 20+ pharmacies to a rep.
- Rep can log in, see assigned pharmacies, submit a visit form with photo.
- Visit submission creates audit event, updates pharmacy record, and enqueues flag if applicable.
- Review queue shows pending items; manager can approve/reject.
- KPI dashboard shows funnel totals and per-rep counts.

### Risks & Mitigations
| Risk | Mitigation |
|------|-----------|
| Polygon drawing UX on mobile is awkward | Assignment creation is manager-only (desktop); rep never draws polygons. |
| Large POI count slows map | GIST spatial index + bbox viewport filter; paginate table at 200 rows. |

---

## Phase 2 — Operational Visibility

**Goal:** Route ordering, Google Maps navigation handoff, GPS pings, check-ins, and breadcrumb monitoring.

### Deliverables
- Nearest-neighbour route ordering at assignment creation.
- Google Maps Directions URL generated per assignment (one-tap open).
- Per-pharmacy "Open in Google Maps" link.
- Periodic GPS pings while rep has active session (configurable interval).
- Pharmacy-level check-in with distance-to-pharmacy computation.
- Manager breadcrumb trail view per rep/assignment.
- Manager live-enough position overview (latest ping per active rep).
- Planned vs actual route comparison (visited count / assigned count).

### Acceptance Criteria
- Assignment detail includes ordered stop list and Google Maps URL.
- Rep can open full route in Google Maps with a single tap.
- Pings recorded at configurable interval; visible as breadcrumb on manager map.
- Check-in records distance to pharmacy; distances > 500 m flagged visually.
- Manager sees real-time-enough rep positions on a map overlay.

### Risks & Mitigations
| Risk | Mitigation |
|------|-----------|
| Browser GPS unreliable in background on iOS Safari | Design around active-session pings + check-in events, not continuous tracking. Test on iOS 17 Safari, Chrome Android, Samsung Internet from week 1. |
| Google Maps URL waypoint limit (~25) | Split long routes into segments if > 25 stops. |

---

## Phase 3 — Commercial Intelligence Layer

**Goal:** Convert field data into commercial pipeline visibility and Marzam dataset enrichment.

### Deliverables
- Auto-create commercial lead when visit outcome = "interested".
- Lead status lifecycle: interested -> follow_up_required -> contact_captured -> converted / lost.
- Potential sales tracking per pharmacy and aggregated.
- Captured market metrics (pharmacy funnel: total -> assigned -> visited -> interested -> converted).
- Coverage gap analysis by municipality.
- Design enrichment layer for Marzam's internal account/sales data (join key TBD).
- Exportable reports: pharmacy list with enrichment, rep productivity, coverage, leads.

### Acceptance Criteria
- "Interested" visit creates a lead automatically; visible in pharmacy profile.
- Dashboard shows potential sales total, conversion funnel, coverage %.
- Manager can export full enriched pharmacy dataset as XLSX.
- Enrichment layer has placeholder join key ready for Marzam data integration.

### Risks & Mitigations
| Risk | Mitigation |
|------|-----------|
| Marzam internal data quality unknown | Build enrichment as optional overlay; MVP operates fully without it. Reserve canonical ID column for future matching. |
| Review queue backlog overwhelms manager | Add severity sorting, flag-type filter, and batch approve/reject. |

---

## Cross-Phase: Non-Functional Requirements

| Requirement | Target |
|------------|--------|
| Map + table response | < 2 s for 5 000 pharmacies in viewport |
| Assignment creation | < 3 s including route ordering |
| Photo upload | < 5 s over 4G for 5 MB image |
| Concurrent users | 1 manager + 20 reps simultaneous |
| Data export | < 10 s for full CDMX dataset |
| Availability | 99 % uptime during pilot (business hours MX) |

## Go / No-Go Criteria per Phase

| Phase | Gate |
|-------|------|
| 1 | Manager can assign territory and rep can submit visit with photo. KPI dashboard shows data. |
| 2 | Route opens in Google Maps. Breadcrumbs visible. Check-in records location. |
| 3 | Interested visit auto-creates lead. Export includes enrichment fields. |

## Out of Scope (confirmed)

- Native mobile app.
- Automatic territory segmentation.
- Advanced route optimization (TSP solver).
- Heatmaps.
- Offline mode.
- ERP / external CRM integration.
- Predictive analytics / lead scoring.
- Multi-country support.
- Supervisor hierarchy / complex RBAC beyond manager + field_rep.
