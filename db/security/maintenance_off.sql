-- END MAINTENANCE FREEZE — removes exactly the policies maintenance_on.sql created.
do $$
declare t text;
begin
  foreach t in array array['projects', 'scenarios', 'versions', 'assumptions', 'intake_state', 'model_outputs',
                           'actuals', 'variances', 'results', 'coa_mappings', 'static_defaults', 'tenants', 'users'] loop
    execute format('drop policy if exists %I on public.%I', t || '_maintenance', t);
  end loop;
end $$;
