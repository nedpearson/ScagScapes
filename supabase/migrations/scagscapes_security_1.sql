-- scagscapes_security_1: security sweep 2026-09-17. Applied to production the same day.
--
-- Finding: ss_kpis, ss_estimate_accuracy and ss_ai_learning carried full anon/authenticated grants and were
-- created without security_invoker, so they read their base tables as the view OWNER and ignored every
-- tenant RLS policy. Verified before the fix: the publishable key shipped in index.html returned
-- ss_kpis rows including booked_value and collected. With one tenant ('demo') nothing real leaked, but the
-- first real tenant would have had its revenue, close rate and margins readable by any holder of that key.
alter view ss_kpis              set (security_invoker = on);
alter view ss_estimate_accuracy set (security_invoker = on);
alter view ss_ai_learning       set (security_invoker = on);

-- A read-only aggregate view needs SELECT and nothing else.
revoke insert, update, delete, truncate, references, trigger
  on ss_kpis, ss_estimate_accuracy, ss_ai_learning from anon, authenticated;

-- Defense in depth: both are SECURITY INVOKER so there is no privilege gain today, but a pinned search_path
-- means a future change to either function cannot be hijacked by a caller-controlled schema.
alter function ss_match(text, vector, int, text[]) set search_path = public, pg_temp;
alter function ss_link_property()                  set search_path = public, pg_temp;

-- Rollback (restores the pre-sweep behaviour exactly):
--   alter view ss_kpis set (security_invoker = off);   -- and the other two
--   grant insert, update, delete, truncate, references, trigger on <views> to anon, authenticated;
--   alter function ss_match(text, vector, int, text[]) reset search_path;
