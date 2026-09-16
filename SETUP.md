# Go-live checklist (Scag Scapes Command)

Everything below is optional for the demo — without keys, texts/emails are logged to the Outbox as *simulated* and pay links are placeholders.

```bash
# 1. Twilio — real SMS (text-back, quote requests to rental branches, alerts)
supabase secrets set TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_FROM=+1225XXXXXXX --project-ref cscowglyrgxqxwcnftzt
#    Twilio console → your number → Voice: status callback (no-answer) → POST https://cscowglyrgxqxwcnftzt.supabase.co/functions/v1/ss-api/webhooks/call-missed
#                                   → Messaging: incoming webhook        → POST .../ss-api/webhooks/sms   (send {from, body}; add header x-tenant: demo)

# 2. Stripe — real deposit / balance links
supabase secrets set STRIPE_SECRET_KEY=sk_live_... --project-ref cscowglyrgxqxwcnftzt
#    Stripe → Webhooks → checkout.session.completed → POST .../ss-api/payments/webhook  {job_id, kind:"deposit"}

# 3. Email
supabase secrets set RESEND_API_KEY=re_... --project-ref cscowglyrgxqxwcnftzt

# 4. Web search in Research
supabase secrets set BRAVE_API_KEY=... --project-ref cscowglyrgxqxwcnftzt

# 5. Field ops (optional): private photo bucket for breakdown photos
#    Supabase Dashboard → Storage → new PRIVATE bucket `breakdown-photos`; the intake stores names only until this exists.
#    Approval limits / recovery weights / crew cost: update ss_tenants.settings (approval, recovery_weights, crew_cost_per_hour).

# 6. Weather cron (post-rain campaigns) — Supabase Dashboard → Integrations → Cron:
#    every 6h: select net.http_post('https://cscowglyrgxqxwcnftzt.supabase.co/functions/v1/ss-api/rain/check', '{}'::jsonb, headers => '{"x-tenant":"demo","apikey":"<anon>"}'::jsonb);

# Redeploy the function after any secret change:
supabase functions deploy ss-api --no-verify-jwt --project-ref cscowglyrgxqxwcnftzt
```

Verify: `GET /functions/v1/ss-api/integrations` shows each switch as live; the API & data page mirrors it.
