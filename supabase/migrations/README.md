# Migrations (applied to Supabase project `cscowglyrgxqxwcnftzt`, 2026-09-16)

1. `scagscapes_core_schema` — 12 `ss_*` tables, `ss_kpis` view, RLS (anon/authenticated may only touch `tenant_id='demo'`), `ss_touch()` trigger.
2. `scagscapes_demo_seed_fn` — `ss_seed_demo()` (security definer) reseeds the demo tenant relative to `current_date`.
3. `scagscapes_hide_api_key` — column-level grants on `ss_tenants` so `api_key` is never readable through PostgREST.
4. `scagscapes_reset_fix_future_timestamps` — `ss_reset_demo()` = seed + slide any future timestamps back a day. Exposed via RPC and `POST /reset`.

5. `scagscapes_security_hardening`, `scagscapes_sourcing_schema`, `scagscapes_outbox` — sourcing tables + outbox.
6. `scagscapes_field_ops` — equipment, breakdowns, recovery options, approvals, requirements, inventory, labor rates, estimate versions, audit; 17 verified providers.
7. `scagscapes_field_ops_2` + `scagscapes_reservation_status_lifecycle` — provider feedback, market rates (BLS), push subscriptions, rental lifecycle columns, breakdown media, private bucket (`scagscapes_field_ops_2.sql` here).

Regenerate with `supabase db pull` (Supabase CLI) against the project; this folder is documentation, not the source of truth.
