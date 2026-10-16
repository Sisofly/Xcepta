-- READ-ONLY security catalog verification (SEC-01..04). Run in the Supabase SQL
-- editor (staging first) before and after each security migration. It changes
-- nothing. Every row must show pass = true once SEC-04 is applied; before that,
-- the rows for later steps show false (expected).
begin read only;
with
defs as (
  select n.nspname || '.' || p.proname as fn, p.oid, pg_get_userbyid(p.proowner) as owner, p.proconfig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef and n.nspname in ('public', 'app_private')),
checks(step, check_name, pass, detail) as (
  select 'SEC-01', 'SECURITY DEFINER functions owned by postgres',
         coalesce(bool_and(owner = 'postgres'), false), string_agg(fn || '=' || owner, ', ') filter (where owner <> 'postgres') from defs
  union all
  select 'SEC-01', 'SECURITY DEFINER functions use search_path = ''''',
         coalesce(bool_and(proconfig = array['search_path=""']), false), string_agg(fn, ', ') filter (where proconfig is distinct from array['search_path=""']) from defs
  union all
  select 'SEC-01', 'no SECURITY DEFINER function executable by PUBLIC or anon',
         coalesce(bool_and(not has_function_privilege('anon', oid, 'EXECUTE')
           and not exists (select 1 from aclexplode(coalesce((select proacl from pg_proc where oid = defs.oid), acldefault('f', (select proowner from pg_proc where oid = defs.oid)))) a
                            where a.grantee = 0 and a.privilege_type = 'EXECUTE')), false),
         string_agg(fn, ', ') filter (where has_function_privilege('anon', oid, 'EXECUTE')) from defs
  union all
  select 'SEC-01', 'app_private schema not usable by anon / authenticated / service_role',
         not (has_schema_privilege('anon', 'app_private', 'USAGE') or has_schema_privilege('authenticated', 'app_private', 'USAGE')
              or has_schema_privilege('service_role', 'app_private', 'USAGE')), null
  union all
  select 'SEC-01', 'operator_* functions executable by service_role only',
         coalesce(bool_and(not has_function_privilege('authenticated', oid, 'EXECUTE') and has_function_privilege('service_role', oid, 'EXECUTE')), false),
         string_agg(fn, ', ') from defs where fn like 'public.operator\_%'
  union all
  select 'SEC-01', 'audit_events: RLS on, append-only and truncate triggers present',
         (select relrowsecurity from pg_class where oid = 'public.audit_events'::regclass)
         and exists (select 1 from pg_trigger where tgrelid = 'public.audit_events'::regclass and tgname = 'audit_events_append_only')
         and exists (select 1 from pg_trigger where tgrelid = 'public.audit_events'::regclass and tgname = 'audit_events_no_truncate'), null
  union all
  select 'SEC-02', 'authenticated cannot change users.tenant_id / role / email / active',
         not (has_column_privilege('authenticated', 'public.users', 'tenant_id', 'UPDATE') or has_column_privilege('authenticated', 'public.users', 'role', 'UPDATE')
              or has_column_privilege('authenticated', 'public.users', 'email', 'UPDATE') or has_column_privilege('authenticated', 'public.users', 'active', 'UPDATE')
              or has_table_privilege('authenticated', 'public.users', 'INSERT') or has_table_privilege('authenticated', 'public.users', 'DELETE')), null
  union all
  select 'SEC-02', 'authenticated cannot write tenants',
         not (has_table_privilege('authenticated', 'public.tenants', 'INSERT') or has_table_privilege('authenticated', 'public.tenants', 'UPDATE')
              or has_table_privilege('authenticated', 'public.tenants', 'DELETE')), null
  union all
  select 'SEC-02', 'users_guard and tenants_guard triggers present',
         exists (select 1 from pg_trigger where tgrelid = 'public.users'::regclass and tgname = 'users_guard')
         and exists (select 1 from pg_trigger where tgrelid = 'public.tenants'::regclass and tgname = 'tenants_guard'), null
  union all
  select 'SEC-02', 'anon has no privilege on any public table',
         not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')),
         (select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))
  union all
  select 'SEC-03', 'lifecycle functions present (approve / archive / delete / admin / operator)',
         (select count(*) from defs where fn in ('public.approve_version', 'public.archive_version', 'public.delete_draft_version', 'public.delete_scenario',
           'public.delete_project', 'public.admin_set_member_role', 'public.admin_set_member_active', 'public.admin_rename_tenant',
           'public.operator_create_tenant', 'public.operator_add_member', 'public.operator_move_member', 'public.operator_purge_project',
           'public.operator_set_member_role')) = 13, null
  union all
  select 'SEC-04', 'authenticated cannot write model_outputs or change version status / delete versions, projects, scenarios',
         not (has_table_privilege('authenticated', 'public.model_outputs', 'INSERT') or has_table_privilege('authenticated', 'public.model_outputs', 'UPDATE')
              or has_table_privilege('authenticated', 'public.model_outputs', 'DELETE') or has_column_privilege('authenticated', 'public.versions', 'status', 'UPDATE')
              or has_column_privilege('authenticated', 'public.versions', 'approved_at', 'UPDATE') or has_table_privilege('authenticated', 'public.versions', 'DELETE')
              or has_table_privilege('authenticated', 'public.projects', 'DELETE') or has_table_privilege('authenticated', 'public.scenarios', 'DELETE')), null
  union all
  select 'SEC-04', 'record-protection triggers present',
         (select count(*) from pg_trigger where not tgisinternal and tgname in ('model_outputs_guard', 'versions_guard', 'projects_guard', 'scenarios_guard',
           'model_outputs_no_truncate', 'versions_no_truncate', 'projects_no_truncate', 'scenarios_no_truncate')) = 8, null
  union all
  select 'SEC-04', 'restrictive active-member and role policies present',
         (select count(*) from pg_policies where schemaname = 'public' and permissive = 'RESTRICTIVE') >= 37, null
  union all
  select 'SEC-04', 'same-tenant result read policy present', exists (select 1 from pg_policies where policyname = 'model_outputs_tenant_read'), null
  union all
  select 'ALL', 'RLS enabled on every public table',
         not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity), null
  union all
  select 'ALL', 'no role can create objects in schema public',
         not (has_schema_privilege('anon', 'public', 'CREATE') or has_schema_privilege('authenticated', 'public', 'CREATE')), null
)
select step, check_name, pass, detail from checks order by step, check_name;
rollback;
