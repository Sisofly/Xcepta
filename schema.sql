-- =============================================================================
-- XCEPTA Real Estate Cash Flow Engine — Supabase (PostgreSQL) Schema
-- =============================================================================
-- Convention:
--   - All monetary amounts stored as NUMERIC(18, 4) — no floating-point drift
--   - Rates stored as NUMERIC(10, 6) — e.g. 0.080000 for 8%
--   - Percentages stored as raw decimal (0.25 = 25%)
--   - All timestamps UTC
--   - Row-level security (RLS) policies enabled — org_id scopes all data
-- =============================================================================

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- =============================================================================
-- ORGANISATIONS (multi-tenant root)
-- =============================================================================
create table if not exists organisations (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,
  created_at  timestamptz not null default now()
);

-- =============================================================================
-- PROJECTS (one row per real estate development project)
-- =============================================================================
create table if not exists re_projects (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organisations(id) on delete cascade,
  project_name           text        not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- Construction timeline
  construction_months    int         not null check (construction_months > 0),

  -- Cost inputs
  land_cost              numeric(18,4) not null check (land_cost >= 0),
  hard_cost_total        numeric(18,4) not null check (hard_cost_total >= 0),
  soft_cost_total        numeric(18,4) not null check (soft_cost_total >= 0),
  upfront_soft_costs     numeric(18,4) not null default 0 check (upfront_soft_costs >= 0),
  s_curve_alpha          numeric(6,4)  not null default 1.0 check (s_curve_alpha > 0),
  soft_cost_mode         text          not null default 'flat'
                                       check (soft_cost_mode in ('flat', 'front', 'proportional')),

  -- Sales inputs
  total_gdv              numeric(18,4) not null check (total_gdv >= 0),
  phase_weight_pre       numeric(8,6)  not null default 0 check (phase_weight_pre between 0 and 1),
  phase_weight_during    numeric(8,6)  not null default 0 check (phase_weight_during between 0 and 1),
  phase_weight_post      numeric(8,6)  not null default 0 check (phase_weight_post between 0 and 1),
  payment_deposit        numeric(8,6)  not null check (payment_deposit between 0 and 1),
  payment_installments   numeric(8,6)  not null check (payment_installments between 0 and 1),
  payment_handover       numeric(8,6)  not null check (payment_handover between 0 and 1),
  post_sale_months       int           not null default 6 check (post_sale_months >= 0),
  during_sale_pattern    text          not null default 'linear'
                                       check (during_sale_pattern in ('linear', 'backend')),

  -- Financing inputs
  equity_amount          numeric(18,4) not null check (equity_amount >= 0),
  loan_amount            numeric(18,4) not null check (loan_amount >= 0),
  annual_interest_rate   numeric(10,6) not null check (annual_interest_rate >= 0),
  capitalize_interest    boolean       not null default true,

  -- Exit inputs
  exit_method            text          not null check (exit_method in ('gdv', 'cap_rate')),
  exit_delay_months      int           not null default 0 check (exit_delay_months >= 0),
  selling_cost_rate      numeric(8,6)  not null default 0.02,
  gross_rental_income    numeric(18,4) null,
  vacancy_rate           numeric(8,6)  null,
  operating_expenses     numeric(18,4) null,
  exit_cap_rate          numeric(8,6)  null,

  -- Discount rate for NPV
  discount_rate          numeric(8,6)  not null default 0.10,

  -- Validation constraints
  constraint phase_weights_sum check (
    abs(phase_weight_pre + phase_weight_during + phase_weight_post - 1.0) < 0.000001
  ),
  constraint payment_schedule_sum check (
    abs(payment_deposit + payment_installments + payment_handover - 1.0) < 0.000001
  ),
  constraint cap_rate_required check (
    exit_method != 'cap_rate' or exit_cap_rate is not null
  )
);

create index if not exists re_projects_org_id_idx on re_projects(org_id);

-- =============================================================================
-- CF ENGINE RUNS (one row per engine execution — keeps history of runs)
-- =============================================================================
create table if not exists cf_engine_runs (
  id                        uuid primary key default gen_random_uuid(),
  project_id                uuid not null references re_projects(id) on delete cascade,
  org_id                    uuid not null references organisations(id) on delete cascade,
  run_at                    timestamptz not null default now(),
  engine_version            text not null default '1.0.0',

  -- Summary KPIs (denormalised for fast dashboard queries)
  total_development_cost    numeric(18,4),
  total_gdv                 numeric(18,4),
  development_profit        numeric(18,4),
  profit_on_cost            numeric(10,6),
  profit_on_gdv             numeric(10,6),
  total_capitalized_interest numeric(18,4),
  total_financing_cost      numeric(18,4),
  total_equity_deployed     numeric(18,4),
  total_loan_drawn          numeric(18,4),
  final_loan_balance        numeric(18,4),
  loan_capacity_breached    boolean,
  equity_shortfall          numeric(18,4),
  ltv                       numeric(10,6),
  gross_exit_value          numeric(18,4),
  net_exit_proceeds         numeric(18,4),
  project_npv               numeric(18,4),
  equity_npv                numeric(18,4),
  unleveraged_irr           numeric(10,6),
  leveraged_irr             numeric(10,6),
  leverage_lift             numeric(10,6),

  -- Full output stored as JSONB for flexibility
  full_output               jsonb
);

create index if not exists cf_runs_project_id_idx on cf_engine_runs(project_id);
create index if not exists cf_runs_org_id_idx     on cf_engine_runs(org_id);

-- =============================================================================
-- MONTHLY SCHEDULE (one row per month per run — queryable time series)
-- =============================================================================
create table if not exists cf_monthly_schedule (
  id                    uuid primary key default gen_random_uuid(),
  run_id                uuid not null references cf_engine_runs(id) on delete cascade,
  project_id            uuid not null references re_projects(id) on delete cascade,
  org_id                uuid not null references organisations(id) on delete cascade,
  month_index           int  not null check (month_index >= 0),

  hard_cost_draw        numeric(18,4) not null default 0,
  soft_cost_draw        numeric(18,4) not null default 0,
  total_cost_draw       numeric(18,4) not null default 0,
  sales_inflow          numeric(18,4) not null default 0,
  equity_draw           numeric(18,4) not null default 0,
  loan_draw             numeric(18,4) not null default 0,
  loan_balance          numeric(18,4) not null default 0,
  capitalized_interest  numeric(18,4) not null default 0,
  cash_interest_paid    numeric(18,4) not null default 0,
  unleveraged_cf        numeric(18,4) not null default 0,
  leveraged_cf          numeric(18,4) not null default 0,
  exit_proceeds         numeric(18,4) not null default 0,

  constraint cf_monthly_unique unique (run_id, month_index)
);

create index if not exists cf_monthly_run_id_idx     on cf_monthly_schedule(run_id);
create index if not exists cf_monthly_project_id_idx on cf_monthly_schedule(project_id);

-- =============================================================================
-- ROW-LEVEL SECURITY
-- =============================================================================
alter table re_projects         enable row level security;
alter table cf_engine_runs      enable row level security;
alter table cf_monthly_schedule enable row level security;

-- Policy: users can only access their own org's data.
-- Assumes JWT contains org_id claim: auth.jwt()->'app_metadata'->>'org_id'

create policy "org_isolation_projects" on re_projects
  for all using (org_id::text = auth.jwt()->'app_metadata'->>'org_id');

create policy "org_isolation_runs" on cf_engine_runs
  for all using (org_id::text = auth.jwt()->'app_metadata'->>'org_id');

create policy "org_isolation_schedule" on cf_monthly_schedule
  for all using (org_id::text = auth.jwt()->'app_metadata'->>'org_id');

-- =============================================================================
-- HELPER: updated_at auto-update trigger
-- =============================================================================
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger re_projects_updated_at
  before update on re_projects
  for each row execute procedure set_updated_at();
