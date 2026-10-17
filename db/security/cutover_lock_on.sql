-- SEC-04 CUTOVER LOCK — ON (temporary; STAGING ONLY)
-- ---------------------------------------------------------------------------
-- Purpose: while the old Preview build (2e4994c) can still reach staging, its
-- multi-request deletes (project, scenario) and FP&A replacement must not
-- leave partial data. They ignore the errors of intermediate steps, so EVERY
-- step they use must be refused, before and after SEC-04. Removes from
-- `authenticated` exactly these table privileges:
--   DELETE on assumptions, actuals, variances, versions, model_outputs, scenarios, projects
--   INSERT on actuals, variances
-- (SEC-04 itself revokes the DELETEs on versions / model_outputs / scenarios /
-- projects; the lock closes them already before SEC-04, so no intermediate
-- stage exists in which only some steps succeed.)
-- Effect for every API client (old or new app, any member incl. admins):
-- these direct deletes and FP&A submissions are refused; nothing is removed or
-- duplicated. The SEC-03 functions (delete_project, delete_scenario,
-- delete_draft_version, operator_purge_project, approve_version, …) are
-- SECURITY DEFINER and keep working. Paused while locked: FP&A submission and
-- resetting assumption overrides / scenario drivers.
-- Independent of PostgREST configuration and of request headers.
-- Guards: SEC-03 present (Production has none) and only synthetic
-- @xcepta.test Auth accounts. Post-condition inside the transaction: the
-- EFFECTIVE privileges are gone (a grant made by another role would survive an
-- owner's REVOKE — then nothing is changed). Idempotent. One transaction.
-- Off: db/security/cutover_lock_off.sql   State: cutover_lock_preflight.sql
-- ---------------------------------------------------------------------------
begin;

do $$
begin
  if not exists (select 1 from pg_trigger where not tgisinternal and tgname = 'users_last_admin_guard') then
    raise exception 'CUTOVER_LOCK: SEC-03 is not present — this is not the staging database. Nothing changed.';
  end if;
  if not exists (select 1 from auth.users)
     or exists (select 1 from auth.users where lower(coalesce(email, '')) not like '%@xcepta.test') then
    raise exception 'CUTOVER_LOCK: non-synthetic Auth accounts found — this is not the staging database. Nothing changed.';
  end if;
end $$;

revoke delete on public.assumptions, public.actuals, public.variances,
                 public.versions, public.model_outputs, public.scenarios, public.projects from authenticated;
revoke insert on public.actuals, public.variances from authenticated;

do $$
declare t text;
begin
  foreach t in array array['assumptions', 'actuals', 'variances', 'versions', 'model_outputs', 'scenarios', 'projects'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'DELETE') then
      raise exception 'CUTOVER_LOCK: DELETE on % still effective after REVOKE (granted by another role or via PUBLIC). Nothing changed.', t;
    end if;
  end loop;
  foreach t in array array['actuals', 'variances'] loop
    if has_any_column_privilege('authenticated', 'public.' || t, 'INSERT') then
      raise exception 'CUTOVER_LOCK: INSERT on % still effective after REVOKE (granted by another role or via PUBLIC). Nothing changed.', t;
    end if;
  end loop;
end $$;

commit;

-- Confirmation (read-only): expect lock_state = locked
select case when not (has_table_privilege('authenticated', 'public.assumptions', 'DELETE') or has_table_privilege('authenticated', 'public.actuals', 'DELETE')
                   or has_table_privilege('authenticated', 'public.variances', 'DELETE') or has_table_privilege('authenticated', 'public.versions', 'DELETE')
                   or has_table_privilege('authenticated', 'public.model_outputs', 'DELETE') or has_table_privilege('authenticated', 'public.scenarios', 'DELETE')
                   or has_table_privilege('authenticated', 'public.projects', 'DELETE')
                   or has_any_column_privilege('authenticated', 'public.actuals', 'INSERT') or has_any_column_privilege('authenticated', 'public.variances', 'INSERT'))
            then 'locked' else 'NOT LOCKED' end as lock_state;
