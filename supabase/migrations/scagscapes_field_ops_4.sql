-- scagscapes_field_ops_4: commercial pursuits (real persistence), purchase orders, part compatibility
--
-- Replaces an earlier draft of this file that declared `tenant_id uuid not null`. Every one of the 44 existing
-- tables uses `tenant_id text`, and `ss_tenants.id` is text ('demo', 'scagscapes') - so that draft would have
-- created three tables that rejected every insert the app makes. It was never applied. Additive only.
--
-- It also proposed `ss_equipment_maintenance_events`, which is a near-duplicate of the existing
-- `ss_equipment_events` (kind, body, cost, hours, ref_id). Splitting maintenance across two tables would mean
-- context() and the recovery scorer each see half the history, so maintenance stays in ss_equipment_events and
-- this migration adds only what genuinely has no home.

-- ---------------------------------------------------------------------------------------------------------
-- Commercial pursuits
--
-- These existed on branch codex/commercial-growth-intelligence as `S.intel.pursuits` - a localStorage array
-- with three hardcoded rows and no backend at all (that branch's index.ts contains the word "pursuit" zero
-- times). That is why commercial data "disappeared after refresh": it was never persisted anywhere. The board
-- also rendered a `data-act="intel.advance"` button that had no handler, so the stage control did nothing.
-- ---------------------------------------------------------------------------------------------------------
create table if not exists ss_commercial_pursuits (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references ss_tenants(id),
  account text not null,
  market text,
  route text,                       -- how we get in: property manager, GC, architect, public bid, facility, referral
  scope text,
  stage text not null default 'Research'
    check (stage in ('Research','Contacted','Qualified','Proposed','Won','Lost')),
  value numeric default 0,
  next_action text,
  due date,
  owner text,
  lead_id uuid references ss_leads(id),      -- when a pursuit becomes a real lead, it is the SAME lead
  job_id uuid references ss_jobs(id),        -- and the same job. No duplicate customer records (prompt §30).
  history jsonb default '[]'::jsonb,         -- every stage change, who and when
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists ss_commercial_losses (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references ss_tenants(id),
  pursuit_id uuid references ss_commercial_pursuits(id) on delete set null,
  competitor text,
  value numeric default 0,
  reason text,
  lesson text,
  recorded_by text,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------------------------------------
-- Purchasing: the approved request becomes an order. ss_purchase_requests does not exist yet either, so the
-- order carries the requirement link directly rather than dangling off a table that is not there.
-- ---------------------------------------------------------------------------------------------------------
create table if not exists ss_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references ss_tenants(id),
  job_id uuid references ss_jobs(id),
  vendor_id uuid references ss_vendors(id),
  requirement_id uuid references ss_job_requirements(id),
  approval_id uuid references ss_approvals(id),
  items jsonb default '[]'::jsonb,
  total_amount numeric,
  status text not null default 'draft'
    check (status in ('draft','requested','approved','ordered','partial','received','cancelled')),
  confirmation text,
  ordered_by text,
  ordered_at timestamptz,
  received_at timestamptz,
  created_at timestamptz default now()
);

-- Part compatibility: only ever written from a confirmed fit, never from an AI guess (prompt §30).
create table if not exists ss_part_compatibility (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references ss_tenants(id),
  asset_category text not null,
  make text,
  model text,
  part_name text not null,
  part_number text,
  source text,                      -- manual, dealer, invoice - where the fit was confirmed
  confirmed_by text,                -- null means proposed, not confirmed
  confirmed_at timestamptz,
  notes text,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------------------------------------
-- Indexes: tenant scoping on every operational table, plus the lookups these are actually queried by.
-- ---------------------------------------------------------------------------------------------------------
create index if not exists ss_commercial_pursuits_tenant on ss_commercial_pursuits(tenant_id, stage);
create index if not exists ss_commercial_pursuits_due on ss_commercial_pursuits(tenant_id, due) where stage not in ('Won','Lost');
create index if not exists ss_commercial_pursuits_lead on ss_commercial_pursuits(lead_id) where lead_id is not null;
create index if not exists ss_commercial_pursuits_job on ss_commercial_pursuits(job_id) where job_id is not null;
create index if not exists ss_commercial_losses_tenant on ss_commercial_losses(tenant_id);
create index if not exists ss_commercial_losses_pursuit on ss_commercial_losses(pursuit_id) where pursuit_id is not null;
create index if not exists ss_purchase_orders_tenant on ss_purchase_orders(tenant_id, status);
create index if not exists ss_purchase_orders_job on ss_purchase_orders(job_id) where job_id is not null;
create index if not exists ss_purchase_orders_vendor on ss_purchase_orders(vendor_id) where vendor_id is not null;
create index if not exists ss_part_compatibility_lookup on ss_part_compatibility(tenant_id, asset_category, make, model);

-- ---------------------------------------------------------------------------------------------------------
-- RLS, matching every other operational table: the publishable key may SELECT demo-tenant rows and nothing
-- else. All writes go through ss-api's service role.
-- ---------------------------------------------------------------------------------------------------------
alter table ss_commercial_pursuits enable row level security;
alter table ss_commercial_losses   enable row level security;
alter table ss_purchase_orders     enable row level security;
alter table ss_part_compatibility  enable row level security;

drop policy if exists demo_read on ss_commercial_pursuits;
create policy demo_read on ss_commercial_pursuits for select to anon, authenticated using (tenant_id = 'demo');
drop policy if exists demo_read on ss_commercial_losses;
create policy demo_read on ss_commercial_losses for select to anon, authenticated using (tenant_id = 'demo');
drop policy if exists demo_read on ss_purchase_orders;
create policy demo_read on ss_purchase_orders for select to anon, authenticated using (tenant_id = 'demo');
drop policy if exists demo_read on ss_part_compatibility;
create policy demo_read on ss_part_compatibility for select to anon, authenticated using (tenant_id = 'demo');

-- Keep updated_at honest on the pursuit board, where stage changes are the whole point.
drop trigger if exists ss_commercial_pursuits_touch on ss_commercial_pursuits;
create trigger ss_commercial_pursuits_touch before update on ss_commercial_pursuits
  for each row execute function ss_touch();

-- ---------------------------------------------------------------------------------------------------------
-- Seed the demo tenant with the three pursuits and three losses that used to be hardcoded in the page, so the
-- demo looks the same and the data is now real. Idempotent: only inserts when the table is empty for demo.
-- ---------------------------------------------------------------------------------------------------------
insert into ss_commercial_pursuits (tenant_id, account, market, route, scope, stage, value, next_action, due, owner)
select * from (values
  ('demo','Port of Greater Baton Rouge','Port Allen','Facility team','Drainage assessment + recurring inspection','Research',85000::numeric,'Map facility contacts and vendor registration',current_date + 1,'Charlie'),
  ('demo','Baton Rouge commercial portfolio','Baton Rouge','Property manager','Portfolio drainage risk audit','Qualified',140000::numeric,'Build 3-property pilot proposal',current_date - 2,'Charlie'),
  ('demo','Local civil / GC partner','Capital Region','General contractor','Drainage verification + landscape restoration','Contacted',225000::numeric,'Schedule capability meeting',current_date - 3,'Charlie')
) as v(tenant_id,account,market,route,scope,stage,value,next_action,due,owner)
where not exists (select 1 from ss_commercial_pursuits where tenant_id = 'demo');

insert into ss_commercial_losses (tenant_id, competitor, value, reason, lesson)
select * from (values
  ('demo','General landscape contractor',42000::numeric,'Existing relationship','Build the referral channel before bid day'),
  ('demo','Low-price drainage crew',18500::numeric,'Price','Show discharge, grade proof, restoration and lifetime risk'),
  ('demo','Large regional operator',76000::numeric,'Capacity confidence','Present insurance, crew plan, schedule and named project owner')
) as v(tenant_id,competitor,value,reason,lesson)
where not exists (select 1 from ss_commercial_losses where tenant_id = 'demo');
