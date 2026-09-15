# Scag Scapes Command

Demo of the automated sales-to-billing operating layer for **Scag Scapes LLC** (Baton Rouge, LA) — a BridgeBox.ai client app.

Missed-call text-back · self-booking · six-service quote builder with auto-BOM · job pipeline · rain-triggered campaigns · auto-invoicing · review capture · customers · automation settings. Desktop and phone (installable PWA).

## Run

Static site. Open `index.html`, or:

```
npx serve .
```

## Deploy

Vercel project `bridgebox-scagscapes` (team Pearson Projects) is linked to `main`. Push to deploy.

## Notes

- All data is sample data, held in `localStorage` per device. **Reset demo data** in the sidebar restores the seed.
- No backend, no secrets. Any future integrations (Twilio, NWS API, Stripe, QuickBooks) take env vars — see `.env.example`.
- `sw.js` caches the app for offline / home-screen use.
