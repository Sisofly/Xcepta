-- S0 — READ-ONLY pre-migration check for SEC-01..04 (staging first).
-- One SELECT, no writes: safe in the Supabase SQL editor (Run → export CSV)
-- or with psql under PGOPTIONS='-c default_transaction_read_only=on'.
-- Output: section | item | value.
with
mo as (select m.*, p.tenant_id as project_tenant, s.project_id as version_project, vp.tenant_id as version_tenant, u.tenant_id as creator_tenant
         from public.model_outputs m
         left join public.projects p on p.project_id = m.project_id
         left join public.versions v on v.version_id = m.version_id
         left join public.scenarios s on s.scenario_id = v.scenario_id
         left join public.projects vp on vp.project_id = s.project_id
         left join public.users u on u.user_id = m.created_by),
vv as (select v.*, p.tenant_id as project_tenant, u.tenant_id as creator_tenant,
              (select count(*) from public.model_outputs m where m.version_id = v.version_id) as n_out
         from public.versions v
         left join public.scenarios s on s.scenario_id = v.scenario_id
         left join public.projects p on p.project_id = s.project_id
         left join public.users u on u.user_id = v.created_by),
names(kind, name) as (values
  ('schema', 'app_private'), ('table', 'audit_events'),
  ('function', 'app_tenant_id'), ('function', 'app_role'), ('function', 'app_has_role'), ('function', 'approve_version'),
  ('function', 'archive_version'), ('function', 'delete_draft_version'), ('function', 'delete_scenario'), ('function', 'delete_project'),
  ('function', 'admin_set_member_role'), ('function', 'admin_set_member_active'), ('function', 'admin_rename_tenant'),
  ('function', 'operator_create_tenant'), ('function', 'operator_add_member'), ('function', 'operator_move_member'),
  ('function', 'operator_set_member_role'), ('function', 'operator_purge_project'),
  ('column', 'users.active'), ('column', 'versions.approved_by'), ('column', 'versions.archived_at'), ('column', 'versions.archived_by')),
present as (
  select n.kind, n.name,
         case n.kind
           when 'schema'   then exists (select 1 from pg_namespace where nspname = n.name)
           when 'table'    then exists (select 1 from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relname = n.name)
           when 'function' then exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = n.name)
           when 'column'   then exists (select 1 from information_schema.columns where table_schema = 'public'
                                         and table_name = split_part(n.name, '.', 1) and column_name = split_part(n.name, '.', 2))
         end as exists_now
    from names n),
r(section, item, value) as (
  -- 1. environment and prerequisites
  select '1 env', 'server version', current_setting('server_version')
  union all select '1 env', 'database', current_database()
  union all select '1 env', 'P-022 columns present (expect 5)', (select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'model_outputs'
                    and column_name in ('engine_version', 'result_schema_version', 'periodicity', 'result_payload', 'inputs_snapshot'))
  union all select '1 env', 'auth.uid() / auth.role() exist', (select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'auth' and p.proname in ('uid', 'role'))
  union all select '1 env', 'owner of public tables', (select string_agg(distinct tableowner, ',') from pg_tables where schemaname = 'public')
  union all select '1 env', 'postgres role: bypassrls', (select rolbypassrls::text from pg_roles where rolname = 'postgres')
  union all select '1 env', 'service_role: bypassrls', (select rolbypassrls::text from pg_roles where rolname = 'service_role')
  union all select '1 env', 'public tables (count)', (select count(*)::text from pg_tables where schemaname = 'public')
  -- 2. objects SEC-01..04 will create — must not exist yet
  union all select '2 collisions', kind || ' ' || name, case when exists_now then 'EXISTS (collision)' else 'absent (ok)' end from present
  union all select '2 collisions', 'policies with SEC names already present', (select count(*)::text from pg_policies where schemaname = 'public' and (
                    policyname like '%\_active\_member' or policyname like '%\_role\_insert' or policyname like '%\_role\_update' or policyname like '%\_role\_delete'
                    or policyname like '%\_maintenance' or policyname in ('users_same_tenant_read', 'users_active_or_self', 'model_outputs_tenant_read', 'audit_events_admin_read')))
  union all select '2 collisions', 'triggers with SEC names already present', (select count(*)::text from pg_trigger where not tgisinternal and (
                    tgname like '%\_guard' or tgname like '%\_no\_truncate' or tgname = 'audit_events_append_only'))
  -- 3. memberships and roles
  union all select '3 roles', 'tenants', (select count(*)::text from public.tenants)
  union all select '3 roles', 'members (public.users)', (select count(*)::text from public.users)
  union all select '3 roles', 'members by role', (select string_agg(role || '=' || n, ', ' order by role) from (select role, count(*) n from public.users group by role) x)
  union all select '3 roles', 'members by tenant and role', (select string_agg(t || ': ' || roles, ' | ' order by t) from (
                    select coalesce(tn.name, u.tenant_id::text) t, string_agg(u.role || '=' || u.n, ',' order by u.role) roles
                      from (select tenant_id, role, count(*) n from public.users group by tenant_id, role) u left join public.tenants tn on tn.tenant_id = u.tenant_id
                     group by 1) y)
  union all select '3 roles', 'tenants WITHOUT an admin', (select count(*)::text from public.tenants t where not exists (select 1 from public.users u where u.tenant_id = t.tenant_id and u.role = 'admin'))
  union all select '3 roles', 'tenants WITHOUT a manager or admin (cannot approve after SEC-04)', (select count(*)::text from public.tenants t where not exists
                    (select 1 from public.users u where u.tenant_id = t.tenant_id and u.role in ('manager', 'admin')))
  union all select '3 roles', 'auth accounts without membership', (select count(*)::text from auth.users a where not exists (select 1 from public.users u where u.user_id = a.id))
  union all select '3 roles', 'memberships without auth account', (select count(*)::text from public.users u where not exists (select 1 from auth.users a where a.id = u.user_id))
  -- 4. tenant relationships
  union all select '4 tenancy', 'results: tenant_id ≠ project tenant', (select count(*)::text from mo where tenant_id is distinct from project_tenant)
  union all select '4 tenancy', 'results: project_id ≠ version''s project', (select count(*)::text from mo where project_id is distinct from version_project)
  union all select '4 tenancy', 'results: tenant_id ≠ version''s project tenant', (select count(*)::text from mo where tenant_id is distinct from version_tenant)
  union all select '4 tenancy', 'results: creator not a member of the result tenant', (select count(*)::text from mo where created_by is not null and creator_tenant is distinct from tenant_id)
  union all select '4 tenancy', 'results: created_by null', (select count(*)::text from mo where created_by is null)
  union all select '4 tenancy', 'versions: creator not a member of the project tenant', (select count(*)::text from vv where created_by is not null and creator_tenant is distinct from project_tenant)
  union all select '4 tenancy', 'versions: parent version in another scenario', (select count(*)::text from public.versions c join public.versions p on p.version_id = c.parent_version_id
                    where p.scenario_id is distinct from c.scenario_id)
  union all select '4 tenancy', 'projects: creator not a member of the project tenant', (select count(*)::text from public.projects p left join public.users u on u.user_id = p.created_by
                    where p.created_by is not null and u.tenant_id is distinct from p.tenant_id)
  union all select '4 tenancy', 'assumptions: tenant ≠ project tenant', (select count(*)::text from public.assumptions a join public.projects p on p.project_id = a.project_id where a.tenant_id <> p.tenant_id)
  union all select '4 tenancy', 'assumptions: scenario in another project', (select count(*)::text from public.assumptions a join public.scenarios s on s.scenario_id = a.scenario_id where s.project_id is distinct from a.project_id)
  union all select '4 tenancy', 'actuals / variances: tenant ≠ project tenant', (select count(*)::text from (
                    select a.tenant_id, p.tenant_id pt from public.actuals a join public.projects p on p.project_id = a.project_id
                    union all select v.tenant_id, p.tenant_id from public.variances v join public.projects p on p.project_id = v.project_id) x where tenant_id <> pt)
  -- 5. approval integrity
  union all select '5 approvals', 'projects / scenarios / versions / results', (select count(*) from public.projects)::text || ' / ' || (select count(*) from public.scenarios)::text
                    || ' / ' || (select count(*) from public.versions)::text || ' / ' || (select count(*) from public.model_outputs)::text
  union all select '5 approvals', 'versions by status', (select string_agg(status || '=' || n, ', ' order by status) from (select status, count(*) n from public.versions group by status) x)
  union all select '5 approvals', 'approved versions WITHOUT a saved result', (select count(*)::text from vv where status = 'approved' and n_out = 0)
  union all select '5 approvals', 'draft versions WITH a saved result', (select count(*)::text from vv where status = 'draft' and n_out > 0)
  union all select '5 approvals', 'versions with more than one result', (select count(*)::text from vv where n_out > 1)
  union all select '5 approvals', 'status / approved_at mismatch', (select count(*)::text from public.versions where (status = 'approved') <> (approved_at is not null))
  union all select '5 approvals', 'results by engine (null = legacy)', (select string_agg(coalesce(engine_version, 'legacy') || '=' || n, ', ' order by engine_version) from
                    (select engine_version, count(*) n from public.model_outputs group by engine_version) x)
  union all select '5 approvals', 'versions / projects without created_by', (select count(*) from public.versions where created_by is null)::text || ' / '
                    || (select count(*) from public.projects where created_by is null)::text
  union all select '5 approvals', 'archived projects (flag)', (select count(*)::text from public.projects where archived)
  -- 6. baseline (record before SEC-01)
  union all select '6 baseline', 'RLS enabled tables / public tables', (select count(*) filter (where relrowsecurity)::text || ' / ' || count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relkind = 'r')
  union all select '6 baseline', 'policies (count)', (select count(*)::text from pg_policies where schemaname = 'public')
  union all select '6 baseline', 'policies md5', (select md5(string_agg(tablename || ':' || policyname || ':' || permissive || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), '|'
                    order by tablename, policyname)) from pg_policies where schemaname = 'public')
  union all select '6 baseline', 'policy', x.t from (select tablename || ' · ' || policyname || ' · ' || permissive || ' · ' || cmd || ' · ' || array_to_string(roles, ',') t
                    from pg_policies where schemaname = 'public' order by tablename, policyname) x
  union all select '6 baseline', 'user-defined triggers on public tables', (select coalesce(string_agg(tgrelid::regclass::text || '.' || tgname, ', '), 'none') from pg_trigger t
                    join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal)
  union all select '6 baseline', 'table grants md5 (anon/authenticated/service_role)', (select md5(string_agg(table_name || ':' || grantee || ':' || privilege_type, '|' order by table_name, grantee, privilege_type))
                    from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role'))
  union all select '6 baseline', 'table grants: ' || grantee, string_agg(table_name || '(' || privs || ')', ', ' order by table_name) from (
                    select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) privs from information_schema.role_table_grants
                     where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role') group by grantee, table_name) g group by grantee
  union all select '6 baseline', 'SECURITY DEFINER functions in public', (select coalesce(string_agg(p.proname || ' owner=' || pg_get_userbyid(p.proowner) || ' config=' || coalesce(array_to_string(p.proconfig, ';'), 'none')
                    || ' anon_exec=' || has_function_privilege('anon', p.oid, 'EXECUTE')::text, ' | '), 'none') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.prosecdef)
  union all select '6 baseline', 'default privileges in public (functions)', (select coalesce(string_agg(pg_get_userbyid(d.defaclrole) || ':' || array_to_string(d.defaclacl, ','), ' | '), 'none')
                    from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace where n.nspname = 'public' and d.defaclobjtype = 'f')
  union all select '6 baseline', 'table privileges for anon/authenticated/service_role granted by a role other than the owner', (select count(*)::text
                    from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
                    where n.nspname = 'public' and c.relkind = 'r' and a.grantee in ('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole) and a.grantor <> c.relowner)
  union all select '6 baseline', 'CREATE on schema public: anon / authenticated', has_schema_privilege('anon', 'public', 'CREATE')::text || ' / ' || has_schema_privilege('authenticated', 'public', 'CREATE')::text
)
select section, item, value from r order by section, item, value;
