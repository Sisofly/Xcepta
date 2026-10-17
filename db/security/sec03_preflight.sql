-- SEC-03 PRE-FLIGHT (read-only, single SELECT). Staging only, role postgres.
-- Expected before SEC-03 on staging: 5 · 3 · 4 · 1 · 5 · 3 · 2 · 0 · 0 · 28 · 264e089a3a351afa75905fcd1f4b193c · 23 · 5 · 29 · 0
-- Expected after:  sec03_functions = 20, last_admin_trigger = 1; every other column unchanged.
select
 (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname in ('ctx', 'deny_change', 'set_ctx', 'audit', 'require_member')) as sec01_internal_functions,
 (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('app_tenant_id', 'app_role', 'app_has_role')) as sec01_helpers,
 (select count(*) from pg_trigger where not tgisinternal
   and tgname in ('users_guard', 'tenants_guard', 'users_no_truncate', 'tenants_no_truncate')) as sec02_triggers,
 (select count(*) from pg_policies where policyname = 'users_same_tenant_read') as sec02_policy,
 (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'model_outputs'
   and column_name in ('engine_version', 'result_schema_version', 'periodicity', 'result_payload', 'inputs_snapshot')) as p022_columns,
 (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'versions'
   and column_name in ('approved_by', 'archived_at', 'archived_by')) as versions_sec01_columns,
 (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'auth' and p.proname in ('uid', 'role')) as auth_functions,
 (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname = 'public' and p.proname in ('approve_version', 'archive_version', 'delete_draft_version', 'delete_scenario', 'delete_project',
          'admin_set_member_role', 'admin_set_member_active', 'admin_rename_tenant', 'operator_create_tenant', 'operator_add_member',
          'operator_move_member', 'operator_set_member_role', 'operator_purge_project'))
      or (n.nspname = 'app_private' and p.proname in ('assert_draft_only', 'require_admin_target', 'require_operator',
          'set_last_admin_override', 'lock_tenant', 'users_last_admin_guard', 'last_admin_override'))) as sec03_functions,
 (select count(*) from pg_trigger where not tgisinternal and tgname = 'users_last_admin_guard') as last_admin_trigger,
 (select count(*) from pg_policies where schemaname = 'public') as policies_now,
 (select md5(string_agg(table_name || ':' || grantee || ':' || privilege_type, '|' order by table_name, grantee, privilege_type))
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')) as grants_md5_now,
 (select count(*) from public.versions where status = 'approved') as approved_versions,
 (select count(*) from public.versions where status = 'draft') as draft_versions,
 (select count(*) from public.model_outputs) as saved_results,
 (select count(*) from public.audit_events) as audit_events_rows;
