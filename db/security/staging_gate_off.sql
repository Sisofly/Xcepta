-- STAGING REQUEST GATE — DISABLE (step 1 of removal; STAGING ONLY)
-- Removes ONLY this gate's PostgREST setting and reloads PostgREST. The
-- function is kept until staging_gate_remove.sql (run after the probe shows
-- the gate is off), so PostgREST is never left pointing at a missing function.
-- Leaves any other pre-request setting untouched. Idempotent. One transaction.
begin;
do $$
begin
  if exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c
              where r.rolname = 'authenticator' and s.setdatabase = 0 and c = 'pgrst.db_pre_request=staging_gate.check_request') then
    execute 'alter role authenticator reset pgrst.db_pre_request';
  end if;
  if exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c
              where r.rolname = 'authenticator' and c = 'pgrst.db_pre_request=staging_gate.check_request') then
    raise exception 'STAGING_GATE_OFF: the gate is configured in an unexpected scope (per database); nothing changed';
  end if;
end $$;
notify pgrst, 'reload config';
commit;

select (select count(*) from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c
         where r.rolname = 'authenticator' and c = 'pgrst.db_pre_request=staging_gate.check_request') as gate_configured,
       (select count(*) from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c
         where r.rolname = 'authenticator' and c like 'pgrst.db\_pre\_request=%') as any_pre_request;
