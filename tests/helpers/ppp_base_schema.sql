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
