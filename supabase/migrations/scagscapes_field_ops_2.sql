-- scagscapes_field_ops_2: provider performance, market-rate research, push subscriptions, private breakdown photos, rental lifecycle
create table if not exists ss_provider_feedback (
  id uuid primary key default gen_random_uuid(), tenant_id text not null references ss_tenants(id),
  vendor_id uuid references ss_vendors(id), ref_type text, ref_id uuid,
  on_time boolean, quote_accurate boolean, issue text, rating int check (rating between 1 and 5), note text,
  reported_by text, created_at timestamptz default now()
);
create index if not exists ss_provider_feedback_vendor on ss_provider_feedback(tenant_id, vendor_id);

create table if not exists ss_market_rates (
  id uuid primary key default gen_random_uuid(), tenant_id text not null references ss_tenants(id),
  geography text not null, occupation text not null, soc text, source text not null, source_url text, source_date date,
  min numeric, typical numeric, max numeric, unit text default 'hour', confidence numeric, assumptions text, created_at timestamptz default now()
);

create table if not exists ss_push_subscriptions (
  id uuid primary key default gen_random_uuid(), tenant_id text not null references ss_tenants(id),
  endpoint text not null unique, keys jsonb not null, ua text, role text, created_at timestamptz default now()
);

alter table ss_reservations add column if not exists confirmation text, add column if not exists end_date date, add column if not exists returned_at timestamptz, add column if not exists pickup_at timestamptz, add column if not exists history jsonb default '[]'::jsonb;
alter table ss_breakdowns add column if not exists media jsonb default '[]'::jsonb;

alter table ss_provider_feedback enable row level security; alter table ss_market_rates enable row level security; alter table ss_push_subscriptions enable row level security;
drop policy if exists demo_read on ss_provider_feedback; create policy demo_read on ss_provider_feedback for select to anon, authenticated using (tenant_id = 'demo');
drop policy if exists demo_read on ss_market_rates; create policy demo_read on ss_market_rates for select to anon, authenticated using (tenant_id = 'demo');
-- push subscriptions: never readable by the publishable key
revoke all on ss_push_subscriptions from anon, authenticated;

-- private bucket for breakdown media (service role only; the app gets 1-hour signed URLs from ss-api)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('breakdown-media', 'breakdown-media', false, 8388608, array['image/jpeg','image/png','image/webp','video/mp4','audio/webm','audio/mpeg'])
on conflict (id) do nothing;

-- market benchmarks (recommendation only, never auto-applied). Source: BLS OEWS May 2023, Baton Rouge MSA (12940).
insert into ss_market_rates (tenant_id, geography, occupation, soc, source, source_url, source_date, min, typical, max, unit, confidence, assumptions) values
('demo','Baton Rouge, LA MSA','Landscaping and groundskeeping workers','37-3011','BLS OEWS May 2023','https://www.bls.gov/oes/2023/may/oes_12940.htm','2023-05-01',null,16.80,null,'hour',0.8,'Mean hourly wage; percentiles not captured. 2,240 employed.'),
('demo','Baton Rouge, LA MSA','First-line supervisors of landscaping workers','37-1012','BLS OEWS May 2023','https://www.bls.gov/oes/2023/may/oes_12940.htm','2023-05-01',null,24.53,null,'hour',0.8,'Mean hourly wage. 280 employed.'),
('demo','Baton Rouge, LA MSA','Construction laborers','47-2061','BLS OEWS May 2023','https://www.bls.gov/oes/2023/may/oes_12940.htm','2023-05-01',null,20.43,null,'hour',0.8,'Mean hourly wage. 3,180 employed.'),
('demo','Baton Rouge, LA MSA','Operating engineers / construction equipment operators','47-2073','BLS OEWS May 2023','https://www.bls.gov/oes/2023/may/oes_12940.htm','2023-05-01',null,32.26,null,'hour',0.8,'Mean hourly wage. 1,220 employed.'),
('demo','Baton Rouge, LA MSA','Cement masons and concrete finishers','47-2051','BLS OEWS May 2023','https://www.bls.gov/oes/2023/may/oes_12940.htm','2023-05-01',null,23.94,null,'hour',0.8,'Mean hourly wage. 680 employed.'),
('demo','Baton Rouge, LA MSA','Mobile heavy equipment mechanics','49-3042','BLS OEWS May 2023','https://www.bls.gov/oes/2023/may/oes_12940.htm','2023-05-01',null,32.22,null,'hour',0.8,'Mean hourly wage — benchmark for mobile-mechanic labor rates. 320 employed.'),
('demo','Baton Rouge, LA MSA','Heavy and tractor-trailer truck drivers','53-3032','BLS OEWS May 2023','https://www.bls.gov/oes/2023/may/oes_12940.htm','2023-05-01',null,24.48,null,'hour',0.8,'Mean hourly wage. 7,090 employed.');
