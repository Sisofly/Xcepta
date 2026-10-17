-- STAGING REQUEST GATE — PRE-CHECK (read-only, single SELECT). Staging only, role postgres.
-- Confirms, before anything is installed, that this database can host the gate.
-- Expected on staging:
--   postgrest_sessions        one or more PostgREST connections (application_name shows the version
--                             when PostgREST sets it; may be empty if no request arrived recently)
--   authenticator_settings    current in-database PostgREST settings (pgrst.*), for the record
--   existing_pre_request      0  (the install refuses to replace another pre-request function)
--   can_alter_authenticator   true (superuser, or CREATEROLE + ADMIN OPTION on authenticator — PG 16+ rule)
--   sec03_present             1  (Production has no SEC-03: the install refuses there)
--   auth_users / non_test_auth_users   n / 0  (staging holds only synthetic @xcepta.test accounts)
--   staging_gate_schema       0  (not installed yet)
select
 (select coalesce(string_agg(distinct coalesce(nullif(application_name, ''), '(unnamed)'), ', '), '(none connected)')
    from pg_stat_activity where usename = 'authenticator') as postgrest_sessions,
 (select coalesce(string_agg(array_to_string(s.setconfig, ', '), ' | '), '(none)')
    from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = 'authenticator') as authenticator_settings,
 (select count(*) from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c
   where r.rolname = 'authenticator' and c like 'pgrst.db\_pre\_request=%') as existing_pre_request,
 (select r.rolsuper or (r.rolcreaterole and exists (select 1 from pg_auth_members m
          where m.roleid = (select oid from pg_roles where rolname = 'authenticator') and m.member = r.oid and m.admin_option))
    from pg_roles r where r.rolname = current_user) as can_alter_authenticator,
 current_user as running_as,
 (select count(*) from pg_trigger where not tgisinternal and tgname = 'users_last_admin_guard') as sec03_present,
 (select count(*) from auth.users) as auth_users,
 (select count(*) from auth.users where lower(coalesce(email, '')) not like '%@xcepta.test') as non_test_auth_users,
 (select count(*) from pg_namespace where nspname = 'staging_gate') as staging_gate_schema;
