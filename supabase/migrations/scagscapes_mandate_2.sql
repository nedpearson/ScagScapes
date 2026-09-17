-- scagscapes_mandate_2: property as a first-class node (§11), retrieval index (§15, exportable), vision-ready media refs (§10).
create extension if not exists vector;

-- §11 Customer -> Property -> Lead/Job. Backfilled from the address strings the leads already carry.
create table if not exists ss_properties (
  id uuid primary key default gen_random_uuid(), tenant_id text not null references ss_tenants(id),
  addr text not null, area text, lat double precision, lng double precision,
  lot_sqft numeric, soil text, drainage_notes text, elevation_scan jsonb, photos jsonb default '[]'::jsonb,
  created_at timestamptz default now(), unique (tenant_id, addr)
);
alter table ss_leads add column if not exists property_id uuid references ss_properties(id);
alter table ss_jobs  add column if not exists property_id uuid references ss_properties(id);
insert into ss_properties (tenant_id, addr, area)
  select distinct tenant_id, addr, area from ss_leads where coalesce(addr,'') <> '' on conflict (tenant_id, addr) do nothing;
update ss_leads l set property_id = p.id from ss_properties p where l.property_id is null and l.tenant_id = p.tenant_id and l.addr = p.addr;
update ss_jobs j set property_id = l.property_id from ss_leads l where j.property_id is null and j.lead_id = l.id and l.property_id is not null;
-- keep it in sync going forward
create or replace function ss_link_property() returns trigger language plpgsql as $$
begin
  if coalesce(new.addr,'') <> '' and new.property_id is null then
    insert into ss_properties (tenant_id, addr, area) values (new.tenant_id, new.addr, new.area) on conflict (tenant_id, addr) do update set area = coalesce(excluded.area, ss_properties.area)
    returning id into new.property_id;
  end if; return new;
end $$;
drop trigger if exists ss_leads_link_property on ss_leads;
create trigger ss_leads_link_property before insert or update of addr on ss_leads for each row execute function ss_link_property();

-- §15 retrieval index: embeddings live HERE, in an exportable table, keyed to the record they came from. Provider-agnostic
-- (the vector dimension is stored per row so a different embedding model can coexist during a migration).
create table if not exists ss_embeddings (
  id uuid primary key default gen_random_uuid(), tenant_id text not null references ss_tenants(id),
  ref_type text not null, ref_id uuid not null, chunk int default 0, text text not null,
  provider text not null, model_id text not null, dims int not null, embedding vector(1536),
  created_at timestamptz default now(), unique (tenant_id, ref_type, ref_id, chunk, provider, model_id)
);
create index if not exists ss_embeddings_ref on ss_embeddings(tenant_id, ref_type, ref_id);
create or replace function ss_match(t text, q vector(1536), k int default 8, kinds text[] default null)
returns table (ref_type text, ref_id uuid, chunk int, text text, similarity float) language sql stable as $$
  select e.ref_type, e.ref_id, e.chunk, e.text, 1 - (e.embedding <=> q) as similarity
  from ss_embeddings e where e.tenant_id = t and (kinds is null or e.ref_type = any(kinds)) and e.embedding is not null
  order by e.embedding <=> q limit k $$;

-- §10 vision-ready: images referenced by storage path, never by an AI provider's file id.
alter table ss_ai_recommendations add column if not exists media jsonb default '[]'::jsonb;

alter table ss_properties enable row level security; alter table ss_embeddings enable row level security;
drop policy if exists demo_read on ss_properties; create policy demo_read on ss_properties for select to anon, authenticated using (tenant_id = 'demo');
revoke all on ss_embeddings from anon, authenticated;

-- an embedding model for the retrieval index; inert until OPENAI_API_KEY exists
insert into ss_ai_models (tenant_id, provider, model_id, enabled, capabilities, cost_in_per_m, cost_out_per_m, task_weights)
values ('demo','openai','text-embedding-3-small', true, '{embed}', 0.02, 0, '{"general":0}') on conflict (tenant_id, provider, model_id) do nothing;
