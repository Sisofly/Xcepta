/**
 * debtSchedule.js
 * ---------------------------------------------------------------------------
 * PPP debt-schedule rows for the Results tab, from a model output in any of
 * the shapes that exist in storage (P-010 / P-015D).
 *
 * Results renders the PERSISTED model_outputs row, which stores only irr,
 * npv, equity_multiple, dscr_series and cash_flows — not debt_schedule or
 * debt_sizing. The schedule is therefore rebuilt from the engine's own
 * cash_flows rows using the engine's balance identity:
 *
 *   closing_t = opening_t + debt_draw_t + idc_t − principal_t
 *
 * Supported shapes, in priority order:
 *   1. Fresh engine output carrying debt_schedule → returned verbatim.
 *   2. cash_flows rows with debt_draw (P-015A+) → roll forward from 0,
 *      including idc where present (P-015C+; absent ⇒ 0, which is exact for
 *      pre-IDC outputs).
 *   3. Legacy rows without debt_draw → every row opens at the starting debt
 *      (debt_sizing.actual_debt → debt_amount → Σ principal).
 * Returns null when no schedule can be derived.
 * ---------------------------------------------------------------------------
 */
export function buildDebtScheduleRows(modelOutput) {
  if (!modelOutput || !Array.isArray(modelOutput.cash_flows) || modelOutput.cash_flows.length === 0) return null
  if (Array.isArray(modelOutput.debt_schedule) && modelOutput.debt_schedule.length > 0) {
    return modelOutput.debt_schedule
  }

  const cfs = modelOutput.cash_flows
  const hasDebtDrawField = cfs.some(r => r.debt_draw != null)
  let opening
  if (hasDebtDrawField) {
    opening = 0
  } else {
    // Legacy baselines (pre-P-015A): starting term-loan balance. Prefer the
    // engine's sized figure; fall back to debt_amount; finally Σ principal
    // (the loan fully amortizes, so total principal = original debt).
    const principalSum = cfs.reduce((s, r) => s + (Number(r.principal) || 0), 0)
    opening =
      (modelOutput.debt_sizing && modelOutput.debt_sizing.actual_debt != null)
        ? Number(modelOutput.debt_sizing.actual_debt)
        : (modelOutput.debt_amount != null)
          ? Number(modelOutput.debt_amount)
          : (principalSum > 0 ? principalSum : null)
    if (opening === null || !Number.isFinite(opening)) return null
  }

  return cfs.map(r => {
    const principal = Number(r.principal) || 0
    const interest  = Number(r.interest)  || 0
    const draw      = Number(r.debt_draw) || 0
    const idc       = Number(r.idc)       || 0
    const closing = (hasDebtDrawField && r.phase === 'Construction')
      ? opening + draw + idc
      : opening - principal
    const row = { year: r.year, phase: r.phase, opening, draw, idc, interest, principal, closing }
    opening = closing
    return row
  })
}
