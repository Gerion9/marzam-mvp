PRD v1 — Marzam Independent Pharmacy Intelligence & Field Sales Execution Platform
1. Document Overview
Product Name (working title): Marzam Pharmacy Market Capture Platform
Built By: BlackPrint
Version: PRD v1
Product Type: Web platform with mobile-browser field workflow
Stage: MVP / pilot in production
Primary Client: Marzam
Initial Geography: Mexico City Metropolitan Area
Future Expansion: 10 states in Mexico
This product is a territory intelligence + field sales execution platform designed to help Marzam identify, prioritize, visit, and convert independent pharmacies across a target geography. The MVP combines BlackPrint’s POI intelligence with a manager-to-field-rep operational workflow for assigning territories, routing visits, capturing structured field data, and monitoring execution centrally.

2. Problem Statement
Marzam currently lacks a centralized and operationally useful view of the independent pharmacy market across its target geographies. This creates several problems:
Limited visibility into the full market of independent pharmacies


Inefficient sales coverage and territory planning


Low standardization in field visit tracking and reporting


Poor real-time visibility into field team execution


No reliable system to validate, enrich, and operationalize pharmacy-level market data


Difficulty measuring market penetration, captured market, and sales-team productivity


Marzam needs a system that not only maps and segments the market, but also turns that intelligence into field execution and measurable commercial outcomes.

3. Product Vision
Create a centralized operating system for Marzam to:
View every independent pharmacy in a target geography


Filter and analyze the market with BlackPrint data


Assign sales coverage geographically


Route field reps efficiently


Capture standardized field intelligence


Track execution and progress centrally


Build an increasingly accurate, enriched pharmacy database over time


Convert visited pharmacies into structured commercial opportunities


This product should be built as a reusable module that BlackPrint can later adapt and sell to other distribution companies.

4. Goals
Business Goals
Optimize Marzam’s sales strategy and market capture


Increase acquisition of independent pharmacies


Improve sales coverage efficiency


Increase visit productivity


Improve manager visibility into field operations


Build a cleaner and richer territorial pharmacy database


Establish measurable KPIs around field sales performance and market penetration


Product Goals
Deliver a working MVP in production for pilot use


Support one manager and ~20 field reps in CDMX Metro


Enable territory assignment and route execution through a simple web/mobile workflow


Standardize field data capture and operational reporting


Create a scalable base for future territory expansion and deeper CRM/logistics workflows



5. Success Metrics
A successful pilot (30–90 days) should give Marzam:
Clear KPIs on sales-team execution


Improved visibility into target market coverage


More efficient market penetration


Structured evidence of visits and outcomes


A measurable increase in captured locations and sales opportunity visibility


Core MVP KPIs
Total independent pharmacies in enabled territory


Assigned pharmacies


Visited pharmacies


Visit completion rate


Captured locations


Interested pharmacies


Follow-up required


Invalid / closed / duplicate records found


Active reps in field


Visits per rep


Coverage by geography


Estimated potential sales


Planned vs completed route progress



6. Users & Roles
The MVP will support two roles only.
6.1 Manager
The manager is the main control user for the system.
Responsibilities:
View all enabled pharmacies in the pilot geography


Filter, search, and analyze the dataset


Draw assignment polygons


Review auto-selected pharmacies inside the area


Deselect unwanted pharmacies before assignment


Assign areas/routes to reps


Define campaign objective


Monitor route progress


Review field updates


Edit rep-entered data


Approve or reject flagged/new records in review queues


View operational KPIs and export data


6.2 Field Rep
Field reps operate only within their assigned work.
Responsibilities:
Access assigned route and pharmacy list via mobile browser


Follow ordered route


Open stops in Google Maps


Check in at locations


Submit structured visit forms


Upload required photo evidence


Mark outcomes


Add comments and commercial observations


Create new pharmacy records discovered in the field


Flag incorrect or invalid records


Access restriction: Reps only see their assigned pharmacies/routes. They do not browse the full map freely.

7. Geographic Scope
MVP Scope
Entire Mexico City Metropolitan Area


One manager


Approximately 20 field reps


Thousands of independent pharmacy records


Expansion Scope
After pilot validation, the system should support:
Gradual geographic rollout


Activation of up to 10 states


Territory-based access segmentation


Managers with broader visibility, regional teams with limited territory access



8. Data Scope
8.1 POI Definition
An independent pharmacy is any pharmacy that does not belong to an established chain.
This may later be refined through:
known chain exclusion lists


store-count thresholds


manual validation rules


8.2 Included POI Category in MVP
Independent pharmacies only


Related entities such as clinics, hospitals, wholesalers, and consultorios are out of scope for MVP.
8.3 Base POI Data Available
The platform should expose BlackPrint’s POI dataset, including all relevant fields available from Google Maps-derived sources, such as:
Name


Address


Coordinates


Category / subcategory


Contact information


Social links


Opening hours


Closing hours


Date of opening


Number of reviews


Popularity score (1–5)


Data confidence score


8.4 Field-Enriched Data
In addition to BlackPrint base data, each pharmacy profile may accumulate:
Visit notes


Comments


Photos


Contact history


Assigned rep


Visit history


Commercial lead status


Order potential / demand estimate


Competitor products observed


Stock observations


Follow-up requirements


Review/validation flags


8.5 Data Freshness
Pilot uses a static snapshot (December 2025)


During pilot, manual corrections are allowed


Full implementation should support monthly data refreshes



9. Core Product Experience
The MVP should function as a centralized command system for market intelligence and field execution.
9.1 Manager Workflow
Manager opens platform


Reviews all enabled independent pharmacies across CDMX Metro


Applies filters and table views


Draws a polygon on the map


System selects all pharmacies inside the polygon


Manager reviews included pharmacies and deselects unwanted ones


Manager assigns the area + pharmacy set to a field rep


Manager defines campaign objective


System generates a single ordered route


Rep receives access to the assignment


Manager monitors execution live enough for supervisor visibility


Manager reviews submitted data, approvals, and KPIs


9.2 Field Rep Workflow
Rep opens assigned route in mobile browser


Rep sees assigned stops only


Rep opens route/stops in Google Maps


Rep travels to assigned pharmacies


Rep checks in and submits required visit form


Rep uploads photo evidence for every visit


Rep marks visit outcome


Rep adds commercial notes and structured data


Rep flags incorrect records or creates new pharmacy entries if needed


Rep continues through assigned route


Manager sees progress and updates centrally



10. Functional Requirements
10.1 Map View
The manager-facing map must support:
Display of all enabled independent pharmacies in the pilot area


Clickable POI markers


Polygon drawing for territory assignment


Auto-selection of pharmacies within a drawn polygon


Post-selection review and deselection of unwanted locations


Warning when newly drawn polygons overlap with prior assignments


Allow overlap after warning


Visual route display for assignments


Route progress visibility


Breadcrumb trail for rep activity where technically feasible


The field-rep map should be simplified and only show assigned route/stops.

10.2 Table / List Workspace
The platform must include a table view of pharmacies with the following features:
Required actions
Search


Sort


Bulk select


Export CSV / Excel


Assign selected locations


Mark statuses


Open pharmacy profile


Required filters
Municipality / state


Status


Assigned rep


Verification status


Last visited


Visit outcome


Potential score


Presence of contact info


Saved Views
Managers should be able to save filters / views



10.3 Pharmacy Profile Page
Each pharmacy detail page should include:
All base POI information from BlackPrint DB


Full contact history


Assigned rep


Visit history


Uploaded photos


Nearby context


Comments thread


Sales opportunity score / potential


Commercial lead record (if applicable)


This page should become the persistent operating record for that pharmacy.

10.4 Assignment Model
Assignments must be created at the level of:
Area + Rep + Campaign Objective
Each assignment contains:
A drawn geographic polygon


A selected list of pharmacies within that area


One assigned rep


One campaign objective (e.g. prospecting, follow-up, validation)


Priority


Due date


Visit goal / quota


Route order


Assignment rules
A pharmacy may appear in multiple active campaigns if needed


Managers can reassign partially worked locations


Overlapping areas are allowed after warning


Assignments should support exclusive practical ownership, but not hard-block multi-campaign use



10.5 Status Model
The MVP will use two separate status systems.
A. Assignment Status
Tracks progress of the work package.
Example states:
Unassigned


Assigned


In Progress


Completed


B. Pharmacy Visit Outcome
Tracks result at the pharmacy level.
Required outcomes include:
Visited


Contact made


Interested


Not interested


Needs follow-up


Closed


Invalid


Duplicate


Moved


Wrong category


Chain / not independent


Rules
“Interested” should create a commercial lead record in the pharmacy profile


“Needs follow-up” requires:


follow-up date


follow-up reason


Reassignment may be optional for follow-up



10.6 Field Visit Forms
The MVP should use a single universal visit form that can adapt by outcome type.
Mandatory fields before marking a pharmacy as visited
Visit outcome


Note


Order potential / demand estimate


Photo evidence (always required)


Optional when available
Contact person


Phone number


Competitor products seen


Stock observations


Additional requirements
Structured forms preferred over free-form-only input


Some outcomes may reveal extra fields (e.g. follow-up reason, invalid reason, closed, moved)


New Pharmacy Creation
If a rep discovers a pharmacy not in the database, they can create a new record with:
Name


Location


Photo


Address / reference


Contact info if available


Note


Independent / chain flag


Data Correction / Record Flagging
Reps must be able to flag:
Duplicate


Closed


Moved


Wrong category


Chain / not independent



10.7 GPS Tracking & Visit Verification
Because the MVP is web + mobile browser only, GPS must be implemented in a practical way that respects browser limitations.
MVP Tracking Approach
“Live enough” for supervisor monitoring


Use periodic pings rather than true high-frequency live tracking


Track while active route session is open


Support pharmacy-level check-ins


Support timestamped visit proof


Rep may be required to ping location at each pharmacy if needed for reliability


Goals of tracking
Supervisor visibility


Visit verification


Performance analytics


Planned vs actual route comparison


Constraints
True background continuous GPS in browser may be limited by OS/browser behavior. The MVP should be designed around:
active session tracking


check-in events


timestamped proof
 rather than depending on native-app-grade background tracking



10.8 Routing & Navigation
MVP routing requirements
System generates a single ordered route for assigned pharmacies


Route should prioritize shortest travel time


Route/stops should be exportable / openable directly in Google Maps


Native turn-by-turn navigation is not required


Route behavior rules
Rep cannot silently skip a pharmacy


If a stop is not completed, rep must specify an outcome/reason (e.g. closed) and upload photo


Managers should see:


visited count vs assigned count


map-based breadcrumb trail


both in the interface


Out of scope
Advanced route optimization


Dynamic rerouting logic



10.9 Dashboard & Reporting
The MVP should include a manager dashboard with:
KPI widgets
Total independent pharmacies


Assigned pharmacies


Visited pharmacies


Visit completion rate


Captured locations


Interested pharmacies


Follow-up required


Invalid / closed records


Active reps in field


Visits per rep


Coverage by geography


Potential sales


Management views
Exportable reports


Route progress summaries


Rep productivity tracking


Sales coverage gaps


Unvisited opportunity pockets


Counts by geography


Concentration of independents by zone


Enrichment with Marzam data
The system should be designed to support enrichment with Marzam’s current account / sales data, enabling metrics like:
captured market


sales per pharmacy


market potential vs current penetration


Note: exact join logic depends on diagnosis of Marzam’s internal data (name, address, manual matching, internal ID, etc.).

10.10 CRM / Commercial Record Layer
Although ERP/CRM integrations are out of scope, a lightweight internal commercial record is in scope.
MVP commercial record requirements
When a pharmacy is marked as “Interested,” the platform should create a lead-like commercial state inside the pharmacy profile, such as:
Interested


Follow-up required


Contact information captured


Notes and history


Potential sales estimate


This is not a full CRM, but a basic in-platform commercial tracking layer tied to each pharmacy.

11. Access & Authentication
Authentication
BlackPrint-managed login


MVP Roles
Manager


Field Rep


Permission Rules
Manager
Full access to enabled territory


Full edit permissions


Can review, approve, reject, assign, export, and modify records


Field Rep
Access only to assigned routes/pharmacies


Cannot browse broader market


Can submit updates, create candidate records, and flag records



12. Data Governance & Review Queues
To protect dataset quality, the master POI database should not be updated automatically from field actions.
Review Queue Required For:
New pharmacies created by reps


Duplicate flags


Closed flags


Wrong category flags


Moved flags


Chain / not independent flags


Workflow
Rep submits update/flag/new record


Record enters review queue


Manager reviews submission


Manager approves or rejects


Approved changes are reflected in operational dataset / master record


This ensures the pilot improves the dataset without corrupting it.

13. Audit Trail Requirements
The system should keep an audit trail for at least:
Who changed a status


Who reassigned a location


When a location was visited


Who uploaded evidence


When a review item was created and resolved


This is important for operational trust, accountability, and management visibility.

14. Non-Functional Requirements
Platform
Web application for desktop manager usage


Mobile-browser-compatible interface for reps


No native app in MVP


Performance
Must handle thousands of pharmacies in CDMX Metro


Map and table interactions should remain operationally responsive


Assignment and route generation should be fast enough for daily use


Usability
Rep workflow should minimize taps and friction


Forms should be simple enough for frequent daily usage


Manager should be able to assign work quickly


Data export
Marzam must be able to own and export all enriched field data collected in the platform



15. Out of Scope for MVP
The following are explicitly out of scope:
Automatic territory segmentation


Advanced route optimization


Heatmaps


Offline mode


Native mobile app


ERP / external CRM integrations


Predictive analytics / lead scoring


Multi-country support


Supervisor hierarchy / complex RBAC



16. Risks & Constraints
16.1 Mobile GPS Limitation
Because the MVP is browser-based, true continuous background GPS may be unreliable. The design should rely on:
periodic pings


active session tracking


pharmacy check-ins


timestamped visit proof


16.2 Marzam Internal Data Quality
Crossing BlackPrint data with Marzam’s current account/sales data is feasible, but the exact implementation depends on:
format quality


match keys


consistency of pharmacy identifiers


16.3 Data Accuracy / Review Load
Field reps can improve the dataset significantly, but review queues may create manager overhead if many records are flagged/created during the pilot.

17. Future Enhancements
Potential post-MVP enhancements include:
Automatic territory segmentation


Smarter route optimization


Deeper CRM pipeline


Supervisor hierarchy / multi-level permissions


Monthly automated POI refresh


Heatmaps and territory summaries


Expansion to additional categories beyond pharmacies


Logistics and distribution workflows


Native mobile application


Performance scoring and predictive opportunity models



18. Recommended MVP Build Priorities
Phase 1 — Core Operational Backbone
Authentication


Manager map + table


Pharmacy profile


Polygon assignment flow


Assignment creation (area + rep + objective)


Basic rep mobile view


Visit forms


Photo upload


Basic statuses


Review queue


KPI dashboard


Phase 2 — Operational Visibility
Ordered route generation


Google Maps handoff


Periodic location pings


Check-ins


Planned vs actual route monitoring


Breadcrumb-style progress view


Phase 3 — Commercial Intelligence Layer
Interested → lead record creation


Potential sales tracking


Captured market metrics


Marzam dataset enrichment



19. Open Implementation Assumptions
These are not blockers for the PRD, but should be validated during solution design:
Exact join key for Marzam internal commercial data


Exact routing export mechanism into Google Maps


Browser/OS behavior for mobile location tracking


Final shape of commercial record fields


Whether universal visit form is fully dynamic or mostly static with conditional sections



20. Summary
This MVP is a production-ready pilot web platform that combines:
BlackPrint’s independent pharmacy market intelligence


Geographic sales assignment


Mobile-browser route execution


Structured field-data capture


GPS-informed operational monitoring


Centralized management reporting


A review-driven feedback loop that continuously improves the pharmacy dataset


It should be treated as the first version of a scalable, reusable BlackPrint product for commercial distribution teams.

