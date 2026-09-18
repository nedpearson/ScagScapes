-- /reset reseeds the demo tenant, which rewrites ss_tenants.settings wholesale. That silently reverted
-- settings.ai_sms from "shadow" back to unset the first time the demo was reset after turning it on - an
-- operational switch undone by a content reset, with nothing to tell anyone it had happened. Operational AI
-- settings are not demo content, so carry them across the reseed.
create or replace function ss_reset_demo() returns void language plpgsql security definer set search_path to 'public' as $function$
declare keep jsonb;
begin
  select coalesce(settings, '{}'::jsonb) into keep from ss_tenants where id = 'demo';
  keep := jsonb_strip_nulls(jsonb_build_object(
    'ai_sms', keep->'ai_sms',
    'ai_sms_min_confidence', keep->'ai_sms_min_confidence'));

  perform public.ss_seed_demo();
  -- seed uses date + hour offsets; anything that lands in the future slides back a day so ordering stays sane
  update ss_events    set created_at = created_at - interval '1 day' where tenant_id='demo' and created_at > now();
  update ss_messages  set created_at = created_at - interval '1 day' where tenant_id='demo' and created_at > now();
  update ss_reviews   set created_at = created_at - interval '1 day' where tenant_id='demo' and created_at > now();
  update ss_campaigns set created_at = created_at - interval '1 day' where tenant_id='demo' and created_at > now();

  if keep <> '{}'::jsonb then
    update ss_tenants set settings = coalesce(settings, '{}'::jsonb) || keep where id = 'demo';
  end if;
end $function$;

-- Rollback: restore the previous body (the four update statements, no keep/restore).
