-- Allow coach-authored training sessions.
-- ─────────────────────────────────────────────────────────────────────────────
-- training_sessions.source has a check constraint that predates the coach feature
-- and never included 'coach', so every coach-authored insert failed. The app
-- (lib/server/planAuthority.js) already treats source='coach' as coach-authored;
-- this widens the DB to match. Rebuilt dynamically from the values already present
-- so no existing source value is dropped. Safe to run more than once.
do $$
declare existing text;
begin
  select coalesce(string_agg(distinct quote_literal(source), ', '), '''ai_generated''')
    into existing
    from public.training_sessions
    where source is not null;
  execute 'alter table public.training_sessions drop constraint if exists training_sessions_source_check';
  execute 'alter table public.training_sessions add constraint training_sessions_source_check '
       || 'check (source in (' || existing || ', ''coach'', ''human_coach'', ''athlete'', ''system'', ''ai_generated''))';
end $$;
