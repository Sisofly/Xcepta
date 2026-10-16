-- SEC-04 CUTOVER LOCK — OFF (STAGING ONLY)
-- Restores exactly what cutover_lock_on.sql removed from `authenticated`,
-- according to the current state:
--   always:              DELETE on assumptions, actuals, variances; INSERT on actuals, variances
--   SEC-04 NOT present:  also DELETE on versions, model_outputs, scenarios, projects
--                        (abandoned or failed cutover → exactly the pre-lock state)
--   SEC-04 present:      those four stay revoked — SEC-04 owns them; never re-opened here
-- Run only when the old Preview can no longer reach staging (Preview rebuilt
-- with the new app), or to abandon the cutover. Guards as the lock.
-- Post-condition checked inside the transaction. Idempotent. One transaction.
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

grant delete on public.assumptions, public.actuals, public.variances to authenticated;
grant insert on public.actuals, public.variances to authenticated;

do $$
declare
  sec04 boolean := exists (select 1 from pg_trigger where not tgisinternal and tgname = 'versions_guard');
  t text;
begin
  if not sec04 then
    execute 'grant delete on public.versions, public.model_outputs, public.scenarios, public.projects to authenticated';
  end if;
  foreach t in array array['assumptions', 'actuals', 'variances'] loop
    if not has_table_privilege('authenticated', 'public.' || t, 'DELETE') then
      raise exception 'CUTOVER_LOCK: DELETE on % not effective after GRANT. Nothing changed.', t;
    end if;
  end loop;
  foreach t in array array['actuals', 'variances'] loop
    if not has_table_privilege('authenticated', 'public.' || t, 'INSERT') then
      raise exception 'CUTOVER_LOCK: INSERT on % not effective after GRANT. Nothing changed.', t;
    end if;
  end loop;
  foreach t in array array['versions', 'model_outputs', 'scenarios', 'projects'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'DELETE') is distinct from (not sec04) then
      raise exception 'CUTOVER_LOCK: DELETE on % does not match the SEC-04 state. Nothing changed.', t;
    end if;
  end loop;
end $$;

commit;

-- Confirmation (read-only): expect lock_state = unlocked
select case when has_table_privilege('authenticated', 'public.assumptions', 'DELETE') and has_table_privilege('authenticated', 'public.actuals', 'DELETE')
             and has_table_privilege('authenticated', 'public.variances', 'DELETE')
             and has_table_privilege('authenticated', 'public.actuals', 'INSERT') and has_table_privilege('authenticated', 'public.variances', 'INSERT')
            then 'unlocked' else 'NOT UNLOCKED' end as lock_state,
       exists (select 1 from pg_trigger where not tgisinternal and tgname = 'versions_guard') as sec04_present;
