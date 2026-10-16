-- ROLLBACK SEC-04 — EMERGENCY USE ONLY. Returns approved-record protection to
-- the pre-SEC-04 state (the I1 / I2 findings re-open). Apply only together
-- with an application rollback, after a fresh backup. No data is changed.
drop trigger if exists model_outputs_guard on public.model_outputs;
drop trigger if exists versions_guard on public.versions;
drop trigger if exists projects_guard on public.projects;
drop trigger if exists scenarios_guard on public.scenarios;
drop trigger if exists model_outputs_no_truncate on public.model_outputs;
drop trigger if exists versions_no_truncate on public.versions;
drop trigger if exists projects_no_truncate on public.projects;
drop trigger if exists scenarios_no_truncate on public.scenarios;
drop function if exists app_private.model_outputs_guard();
drop function if exists app_private.versions_guard();
drop function if exists app_private.projects_guard();
drop function if exists app_private.scenarios_guard();
do $$
declare t text;
begin
  foreach t in array array['projects', 'scenarios', 'versions', 'assumptions', 'intake_state', 'model_outputs',
                           'actuals', 'variances', 'results', 'tenants', 'coa_mappings', 'static_defaults'] loop
    execute format('drop policy if exists %I on public.%I', t || '_active_member', t);
    execute format('drop policy if exists %I on public.%I', t || '_role_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_role_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_role_delete', t);
  end loop;
end $$;
drop policy if exists users_active_or_self on public.users;
drop policy if exists model_outputs_tenant_read on public.model_outputs;
-- privileges as before SEC-04 (production baseline: authenticated had ALL on these tables)
grant select, insert, update, delete, truncate on public.model_outputs, public.versions to authenticated;
grant delete, truncate on public.projects, public.scenarios to authenticated;
grant truncate on public.actuals, public.assumptions, public.coa_mappings, public.intake_state, public.results,
  public.static_defaults, public.variances to authenticated;
