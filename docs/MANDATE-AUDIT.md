# Mandate audit — Scag Scapes Command v1.5.0 (September 17, 2026; updated same day after the follow-through below)

Method: every file in `supabase/functions/ss-api/`, `supabase/migrations/`, `index.html` and `docs/FIELD-OPS.md` was read and grepped. The single most important finding shaped everything below:

> **Before this audit the product contained no AI model call at all.** `grep -i "openai|anthropic|claude|gemini|llm|gpt"` across the codebase returned one hit, and it was a label: `"rule-assisted triage from reported symptoms (no photo/vision model configured)"`. Everything described as intelligent — pricing, intent detection, breakdown triage, recovery ranking, universal search — is deterministic code. That is the correct starting point for §5, and it is why §2/§3/§8 were Missing rather than wrong: there was nothing to route, evaluate, or learn from.

Status key: **Implemented** / **Partial** / **Missing**, each with the evidence and what this release changed.

| # | Requirement | Before | Evidence (before) | Gap | Now |
|---|---|---|---|---|---|
| 1 | Own the data; rent the intelligence | **Implemented** | All records in Supabase (`ss_leads`, `ss_quotes`, `ss_jobs`, `ss_payments`, `ss_vendors`, `ss_rate_cards`, `ss_equipment_assets`, `ss_breakdowns`, `ss_provider_feedback`, `ss_market_rates`…); RLS confines the publishable key to the demo tenant; no third-party AI service holds any record. `index.html` falls back to `localStorage` sample data only when the backend is unreachable. | None on ownership. Job *outcomes* were only partly captured (see §4). | Unchanged. `GET /export` added (§15). |
| 2 | Model-agnostic AI layer | **Missing** | No model call existed, so no coupling — but no abstraction either. | No router, no registry, no way to add a model without writing app code. | **Implemented.** `ai.ts`: `Provider` interface, adapters for `anthropic`/`openai`/`gemini`/`none`; `ss_ai_models` registry per tenant with capabilities, privacy tier, cost per million and per-task weights; `pick()` routes by task weight then cost, and ignores any provider without a configured key. Adding a model = insert a row. Replacing a provider = one adapter object. |
| 3 | Continuous evaluation | **Missing** | `tests.ts` covers pure functions only (58 lines, no network). No model evaluation. | Nothing measured model quality; a "better" model could only be adopted on the vendor's word. | **Implemented.** `evals.ts`: `SUITE_VERSION` + 6 fixtures on real tasks (scope from lead, no-invention trap, breakdown triage, takeoff review, customer reply, job risk) with a deterministic scorer that penalises invented prices and rewards "not in records". `POST /ai/evals/run` scores every enabled model and writes `ss_ai_evals`; `GET /ai/evals` is the history. Promotion is a decision made from that table. |
| 4 | Proprietary data moat (every job makes it better) | **Partial → Implemented** | Captured: estimate versions (`ss_estimate_versions`), breakdown `actual_cost`/`actual_downtime_hours` on resolve (`fieldops.ts:168`), vendor performance (`ss_provider_feedback`), call outcomes → `LIVE_VERIFIED`. **Not captured:** actual labour hours, actual material cost, LF per crew-day, callbacks, change orders, weather days, waste, customer rating. `ss_jobs` stores only the *estimate* (`value`, `material_cost`, `labor_hours`). | The core moat — estimate vs. actual — had no table. | **Implemented.** `ss_job_actuals` (one row per finished job, `POST /jobs/:id/actuals`) and the `ss_estimate_accuracy` view (hours ratio, material ratio, LF/crew-day, callbacks/job, weather, waste, rating, actual gross margin) by service type. `context()` feeds this history into every recommendation, so the model reasons from Scag's own record. **Front end now wired:** advancing a job to *Complete · paid* opens the actuals sheet automatically, and completed jobs carry an *Enter actuals* button. |
| 5 | Deterministic logic separate from AI | **Implemented** | `price()` in `core.ts` is the single pricing authority ("the web app mirrors it"); stage machine, deposits, payments, bookings are code; intent detection is regex (`guessType`, `/webhooks/sms`). | None — but with no AI present it was untested against an AI that *could* emit a number. | Hardened. `strip()` renames any numeric `price/total/deposit/rate/cost/amount/balance/value` an AI returns to `suggested_*`; every recommendation carries `authoritative:false`; the system prompt forbids stating totals. `price()` untouched. |
| 6 | Recommendations require evidence; no fabricated real-time claims | **Implemented** (sourcing) / **Missing** (AI) | Every sourcing/resource row carries `evidence{source,url,method,checked_at,confidence,notes}` and one of `LIVE_VERIFIED / PROVIDER_POSTED / CALL_TO_CONFIRM / ESTIMATED / UNAVAILABLE / STALE / CONNECTION_ERROR` (`core.ts:5`, `resources.ts`, `sourcing.ts`). The README documents each source's honesty level. | No AI, so no AI evidence. | Every `/ai/recommend` response returns `evidence[]`, `assumptions[]`, `alternatives[]`, `confidence`, the `model` used and the exact `context.sources` retrieved. The `none` provider returns records only, labelled. Fixture `scope-02-noinvent` fails any model that invents. |
| 7 | Universal real-time search | **Implemented** | `/resources/search` fans out to internal records, verified vendor directory, Home Depot live inventory/pricing, chain rate cards, Rokrunner, OpenStreetMap; recovery ranking weighs total cost + transport + downtime + distance + open-now + reliability + cancel flexibility (`fieldops.ts:66`, `settings.recovery_weights`). Own-vs-rent per asset (`/pricing/equipment`). | Search is deterministic — fine. It does not yet use a model to *interpret* a vague query; not required to. | Unchanged. `supplier_search` is a registered task so a model can be routed to it later without touching search. |
| 8 | Closed-loop learning | **Partial** | Vendor outcomes (`ss_provider_feedback`), call-package outcomes, breakdown resolution. No AI decisions to learn from. | No record of what was recommended vs. what people did. | **Implemented.** `ss_ai_recommendations` stores task, input, context sources, model, output, confidence, latency, usage, error; `POST /ai/recommendations/:id/decision` records `accepted/modified/rejected`, the final value, the outcome and a KPI; `ss_ai_learning` view aggregates acceptance by task and model. Evaluation history is append-only — no self-modification. |
| 9 | Human control | **Implemented** | Approval guardrails (`settings.approval`), audited labor-rate changes, breakdown intake idempotent by `client_id`, `audit()` trail on incident close, "recommendation only, never auto-applied" on market rates. | — | AI cannot write to any business table. `/ai/recommend` only inserts its own ledger row; the human decision endpoint is the only path from recommendation to action. |
| 10 | Future capabilities (vision, voice, robotics, agents) | **Partial → Implemented (vision, embeddings)** | Provider-adapter pattern already existed for *vendors* (`Provider.search/createReservation/createDeepLink/getCallInstructions` with honest `caps`). Nothing equivalent for models or sensors. | No interface for a vision or voice model to plug into. | Registry rows carry `capabilities[]` (`text`, `vision`, …); the `Provider` interface for models mirrors the vendor one. **Vision is live:** every adapter accepts images; `/ai/recommend` with a `breakdown_id` signs the breakdown photos (10-minute URLs, files never leave the bucket) and routes only to a model tagged `vision`. Fixture `triage-photo-01` scores it; text-only models are skipped on it, not penalised. `embed()` on the Provider interface feeds `ss_embeddings`. Robotics/IoT: still no interface, deliberately — nothing exists to integrate. |
| 11 | Operational knowledge graph | **Partial → Implemented** | Relations exist in the schema: lead → quote → job → payments/bookings; job → requirements → equipment/rentals; asset → events/breakdowns; vendor → feedback. No retrieval layer assembled them for reasoning. | AI had no way to see the graph. | `context()` walks lead → messages, job → quote → actuals, asset → breakdown history, plus service-type accuracy — and returns `sources[]` so the caller can see exactly what was retrieved. **`ss_properties` is now first-class** (migration 2): backfilled from `lead.addr` (6 properties, 6 leads, 5 jobs linked on the demo tenant), kept in sync by a trigger, and `context()` returns the property plus every prior job at that address. Retrieval hits from `ss_embeddings` are merged in when an embedding model is enabled. |
| 12 | No demo-as-production | **Partial** | `tests.ts` (pure), `docs/FIELD-OPS.md` capability table with explicit limits, honest labels ("no vision model configured"). | No acceptance criteria for AI features. | `evals.ts` is the acceptance gate; `/ai/audit` returns the eight questions with where each is satisfied. Demo registry rows are inert until a key is set — nothing pretends to work. |
| 13 | Obsolescence risk | **Partial** | The product already avoids duplicating commodity AI (it has none); value sits in data, integrations and execution. | Not written down as a standing check. | `docs/PRODUCT-MANDATE.md` is now in the repo root's `CLAUDE.md` load path, so every future session inherits the check. Commodity-risk items today: SMS intent regex (`guessType`) and rule triage — both should *use* a routed model, not compete with one. |
| 14 | Measure the business outcome | **Partial** | `ss_kpis` view; vendor on-time/accuracy; `ss_market_rates` benchmarks. No estimate accuracy, callbacks, waste, LF/day, rating. | The metrics the mandate names were not tracked. | `ss_estimate_accuracy` covers gross margin (actual), labour utilisation (hours ratio), material waste, callbacks, customer rating, LF per crew-day, weather loss. Every AI recommendation may carry a `kpi`. |
| 15 | Portability | **Implemented** | Data in Postgres (exportable by nature); prompts and rules lived only in code. | No one-call export; no documented prompt/eval/rules bundle. | `GET /export` returns every tenant table (now including `ss_properties` and `ss_embeddings`) plus the system prompt, eval fixtures and app/suite versions as one JSON file. Embeddings live in Scag's own table with the model and dimension recorded per row, so a different embedding model can coexist during a migration. Business rules remain in `price()`. |

## What was deliberately NOT changed
- `price()`, the stage machine, webhooks, sourcing, field ops and resources modules are untouched. Working functionality was not replaced.
- No AI provider is enabled by default. `pick()` returns `null` until a key exists, and `/ai/recommend` then returns the retrieved records with an honest note.
- The regex intent detector in `/webhooks/sms` stays. It is a candidate to route through `customer_reply` once evals show a model beats it.

## Follow-through, same day
1. ✅ `ss_properties` — first-class, backfilled, trigger-maintained, in the graph.
2. ✅ Front end — actuals sheet at stage 4 (`job.actuals`), *AI: job risk* on open jobs, *AI: second opinion* on the breakdown drawer (sends the photos), *AI: review scope* on the quote builder; every panel shows evidence, records read, confidence and model, carries "Not authoritative", and posts Accept / Used with changes / Reject to the ledger. Service-worker cache bumped to v10.
3. ✅ Vision — image-capable adapters, capability-aware routing, `triage-photo-01` fixture, suite 2026.09.2.
4. ✅ Retrieval — `ss_embeddings` (pgvector, 1536, exportable), `ss_match()` SQL, `POST /ai/index`, `GET /ai/search`; merged into `context()` when a query is present. Inert until an `embed`-capable model has a key.
5. ✅ CI — `.github/workflows/tests.yml` runs `deno check`, `deno test` and a front-end parse on every push, since Deno is not installed locally.

## Remaining gaps (in priority order)
1. **Security review** before any AI feature touches customer data in production ($5–15K, already budgeted in the AI blueprint). The new surfaces to include in scope: `/ai/recommend` (sends lead names, addresses and messages to a third-party model when enabled), signed breakdown-photo URLs, `/export` (tenant-wide dump — demo tenant is open; any real tenant must require `x-ss-key`).
2. **Enable a provider and run `/ai/evals/run`** — nothing in the AI layer is exercised against a real model until a key exists. Do the first run on the demo tenant and read the scores before touching a real one.
3. **SMS reply** (`/webhooks/sms`) still uses regex intent; route through `customer_reply` only after `reply-01` scores above the regex baseline.
4. **Property enrichment UI** — `POST /properties/:id` exists (soil, lot, drainage notes, elevation scan, photos) but the front end does not surface it yet.

## Deploy
```
supabase db push            # applies migrations/scagscapes_mandate_1.sql
supabase secrets set ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=...   # any subset
supabase functions deploy ss-api --no-verify-jwt --project-ref cscowglyrgxqxwcnftzt
curl .../ss-api/ai/audit      # the eight questions, machine-readable
curl -X POST .../ss-api/ai/evals/run -H "x-ss-key: $SS_ADMIN_KEY"   # score every enabled model before trusting any of them
```

---

## Security sweep — September 17, 2026 (v1.5.1)

Run before any provider key is set, because two of the findings convert to money or to customer data the day one is. Method: repo credential scan (tree + history), Postgres grant/RLS/SECURITY DEFINER verification, live probes against the deployed function, Vercel project settings. A finding is listed only where the exploit path was verified open end to end.

**Verdict: no real data was ever at risk.** `demo` is the only tenant and every record in it is seed fiction (225-555-xxxx). Two paths were open and are now closed; one was latent and would have opened on the first real tenant.

| # | Finding | Verified how | Status |
|---|---|---|---|
| 1 | Three views bypassed tenant RLS | `ss_kpis`, `ss_estimate_accuracy`, `ss_ai_learning` held full `anon` grants with no `security_invoker`, so they read base tables as owner. The publishable key from `index.html:455` returned `booked_value`/`collected`. | **Fixed** — `scagscapes_security_1.sql`. `ss_ai_learning` now returns `42501`; `ss_kpis` returns only rows the caller's policies allow. |
| 2 | `/export` unauthenticated | `GET /export` with zero headers → 200, 99,191 bytes, 26 tables. | **Fixed** — gated on `SS_ADMIN_KEY` (`ai.ts`, `guard()`), returns 401. |
| 3 | `/ai/evals/run`, `POST /ai/models` unauthenticated | Same path; inert only because no provider key exists. A stranger could otherwise loop the eval suite on Scag's card, or enable a model nobody chose. | **Fixed** — same guard, 401. |
| 4 | `api_key` plaintext, compared with `!==` | `core.ts:73`. Timing-variable. | **Open, low** — fix in the commit that creates the first real tenant. |
| 5 | Mutable `search_path` on two functions | Both SECURITY INVOKER, so no privilege gain. | **Fixed** — pinned to `public, pg_temp`. |

**Deliberately left open:** the rest of the API is unauthenticated for tenant `demo` (`core.ts:73`). That is the design — `demo` is a public sandbox with a `/reset`, and gating it would break the clickable demo. The standing rule this creates: **no real tenant is ever named `demo`, and no real record is ever written to it.**

**Dismissed as noise, with the reason:**
- 4× `rls_enabled_no_policy` (INFO) on `ss_ai_recommendations`, `ss_embeddings`, `ss_ai_evals`, `ss_push_subscriptions` — `anon`/`authenticated` hold **zero grants** on all four and PostgREST returns `42501`. Postgres checks grants before RLS, so this is the correct end state, not a gap.
- `vector` extension in `public` (WARN) — no exposure path.
- `ss_reset_demo` / `ss_seed_demo` are SECURITY DEFINER but `executable_by: NONE` with `search_path` pinned.

**Checked and clean:** repo credential scan found no service-role JWT, Postgres URL or provider key in the tree or in history (`.gitignore` covers `.env`, `.env.*`; `.env` never committed) — the only key in the repo is the publishable one, public by design. `/export` is tenant-scoped and omits `ss_tenants`, so no `api_key` can leak through it. Vercel preview deployments are SSO-protected. `auth.users` is empty **and** no policy keys on `auth.uid()`, so there is no inert-policy trap waiting.

**Note on the public repo:** `github.com/nedpearson/ScagScapes` is public. No credentials are exposed, but the full route table and `docs/PRODUCT-MANDATE.md` are readable by anyone, which is how someone would find an open endpoint without guessing. Worth a deliberate decision given the NDA and watermarking around the Charlie package.

---

## Follow-through round 3 — September 17, 2026 (v1.6.0)

Closes the two items on the remaining-gaps list that did not require a key Ned has to set himself.

### §13 — the SMS regex now has a measurable challenger
The audit said the regex intent detector in `/webhooks/sms` "should *use* a routed model, not compete with one," and that it stays until evals show a model beats it. That sentence was unenforceable, because there was no number for the regex. There is now.

- `smsIntent()` moved into `core.ts` as a pure function. `index.ts` runs it in production and `evals.ts` scores **the same function** as the baseline — they cannot diverge, and `tests.ts` fails if they do.
- `POST /ai/evals/run` writes a `provider: "baseline"` row for every fixture with a real deterministic equivalent, alongside every model's rows in `ss_ai_evals`. Fixtures without one get no baseline; inventing one would make the comparison dishonest.
- Measured today: the ladder scores **0.75** on `reply-01`. It loses the point for never mentioning hauling, because "does the **price** include hauling the dirt off" trips the price branch first. That is the gap a model has to close, recorded rather than argued about.
- `settings.ai_sms` gates the routing: `"off"` (default), `"shadow"` (the model drafts, the ladder's reply still sends, the draft is logged as a recommendation for accept/reject), `"live"` (the model answers). Even on `live` the model never handles a **booking** — that has side effects — never sends a reply containing a number (`PRICE_RE`), yields to the ladder below `settings.ai_sms_min_confidence` (default 0.7), and any error falls back silently. A model failure must never drop a customer's text.
- `/ai/recommend`'s body became the exported `recommend()`, so the webhook goes through the identical guarded path — strip, ledger row, confidence — rather than a second unguarded one.

### §11 — property enrichment UI
`ss_properties` existed and `context()` read it, but nothing could fill it. New **Properties** section: every address with soil, lot size, elevation-scan reference, drainage notes, jobs at that address and a 0–5 "known" score, editable in a sheet that writes to `POST /properties/:id`. `context()` now also accepts `property_id` directly, so *AI: read this property* works from the sheet. Verified: `/ai/recommend` with a bare `property_id` returns sources `ss_properties, ss_jobs(property)`.

Verified after deploy: `/health` 1.6.0; all three SMS branches (`book`, `haul`, fallback) return byte-identical replies to v1.5.1 with `ai_draft: null`; `/properties` returns 6; gated routes still 401; demo reset after probing.

**Status change:** §13 Partial → **Implemented** (the check is now a number in a table, not a sentence in a doc). §11 Partial → **Implemented**. §12 stays Partial until a real model is scored — that needs a key.

---

## First real model scores, and two things they exposed — September 18, 2026 (suite 2026.09.4)

`ANTHROPIC_API_KEY` and `SS_ADMIN_KEY` are set (by Ned, from `supabase/setup-secrets.ps1`). First scored run of `claude-sonnet-4-5` against suite 2026.09.3:

| fixture | task | model | baseline |
|---|---|---|---|
| scope-01 | scope_from_lead | **1.00** | — |
| scope-02-noinvent | scope_from_lead | **1.00** | — |
| takeoff-01 | takeoff_review | **1.00** | — |
| reply-01 | customer_reply | **1.00** | **0.75** |
| triage-01 | breakdown_triage | 0.60 | — |
| risk-01 | job_risk | 0.50 | — |
| triage-photo-01 | breakdown_triage | *error* | — |

The model clears the baseline on `reply-01`, which is the gate for routing SMS. `settings.ai_sms` is now **`shadow`** on the demo tenant — the ladder still answers every customer, the model drafts alongside, and every draft is logged for accept/reject. It is deliberately not `live`, on one fixture.

### Two defects the run exposed, both now fixed

**1. The suite was scoring a model for a broken link.** `triage-photo-01` pointed at a Wikimedia URL that returns 400 — the filename was invented when the fixture was written and never verified. The model scored 0 for a dead link rather than for anything it said, and that 0 was averaged into its mean. A test that defames the thing it measures is worse than no test. Fixed two ways: fixture images now use `storage:<bucket>/<path>` and are resolved to short-lived signed URLs from Scag's own bucket at run time (exactly what production does for breakdown photos), and a missing object **skips** the fixture with a stated reason instead of scoring it. Separately, `/ai/evals/run`'s summary now excludes errored rows from the mean and reports `scored` / `errors` / `skipped` separately — an errored call is a missing measurement, not a zero, and averaging it in is how an eval suite quietly starts lying.

**2. A 1.00 on `reply-01` did not mean the reply was sendable.** In shadow mode the model's first real draft was *"Confirm spoil hauling is included per standard practice; offer both Friday slots"* — advice addressed to Charlie. The scorer checks keyword coverage and price abstinence, both of which that sentence passes, so a perfect score hid the fact that the output was not a text message. Had `ai_sms` been `live`, that would have gone to a homeowner. The `customer_reply` system prompt now states that `recommendation` **is** the outgoing message — second person, under ~300 characters, no placeholders, no staff instructions, reasoning goes in `reasoning`.

After the fix, the same three inbound texts produce drafts that are genuinely better than the ladder rather than merely higher-scoring — notably answering both halves of *"does it include hauling AND can you do next week"*, which the single-branch ladder structurally cannot:

> SENT (ladder): "It does — spoils hauled, trench line restored."
> DRAFT (model, 0.95): "It does — spoils hauled, trench line restored. Next week works! We have Friday 9/18 at 7:30am or 4pm open. Which time is better for you?"

**The lesson for §3, written down so it outlives this session:** a fixture score is evidence about the scorer as much as about the model. Before any `shadow → live` decision, read the actual drafts, not only the numbers.

### Still open
- Re-run `POST /ai/evals/run` under suite 2026.09.4 for clean numbers under the corrected prompt and skip logic.
- `triage-photo-01` stays skipped until a real breakdown photo is uploaded to `breakdown-media/evals/hydraulic-hose-burst.jpg`.
- `triage-01` (0.60) and `risk-01` (0.50) are honest mediocre scores. Worth reading the outputs before deciding whether the model or the scorer is wrong — and not tuning the scorer to flatter the model.

---

## Reading the low scores — September 18, 2026 (suite 2026.09.5)

The previous entry left two honest-looking mediocre scores with the instruction to *read the outputs before deciding whether the model or the scorer is wrong, and not to tune the scorer to flatter the model*. Doing that turned up two defects, neither of them the model's.

### 1. The scorer was penalising grounded figures
`triage-01` (0.60) and `risk-01` (0.50) each lost **exactly** the two `must_not_state_price` points and nothing else — every other check passed. Reading the stored outputs shows why:

- triage-01 reasoning: *"Previous breakdown history shows hydraulic hose burst at **$420**/5hrs downtime"* — `breakdown_history[0].actual_cost` is 420, in that fixture's own context.
- risk-01 reasoning: *"**Job value $6,400** represents moderate revenue exposure"* — `job.value` is 6400, likewise.

Both were quoting Scag's own records back. The mandate's rule is that `price()` owns prices and a model must never hand a customer a total — not that a model may never repeat a number Scag already knows. The check tested `recommendation + reasoning` against one regex and could not tell the difference.

Corrected: the **recommendation** stays strictly price-free, because that is the part a human might send on; **reasoning** is penalised only for figures absent from the context. Invention is still caught anywhere it appears, and a new test locks all three cases down — grounded-in-reasoning passes, ungrounded-in-reasoning fails, grounded-in-recommendation fails.

Re-scored against the models' **original unchanged outputs**: triage-01 **0.60 → 1.00**, risk-01 **0.50 → 1.00**. Nothing about the model changed; the measurement was wrong. This is a correction, not a loosening — and it is worth noting that it makes the suite look flattering, which is exactly why the reasoning is written down here rather than left in a commit message.

### 2. `/reset` silently reverted shadow mode
Turning on `settings.ai_sms = "shadow"` and then resetting the demo tenant to clear probe texts wiped the setting, because the reseed rewrites `ss_tenants.settings` wholesale. An operational switch undone by a content reset, with nothing to say it had happened — and `/reset` is unauthenticated on the demo tenant, so any visitor could do it. `ss_reset_demo()` now carries `ai_sms` and `ai_sms_min_confidence` across the reseed (`supabase/migrations/scagscapes_reset_preserves_ai_settings.sql`). Verified: fired `/reset`, `ai_sms` still `shadow`, `deposit_pct` back to the seeded 30.

**Standing lesson, added to the §3 rule:** when a fixture score is low, the first question is whether the scorer measured the right thing. When it is high, the first question is whether the output would survive contact with a customer. Both failures showed up in this suite within a day of each other.
