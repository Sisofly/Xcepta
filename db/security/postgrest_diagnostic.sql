-- PostgREST CONFIGURATION DIAGNOSTIC (read-only, single SELECT). Staging, role postgres.
-- Purpose: record why the in-database pre-request setting (pgrst.db_pre_request on the
-- authenticator role) was not enforced by the hosted Data API. Shows setting NAMES only,
-- plus the values of three non-secret PostgREST control settings — never other values.
--   postgrest_listener_sessions  ≥ 1 → PostgREST holds a LISTEN connection (reload messages can arrive)
--   pgrst_setting_names          which pgrst.* settings exist on any role (Supabase-managed or ours)
--   pgrst_control_values         db_config / db_pre_config / db_channel_enabled, if set in-database
--   config_functions             any pre-config / pre-request functions present
-- Also check, read-only, in the dashboard: Logs → PostgREST around the install time
-- (config reload / LISTEN messages, or their absence) and Logs → Postgres for "staging_gate".
select
 (select count(*) from pg_stat_activity where usename = 'authenticator') as postgrest_connections,
 (select count(*) from pg_stat_activity where usename = 'authenticator' and query ilike 'listen%') as postgrest_listener_sessions,
 (select string_agg(distinct application_name, ', ') from pg_stat_activity where usename = 'authenticator') as postgrest_version,
 (select coalesce(string_agg(r.rolname || ':' || split_part(c, '=', 1), ', ' order by r.rolname, c), '(none)')
    from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c
   where split_part(c, '=', 1) like 'pgrst.%') as pgrst_setting_names,
 (select coalesce(string_agg(r.rolname || ':' || c, ', '), '(none)')
    from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c
   where split_part(c, '=', 1) in ('pgrst.db_config', 'pgrst.db_pre_config', 'pgrst.db_channel_enabled')) as pgrst_control_values,
 (select coalesce(string_agg(n.nspname || '.' || p.proname, ', '), '(none)') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname ilike any (array['%pre_config%', '%pre_request%'])) as config_functions,
 (select string_agg(rolname || ' super=' || rolsuper, ', ' order by rolname) from pg_roles
   where rolname in ('postgres', 'authenticator', 'supabase_admin')) as roles;
