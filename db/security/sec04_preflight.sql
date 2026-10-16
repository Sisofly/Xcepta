-- SEC-04 PRE-FLIGHT (read-only, single SELECT). Staging first, role postgres.
-- Run three times: (1) before the freeze, (2) after maintenance_on.sql,
-- (3) after SEC-04. Data columns (approved_versions … audit_events_rows) must be
-- identical across runs 1–3 except audit_events_rows (it may only grow).
-- Expected structure, run 1:   sec03_functions 20 · last_admin_trigger 1 · sec04_triggers 0 ·
--   sec04_policies 0 · maintenance_policies 0 · policies_now 28 · grants_md5_now 264e089a3a351afa75905fcd1f4b193c ·
--   dev_engine_results_column 0 · min_active_admins_per_tenant >= 1
-- Run 2 (freeze on):  maintenance_policies 13, policies_now 41; everything else as run 1.
-- Run 3 (SEC-04 applied, freeze still on): sec04_triggers 8, sec04_policies 38, policies_now 79,
--   grants_md5_now changes (direct writes revoked — compare with the rehearsal value
--   in docs/SECURITY_REMEDIATION.md §4); data columns unchanged.
-- Data-quality columns (report; nothing is fixed automatically):
--   approved_without_result      — legacy approvals with no saved result: stay protected; operator-only correction.
--   results_on_unapproved        — saved results attached to draft versions (old non-atomic approval / orphans):
--   projects_blocked_by_orphans    those projects cannot be deleted by members (delete_project refuses); operator purge only.
--   results_tenant_mismatch      — results whose tenant differs from their project's tenant: invisible to colleagues
--                                  after SEC-04 (still visible to their creator).
--   versions_without_creator     — analysts cannot delete these drafts; managers / admins can.
--   members_by_role              — viewers become read-only; inactive members lose access.
select
 (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname = 'public' and p.proname in ('approve_version', 'archive_version', 'delete_draft_version', 'delete_scenario', 'delete_project',
          'admin_set_member_role', 'admin_set_member_active', 'admin_rename_tenant', 'operator_create_tenant', 'operator_add_member',
          'operator_move_member', 'operator_set_member_role', 'operator_purge_project'))
      or (n.nspname = 'app_private' and p.proname in ('assert_draft_only', 'require_admin_target', 'require_operator',
          'set_last_admin_override', 'lock_tenant', 'users_last_admin_guard', 'last_admin_override'))) as sec03_functions,
 (select count(*) from pg_trigger where not tgisinternal and tgname = 'users_last_admin_guard') as last_admin_trigger,
 (select count(*) from pg_trigger where not tgisinternal and tgname in ('model_outputs_guard', 'versions_guard', 'projects_guard', 'scenarios_guard',
   'model_outputs_no_truncate', 'versions_no_truncate', 'projects_no_truncate', 'scenarios_no_truncate')) as sec04_triggers,
 (select count(*) from pg_policies where schemaname = 'public'
   and (policyname ~ '_(active_member|role_insert|role_update|role_delete)$' or policyname in ('users_active_or_self', 'model_outputs_tenant_read'))) as sec04_policies,
 (select count(*) from pg_policies where schemaname = 'public' and policyname like '%\_maintenance') as maintenance_policies,
 (select count(*) from pg_policies where schemaname = 'public') as policies_now,
 (select md5(string_agg(table_name || ':' || grantee || ':' || privilege_type, '|' order by table_name, grantee, privilege_type))
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')) as grants_md5_now,
 (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'versions'
   and column_name = 'dev_engine_results') as dev_engine_results_column,
 (select coalesce(min(n), 0) from (select t.tenant_id, count(u.user_id) filter (where u.role = 'admin' and u.active) n
    from public.tenants t left join public.users u on u.tenant_id = t.tenant_id group by t.tenant_id) x) as min_active_admins_per_tenant,
 (select string_agg(role || (case when active then '' else '(inactive)' end) || ':' || n, ', ' order by role, active)
    from (select role, active, count(*) n from public.users group by role, active) r) as members_by_role,
 (select count(*) from public.versions where status = 'approved') as approved_versions,
 (select count(*) from public.versions where status = 'draft') as draft_versions,
 (select count(*) from public.versions where status = 'archived') as archived_versions,
 (select count(*) from public.model_outputs) as saved_results,
 (select count(*) from public.projects) as projects,
 (select count(*) from public.versions ver where ver.status = 'approved'
   and not exists (select 1 from public.model_outputs mo where mo.version_id = ver.version_id)) as approved_without_result,
 (select count(*) from public.model_outputs mo
   where not exists (select 1 from public.versions ver where ver.version_id = mo.version_id and ver.status in ('approved', 'archived'))) as results_on_unapproved,
 (select count(distinct p.project_id) from public.projects p
   where exists (select 1 from public.model_outputs mo where mo.project_id = p.project_id)
     and not exists (select 1 from public.versions ver join public.scenarios s on s.scenario_id = ver.scenario_id
                      where s.project_id = p.project_id and ver.status in ('approved', 'archived'))) as projects_blocked_by_orphans,
 (select count(*) from public.model_outputs mo join public.projects p on p.project_id = mo.project_id
   where mo.tenant_id is distinct from p.tenant_id) as results_tenant_mismatch,
 (select count(*) from public.versions where status = 'draft' and created_by is null) as versions_without_creator,
 (select count(*) from public.audit_events) as audit_events_rows;
