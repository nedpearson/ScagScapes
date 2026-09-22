# Scag Scapes Command — repo instructions

**Load-bearing:** read `docs/PRODUCT-MANDATE.md` before any architecture, feature, database, workflow, integration or UI change, and run its eight-question audit before calling anything production-ready. The latest audit is `docs/MANDATE-AUDIT.md`; keep it current.

- `price()` in `supabase/functions/ss-api/core.ts` is the only pricing authority. AI recommends; it never sets a number.
- AI goes through `ai.ts` (`Provider` adapters + `ss_ai_models` registry). Never call a vendor SDK from a feature.
- Promote a model only from `ss_ai_evals` results (`POST /ai/evals/run`), never on a vendor claim. Bump `SUITE_VERSION` when fixtures change.
- Every finished job gets a `ss_job_actuals` row. Every recommendation gets a decision.
- Distances come from `routing.ts`, never raw `miles()`. A fallback is `ESTIMATED` and says so; river crossings carry their caveat.
- Notifications go through `notify.ts`. Never insert into `ss_notifications` directly — that bypasses quiet hours, acknowledgement and escalation.
- Deploy: `supabase db push && supabase functions deploy ss-api --no-verify-jwt --project-ref cscowglyrgxqxwcnftzt`. Tests: `deno test supabase/functions/ss-api/tests.ts` and `node tests/local-smoke.mjs` (working tree, not the deployment).
