-- SEC-04 CUTOVER LOCK — STATE CHECK (read-only, single SELECT). Staging only, role postgres.
-- Expected per stage (grants fingerprint on the production-derived schema; stage A = the value staging reported):
--   stage  lock_state  sec04_triggers  grants_md5_now
--   A      unlocked    0               264e089a3a351afa75905fcd1f4b193c   now (post-SEC-03)
--   B      locked      0               fabdac15a44f3ca18df6fcb894f86101   lock applied, before SEC-04
--   C      locked      8               24b12f0ed2ae58fa8ae7030c61b94989   lock + SEC-04
--   D      unlocked    8               8420a1981965e2e68785c10e12694499   end state (SEC-04, lock removed)
--   R1     PARTIAL     0               d9706beb7c5baf5ef1109202a8e0ffd6   SEC-04 rolled back while locked → re-run cutover_lock_on.sql (→ B)
-- maintenance_on / maintenance_off change policies only, never the fingerprint.
-- other_grantor_privileges must be 0 (a grant by another role survives the owner's REVOKE;
-- the lock would then refuse and change nothing). anon_privileges must be false.
select
 case when not (a_del or ac_del or v_del or ver_del or mo_del or sc_del or pr_del or ac_ins or v_ins) then 'locked'
      when a_del and ac_del and v_del and ac_ins and v_ins
           and ((sec04_triggers = 8 and not (ver_del or mo_del or sc_del or pr_del))
             or (sec04_triggers = 0 and ver_del and mo_del and sc_del and pr_del)) then 'unlocked'
      else 'PARTIAL' end as lock_state,
 sec04_triggers, md5_now as grants_md5_now,
 a_del as assumptions_delete, ac_del as actuals_delete, v_del as variances_delete, ac_ins as actuals_insert, v_ins as variances_insert,
 ver_del as versions_delete, mo_del as model_outputs_delete, sc_del as scenarios_delete, pr_del as projects_delete,
 anon_any as anon_privileges, other_grantors as other_grantor_privileges,
 maintenance_policies, sec03_present, non_test_auth_users
from (select
  has_table_privilege('authenticated', 'public.assumptions', 'DELETE') as a_del,
  has_table_privilege('authenticated', 'public.actuals', 'DELETE') as ac_del,
  has_table_privilege('authenticated', 'public.variances', 'DELETE') as v_del,
  has_any_column_privilege('authenticated', 'public.actuals', 'INSERT') as ac_ins,
  has_any_column_privilege('authenticated', 'public.variances', 'INSERT') as v_ins,
  has_table_privilege('authenticated', 'public.versions', 'DELETE') as ver_del,
  has_table_privilege('authenticated', 'public.model_outputs', 'DELETE') as mo_del,
  has_table_privilege('authenticated', 'public.scenarios', 'DELETE') as sc_del,
  has_table_privilege('authenticated', 'public.projects', 'DELETE') as pr_del,
  (select bool_or(has_table_privilege('anon', 'public.' || t, 'DELETE') or has_any_column_privilege('anon', 'public.' || t, 'INSERT'))
     from unnest(array['assumptions', 'actuals', 'variances', 'versions', 'model_outputs', 'scenarios', 'projects']) t) as anon_any,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
    where n.nspname = 'public' and c.relname in ('assumptions', 'actuals', 'variances', 'versions', 'model_outputs', 'scenarios', 'projects')
      and a.grantee in (select oid from pg_roles where rolname in ('authenticated', 'anon'))
      and a.privilege_type in ('INSERT', 'DELETE') and a.grantor <> c.relowner) as other_grantors,
  (select md5(string_agg(table_name || ':' || grantee || ':' || privilege_type, '|' order by table_name, grantee, privilege_type))
     from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')) as md5_now,
  (select count(*) from pg_trigger where not tgisinternal and tgname in ('model_outputs_guard', 'versions_guard', 'projects_guard', 'scenarios_guard',
    'model_outputs_no_truncate', 'versions_no_truncate', 'projects_no_truncate', 'scenarios_no_truncate')) as sec04_triggers,
  (select count(*) from pg_policies where schemaname = 'public' and policyname like '%\_maintenance') as maintenance_policies,
  (select count(*) from pg_trigger where not tgisinternal and tgname = 'users_last_admin_guard') as sec03_present,
  (select count(*) from auth.users where lower(coalesce(email, '')) not like '%@xcepta.test') as non_test_auth_users
) x;
