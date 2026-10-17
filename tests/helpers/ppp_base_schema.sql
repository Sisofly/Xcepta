-- Test-only base schema for the PPP persistence integration tests.
-- The production DDL for these tables is not in the repository; this
-- reconstructs the columns the application reads and writes
-- (FeasibilityProject.jsx, pppResultStore.js) as they exist BEFORE the P-022
-- migration. Column types assumed: numeric metrics, jsonb series, uuid keys,
-- timestamptz audit columns. The pre-deployment verification query in
-- docs/PPP_COMPLETION_REPORT_RC1.md §8 confirms these against Supabase.

create table versions (
  version_id  uuid primary key default gen_random_uuid(),
  scenario_id uuid,
  label       text,
  status      text not null default 'draft' check (status in ('draft', 'approved')),
  approved_at timestamptz,
  created_at  timestamptz not null default now(),
  created_by  uuid
);

create table model_outputs (
  output_id       uuid primary key default gen_random_uuid(),
  version_id      uuid not null references versions (version_id),
  project_id      uuid,
  tenant_id       uuid,
  irr             numeric,
  npv             numeric,
  equity_multiple numeric,
  dscr_series     jsonb,
  cash_flows      jsonb,
  created_by      uuid,
  computed_at     timestamptz not null default clock_timestamp()
);

-- TEST DOUBLE of public.approve_version (db/migrations/2026-10-16_sec03_lifecycle_functions.sql).
-- This simplified schema has no auth, tenants or RLS, so the double performs
-- only the data part of the real function — save the result row and approve
-- the draft, atomically (one statement, one transaction). Identity, tenant,
-- role, state and immutability rules are tested against the real function on
-- the production schema in tests/security.test.js.
create function approve_version(p_version_id uuid, p_record jsonb, p_label text default null)
  returns uuid language plpgsql as $$
declare v_out uuid;
begin
  if (select status from versions where version_id = p_version_id) is distinct from 'draft' then
    raise exception using errcode = '55000', message = 'INVALID_STATE: only a draft version can be approved';
  end if;
  insert into model_outputs (version_id, project_id, tenant_id, created_by, irr, npv, equity_multiple, dscr_series, cash_flows,
      engine_version, result_schema_version, periodicity, result_payload, inputs_snapshot)
    values (p_version_id, (p_record ->> 'project_id')::uuid, (p_record ->> 'tenant_id')::uuid, (p_record ->> 'created_by')::uuid,
      (p_record ->> 'irr')::numeric, (p_record ->> 'npv')::numeric, (p_record ->> 'equity_multiple')::numeric,
      nullif(p_record -> 'dscr_series', 'null'::jsonb), nullif(p_record -> 'cash_flows', 'null'::jsonb),
      p_record ->> 'engine_version', (p_record ->> 'result_schema_version')::integer, p_record ->> 'periodicity',
      nullif(p_record -> 'result_payload', 'null'::jsonb), nullif(p_record -> 'inputs_snapshot', 'null'::jsonb))
    returning output_id into v_out;
  update versions set status = 'approved', approved_at = now(), label = coalesce(nullif(p_label, ''), label)
   where version_id = p_version_id;
  return v_out;
end $$;
