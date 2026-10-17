-- STAGING REQUEST GATE — INSTALL (temporary; STAGING ONLY; SEC-04 cutover safeguard)
-- ---------------------------------------------------------------------------
-- Purpose: while SEC-04 is active, the old Preview build (2e4994c) must not
-- reach staging — its multi-request delete would remove unprotected data.
-- PostgREST runs staging_gate.check_request() before EVERY Data API request
-- (tables, views and RPC, all methods; GraphQL is served through PostgREST
-- too). The function only reads the request headers PostgREST provides:
--   • Origin present        → allowed only if exactly http://localhost:5173 or
--                              http://127.0.0.1:5173 (the local Vite app);
--                              everything else is refused, incl. *.vercel.app
--   • no Origin, Referer    → allowed only if the Referer is on those origins
--   • neither header        → ALLOWED: non-browser clients (Node staging
--                              scripts, curl). Browsers always send Origin on
--                              these cross-origin requests and page scripts
--                              cannot change it; the gate is not a defence
--                              against a non-browser client forging headers —
--                              the database authorization (SEC-01..04) is.
--   • unreadable headers    → refused (fail closed)
-- Refusal: SQLSTATE 42501 → HTTP 401 (anon) / 403 (signed in), message
-- 'STAGING_GATE: …'. The request's own statement never runs.
-- Not covered (not needed): Auth (sign-in still works, but no data access),
-- Storage, Realtime, Edge Functions — the old app uses none of them for data.
-- Touches no table, policy or grant. Guards: refuses unless SEC-03 is present
-- (Production has none) and every Auth account is a synthetic @xcepta.test
-- account; refuses to replace another pre-request function.
-- One transaction: on any error (e.g. insufficient privilege) nothing changes.
-- Remove: staging_gate_off.sql (disable), verify, then staging_gate_remove.sql.
-- ---------------------------------------------------------------------------
begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    raise exception 'STAGING_GATE_INSTALL: role authenticator not found — not a Supabase database. Nothing installed.';
  end if;
  if not exists (select 1 from pg_trigger where not tgisinternal and tgname = 'users_last_admin_guard') then
    raise exception 'STAGING_GATE_INSTALL: SEC-03 is not present — this is not the staging database. Nothing installed.';
  end if;
  if not exists (select 1 from auth.users)
     or exists (select 1 from auth.users where lower(coalesce(email, '')) not like '%@xcepta.test') then
    raise exception 'STAGING_GATE_INSTALL: non-synthetic Auth accounts found — this is not the staging database. Nothing installed.';
  end if;
  if exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c
              where r.rolname = 'authenticator' and c like 'pgrst.db\_pre\_request=%'
                and c <> 'pgrst.db_pre_request=staging_gate.check_request') then
    raise exception 'STAGING_GATE_INSTALL: another pre-request function is configured; it is not replaced. Nothing installed.';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'staging_gate')
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'staging_gate' and p.proname <> 'check_request') then
    raise exception 'STAGING_GATE_INSTALL: schema staging_gate holds other objects. Nothing installed.';
  end if;
end $$;

create schema if not exists staging_gate;
revoke all on schema staging_gate from public;
grant usage on schema staging_gate to anon, authenticated, service_role;

create or replace function staging_gate.check_request() returns void
  language plpgsql stable set search_path = '' as $$
declare
  allowed constant text[] := array['http://localhost:5173', 'http://127.0.0.1:5173'];
  raw text := pg_catalog.current_setting('request.headers', true);
  h jsonb;
  origins jsonb;
  referers jsonb;
  j jsonb;
begin
  if raw is null or raw = '' then return; end if;          -- no request headers: not a browser request
  begin
    h := raw::jsonb;
  exception when others then
    raise exception using errcode = '42501', message = 'STAGING_GATE: unreadable request headers';
  end;
  if pg_catalog.jsonb_typeof(h) is distinct from 'object' then
    raise exception using errcode = '42501', message = 'STAGING_GATE: unreadable request headers';
  end if;
  -- header names compared case-insensitively (PostgREST sends them in lower case)
  select coalesce(pg_catalog.jsonb_agg(e.value) filter (where pg_catalog.lower(e.key) = 'origin'), '[]'::jsonb),
         coalesce(pg_catalog.jsonb_agg(e.value) filter (where pg_catalog.lower(e.key) = 'referer'), '[]'::jsonb)
    into origins, referers
    from pg_catalog.jsonb_each(h) e;
  if pg_catalog.jsonb_array_length(origins) > 0 then
    for j in select e.value from pg_catalog.jsonb_array_elements(origins) e loop
      if pg_catalog.jsonb_typeof(j) is distinct from 'string' or not ((j #>> '{}') = any (allowed)) then
        raise exception using errcode = '42501',
          message = 'STAGING_GATE: only the local application may use staging during the SEC-04 cutover';
      end if;
    end loop;
    return;
  end if;
  for j in select e.value from pg_catalog.jsonb_array_elements(referers) e loop
    if pg_catalog.jsonb_typeof(j) is distinct from 'string'
       or not exists (select 1 from pg_catalog.unnest(allowed) a
                       where (j #>> '{}') = a or pg_catalog.starts_with(j #>> '{}', a || '/')) then
      raise exception using errcode = '42501',
        message = 'STAGING_GATE: only the local application may use staging during the SEC-04 cutover';
    end if;
  end loop;
end $$;

alter function staging_gate.check_request() owner to postgres;
revoke all on function staging_gate.check_request() from public, anon, authenticated, service_role;
grant execute on function staging_gate.check_request() to anon, authenticated, service_role;

alter role authenticator set pgrst.db_pre_request = 'staging_gate.check_request';
notify pgrst, 'reload config';                              -- delivered at commit

commit;

-- Confirmation (read-only)
select (select count(*) from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c
         where r.rolname = 'authenticator' and c = 'pgrst.db_pre_request=staging_gate.check_request') as gate_configured,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'staging_gate' and p.proname = 'check_request') as gate_function;
