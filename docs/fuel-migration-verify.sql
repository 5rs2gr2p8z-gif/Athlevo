-- Athlevo Fuel V1 — post-migration check.
-- Paste into Supabase → SQL Editor AFTER running migrations/2026-09-30_fuel_tracking.sql.
-- Every row must show ok = true. The last row summarises the result.
-- Read-only: this query changes nothing.
with checks(sort, check_name, ok) as (
  values
    (1,  'table public.fuel_meals exists',       to_regclass('public.fuel_meals') is not null),
    (2,  'table public.fuel_meal_items exists',  to_regclass('public.fuel_meal_items') is not null),
    (3,  'table public.fuel_preferences exists', to_regclass('public.fuel_preferences') is not null),
    (4,  'RLS enabled on fuel_meals',            coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.fuel_meals')), false)),
    (5,  'RLS enabled on fuel_meal_items',       coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.fuel_meal_items')), false)),
    (6,  'RLS enabled on fuel_preferences',      coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.fuel_preferences')), false)),
    (7,  'function fuel_save_meal exists',       to_regprocedure('public.fuel_save_meal(uuid,uuid,jsonb,jsonb)') is not null),
    (8,  'fuel_save_meal: service_role CAN execute',
         coalesce(has_function_privilege('service_role', to_regprocedure('public.fuel_save_meal(uuid,uuid,jsonb,jsonb)'), 'execute'), false)),
    (9,  'fuel_save_meal: anon can NOT execute',
         coalesce(not has_function_privilege('anon', to_regprocedure('public.fuel_save_meal(uuid,uuid,jsonb,jsonb)'), 'execute'), false)),
    (10, 'fuel_save_meal: signed-in users can NOT execute',
         coalesce(not has_function_privilege('authenticated', to_regprocedure('public.fuel_save_meal(uuid,uuid,jsonb,jsonb)'), 'execute'), false)),
    (11, 'signed-in users can NOT write fuel_meals / fuel_meal_items directly',
         coalesce(not (has_table_privilege('authenticated', to_regclass('public.fuel_meals'), 'insert')
                    or has_table_privilege('authenticated', to_regclass('public.fuel_meals'), 'update')
                    or has_table_privilege('authenticated', to_regclass('public.fuel_meals'), 'delete')
                    or has_table_privilege('authenticated', to_regclass('public.fuel_meal_items'), 'insert')
                    or has_table_privilege('authenticated', to_regclass('public.fuel_meal_items'), 'update')
                    or has_table_privilege('authenticated', to_regclass('public.fuel_meal_items'), 'delete')), false)),
    (12, 'anon has no access to Fuel tables',
         coalesce(not (has_table_privilege('anon', to_regclass('public.fuel_meals'), 'select')
                    or has_table_privilege('anon', to_regclass('public.fuel_meal_items'), 'select')
                    or has_table_privilege('anon', to_regclass('public.fuel_preferences'), 'select')), false)),
    (13, 'idempotency index fuel_meals_user_client_idx exists', to_regclass('public.fuel_meals_user_client_idx') is not null),
    (14, 'no client insert/update/delete policy on meals or items',
         not exists (select 1 from pg_policies
                     where schemaname = 'public'
                       and tablename in ('fuel_meals', 'fuel_meal_items')
                       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')))
)
select check_name, ok from checks
union all
select '>>> ALL CHECKS PASSED', bool_and(ok) from checks
order by 1 desc, 2;
