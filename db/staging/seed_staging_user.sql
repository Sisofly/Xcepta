-- seed_staging_user.sql — STAGING ONLY. Links the synthetic staging test user
-- (created in Authentication → Users) to a synthetic tenant so the app and
-- scripts/staging-verify.mjs can run under row-level security.
--
-- 1. Replace <STAGING_TEST_USER_UID> with the UID of the staging test user.
-- 2. Check the production baseline (db/schema/production_baseline.sql) for the
--    exact `users` columns and whether `tenant_id` references a tenants /
--    organisations table; if it does, create that synthetic tenant row first
--    (the block below shows the common case).
-- 3. Run in the STAGING SQL editor. Never run against production.

do $$
declare
  v_tenant uuid := gen_random_uuid();
begin
  -- If users.tenant_id has a foreign key, insert the synthetic tenant first, e.g.:
  -- insert into public.organisations (id, name) values (v_tenant, 'SYNTHETIC — Staging Tenant');

  insert into public.users (user_id, tenant_id, full_name)
  values ('<STAGING_TEST_USER_UID>'::uuid, v_tenant, 'SYNTHETIC — Staging Test User');

  raise notice 'Staging test user linked to synthetic tenant %', v_tenant;
end $$;
