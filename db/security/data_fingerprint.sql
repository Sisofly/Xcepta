-- DATA FINGERPRINT (read-only, single SELECT). Staging, role postgres.
-- One row per table: row count and an md5 over every row's full contents (order-independent).
-- Run before maintenance_on.sql and again after SEC-04 (before any smoke test writes data):
-- every row must be identical, except audit_events (append-only; it may only grow).
-- Neither the freeze, the cutover lock nor SEC-04 change any row — they change policies,
-- privileges, triggers and functions only.
select t as table_name, n as row_count, h as rows_md5 from (
            select 'actuals' t, count(*) n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from public.actuals x
  union all select 'assumptions', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.assumptions x
  union all select 'coa_mappings', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.coa_mappings x
  union all select 'intake_state', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.intake_state x
  union all select 'model_outputs', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.model_outputs x
  union all select 'projects', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.projects x
  union all select 'results', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.results x
  union all select 'scenarios', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.scenarios x
  union all select 'static_defaults', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.static_defaults x
  union all select 'tenants', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.tenants x
  union all select 'users', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.users x
  union all select 'variances', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.variances x
  union all select 'versions', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.versions x
  union all select 'audit_events (may grow)', count(*), null from public.audit_events
) f order by 1;
