# Field Resource, Equipment Recovery, Job Readiness & Estimating — implementation report

Branch `feature/field-ops` · edge function `ss-api` **v1.4.0** · migrations `scagscapes_field_ops`, `scagscapes_field_ops_2`, `scagscapes_reservation_status_lifecycle` · app cache `scagscapes-v7`

## 1. Audit of what existed before this branch

| Area | State found | Kept / changed |
|---|---|---|
| App | Single-file `index.html` (vanilla JS, no framework, no build). Sections: Overview, Leads, Schedule, Quote, Jobs, Rain, Billing, Customers, Sourcing, Reports, Edge, API, Automations. PWA (manifest + `sw.js`). | Kept. Added Equipment, Breakdowns, Pricing & estimates sections; Requirements & readiness panel inside the Job drawer; verification pills on Sourcing rental rows. |
| Auth / roles | None — anonymous publishable key, RLS confines to tenant `demo`. No user accounts, no "commercial pursuits", no AGENTS.md. | Kept for the demo. Roles (`crew`, `crew_lead`, `pm`, `admin`) are passed as a field and enforced server-side against tenant approval limits; real identity is a next-iteration item (Supabase Auth). |
| Backend | Supabase Edge Function `ss-api` (`index.ts` router + `core.ts` + `sourcing.ts`). Writes to operational tables only via the service role inside the function. | Kept. Added `fieldops.ts` (mounted before the sourcing router) and `tests.ts`. |
| Data | `localStorage` for the local/sample mode; Supabase tables in live mode. | Operational records for field ops live in Postgres. The browser holds only an **offline outbox** (`ssc-outbox`) for breakdown reports that could not reach the API; it replays on reconnect. |
| Sourcing (v1.1) | Rentals (Home Depot undocumented endpoint + rate cards), materials (Rokrunner Shopify + stores), fuel (AAA + OSM + crew reports), research, reservations, alerts, notifications. | Kept. Rental rows now carry `status` + `checked_at` (`PROVIDER_POSTED` / `STALE` / `CALL_TO_CONFIRM`) and the UI shows the pill. |
| Outbound comms | Twilio / Resend / Stripe if secrets are set, otherwise *simulated* to `ss_outbox`. | Unchanged; call packages and approval requests go through the same `send()`. |

Nothing that existed was removed. All earlier pages, routes and migrations still work; the earlier Playwright checks (leads, schedule, quote, sourcing, API page) still pass.

## 2. Capability table

| Capability | Implemented | Live data source | Fallback | Tests | Limitations |
|---|---|---|---|---|---|
| Equipment registry (asset no, make/model/serial, hours, QR, status, crew, warranty, dealer, docs) | Yes | `ss_equipment_assets`, `ss_equipment_events` | — | Playwright: list, drawer, status change | QR lookup is by code string; no camera scanner component (browser file/QR libs not bundled). |
| Breakdown intake (symptoms, codes, GPS, photos, can-move, transportable, safety) | Yes | `POST /breakdowns` (idempotent by `client_id`) | Offline outbox in browser, replays on `online` | Playwright: submit → drawer; deployed smoke: dedupe | Photos: file names/sizes stored; binary upload needs a private Storage bucket (not configured). GPS from browser geolocation, 3 s cap. |
| Rule-assisted triage | Yes | `diagnose()` in `fieldops.ts` | — | Deno: causes, confidence cap, shutdown flag | Explicitly labeled "no photo/vision model configured". Confidence capped at 0.85. Symptom rules cover hydraulic, engine, electrical, track/tire, fuel, overheating, trailer. |
| Recovery options, ranked with transparent weights | Yes | `buildOptions()` + `scoreOptions()`; vendors from `ss_vendors` (17 verified Baton Rouge providers), rentals from Home Depot live + `ss_rate_cards` | Rate card when live lookup fails (`STALE`/`CALL_TO_CONFIRM`) | Deno: score normalization, weight override; Playwright: 9 options, 1 recommended | Distance uses straight-line miles from job/site coords; no traffic ETA. Downtime cost uses tenant `crew_cost_per_hour` (135). |
| Call / reserve / book decision | Yes | `method()` → `RESERVE_ONLINE` (live on-hand > 0), `BOOK_APPOINTMENT` (vendor `meta.book='online'`), else `CALL_NOW` | — | Playwright (call package sheet); smoke | No provider offers a real booking API; "online" means the vendor's own web form, linked. |
| Call package + outcome capture | Yes | `POST /breakdowns/:id/call-outcome` → option becomes `LIVE_VERIFIED` (human-confirmed price/availability/ETA) | — | Playwright: outcome recorded | — |
| Approval guardrails | Yes | Tenant `settings.approval` (per-txn 1500, daily 5000, emergency 3000, role limits). `choose` creates `ss_approvals` row when over limit; `approve` route; audit trail. | — | Deployed smoke: under/over limit | Approver identity is a typed name (no auth). |
| Idempotency | Yes | Unique `(tenant_id, client_id)` on `ss_breakdowns`; duplicate POST returns the existing record | — | Deployed smoke | — |
| Job requirements / readiness / loadout | Yes | `POST /jobs/:id/requirements/generate` from quote BOM + service template; matched to `ss_inventory_items` and fleet; `GET /jobs/:id/readiness` (green/yellow/red, critical items block departure) | — | Playwright: generate → 31 items, red; status change → % moves | Templates cover the six quoted services; other job types get the generic template. |
| Quantity explanation | Yes | `explainQty(base, waste, pack)` — shows formula in the UI ("8.2 × (1 + 10% waste) = 9.02; rounded to pack") | — | Deno | — |
| Purchasing lists (buy / rent / pull from yard) | Yes | `GET /jobs/:id/readiness` lists; "Find nearby" jumps into Sourcing with the item pre-filled | Sourcing fallbacks | Playwright: lists sheet | — |
| Labor & pricing tables | Yes | `ss_labor_rates` (wage → burden → overhead → margin → customer rate); changes need a reason and are written to `ss_audit` | — | Deno: loaded-rate math; Playwright: table | — |
| Estimate versions | Yes | `ss_estimate_versions`; `estimateBreakdown()` shows revenue, cost, margin, and margin **with vs without** discount / tier | — | Deno; smoke ($5,130 rev, 43.7% vs 46.5%) | — |
| Customer-facing transparency | Yes | "Customer view" of an estimate strips internal cost/margin, keeps scope, quantities, assumptions, price | — | Playwright: panel renders | — |
| Notifications | Yes | `ss_notifications` + bell; breakdown filed, approval requested/decided, outcome recorded, readiness red | — | Smoke | Push/SMS only when Twilio is configured. |
| Verification statuses | Yes | `LIVE_VERIFIED`, `PROVIDER_POSTED`, `CALL_TO_CONFIRM`, `ESTIMATED`, `UNAVAILABLE`, `STALE`, `CONNECTION_ERROR` on every price/availability field | — | Deno | — |

| Universal resource search (`/resources/search`) | Yes | Provider adapters run in parallel: internal (equipment, inventory, prior rentals), vendor directory (17 verified), Home Depot live, chain rate cards, Rokrunner live, OpenStreetMap places | Each adapter fails independently → `CONNECTION_ERROR` row, never a made-up price | Deno: tokens/intent/rank/evidence; Playwright: header search → 31 rows, sort, call package | Nominatim bounded search is community data (flagged `CALL_TO_CONFIRM`, confidence .3). Straight-line miles. |
| Provider adapter interface | Yes | `Provider { search, createReservation?, createDeepLink?, getCallInstructions? }` + `caps` (search/availability/quote/hold/reserve/book/deeplink/call); `GET /resources/providers` reports what each can really do | Unsupported reserve → `{supported:false, fallback: DEEP_LINK | CALL_NOW | QUOTE_REQUEST}` | Deno; smoke | No provider in Baton Rouge exposes a reservation/booking API to a small contractor; all reservations end in a deep link, a texted quote request, or a call + recorded confirmation. |
| Source evidence on every result | Yes | `evidence{status, source, url, checked_at, method, location, price_type, availability_type, expires_at, confidence, human_confirmed, confirmed_by, notes, ref_no}`; TTL by status (LIVE 4 h, POSTED 24 h, else 30 d) → `STALE` | — | Deno: staleness | — |
| Open-now | Yes | Parsed from vendor `hours` strings (CDT) or OSM `opening_hours`; `null` when unparseable | — | Deno | No holiday calendar. |
| Vendor directory + performance | Yes | `GET /vendors`, `/vendors/:id`, `POST /vendors/:id/feedback`; fill rate, cancellation rate, quote accuracy (quoted vs estimated), response time, on-time %, rating — from Scag's own reservations, call outcomes and crew feedback only | `insufficient` flag under 3 events (reliability defaults to .7 in recovery scoring) | Deno: performance; Playwright: page, drawer, feedback | Not yet fed back into `scoreOptions` reliability automatically (next iteration). |
| Rental lifecycle | Yes | `POST /rentals/:id/confirm|pickup|extend|return-scheduled|returned|cancel` with confirmation number, end date, history; `GET /rentals/due` raises return-due notifications (once per day) | — | Playwright: requested → confirmed (#) → on rent → extend (+2 d) → return scheduled → returned | No cron wired for `/rentals/due` yet — it runs on app load (see SETUP.md for the cron line). |
| Breakdown photos (private) | Yes | `POST/GET /breakdowns/:id/media` → private bucket `breakdown-media` via service role; 1-hour signed URLs; client resizes to ≤1280 px JPEG before upload | Names-only record if upload fails | Playwright: upload → thumbnail → signed URL 200; anon public URL 400, anon list empty | 8 files / 8 MB each per request; video/audio accepted by MIME but not captured by the form yet. |
| Web push | Yes (wired) | `GET /push/vapid`, `POST /push/subscribe`, `POST /push/test`; `sw.js` push + notificationclick; `pushAll()` fans out on every notification when `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` secrets exist | In-app bell only until keys are set (UI says so) | Not exercised end-to-end (needs keys + a real browser subscription) | Escalation / quiet hours not implemented. |
| Market-rate research | Yes | `ss_market_rates` seeded from BLS OEWS May 2023, Baton Rouge MSA (7 occupations, source URL + date); `GET /pricing/market` compares to current wages and returns a recommendation string | — | Smoke; Playwright: panel renders | Recommendation only — rate changes still go through `POST /pricing/labor` with a reason. May 2024 table could not be fetched (BLS bot mitigation); refresh manually. |
| Equipment rates | Yes | `GET /pricing/equipment`: own hourly/daily cost vs cheapest rental card for the same class (own-vs-rent Δ/day) | — | Playwright: panel | — |

## 3. Routes added (all under `/functions/v1/ss-api`, header `x-tenant: demo`)

```
GET  /equipment                 POST /equipment
GET  /equipment/:id             POST /equipment/:id/status
GET  /equipment/qr/:code
GET  /breakdowns                POST /breakdowns            (idempotent: client_id)
GET  /breakdowns/:id
POST /breakdowns/:id/choose     POST /breakdowns/:id/approve
POST /breakdowns/:id/call-outcome
POST /breakdowns/:id/resolve
GET  /jobs/:id/requirements     POST /jobs/:id/requirements/generate
GET  /jobs/:id/readiness
GET  /jobs/:id/estimates        POST /jobs/:id/estimates
POST /requirements/:id          (status/allocation; 409 on allocation conflict)
GET  /pricing/labor             POST /pricing/labor         (reason required → ss_audit)
GET  /approvals                 GET  /audit                 GET /inventory

v1.4.0:
GET|POST /resources/search      GET /resources/providers
POST /resources/reserve         POST /resources/call-package
GET  /vendors                   GET /vendors/:id            POST /vendors/:id/feedback
POST /rentals/:id/{confirm|pickup|extend|return-scheduled|returned|cancel}
GET  /rentals/due
POST /breakdowns/:id/media      GET /breakdowns/:id/media   (signed URLs, 1 h)
GET  /push/vapid                POST /push/subscribe        POST /push/test
GET  /pricing/market            GET /pricing/equipment
```

## 4. Migration `scagscapes_field_ops`

Tables: `ss_equipment_assets`, `ss_equipment_events`, `ss_breakdowns`, `ss_recovery_options`, `ss_approvals`, `ss_job_requirements`, `ss_inventory_items`, `ss_labor_rates`, `ss_estimate_versions`, `ss_audit`. `ss_vendors.kind` check extended (repair, mobile_repair, hose, dealer, tire, transport, small_engine). RLS: `select` only for the demo tenant via the publishable key; all writes go through the edge function's service role. Tenant settings gained `approval`, `recovery_weights`, `crew_cost_per_hour`. Seed: 7 fleet assets, inventory, 4 labor rates, 17 providers with verified phone numbers/addresses.

## 4b. Migrations `scagscapes_field_ops_2`, `scagscapes_reservation_status_lifecycle`

`ss_provider_feedback`, `ss_market_rates` (seeded), `ss_push_subscriptions` (RLS on, no anon policy — service role only, by design), `ss_reservations` + confirmation/end_date/pickup_at/returned_at/history and widened status check, `ss_breakdowns.media`, private storage bucket `breakdown-media` (no storage policies → only the service role can read/write; the app never touches the bucket directly). SQL in `supabase/migrations/scagscapes_field_ops_2.sql`.

## 5. Env vars / secrets

New **optional** secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (web push; generate with `npx web-push generate-vapid-keys`). Without them push stays in-app. Existing optional ones (see `SETUP.md`): `TWILIO_*`, `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `BRAVE_API_KEY`. The only key in the page is the Supabase publishable key.

## 6. Tests executed

- `deno test supabase/functions/ss-api/tests.ts` — 11 passed: pricing engine ×2, rentalTotal caps, diagnose ×2 (shutdown + 0.85 cap; honest unknown), scoreOptions ranking/explanation, explainQty, readiness red-on-critical, loaded labor monotonic, estimate discount impact, status vocabulary.
- Playwright (headless Chromium against the built page in live mode): equipment list → asset drawer → report breakdown (symptom chips, address) → 9 ranked options, 1 recommended, safety-shutdown flag → choose → call package → outcome recorded (`LIVE_VERIFIED`) → breakdown list count; job drawer → generate requirements (31 items, red, 3 blocking) → status change → readiness % updates; pricing page (4 labor rates, 4 panels); mobile "More" sheet lists the new sections. No console or page errors.
- Deployed smoke (v1.3.0): idempotent dedupe, approval under/over crew-lead limit, estimate v1 with/without discount.
- Test rows created in the demo tenant were deleted afterwards.

## 6b. Live vs. call — by provider

| Provider | Search | Price | Availability | Reserve / book | How it ends |
|---|---|---|---|---|---|
| Internal (equipment, inventory, prior rentals) | live | internal cost | LIVE_VERIFIED | allocate | in-app |
| Home Depot Tool Rental (#0357, #0375) | live | PROVIDER_POSTED | PROVIDER_POSTED on-hand count | no API → deep link to homedepot.com | record confirmation # |
| Sunbelt / United / Herc | rate card | ESTIMATED / dated POSTED | CALL_TO_CONFIRM | quote request texted (Twilio) or simulated | branch reply → Confirm with # |
| Rokrunner | live Shopify feed | PROVIDER_POSTED | storefront flag | checkout on their site | — |
| SiteOne / HD stores / price book | dated price book | POSTED (dated) / ESTIMATED | CALL_TO_CONFIRM | deep link or call | — |
| Pirtek, Cajun Hose, LA On-Site, Kenworth, Wooddale, Southern Tire, dealers, towing | directory (verified) | ESTIMATED planning figures | CALL_TO_CONFIRM | Doggett / Emery / WPI / Kenworth: online service form; others: call package | call outcome → LIVE_VERIFIED |
| OpenStreetMap places | live bounded search | none | CALL_TO_CONFIRM (.3) | call | — |

## 7. Build

Static site; no bundler. `node --check` on the assembled script passes. `index.html` 226 KB; service worker cache bumped to `scagscapes-v6` so installed phones pick up the new build.

## 8. End-to-end scenarios covered

1. Hydraulic hose failure at a job site → shutdown advice, Pirtek / Cajun Hose mobile hose options vs rental mini-ex from Home Depot (live on-hand) vs reschedule; choose → call package → outcome.
2. Rental needed today → `RESERVE_ONLINE` when on-hand > 0 at the nearest store, otherwise `CALL_TO_CONFIRM` chain branches.
3. Over-limit repair → approval request to admin, notification, approve/reject, audit.
4. Job readiness → BOM + template → inventory match → blocking items → purchasing lists → departure gate with manager exception.
5. Estimate → labor loaded rates + equipment daily + materials → margin with/without discount → customer view.

## 8b. Security notes

- Only the Supabase publishable key ships in the page; RLS limits it to `select` on demo-tenant rows. All writes, provider calls, storage access and push go through `ss-api` with the service role.
- `ss_push_subscriptions` has RLS enabled and no policy (linter INFO, intentional). Bucket `breakdown-media` is private with no storage policies; the app only ever sees 1-hour signed URLs.
- Provider adapters run server-side with 8–12 s timeouts; a failing provider returns a `CONNECTION_ERROR` row rather than blocking or inventing data. Nothing is scraped behind a login; Home Depot's endpoint is unauthenticated and clearly labeled undocumented/`PROVIDER_POSTED`.
- Idempotency: breakdowns by `client_id`; rental actions append to `history` and are audited; reservation status changes are validated by a DB check constraint.
- Not done: authentication. Roles are self-declared (`x-role` header / body). Do not expose this branch to real crews before Supabase Auth + per-role RLS (next iteration).

## 8c. Deployment

1. `git checkout feature/field-ops` (or merge PR #2).
2. Migrations are already applied to `cscowglyrgxqxwcnftzt` (`scagscapes_field_ops`, `scagscapes_field_ops_2`, `scagscapes_reservation_status_lifecycle`). For a new project run the SQL in `supabase/migrations/` in order.
3. `supabase functions deploy ss-api --no-verify-jwt --project-ref cscowglyrgxqxwcnftzt` (already at v1.4.0).
4. Push to `main` → Railway (scagscapes.bridgebox.ai) and Vercel redeploy the static app; installed phones pick up cache `scagscapes-v7`.
5. Optional: `supabase secrets set VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=…` then redeploy; add the `/rentals/due` cron (SETUP.md).

## 8d. Rollback

- App: revert `main` to `59d1c37` (v5) or re-deploy the previous Railway/Vercel deployment; bump nothing — older `sw.js` cache name reinstalls cleanly.
- Function: `git checkout 59d1c37 -- supabase/functions/ss-api && supabase functions deploy ss-api --no-verify-jwt --project-ref cscowglyrgxqxwcnftzt` (v1.2.0). The v1.3/1.4 tables are additive and can stay; nothing in the old function reads them.
- Data: field-ops tables can be dropped with `drop table ss_provider_feedback, ss_market_rates, ss_push_subscriptions, ss_audit, ss_estimate_versions, ss_labor_rates, ss_inventory_items, ss_job_requirements, ss_approvals, ss_recovery_options, ss_breakdowns, ss_equipment_events, ss_equipment_assets;` — irreversible, only if abandoning the feature.

## 8e. Verification checklist

- [x] `deno check index.ts` clean · `deno test` 16/16
- [x] Playwright: breakdown → 9 options → choose → call package → outcome LIVE_VERIFIED; requirements → readiness; pricing (11 rows, 6 panels incl. market + equipment); universal search (31 rows, sort, call package); repair search (9); vendors (35, drawer, feedback); rental lifecycle (5 transitions); photo upload → signed URL 200
- [x] Privacy: anon public-object URL 400; anon bucket list empty; anon `ss_push_subscriptions` permission denied
- [x] Security advisor: 0 errors/warnings (1 intentional INFO)
- [x] Test rows removed from the demo tenant (one orphaned test photo remains in the bucket; delete from Storage UI)
- [ ] Web push end-to-end (needs VAPID keys on a real device)
- [ ] Auth / roles (not in scope of this branch)

Screenshots: `docs/screenshots/` (universal-search, call-package, vendor-performance, pricing-market, rental-lifecycle, breakdown-triage, job-readiness, breakdown-media).

## 9. Unresolved risks

- Home Depot rental endpoint is undocumented; treated as `PROVIDER_POSTED` and can go `STALE`/`CONNECTION_ERROR` at any time.
- No authentication — role is self-declared. Fine for a demo; must become Supabase Auth + JWT claims before real use.
- Photo binaries are not stored (names only) until a private Storage bucket is configured.
- Distances are straight-line; ETAs are vendor-stated or estimated.
- Outbound texts/emails are simulated until Twilio/Resend keys exist.

## 10. Next iteration

Supabase Auth + per-role RLS; feed vendor performance into recovery scoring reliability; multi-item shopping-plan optimizer (one-stop vs lowest-cost vs fastest); private photo bucket with signed URLs; camera QR scanner; Mapbox/OSRM drive-time; vendor SMS quote round-trip (Twilio inbound → option auto-verified); scheduled re-check of `STALE` options; QuickBooks sync for estimate versions.

---

# v1.7 — the six gaps §10 left open

Branch `feature/field-ops-gaps` · edge function `ss-api` **v1.7.0** · migration `scagscapes_field_ops_3` · app cache `scagscapes-v19`

§10 "Next iteration" named these. They are now closed. Nothing that existed was replaced; every change is additive
and the previous function version still runs against this schema.

## 11. Drive time — and what measuring it found

`miles()` (straight-line) fed both `distance_mi` (15% of the recovery score) and every rental/mechanic ETA
(30%, via `ttr_hours`). `routing.ts` now routes on the OpenStreetMap network through OSRM and falls back to a
**measured** road factor rather than a guessed one.

Measured 2026-09-21 against 26 real Baton Rouge destinations — reproduce with `python3 tools/measure-road-factor.py`:

| | crow mi | road mi | ratio | mph |
|---|---|---|---|---|
| Port Allen centre | 1.4 | 3.6 | **2.65** | 35 |
| Lowe's Port Allen | 1.7 | 4.3 | **2.49** | 33 |
| United Rentals BR | 3.6 | 4.1 | 1.14 | 28 |
| Home Depot Airline | 8.3 | 11.0 | 1.32 | 39 |
| Prairieville | 17.4 | 20.3 | 1.17 | 46 |
| Gonzales | 21.7 | 24.4 | 1.13 | 47 |
| **median (n=26)** | | | **1.23** | **36.1** |

**The finding worth acting on: anything across the Mississippi is ~2.5× the crow line, because there is one
bridge.** Port Allen is a named Scag market. Straight-line was telling a crew a west-bank vendor was the nearest
option when it was not — on the two axes that carry 45% of the recovery score. No constant fixes that; only a
route knows where the bridge is. When routing is unavailable the estimate carries an explicit caveat on any leg
that crosses the river, and the number is stated as a floor.

Speed is banded from the same sample (< 5 mi 30.5 mph · 5–12 mi 35.7 · > 12 mi 45.6), because a short trip on
surface streets is not a run down I-10. A routed leg is `LIVE_VERIFIED`; a fallback is `ESTIMATED` and says
"no route was computed" in its own `method` field. One OSRM table call covers every vendor in a breakdown.

## 12. Vendor performance now reaches the score

`performance()` had computed a reliability figure per vendor since v1.4 and `scoreOptions()` had weighted
reliability at 10% since v1.3 — **the two were never connected**. Ranking used a constant per option *kind*
(.75 mobile, .85 dealer, .8 rental), so a vendor that had cancelled on Scag twice scored identically to one that
had never missed. `reliabilityMap()` (resources.ts) now feeds `buildOptions()`; the figure appears in
`score.inputs.reliability`, so the crew can see why one vendor outranked another. Under three recorded events a
vendor keeps the neutral .7 — a new vendor is not punished for being new, and one bad day cannot blackball anyone.

## 13. Shopping plans: one stop vs cheapest vs fastest

`POST /jobs/:id/shopping-plan`. Readiness knew what was missing; search could price each item; nothing joined
them into the decision the crew lead makes at 6:40am. Three plans, always, with the tradeoff on the card:

- **ONE_STOP** — the single supplier covering the most items, remainder filled and reported as partial
- **LOWEST** — cheapest priced supplier per item
- **FASTEST** — verified stock first, then nearest; cost only breaks ties

Compared on **landed cost = materials + crew time (drive + stops) at the tenant's own `crew_cost_per_hour`**, not
on sticker price. A $30 saving 40 minutes away loses to one stop, and the card shows the arithmetic. An item no
supplier could price is returned in `unsourced` — the list is never quietly shortened. Stop-to-stop legs are
approximated from each vendor's leg from the yard, stated in the response `note`. `stop_minutes` (default 18) is
a tenant setting so Charlie can correct it from what the crew actually does.

## 14. Notifications: urgency, quiet hours, acknowledgement, escalation

`notify()` was three identical private copies that wrote a row and pushed to everyone, always, at any hour.
`notify.ts` is now the single path.

- Every kind carries an urgency (`URGENCY` map). Quiet hours (default 21:00–06:00, tenant local, `tz_offset`
  stored per tenant) defer anything below critical to the next morning — a rental-return reminder no longer
  wakes the same phones as a machine down with a crew on site.
- Critical notices require acknowledgement. `POST /notifications/:id/ack`.
- An unacknowledged critical escalates to a named role on a timer (approval requested: 20 min → admin; safety
  shutdown: 10 min → admin). `GET /notifications/escalate` runs the sweep on app load beside `/rentals/due`, and
  is idempotent via `escalated_at`.
- `GET /notifications/routing?kind=…` reports what a kind would do right now and why — the rule is inspectable
  rather than folklore.

## 15. Video, voice notes, and a camera that reads the sticker

- Breakdown intake takes a **short video** and a **voice note** (MediaRecorder, capped at 2 minutes) beside the
  photos, through the same private bucket and 1-hour signed URLs. A clip over the server's 8 MB cap is refused in
  the crew's hand with the actual size, rather than dropped silently server-side. The media strip plays video and
  audio inline.
- **QR scanning** uses `BarcodeDetector` where the browser has it. Where it does not, the app says so and focuses
  the typed field that has always worked — no camera button that silently does nothing.

## 16. Tests

- `deno test` — **35 passed** (was 23). New: road factor and the river caveat, speed bands, plan ranking under
  crew cost, unsourced items, stock below requirement, weakest-link confidence, quiet-hours midnight wrap,
  deferral release, escalation config, reliability changing the ranking.
- `tests/local-smoke.mjs` — **27 checks, 0 failures, no console errors.** New in CI, and it tests the *working
  tree* rather than the deployment, which is the gap that let the KPI bug ship.
- `deno check` clean · front-end parse clean.

## 17. Still open

- **Authentication.** Roles remain self-declared (`x-role`). Unchanged by this branch and still the one thing
  blocking real crew use.
- Escalation notifies a *role*, not a person — there is no identity to page until auth exists.
- OSRM's public demo server is rate-limited and not for bulk use; a paid routing key would be the production move.
- Stop-to-stop legs are approximated, not routed.
- `/notifications/escalate` runs on app load, not on a cron. Same gap as `/rentals/due` (SETUP.md).
