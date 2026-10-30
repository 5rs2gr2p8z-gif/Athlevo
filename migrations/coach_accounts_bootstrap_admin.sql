-- ══════════════════════════════════════════════════════════════════════
--  Athlevo — make the FIRST admin (run once, by hand)
-- ══════════════════════════════════════════════════════════════════════
--  Only needed once. After this, the admin adds coaches inside the app:
--  Coach Dashboard → "Add Coach" → their email.
--
--  1. Sign up in the app first, with the email below.
--  2. Replace YOUR-EMAIL@EXAMPLE.COM, then run in the Supabase SQL editor.
--  3. Sign out and back in. You land on the Coach Dashboard.
--
--  Requires migrations/2026-08-01_coach_dashboard.sql (adds profiles.role)
--  and migrations/2026-10-31_coach_join_links_and_grants.sql.
-- ══════════════════════════════════════════════════════════════════════

update public.profiles
   set role = 'admin'
 where id = (select id from auth.users where lower(email) = lower('YOUR-EMAIL@EXAMPLE.COM'));

-- Check: should return one row with role = admin.
select p.id, u.email, p.role
  from public.profiles p
  join auth.users u on u.id = p.id
 where lower(u.email) = lower('YOUR-EMAIL@EXAMPLE.COM');
