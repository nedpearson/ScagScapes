# Backend

- **Project:** `cscowglyrgxqxwcnftzt` (us-west-2) — https://cscowglyrgxqxwcnftzt.supabase.co
- **Edge Function:** `functions/ss-api/index.ts` → `https://cscowglyrgxqxwcnftzt.supabase.co/functions/v1/ss-api` (verify_jwt off; demo tenant is open, any other tenant needs `x-ss-key` = `ss_tenants.api_key`)
- **Front end** talks to PostgREST with the publishable key (RLS limits it to the demo tenant) and to `ss-api` for anything with business logic: text-back, SMS intent, pricing, stage machine, rain campaigns, payments, reset.

Deploy the function: `supabase functions deploy ss-api --no-verify-jwt --project-ref cscowglyrgxqxwcnftzt`

To onboard a real tenant: insert a row in `ss_tenants` with a fresh `api_key`, seed `ss_automations` + `ss_forecast`, point Twilio's voice status callback at `/webhooks/call-missed` and the SMS webhook at `/webhooks/sms` with header `x-tenant: <id>` and `x-ss-key`.

## Sourcing module (v1.1)

Routes: `/geo/geocode`, `/sourcing/vendors`, `/sourcing/rentals`, `/sourcing/reserve`, `/sourcing/reservations[/:id]`, `/sourcing/materials`, `/sourcing/fuel`, `/sourcing/fuel/report`, `/notifications[/read]`, `/alerts[/:id]`, `/research`.

Live data sources and their honesty level:
- **Home Depot rental** — `apionline.homedepot.com/product-information/rental/inventory[/pricing]/{cat}/{sub}/{stores}`; undocumented, unauthenticated, per-store day/week/4-week + on-hand. Could change or be blocked at any time; the rate card in `ss_rate_cards` is the fallback.
- **AAA fuel** — `gasprices.aaa.com/?state=LA` parsed from static HTML, cached 6h in `ss_fuel_snapshots`. No station-level prices exist for free (GasBuddy has no public API) — crews report prices in-app (`ss_fuel_reports`).
- **OpenStreetMap** — Overpass for stations near the job (Nominatim bounded search as fallback); Nominatim geocoding (1 req/s policy).
- **Rokrunner** — Shopify `products.json`, live truckload prices for #57 / 610 / sand.
- **Sunbelt / United / Herc** — no public API; rate card rows are dated estimates flagged `verified=false`; "Request quote" logs a reservation + notification (wire Twilio to actually text the branch).
- **Research** — internal tables + DuckDuckGo instant answers + Wikipedia. Set secret `BRAVE_API_KEY` (`supabase secrets set BRAVE_API_KEY=...`) for real web results.

Refresh rate cards/material prices: re-run the research checklist in `supabase/migrations/README.md` and update `checked_at`.

## AI layer (v1.5) - PRODUCT MANDATE

`functions/ss-api/ai.ts` + `evals.ts`, migration `scagscapes_mandate_1.sql`. Model-agnostic router over a per-tenant registry (`ss_ai_models`: anthropic / openai / gemini, task weights, cost, capabilities); every recommendation carries evidence, confidence and the retrieved context and is written to `ss_ai_recommendations` with the human decision and outcome; a versioned eval suite (`/ai/evals/run` → `ss_ai_evals`) gates model promotion; `ss_job_actuals` + `ss_estimate_accuracy` close the estimate-vs-actual loop; `/export` dumps everything the tenant owns. `strip()` guarantees no AI number is ever authoritative - `price()` stays the only pricing engine. Governing document: `../docs/PRODUCT-MANDATE.md`; audit: `../docs/MANDATE-AUDIT.md`. No provider is enabled until its key is set (`supabase secrets set ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=...`).

## Field ops module (v1.3)

`functions/ss-api/fieldops.ts` — equipment registry, breakdown intake (idempotent by `client_id`), rule-assisted triage (no vision model; labeled as such), ranked recovery options with configurable weights (`ss_tenants.settings.recovery_weights`), call/reserve/book decision, approval guardrails (`settings.approval`), call packages + outcome capture (→ `LIVE_VERIFIED`), job requirements/readiness/loadout, labor rates with audited changes, estimate versions with discount impact. Routes and the capability table are in `../docs/FIELD-OPS.md`.

Every price/availability carries one of: `LIVE_VERIFIED` (human-confirmed via call outcome), `PROVIDER_POSTED` (read from the provider's own endpoint), `CALL_TO_CONFIRM`, `ESTIMATED` (rate card), `UNAVAILABLE`, `STALE`, `CONNECTION_ERROR`.

Tests: `deno test functions/ss-api/tests.ts` (pure functions, no network).

## Resources module (v1.4)

`functions/ss-api/resources.ts` — provider-adapter interface (`Provider.search / createReservation / createDeepLink / getCallInstructions` + honest `caps`), universal search (`/resources/search`) fanning out to internal records, the verified vendor directory, Home Depot live, chain rate cards, Rokrunner and OpenStreetMap, each result carrying an `evidence` block; vendor performance from Scag's own history; rental lifecycle; private breakdown media (bucket `breakdown-media`, signed URLs); web push; BLS market benchmarks; equipment own-vs-rent rates. Migrations: `migrations/scagscapes_field_ops_2.sql`.
