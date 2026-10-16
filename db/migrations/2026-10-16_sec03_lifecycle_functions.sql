-- SEC-03 — lifecycle, tenant-admin and operator functions (ADDITIVE)
-- ---------------------------------------------------------------------------
-- Requires SEC-01, SEC-02. Nothing calls these until the matching application
-- release; they are inert for the currently deployed app.
-- Every function: SECURITY DEFINER, owner postgres, search_path = '', identity
-- from auth.uid() (never from parameters), tenant and role checked server-side,
-- other tenants' records reported as NOT_FOUND (no existence leak), one
-- transaction, audit record written. EXECUTE: authenticated for lifecycle and
-- tenant-admin functions; service_role only for operator_* functions.
-- Role matrix: viewer read-only · analyst creates/edits, deletes OWN draft-only
-- items · manager approves and archives · admin manages members of its tenant ·
-- platform operator (service role) creates tenants, adds/moves members and is
-- the ONLY path that can permanently delete approved records.
-- Runs in one transaction: on any error nothing is applied.
-- Idempotent. Rollback: db/migrations/rollback/2026-10-16_sec03_rollback.sql
-- ---------------------------------------------------------------------------
begin;

-- ── Approval: the only way a version becomes approved ─────────────────────
create or replace function public.approve_version(p_version_id uuid, p_record jsonb, p_label text default null)
  returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  v record; v_out uuid; v_tenant uuid := public.app_tenant_id();
begin
  perform app_private.require_member();
  select ver.version_id, ver.status, p.project_id, p.tenant_id into v
    from public.versions ver
    join public.scenarios s on s.scenario_id = ver.scenario_id
    join public.projects  p on p.project_id  = s.project_id
   where ver.version_id = p_version_id
     for update of ver;
  if not found or v.tenant_id is distinct from v_tenant then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: version not found';
  end if;
  if not public.app_has_role(array['manager', 'admin']) then
    raise exception using errcode = '42501', message = 'NOT_AUTHORIZED: approving requires the manager or admin role';
  end if;
  if v.status <> 'draft' then
    raise exception using errcode = '55000', message = 'INVALID_STATE: only a draft version can be approved';
  end if;
  if p_record is null or jsonb_typeof(p_record) <> 'object' then
    raise exception using errcode = '22023', message = 'INVALID_RECORD: the result record must be a JSON object';
  end if;
  perform app_private.set_ctx('approve');
  -- Identity and ownership are server-side: version / project / tenant /
  -- created_by come from the database and auth.uid(), not from p_record.
  insert into public.model_outputs (version_id, project_id, tenant_id, created_by,
      irr, npv, equity_multiple, dscr_series, cash_flows,
      engine_version, result_schema_version, periodicity, result_payload, inputs_snapshot)
    values (v.version_id, v.project_id, v.tenant_id, auth.uid(),
      (p_record ->> 'irr')::numeric, (p_record ->> 'npv')::numeric, (p_record ->> 'equity_multiple')::numeric,
      nullif(p_record -> 'dscr_series', 'null'::jsonb), nullif(p_record -> 'cash_flows', 'null'::jsonb),
      p_record ->> 'engine_version', (p_record ->> 'result_schema_version')::integer, p_record ->> 'periodicity',
      nullif(p_record -> 'result_payload', 'null'::jsonb), nullif(p_record -> 'inputs_snapshot', 'null'::jsonb))
    returning output_id into v_out;
  update public.versions
     set status = 'approved', approved_at = now(), approved_by = auth.uid(),
         label = coalesce(nullif(p_label, ''), label)
   where version_id = v.version_id;
  perform app_private.audit('version.approve', 'versions', v.version_id, v.tenant_id,
    jsonb_build_object('output_id', v_out, 'project_id', v.project_id, 'engine_version', p_record ->> 'engine_version'));
  perform app_private.set_ctx('');
  return v_out;
end $$;

-- ── Archive an approved version (kept, hidden from FP&A) ──────────────────
create or replace function public.archive_version(p_version_id uuid, p_reason text)
  returns void language plpgsql volatile security definer set search_path = '' as $$
declare v record; v_tenant uuid := public.app_tenant_id();
begin
  perform app_private.require_member();
  select ver.version_id, ver.status, p.tenant_id into v
    from public.versions ver join public.scenarios s on s.scenario_id = ver.scenario_id
    join public.projects p on p.project_id = s.project_id
   where ver.version_id = p_version_id for update of ver;
  if not found or v.tenant_id is distinct from v_tenant then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: version not found';
  end if;
  if not public.app_has_role(array['manager', 'admin']) then
    raise exception using errcode = '42501', message = 'NOT_AUTHORIZED: archiving requires the manager or admin role';
  end if;
  if v.status <> 'approved' then
    raise exception using errcode = '55000', message = 'INVALID_STATE: only an approved version can be archived';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 3 then
    raise exception using errcode = '22023', message = 'REASON_REQUIRED: give a reason for archiving';
  end if;
  perform app_private.set_ctx('archive');
  update public.versions set status = 'archived', archived_at = now(), archived_by = auth.uid() where version_id = v.version_id;
  perform app_private.audit('version.archive', 'versions', v.version_id, v.tenant_id, jsonb_build_object('reason', p_reason));
  perform app_private.set_ctx('');
end $$;

-- ── Deletion of DRAFT-ONLY items (approved / archived records never) ──────
-- Analysts may delete only items they created; managers / admins any draft-only item.
create or replace function app_private.assert_draft_only(p_project uuid, p_scenario uuid, p_version uuid)
  returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from public.versions ver join public.scenarios s on s.scenario_id = ver.scenario_id
              where ver.status in ('approved', 'archived')
                and (p_project is null or s.project_id = p_project)
                and (p_scenario is null or ver.scenario_id = p_scenario)
                and (p_version is null or ver.version_id = p_version or ver.parent_version_id = p_version))
     or exists (select 1 from public.model_outputs mo
                 where (p_project is not null and mo.project_id = p_project)
                    or (p_version is not null and mo.version_id = p_version)
                    or (p_scenario is not null and mo.version_id in (select version_id from public.versions where scenario_id = p_scenario))) then
    raise exception using errcode = '42501',
      message = 'RECORD_PROTECTED: approved or archived records are kept; archive instead (permanent deletion is an operator procedure)';
  end if;
end $$;

create or replace function public.delete_draft_version(p_version_id uuid)
  returns void language plpgsql volatile security definer set search_path = '' as $$
declare v record; v_tenant uuid := public.app_tenant_id();
begin
  perform app_private.require_member();
  select ver.version_id, ver.created_by, p.tenant_id into v
    from public.versions ver join public.scenarios s on s.scenario_id = ver.scenario_id
    join public.projects p on p.project_id = s.project_id where ver.version_id = p_version_id;
  if not found or v.tenant_id is distinct from v_tenant then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: version not found';
  end if;
  if not (public.app_has_role(array['manager', 'admin'])
          or (public.app_has_role(array['analyst']) and v.created_by = auth.uid())) then
    raise exception using errcode = '42501', message = 'NOT_AUTHORIZED: analysts may delete only their own drafts';
  end if;
  perform app_private.assert_draft_only(null, null, p_version_id);
  perform app_private.set_ctx('delete');
  delete from public.versions where version_id = p_version_id;
  perform app_private.audit('version.delete_draft', 'versions', p_version_id, v.tenant_id, '{}'::jsonb);
  perform app_private.set_ctx('');
end $$;

create or replace function public.delete_scenario(p_scenario_id uuid)
  returns void language plpgsql volatile security definer set search_path = '' as $$
declare s record; v_tenant uuid := public.app_tenant_id();
begin
  perform app_private.require_member();
  select sc.scenario_id, p.project_id, p.tenant_id, p.created_by as project_owner into s
    from public.scenarios sc join public.projects p on p.project_id = sc.project_id where sc.scenario_id = p_scenario_id;
  if not found or s.tenant_id is distinct from v_tenant then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: scenario not found';
  end if;
  if not (public.app_has_role(array['manager', 'admin'])
          or (public.app_has_role(array['analyst'])
              and not exists (select 1 from public.versions where scenario_id = p_scenario_id and created_by is distinct from auth.uid())
              and (exists (select 1 from public.versions where scenario_id = p_scenario_id) or s.project_owner = auth.uid()))) then
    raise exception using errcode = '42501', message = 'NOT_AUTHORIZED: analysts may delete only their own draft-only scenarios';
  end if;
  perform app_private.assert_draft_only(null, p_scenario_id, null);
  perform app_private.set_ctx('delete');
  delete from public.assumptions where scenario_id = p_scenario_id;
  delete from public.versions    where scenario_id = p_scenario_id;
  delete from public.scenarios   where scenario_id = p_scenario_id;
  perform app_private.audit('scenario.delete_draft_only', 'scenarios', p_scenario_id, s.tenant_id, jsonb_build_object('project_id', s.project_id));
  perform app_private.set_ctx('');
end $$;

create or replace function public.delete_project(p_project_id uuid)
  returns void language plpgsql volatile security definer set search_path = '' as $$
declare p record; v_tenant uuid := public.app_tenant_id();
begin
  perform app_private.require_member();
  select pr.project_id, pr.tenant_id, pr.created_by, pr.name into p from public.projects pr where pr.project_id = p_project_id;
  if not found or p.tenant_id is distinct from v_tenant then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: project not found';
  end if;
  if not (public.app_has_role(array['manager', 'admin'])
          or (public.app_has_role(array['analyst']) and p.created_by = auth.uid()
              and not exists (select 1 from public.versions ver join public.scenarios s on s.scenario_id = ver.scenario_id
                               where s.project_id = p_project_id and ver.created_by is distinct from auth.uid()))) then
    raise exception using errcode = '42501', message = 'NOT_AUTHORIZED: analysts may delete only their own draft-only projects';
  end if;
  perform app_private.assert_draft_only(p_project_id, null, null);
  perform app_private.set_ctx('delete');
  delete from public.assumptions where project_id = p_project_id;
  delete from public.versions    where scenario_id in (select scenario_id from public.scenarios where project_id = p_project_id);
  delete from public.scenarios   where project_id = p_project_id;
  delete from public.projects    where project_id = p_project_id;     -- cascades actuals / variances
  perform app_private.audit('project.delete_draft_only', 'projects', p_project_id, p.tenant_id, jsonb_build_object('name', p.name));
  perform app_private.set_ctx('');
end $$;

-- ── Tenant administration (admin role, own tenant only) ───────────────────
create or replace function app_private.require_admin_target(p_user_id uuid) returns public.users
  language plpgsql stable security definer set search_path = '' as $$
declare u public.users;
begin
  perform app_private.require_member();
  if not public.app_has_role(array['admin']) then
    raise exception using errcode = '42501', message = 'NOT_AUTHORIZED: member administration requires the admin role';
  end if;
  select x.* into u from public.users x where x.user_id = p_user_id;
  if not found or u.tenant_id is distinct from public.app_tenant_id() then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: member not found';
  end if;
  return u;
end $$;

create or replace function public.admin_set_member_role(p_user_id uuid, p_role text)
  returns void language plpgsql volatile security definer set search_path = '' as $$
declare u public.users;
begin
  u := app_private.require_admin_target(p_user_id);
  if p_role not in ('admin', 'manager', 'analyst', 'viewer') then
    raise exception using errcode = '22023', message = 'INVALID_ROLE: role must be admin, manager, analyst or viewer';
  end if;
  if u.role = 'admin' and p_role <> 'admin'
     and (select count(*) from public.users where tenant_id = u.tenant_id and role = 'admin' and active) <= 1 then
    raise exception using errcode = '55000', message = 'LAST_ADMIN: a tenant must keep at least one active admin';
  end if;
  perform app_private.set_ctx('admin');
  update public.users set role = p_role where user_id = p_user_id;
  perform app_private.audit('member.set_role', 'users', p_user_id, u.tenant_id, jsonb_build_object('from', u.role, 'to', p_role));
  perform app_private.set_ctx('');
end $$;

create or replace function public.admin_set_member_active(p_user_id uuid, p_active boolean)
  returns void language plpgsql volatile security definer set search_path = '' as $$
declare u public.users;
begin
  u := app_private.require_admin_target(p_user_id);
  if p_active is null then raise exception using errcode = '22023', message = 'INVALID_PARAMETER: active must be true or false'; end if;
  if not p_active and u.role = 'admin' and u.active
     and (select count(*) from public.users where tenant_id = u.tenant_id and role = 'admin' and active) <= 1 then
    raise exception using errcode = '55000', message = 'LAST_ADMIN: a tenant must keep at least one active admin';
  end if;
  perform app_private.set_ctx('admin');
  update public.users set active = p_active where user_id = p_user_id;
  perform app_private.audit(case when p_active then 'member.activate' else 'member.deactivate' end, 'users', p_user_id, u.tenant_id, '{}'::jsonb);
  perform app_private.set_ctx('');
end $$;

create or replace function public.admin_rename_tenant(p_name text)
  returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_tenant uuid := public.app_tenant_id();
begin
  perform app_private.require_member();
  if not public.app_has_role(array['admin']) then
    raise exception using errcode = '42501', message = 'NOT_AUTHORIZED: renaming the tenant requires the admin role';
  end if;
  if coalesce(length(trim(p_name)), 0) < 2 then raise exception using errcode = '22023', message = 'INVALID_NAME'; end if;
  perform app_private.set_ctx('admin');
  update public.tenants set name = trim(p_name) where tenant_id = v_tenant;
  perform app_private.audit('tenant.rename', 'tenants', v_tenant, v_tenant, jsonb_build_object('name', trim(p_name)));
  perform app_private.set_ctx('');
end $$;

-- ── Platform operator (service role only) ─────────────────────────────────
create or replace function app_private.require_operator() returns void
  language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'NOT_AUTHORIZED: platform operator only';
  end if;
end $$;

create or replace function public.operator_create_tenant(p_name text, p_country text default 'Jordan', p_currency text default 'JOD')
  returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app_private.require_operator();
  perform app_private.set_ctx('admin');
  insert into public.tenants (name, country, currency) values (p_name, p_country, p_currency) returning tenant_id into v_id;
  perform app_private.audit('tenant.create', 'tenants', v_id, v_id, jsonb_build_object('name', p_name));
  perform app_private.set_ctx('');
  return v_id;
end $$;

create or replace function public.operator_add_member(p_user_id uuid, p_tenant_id uuid, p_email text, p_name text, p_role text default 'analyst')
  returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform app_private.require_operator();
  if not exists (select 1 from public.tenants where tenant_id = p_tenant_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: tenant not found';
  end if;
  if exists (select 1 from public.users where user_id = p_user_id) then
    raise exception using errcode = '55000', message = 'MEMBER_EXISTS: use operator_move_member to change tenants';
  end if;
  if p_role not in ('admin', 'manager', 'analyst', 'viewer') then
    raise exception using errcode = '22023', message = 'INVALID_ROLE';
  end if;
  perform app_private.set_ctx('admin');
  insert into public.users (user_id, tenant_id, email, name, role) values (p_user_id, p_tenant_id, p_email, p_name, p_role);
  perform app_private.audit('member.add', 'users', p_user_id, p_tenant_id, jsonb_build_object('email', p_email, 'role', p_role));
  perform app_private.set_ctx('');
end $$;

create or replace function public.operator_move_member(p_user_id uuid, p_tenant_id uuid, p_reason text)
  returns void language plpgsql volatile security definer set search_path = '' as $$
declare u record;
begin
  perform app_private.require_operator();
  if coalesce(length(trim(p_reason)), 0) < 10 then
    raise exception using errcode = '22023', message = 'REASON_REQUIRED: document the reason (at least 10 characters)';
  end if;
  select user_id, tenant_id, role into u from public.users where user_id = p_user_id;
  if not found then raise exception using errcode = 'P0002', message = 'NOT_FOUND: member not found'; end if;
  if not exists (select 1 from public.tenants where tenant_id = p_tenant_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND: tenant not found';
  end if;
  perform app_private.set_ctx('admin');
  update public.users set tenant_id = p_tenant_id, role = 'analyst', active = true where user_id = p_user_id;   -- least privilege in the new tenant
  perform app_private.audit('member.move_out', 'users', p_user_id, u.tenant_id, jsonb_build_object('to', p_tenant_id, 'reason', p_reason, 'previous_role', u.role));
  perform app_private.audit('member.move_in', 'users', p_user_id, p_tenant_id, jsonb_build_object('from', u.tenant_id, 'reason', p_reason));
  perform app_private.set_ctx('');
end $$;

-- Role assignment by the operator — used to bootstrap a tenant's first admin
-- (tenant admins use admin_set_member_role). Reason required; audited.
create or replace function public.operator_set_member_role(p_user_id uuid, p_role text, p_reason text)
  returns void language plpgsql volatile security definer set search_path = '' as $$
declare u record;
begin
  perform app_private.require_operator();
  if p_role not in ('admin', 'manager', 'analyst', 'viewer') then
    raise exception using errcode = '22023', message = 'INVALID_ROLE';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 10 then
    raise exception using errcode = '22023', message = 'REASON_REQUIRED: document the reason (at least 10 characters)';
  end if;
  select user_id, tenant_id, role into u from public.users where user_id = p_user_id;
  if not found then raise exception using errcode = 'P0002', message = 'NOT_FOUND: member not found'; end if;
  perform app_private.set_ctx('admin');
  update public.users set role = p_role where user_id = p_user_id;
  perform app_private.audit('member.set_role_by_operator', 'users', p_user_id, u.tenant_id,
    jsonb_build_object('from', u.role, 'to', p_role, 'reason', p_reason));
  perform app_private.set_ctx('');
end $$;

-- Permanent deletion of a project INCLUDING approved records. Explicit
-- confirmation ('PURGE <project_id>') and a documented reason are required;
-- the audit record (with counts and checksums of the removed approved rows)
-- is written before deletion and survives it (audit_events has no FKs).
create or replace function public.operator_purge_project(p_project_id uuid, p_reason text, p_confirm text)
  returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p record; v_summary jsonb;
begin
  perform app_private.require_operator();
  select project_id, tenant_id, name into p from public.projects where project_id = p_project_id;
  if not found then raise exception using errcode = 'P0002', message = 'NOT_FOUND: project not found'; end if;
  if p_confirm is distinct from ('PURGE ' || p_project_id::text) then
    raise exception using errcode = '22023', message = 'CONFIRMATION_REQUIRED: p_confirm must be ''PURGE <project_id>''';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 10 then
    raise exception using errcode = '22023', message = 'REASON_REQUIRED: document the reason (at least 10 characters)';
  end if;
  select jsonb_build_object(
      'name', p.name, 'reason', p_reason,
      'approved_versions', (select count(*) from public.versions ver join public.scenarios s on s.scenario_id = ver.scenario_id
                             where s.project_id = p_project_id and ver.status in ('approved', 'archived')),
      'model_outputs', (select count(*) from public.model_outputs where project_id = p_project_id),
      'model_outputs_md5', (select md5(coalesce(string_agg(md5(mo::text), ',' order by mo.output_id), ''))
                              from public.model_outputs mo where mo.project_id = p_project_id))
    into v_summary;
  perform app_private.audit('project.purge', 'projects', p_project_id, p.tenant_id, v_summary);
  perform app_private.set_ctx('purge');
  delete from public.model_outputs where project_id = p_project_id;
  delete from public.assumptions   where project_id = p_project_id;
  delete from public.versions      where scenario_id in (select scenario_id from public.scenarios where project_id = p_project_id);
  delete from public.scenarios     where project_id = p_project_id;
  delete from public.projects      where project_id = p_project_id;
  perform app_private.set_ctx('');
  return v_summary;
end $$;

-- ── Ownership and grants ──────────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array[
    'public.approve_version(uuid, jsonb, text)', 'public.archive_version(uuid, text)',
    'public.delete_draft_version(uuid)', 'public.delete_scenario(uuid)', 'public.delete_project(uuid)',
    'public.admin_set_member_role(uuid, text)', 'public.admin_set_member_active(uuid, boolean)', 'public.admin_rename_tenant(text)',
    'public.operator_create_tenant(text, text, text)', 'public.operator_add_member(uuid, uuid, text, text, text)',
    'public.operator_move_member(uuid, uuid, text)', 'public.operator_purge_project(uuid, text, text)',
    'public.operator_set_member_role(uuid, text, text)',
    'app_private.assert_draft_only(uuid, uuid, uuid)', 'app_private.require_admin_target(uuid)', 'app_private.require_operator()']
  loop
    execute format('alter function %s owner to postgres', f);
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
grant execute on function public.approve_version(uuid, jsonb, text), public.archive_version(uuid, text),
  public.delete_draft_version(uuid), public.delete_scenario(uuid), public.delete_project(uuid),
  public.admin_set_member_role(uuid, text), public.admin_set_member_active(uuid, boolean), public.admin_rename_tenant(text)
  to authenticated;
grant execute on function public.operator_create_tenant(text, text, text), public.operator_add_member(uuid, uuid, text, text, text),
  public.operator_move_member(uuid, uuid, text), public.operator_purge_project(uuid, text, text),
  public.operator_set_member_role(uuid, text, text)
  to service_role;

commit;
