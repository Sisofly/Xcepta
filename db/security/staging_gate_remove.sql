-- STAGING REQUEST GATE — REMOVE OBJECTS (step 2 of removal; STAGING ONLY)
-- Run only after staging_gate_off.sql and a probe showing the gate is off.
-- Refuses while PostgREST is still configured to call the function. Drops the
-- function, then the schema WITHOUT CASCADE (fails — nothing dropped — if the
-- schema holds anything else). Idempotent. One transaction.
begin;
do $$
begin
  if exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c
              where r.rolname = 'authenticator' and c = 'pgrst.db_pre_request=staging_gate.check_request') then
    raise exception 'STAGING_GATE_REMOVE: the gate is still configured — run staging_gate_off.sql first. Nothing removed.';
  end if;
end $$;
drop function if exists staging_gate.check_request();
drop schema if exists staging_gate;                         -- RESTRICT (default): only an empty schema is dropped
commit;

select (select count(*) from pg_namespace where nspname = 'staging_gate') as staging_gate_schema;
