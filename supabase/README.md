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
