-- SEC-04 — protection of approved records, role authorization, same-tenant reads
-- ---------------------------------------------------------------------------
-- Requires SEC-01..03 AND the application release that approves / deletes
-- through the SEC-03 functions. Apply during the controlled cutover
-- (docs/SECURITY_REMEDIATION.md §5): an older app cannot approve or delete
-- after this file (it fails closed — nothing is changed).
--   • model_outputs: written only by approve_version(); never updated; deleted
--     only by operator_purge_project().
--   • versions: drafts only on insert (creator stamped server-side); approval
--     state changes only through approve_version / archive_version; approved
--     and archived versions are immutable and cannot be deleted — directly, via
--     FK cascades (project / scenario / parent version) or by the service role —
--     except by operator_purge_project().
--   • projects / scenarios: deleted only through the delete_* functions
--     (draft-only) or the operator purge; project identity is fixed; project
--     archiving requires manager / admin.
--   • RESTRICTIVE policies (they can only narrow the existing policies):
--     writes need analyst / manager / admin (viewers are read-only); every
--     tenant table requires an ACTIVE membership.
--   • model_outputs_tenant_read: colleagues in the same tenant can read
--     approved results (previously creator-only); other tenants still cannot.
-- Idempotent. Rollback: db/migrations/rollback/2026-10-16_sec04_rollback.sql
-- ---------------------------------------------------------------------------

-- ── Direct-write privileges ───────────────────────────────────────────────
revoke insert, update, delete, truncate on public.model_outputs from public, anon, authenticated;
revoke update, delete, truncate on public.versions from public, anon, authenticated;
grant update (label) on public.versions to authenticated;
revoke delete, truncate on public.projects, public.scenarios from public, anon, authenticated;
revoke truncate on all tables in schema public from authenticated;

-- ── Saved results: append-only ────────────────────────────────────────────
create or replace function app_private.model_outputs_guard() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare c text := app_private.ctx();
begin
  if tg_op = 'INSERT' then
    if c = 'approve' then return new; end if;
    raise exception using errcode = '42501', message = 'RECORD_PROTECTED: results are saved only by approving a version';
  elsif tg_op = 'UPDATE' then
    raise exception using errcode = '42501', message = 'RECORD_PROTECTED: saved results and input snapshots are immutable';
  end if;
  if c = 'purge' then return old; end if;
  raise exception using errcode = '42501', message = 'RECORD_PROTECTED: saved results cannot be deleted (operator purge only)';
end $$;
drop trigger if exists model_outputs_guard on public.model_outputs;
create trigger model_outputs_guard before insert or update or delete on public.model_outputs
  for each row execute function app_private.model_outputs_guard();

-- ── Versions: approval state machine ──────────────────────────────────────
create or replace function app_private.versions_guard() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare c text := app_private.ctx();
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.approved_at is not null or new.approved_by is not null
       or new.archived_at is not null or new.archived_by is not null then
      raise exception using errcode = '42501', message = 'RECORD_PROTECTED: new versions are drafts; approval only through approve_version';
    end if;
    if auth.uid() is not null then new.created_by := auth.uid(); end if;          -- ownership is server-side
    return new;
  elsif tg_op = 'UPDATE' then
    if old.status in ('approved', 'archived') then
      if c = 'archive' and old.status = 'approved' and new.status = 'archived'
         and (new.version_id, new.scenario_id, new.parent_version_id, new.label, new.created_at, new.created_by, new.approved_at, new.approved_by)
             is not distinct from
             (old.version_id, old.scenario_id, old.parent_version_id, old.label, old.created_at, old.created_by, old.approved_at, old.approved_by) then
        return new;
      end if;
      raise exception using errcode = '42501', message = 'RECORD_PROTECTED: approved and archived versions cannot be changed';
    end if;
    if (new.version_id, new.scenario_id, new.parent_version_id, new.created_at, new.created_by)
       is distinct from (old.version_id, old.scenario_id, old.parent_version_id, old.created_at, old.created_by) then
      raise exception using errcode = '42501', message = 'RECORD_PROTECTED: version identity cannot be changed';
    end if;
    if (new.status, new.approved_at, new.approved_by, new.archived_at, new.archived_by)
       is distinct from (old.status, old.approved_at, old.approved_by, old.archived_at, old.archived_by) then
      if c = 'approve' and new.status = 'approved' then return new; end if;
      raise exception using errcode = '42501', message = 'RECORD_PROTECTED: approval status changes only through approve_version';
    end if;
    return new;
  end if;
  -- DELETE (direct or cascaded from a scenario / project / parent version)
  if old.status in ('approved', 'archived') then
    if c = 'purge' then return old; end if;
    raise exception using errcode = '42501', message = 'RECORD_PROTECTED: approved and archived versions cannot be deleted (operator purge only)';
  end if;
  if c in ('delete', 'purge') then return old; end if;
  raise exception using errcode = '42501', message = 'RECORD_PROTECTED: drafts are deleted only through the delete functions';
end $$;
drop trigger if exists versions_guard on public.versions;
create trigger versions_guard before insert or update or delete on public.versions
  for each row execute function app_private.versions_guard();

-- ── Projects and scenarios ────────────────────────────────────────────────
create or replace function app_private.projects_guard() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare c text := app_private.ctx();
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.created_by := auth.uid(); end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if (new.project_id, new.tenant_id, new.created_by, new.created_at)
       is distinct from (old.project_id, old.tenant_id, old.created_by, old.created_at) then
      raise exception using errcode = '42501', message = 'RECORD_PROTECTED: project identity, tenant and owner cannot be changed';
    end if;
    if new.archived is distinct from old.archived and c <> 'admin' and not public.app_has_role(array['manager', 'admin']) then
      raise exception using errcode = '42501', message = 'NOT_AUTHORIZED: archiving or restoring a project requires the manager or admin role';
    end if;
    return new;
  end if;
  if c in ('delete', 'purge') then return old; end if;
  raise exception using errcode = '42501', message = 'RECORD_PROTECTED: projects are deleted only through delete_project (draft-only)';
end $$;
drop trigger if exists projects_guard on public.projects;
create trigger projects_guard before insert or update or delete on public.projects
  for each row execute function app_private.projects_guard();

create or replace function app_private.scenarios_guard() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare c text := app_private.ctx();
begin
  if tg_op = 'UPDATE' then
    if new.project_id is distinct from old.project_id or new.scenario_id is distinct from old.scenario_id then
      raise exception using errcode = '42501', message = 'RECORD_PROTECTED: a scenario cannot be moved to another project';
    end if;
    return new;
  end if;
  if c in ('delete', 'purge') then return old; end if;
  raise exception using errcode = '42501', message = 'RECORD_PROTECTED: scenarios are deleted only through delete_scenario (draft-only)';
end $$;
drop trigger if exists scenarios_guard on public.scenarios;
create trigger scenarios_guard before update or delete on public.scenarios
  for each row execute function app_private.scenarios_guard();

do $$
declare t text;
begin
  foreach t in array array['model_outputs', 'versions', 'projects', 'scenarios'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function app_private.deny_change()', t || '_no_truncate', t);
  end loop;
end $$;

-- ── RESTRICTIVE policies: active membership; writes need analyst+ ─────────
do $$
declare t text;
begin
  foreach t in array array['projects', 'scenarios', 'versions', 'assumptions', 'intake_state', 'model_outputs',
                           'actuals', 'variances', 'results', 'tenants', 'coa_mappings', 'static_defaults'] loop
    execute format('drop policy if exists %I on public.%I', t || '_active_member', t);
    execute format('create policy %I on public.%I as restrictive for all to authenticated
                      using (public.app_tenant_id() is not null) with check (public.app_tenant_id() is not null)', t || '_active_member', t);
  end loop;
  foreach t in array array['projects', 'scenarios', 'versions', 'assumptions', 'intake_state', 'actuals', 'variances', 'results'] loop
    execute format('drop policy if exists %I on public.%I', t || '_role_insert', t);
    execute format('create policy %I on public.%I as restrictive for insert to authenticated
                      with check (public.app_has_role(array[''analyst'', ''manager'', ''admin'']))', t || '_role_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_role_update', t);
    execute format('create policy %I on public.%I as restrictive for update to authenticated
                      using (public.app_has_role(array[''analyst'', ''manager'', ''admin'']))
                      with check (public.app_has_role(array[''analyst'', ''manager'', ''admin'']))', t || '_role_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_role_delete', t);
    execute format('create policy %I on public.%I as restrictive for delete to authenticated
                      using (public.app_has_role(array[''analyst'', ''manager'', ''admin'']))', t || '_role_delete', t);
  end loop;
end $$;
-- An inactive member may still read only their own profile row.
drop policy if exists users_active_or_self on public.users;
create policy users_active_or_self on public.users as restrictive for select to authenticated
  using (user_id = auth.uid() or public.app_tenant_id() is not null);

-- ── Same-tenant read of approved results (I2) ─────────────────────────────
-- Both the row's tenant and its version's project tenant must be the caller's.
drop policy if exists model_outputs_tenant_read on public.model_outputs;
create policy model_outputs_tenant_read on public.model_outputs for select to authenticated
  using (tenant_id = public.app_tenant_id()
         and version_id in (select ver.version_id from public.versions ver
                              join public.scenarios s on s.scenario_id = ver.scenario_id
                              join public.projects p on p.project_id = s.project_id
                             where p.tenant_id = public.app_tenant_id()));

alter function app_private.model_outputs_guard() owner to postgres;
alter function app_private.versions_guard() owner to postgres;
alter function app_private.projects_guard() owner to postgres;
alter function app_private.scenarios_guard() owner to postgres;
revoke all on function app_private.model_outputs_guard(), app_private.versions_guard(), app_private.projects_guard(),
  app_private.scenarios_guard() from public, anon, authenticated, service_role;
