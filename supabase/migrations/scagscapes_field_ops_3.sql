-- scagscapes_field_ops_3: notification urgency / quiet hours / acknowledgement / escalation
--
-- Additive only. Every column is nullable or defaulted, so rows written by the previous function version stay
-- valid and the old function keeps working against this schema (it simply never sets the new columns).

alter table ss_notifications
  add column if not exists urgency text default 'normal' check (urgency in ('critical','high','normal','low')),
  add column if not exists roles text[] default array['pm','admin'],
  add column if not exists channels text[] default array['in_app'],
  add column if not exists needs_ack boolean default false,
  add column if not exists ack_at timestamptz,
  add column if not exists ack_by text,
  add column if not exists deferred_to timestamptz,          -- set while quiet hours hold it back
  add column if not exists escalate_after_min int,
  add column if not exists escalate_to text,
  add column if not exists escalated_at timestamptz,          -- stamped once; makes escalation idempotent
  add column if not exists escalated_from uuid references ss_notifications(id);

-- The escalation sweep asks exactly two questions; both get an index so it stays cheap when called on app load.
create index if not exists ss_notifications_deferred
  on ss_notifications (tenant_id, deferred_to) where deferred_to is not null;
create index if not exists ss_notifications_pending_ack
  on ss_notifications (tenant_id, created_at) where needs_ack = true and ack_at is null and escalated_at is null;
create index if not exists ss_notifications_escalated_from
  on ss_notifications (escalated_from) where escalated_from is not null;

-- Tenant-level notification preferences. Defaults mirror DEFAULT_PREFS in notify.ts; a tenant that has never
-- been configured behaves exactly as it did before this migration except that low/normal notices no longer
-- push a phone between 21:00 and 06:00.
update ss_tenants
   set settings = jsonb_set(
         coalesce(settings, '{}'::jsonb), '{notifications}',
         coalesce(settings -> 'notifications', '{
           "quiet_start": 21,
           "quiet_end": 6,
           "quiet_min_urgency": "critical",
           "tz_offset": -5,
           "escalation_enabled": true,
           "channels": {
             "critical": ["push","sms","in_app"],
             "high": ["push","in_app"],
             "normal": ["in_app"],
             "low": ["in_app"]
           }
         }'::jsonb), true)
 where settings -> 'notifications' is null;

-- Stop overhead used by the shopping-plan optimizer (park, counter, load, leave). Named here rather than
-- hardcoded so Charlie can correct it from what the crew actually does.
update ss_tenants
   set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{stop_minutes}', '18'::jsonb, true)
 where settings -> 'stop_minutes' is null;
