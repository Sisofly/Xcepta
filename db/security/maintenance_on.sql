-- MAINTENANCE FREEZE (cutover window). Requires SEC-01. Reversible with
-- maintenance_off.sql; changes no data and no privileges.
-- While on, ONLY active tenant admins can read or write tenant tables through
-- the API (so the product owner can verify the cutover); every other member's
-- table access returns nothing / is refused, so no old or new client can make
-- partial changes while application and database protections are switched.
-- Definer functions (approve_version, …) keep their own server-side checks.
-- Runs in one transaction: on any error no policy is created.
begin;
do $$
declare t text;
begin
  foreach t in array array['projects', 'scenarios', 'versions', 'assumptions', 'intake_state', 'model_outputs',
                           'actuals', 'variances', 'results', 'coa_mappings', 'static_defaults', 'tenants', 'users'] loop
    execute format('drop policy if exists %I on public.%I', t || '_maintenance', t);
    execute format('create policy %I on public.%I as restrictive for all to authenticated
                      using (public.app_has_role(array[''admin''])) with check (public.app_has_role(array[''admin'']))', t || '_maintenance', t);
  end loop;
end $$;
commit;
