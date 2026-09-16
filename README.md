# Scag Scapes Command

Demo of the automated sales-to-billing operating layer for **Scag Scapes LLC** (Baton Rouge, LA) — a BridgeBox.ai client app.

Missed-call text-back · self-booking · six-service quote builder with auto-BOM · job pipeline · rain-triggered campaigns · auto-invoicing · review capture · customers · reports · competitive edge · commercial growth intelligence · API/data controls · automation settings. Desktop and phone (installable PWA).

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


## Commercial growth intelligence

The `Commercial growth` workspace adds:

- named-account pursuit tracking by market, route-in, stage, value and next action
- a public-evidence competitor matrix that separates verified strengths from positioning hypotheses
- direct links to Louisiana and Baton Rouge procurement channels
- proposal battlecards based on contractor archetype rather than public attacks
- loss-intelligence capture so counter-positioning improves from actual buyer decisions

Competitor and opportunity entries are research leads, not allegations or guaranteed work. Verify bid status, licensing, insurance, bonding, scope and eligibility before pursuit.
