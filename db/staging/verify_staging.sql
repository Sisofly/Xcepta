-- verify_staging.sql — READ-ONLY checks on the STAGING database.
-- Run by scripts/staging/build-staging.ps1 after the schema is applied
-- (or paste into the staging SQL editor).

\echo '== 1. Application tables: row-level security enabled? (expect true for every app table)'
select c.relname as table_name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and c.relname in ('projects','scenarios','versions','assumptions','model_outputs','users',
                    'variances','actuals','static_defaults','intake_state')
order by c.relname;

\echo '== 2. Expected app tables missing from staging (expect no rows)'
select t as missing_table from unnest(array['projects','scenarios','versions','assumptions','model_outputs','users',
  'variances','actuals','static_defaults','intake_state']) t
where not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = t);

\echo '== 3. P-022 migration columns on model_outputs (expect 5 rows)'
select column_name, data_type, is_nullable from information_schema.columns
where table_schema = 'public' and table_name = 'model_outputs'
  and column_name in ('engine_version','result_schema_version','periodicity','result_payload','inputs_snapshot')
order by column_name;

\echo '== 4. model_outputs primary key (expect output_id, model_output_id or id)'
select kcu.column_name as primary_key from information_schema.table_constraints tc
join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
where tc.table_schema = 'public' and tc.table_name = 'model_outputs' and tc.constraint_type = 'PRIMARY KEY';

\echo '== 5. Data present in staging (expect 0 everywhere except static_defaults reference data and your synthetic test rows)'
select 'projects' t, count(*) from public.projects union all
select 'versions', count(*) from public.versions union all
select 'model_outputs', count(*) from public.model_outputs union all
select 'assumptions', count(*) from public.assumptions union all
select 'users', count(*) from public.users union all
select 'static_defaults', count(*) from public.static_defaults;

\echo '== 6. Auth users in staging (expect only your synthetic staging test user(s))'
select count(*) as auth_users from auth.users;
