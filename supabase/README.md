# Backend

- **Project:** `cscowglyrgxqxwcnftzt` (us-west-2) — https://cscowglyrgxqxwcnftzt.supabase.co
- **Edge Function:** `functions/ss-api/index.ts` → `https://cscowglyrgxqxwcnftzt.supabase.co/functions/v1/ss-api` (verify_jwt off; demo tenant is open, any other tenant needs `x-ss-key` = `ss_tenants.api_key`)
- **Front end** talks to PostgREST with the publishable key (RLS limits it to the demo tenant) and to `ss-api` for anything with business logic: text-back, SMS intent, pricing, stage machine, rain campaigns, payments, reset.

Deploy the function: `supabase functions deploy ss-api --no-verify-jwt --project-ref cscowglyrgxqxwcnftzt`

To onboard a real tenant: insert a row in `ss_tenants` with a fresh `api_key`, seed `ss_automations` + `ss_forecast`, point Twilio's voice status callback at `/webhooks/call-missed` and the SMS webhook at `/webhooks/sms` with header `x-tenant: <id>` and `x-ss-key`.
