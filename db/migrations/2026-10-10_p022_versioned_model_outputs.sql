-- P-022 — versioned PPP result persistence (ADDITIVE, non-destructive)
-- ---------------------------------------------------------------------------
-- Adds nullable columns to public.model_outputs. Existing rows are NOT
-- modified: they keep NULL in every new column, which the application reads
-- as "legacy result (stored before versioned persistence)".
-- No data is updated, recalculated or deleted. Existing RLS policies on
-- model_outputs apply to the new columns unchanged.
--
-- Apply BEFORE deploying the release that writes these columns. Until it is
-- applied, PPP approvals are refused with a clear message (nothing written).
-- Rollback (only if no versioned rows need to be kept):
--   alter table public.model_outputs
--     drop column if exists result_payload, drop column if exists inputs_snapshot,
--     drop column if exists engine_version, drop column if exists result_schema_version,
--     drop column if exists periodicity;
-- ---------------------------------------------------------------------------

alter table public.model_outputs
  add column if not exists engine_version        text,
  add column if not exists result_schema_version integer,
  add column if not exists periodicity           text,
  add column if not exists result_payload        jsonb,
  add column if not exists inputs_snapshot       jsonb;

comment on column public.model_outputs.engine_version is
  'P-022: PPP engine version that produced this result (NULL = legacy, pre-P-022).';
comment on column public.model_outputs.result_schema_version is
  'P-022: layout version of result_payload.';
comment on column public.model_outputs.periodicity is
  'P-022: annual | quarterly.';
comment on column public.model_outputs.result_payload is
  'P-022: complete engine output (debt schedule, IDC, debt sizing, integrity, warnings, periodic detail). Immutable once written.';
comment on column public.model_outputs.inputs_snapshot is
  'P-022: assumption rows the result was calculated from.';

-- Verification (read-only):
--   select count(*) filter (where result_payload is null) as legacy_rows,
--          count(*) filter (where result_payload is not null) as versioned_rows
--   from public.model_outputs;
