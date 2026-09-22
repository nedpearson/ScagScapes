# Scag Scapes Command

Demo of the automated sales-to-billing operating layer for **Scag Scapes LLC** (Baton Rouge, LA) — a BridgeBox.ai client app.

Missed-call text-back · self-booking · six-service quote builder with auto-BOM · job pipeline · rain-triggered campaigns · auto-invoicing · review capture · customers · automation settings · sourcing (rentals, materials, fuel, research) · **field ops** (equipment registry, camera QR scan, breakdown → ranked recovery → call/reserve/book, approvals, job readiness, **shopping plans** costed with crew time, loaded labor & estimate versions) · **Find anything** universal search with source evidence on every row · vendors & performance · rental lifecycle · private breakdown photos · web push (VAPID) with quiet hours, acknowledgement and escalation · real drive time (OSRM) with a measured fallback. Desktop and phone (installable PWA).

Field-ops implementation report, capability table and limits: `docs/FIELD-OPS.md`.

## Run

Static site. Open `index.html`, or:

```
npx serve .
```

## Deploy

Vercel project `bridgebox-scagscapes` (team Pearson Projects) is linked to `main`. Push to deploy.

## Backend

Live mode reads/writes Supabase (`supabase/` folder: schema notes + the `ss-api` Edge Function). The app falls back to local sample data if the backend is unreachable; switch modes on the **API & data** page.

## Notes

- All data is sample data, held in `localStorage` per device. **Reset demo data** in the sidebar restores the seed.
- The only key shipped in the page is the Supabase publishable key; RLS confines it to the `demo` tenant. Twilio / NWS / Stripe / QuickBooks keys live in Supabase secrets, never in the repo — see `.env.example`.
- `sw.js` caches the app for offline / home-screen use.
- Breakdown intake takes photos, a short video and a voice note; all land in a private bucket reached only through 1-hour signed URLs.
