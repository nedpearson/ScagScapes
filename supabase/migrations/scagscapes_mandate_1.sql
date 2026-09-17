-- scagscapes_mandate_1: PRODUCT MANDATE tables - model registry, recommendation ledger, evaluation history, job actuals.
-- Additive only. Nothing existing is altered.

-- §2 model-agnostic layer: which models exist, what they cost, what they are trusted for. Swapping a provider is a row, not a rewrite.
create table if not exists ss_ai_models (
  id uuid primary key default gen_random_uuid(), tenant_id text not null references ss_tenants(id),
  provider text not null check (provider in ('anthropic','openai','gemini','none')), model_id text not null,
  enabled boolean not null default true, capabilities text[] not null default '{text}', privacy_tier text not null default 'vendor-processed',
  cost_in_per_m numeric default 0, cost_out_per_m numeric default 0, task_weights jsonb not null default '{"general":0.5}'::jsonb,
  created_at timestamptz default now(), unique (tenant_id, provider, model_id)
);

-- §8/§9 every recommendation, its evidence, the human decision and what actually happened. This is the closed loop.
create table if not exists ss_ai_recommendations (
  id uuid primary key default gen_random_uuid(), tenant_id text not null references ss_tenants(id),
  task text not null, ref jsonb default '{}'::jsonb, input jsonb default '{}'::jsonb, context_sources text[] default '{}',
  provider text, model_id text, output jsonb, confidence numeric, latency_ms int, usage jsonb, error text, app_version text,
  decision text check (decision in ('accepted','modified','rejected')), decided_by text, decided_at timestamptz,
  final_value jsonb, outcome jsonb, kpi jsonb, created_at timestamptz default now()
);
create index if not exists ss_ai_recs_tenant_task on ss_ai_recommendations(tenant_id, task, created_at desc);

-- §3 versioned evaluation history on real tasks. Promotion decisions are made from this table.
create table if not exists ss_ai_evals (
  id uuid primary key default gen_random_uuid(), tenant_id text not null references ss_tenants(id),
  suite_version text not null, task text not null, fixture_id text not null, provider text not null, model_id text not null,
  score numeric not null, latency_ms int, error text, output text, ran_at timestamptz default now()
);
create index if not exists ss_ai_evals_model on ss_ai_evals(tenant_id, provider, model_id, suite_version);

-- §4 estimate vs actual. One row per finished job. Every completed job makes the next estimate better.
create table if not exists ss_job_actuals (
  id uuid primary key default gen_random_uuid(), tenant_id text not null references ss_tenants(id),
  job_id uuid not null unique references ss_jobs(id) on delete cascade,
  labor_hours_actual numeric, material_cost_actual numeric, crew_days numeric, lf_installed numeric,
  callbacks int default 0, change_orders_value numeric default 0, weather_days_lost numeric default 0,
  equipment_downtime_hours numeric default 0, material_waste_pct numeric, customer_rating int check (customer_rating between 1 and 5),
  notes text, closed_at timestamptz default now()
);

-- §14 the KPI the whole thing is measured on, by service type: how good are our estimates, really.
create or replace view ss_estimate_accuracy as
select j.tenant_id, j.service_type, count(*) as jobs,
  round(avg(a.labor_hours_actual / nullif(j.labor_hours,0))::numeric, 3) as hours_est_vs_actual_ratio,
  round(avg(a.material_cost_actual / nullif(j.material_cost,0))::numeric, 3) as material_est_vs_actual_ratio,
  round(avg(a.lf_installed / nullif(a.crew_days,0))::numeric, 1) as lf_per_crew_day,
  round(avg(a.callbacks)::numeric, 3) as callbacks_per_job,
  round(avg(a.weather_days_lost)::numeric, 2) as weather_days_lost_mean,
  round(avg(a.material_waste_pct)::numeric, 3) as material_waste_pct_mean,
  round(avg(a.customer_rating)::numeric, 2) as customer_rating_mean,
  round(avg((j.value - a.material_cost_actual) / nullif(j.value,0))::numeric, 3) as gross_margin_actual
from ss_jobs j join ss_job_actuals a on a.job_id = j.id group by j.tenant_id, j.service_type;

-- §8 what the model recommended vs what people did - per task and model. Feeds prompt/routing changes.
create or replace view ss_ai_learning as
select tenant_id, task, provider, model_id, count(*) as recommendations,
  count(*) filter (where decision = 'accepted') as accepted,
  count(*) filter (where decision = 'modified') as modified,
  count(*) filter (where decision = 'rejected') as rejected,
  round(avg(confidence)::numeric, 3) as mean_confidence, round(avg(latency_ms)::numeric) as mean_latency_ms,
  count(*) filter (where error is not null) as errors
from ss_ai_recommendations group by tenant_id, task, provider, model_id;

alter table ss_ai_models enable row level security; alter table ss_ai_recommendations enable row level security;
alter table ss_ai_evals enable row level security; alter table ss_job_actuals enable row level security;
drop policy if exists demo_read on ss_ai_models; create policy demo_read on ss_ai_models for select to anon, authenticated using (tenant_id = 'demo');
drop policy if exists demo_read on ss_job_actuals; create policy demo_read on ss_job_actuals for select to anon, authenticated using (tenant_id = 'demo');
-- recommendation ledger and evals hold prompts and customer context: service role only
revoke all on ss_ai_recommendations from anon, authenticated; revoke all on ss_ai_evals from anon, authenticated;

-- Demo registry: nothing enabled until a key exists; pick() ignores providers without a configured key.
insert into ss_ai_models (tenant_id, provider, model_id, enabled, capabilities, cost_in_per_m, cost_out_per_m, task_weights) values
('demo','anthropic','claude-sonnet-4-5', true, '{text,vision}', 3, 15, '{"general":0.7,"scope_from_lead":0.8,"customer_reply":0.8,"job_risk":0.7}'),
('demo','openai','gpt-5-mini', true, '{text,vision}', 0.25, 2, '{"general":0.6,"takeoff_review":0.7,"supplier_search":0.6}'),
('demo','gemini','gemini-2.5-flash', true, '{text,vision}', 0.3, 2.5, '{"general":0.55,"breakdown_triage":0.7}')
on conflict (tenant_id, provider, model_id) do nothing;
