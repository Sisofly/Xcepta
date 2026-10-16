-- ROLLBACK SEC-02 — EMERGENCY USE ONLY: re-opens B1 (self-assignment of
-- tenant / role) and anonymous table privileges exactly as in the production
-- baseline. Roll back SEC-04 and SEC-03 first. No data is changed.
-- Runs in one transaction: on any error nothing is changed.
begin;
drop trigger if exists users_guard on public.users;
drop trigger if exists tenants_guard on public.tenants;
drop trigger if exists users_no_truncate on public.users;
drop trigger if exists tenants_no_truncate on public.tenants;
drop function if exists app_private.users_guard();
drop function if exists app_private.tenants_guard();
drop policy if exists users_same_tenant_read on public.users;
grant all on public.users, public.tenants to authenticated;
grant truncate, trigger, references on public.actuals, public.assumptions, public.coa_mappings, public.intake_state,
  public.model_outputs, public.projects, public.results, public.scenarios, public.static_defaults, public.tenants,
  public.users, public.variances, public.versions to authenticated, service_role;
grant all on public.actuals, public.assumptions, public.coa_mappings, public.intake_state, public.model_outputs,
  public.projects, public.results, public.scenarios, public.static_defaults, public.tenants, public.users,
  public.variances, public.versions to anon;
commit;
