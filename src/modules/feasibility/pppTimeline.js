/**
 * pppTimeline.js — calendar timing of an APPROVED PPP result, for FP&A
 * ---------------------------------------------------------------------------
 * The PPP engine counts model periods (years or quarters) from the start of
 * construction; it does not use calendar dates. FP&A needs calendar months,
 * so a PPP project records one date:
 *
 *   Construction Start / Financial Close Date
 *     stored as the existing assumption 'Construction Start Date' (unit =
 *     'YYYY-MM-DD'); no schema change. For tax-exempt projects the engine
 *     ignores it; for taxable projects it also sets the tax-year boundaries
 *     (P-028, pppTax.js), so it is a calculation input.
 *
 * Operations start (COD) is DERIVED, never entered: start date + the
 * construction periods the engine models (ceil(months / period length)).
 *
 * Approval integrity: FP&A takes the date from the approved result's
 * immutable inputs_snapshot, never from the live assumption rows. A date
 * added (or changed) after approval is used only once a new version is
 * approved; approved versions are never modified.
 *
 * Monthly budgets are ESTIMATES: a modelled period's value is spread evenly
 * over its months (quarterly models use each quarter's own cash flows — no
 * re-spreading of annual totals). Whole-currency amounts are allocated by
 * cumulative rounding, so the months of a period add up exactly to the
 * period total rounded to whole currency.
 * ---------------------------------------------------------------------------
 */
import { hydrateModelOutput } from './resultPersistence.js'
import { parseStartDate } from './pppTax.js'

export const PPP_START_DATE = 'Construction Start Date'
export const PPP_START_DATE_LABEL = 'Construction Start / Financial Close Date'

// FP&A accounts for PPP projects. Availability payments have their own
// revenue account; they are never classified as sale or rental revenue.
export const PPP_FPA_ACCOUNTS = [
  { code: 'REV_AVAILABILITY', name: 'Availability Payments', field: 'revenue' },
  { code: 'COST_CONST',       name: 'Construction Costs',    field: 'capex' },
  { code: 'COST_OPEX',        name: 'Operating Expenses',    field: 'opex' },
  { code: 'COST_FINANCE',     name: 'Finance Charges',       field: 'interest' },
  { code: 'COST_ADMIN',       name: 'Admin & Overheads',     field: null },
]

// Strict 'YYYY-MM-DD' date parser (shared with the tax calendar, pppTax.js)
export { parseStartDate }

const monthIndex = (year, month) => year * 12 + (month - 1)
function monthLabel(idx) {
  const year = Math.floor(idx / 12), month = (idx % 12) + 1
  return year + '-' + String(month).padStart(2, '0')
}
const pad2 = n => String(n).padStart(2, '0')

// Adds whole months to a 'YYYY-MM-DD' date; the day is clamped to the end of
// the target month (31 Jan + 3 months → 30 Apr).
export function addMonthsISO(date, months) {
  const p = parseStartDate(date)
  if (!p) return null
  const idx = monthIndex(p.year, p.month) + months
  const year = Math.floor(idx / 12), month = (idx % 12) + 1
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return year + '-' + pad2(month) + '-' + pad2(Math.min(p.day, lastDay))
}

// Mirrors the engine: construction occupies ceil(months / period length)
// whole model periods, at least one.
export function modelConstructionPeriods(constrMonths, periodsPerYear) {
  return Math.max(1, Math.ceil(Number(constrMonths) / (12 / periodsPerYear)))
}

// Model periodicity and construction months from assumption rows, read the
// way the engine reads them (Construction Period defaults to 24 months).
function rowsTiming(assumptions) {
  const find = name => (assumptions || []).find(a => a && a.name === name)
  const per = find('Model Periodicity')
  const perText = per && ((typeof per.value === 'string' && per.value.trim()) || (typeof per.unit === 'string' && per.unit.trim()))
  const ppy = String(perText || 'Annual').toLowerCase() === 'quarterly' ? 4 : 1
  const cp = find('Construction Period')
  const months = cp && cp.value !== null && cp.value !== undefined && Number.isFinite(Number(cp.value)) ? Number(cp.value) : 24
  return { ppy, months }
}

// Derived operations start (COD) for display in Assumptions — the calendar
// date of the first modelled operating period. null without a valid date.
export function derivePPPOperationsStart(assumptions) {
  const start = pppStartDateOf(assumptions)
  if (!parseStartDate(start)) return null
  const { ppy, months } = rowsTiming(assumptions)
  const modelled = modelConstructionPeriods(months, ppy) * (12 / ppy)
  return { date: addMonthsISO(start, modelled), modelledMonths: modelled, enteredMonths: months }
}

export function pppStartDateOf(rows) {
  const a = (rows || []).find(r => r && r.name === PPP_START_DATE)
  return a && typeof a.unit === 'string' && a.unit.trim() ? a.unit.trim() : null
}

// The period rows FP&A allocates from: quarterly results use their own
// quarterly cash flows; annual results use annual rows.
function timelineRows(result) {
  const ppy = Number(result && result.periods_per_year) > 1 ? Number(result.periods_per_year) : 1
  if (ppy > 1) {
    const rows = result.cash_flows_periodic
    return Array.isArray(rows) && rows.length ? { ppy, rows } : null
  }
  const rows = result && result.cash_flows
  return Array.isArray(rows) && rows.length ? { ppy, rows } : null
}

// Calendar bounds of the modelled timeline (months, inclusive).
export function pppTimelineBounds(result, startDate) {
  const s = parseStartDate(startDate)
  const tl = timelineRows(result)
  if (!s || !tl) return null
  const mpp = 12 / tl.ppy
  const first = monthIndex(s.year, s.month)
  const nC = tl.rows.filter(r => r.phase === 'Construction').length
  return {
    constructionStart: monthLabel(first),
    operationsStart: monthLabel(first + nC * mpp),
    concessionEnd: monthLabel(first + tl.rows.length * mpp - 1),
    monthsPerPeriod: mpp,
    granularity: tl.ppy > 1 ? 'quarter' : 'year',
  }
}

// Month j (0-based) of a period of n months receives
// round(T·(j+1)/n) − round(T·j/n): whole currency, and the n months add up
// exactly to round(T).
function allocate(total, n, j) {
  const upTo = k => (k === n ? Math.round(total) : Math.round(total * k / n))
  return upTo(j + 1) - upTo(j)
}

// Estimated FP&A budget for calendar month `period` ('YYYY-MM').
//   status 'ok' | 'no_date' | 'invalid_date' | 'invalid_period' |
//          'no_period_detail' | 'before_start' | 'after_concession'
export function pppMonthlyBudget(result, startDate, period) {
  if (!startDate) return { status: 'no_date' }
  const s = parseStartDate(startDate)
  if (!s) return { status: 'invalid_date', startDate }
  const pm = /^(\d{4})-(\d{2})$/.exec(String(period || ''))
  if (!pm || Number(pm[2]) < 1 || Number(pm[2]) > 12) return { status: 'invalid_period' }
  const tl = timelineRows(result)
  if (!tl) return { status: 'no_period_detail' }
  const bounds = pppTimelineBounds(result, startDate)
  const mpp = 12 / tl.ppy
  const offset = monthIndex(Number(pm[1]), Number(pm[2])) - monthIndex(s.year, s.month)
  if (offset < 0) return { status: 'before_start', bounds }
  if (offset >= tl.rows.length * mpp) return { status: 'after_concession', bounds }
  const k = Math.floor(offset / mpp), j = offset % mpp
  const row = tl.rows[k]
  const budget = {}
  PPP_FPA_ACCOUNTS.forEach(a => { budget[a.code] = a.field ? allocate(Number(row[a.field] || 0), mpp, j) : 0 })
  const nC = tl.rows.filter(r => r.phase === 'Construction').length
  const phaseIndex = row.phase === 'Construction' ? k + 1 : k - nC + 1
  return {
    status: 'ok', budget, bounds, phase: row.phase,
    periodIndex: k, monthInPeriod: j + 1, monthsPerPeriod: mpp, granularity: bounds.granularity,
    periodLabel: (row.phase === 'Construction' ? 'construction ' : 'operating ') + bounds.granularity + ' ' + phaseIndex,
  }
}

// Decides what FP&A may use for a PPP project, from the approved
// model_outputs row and the live assumption rows.
//   status 'ok'                       — date recorded in the approved inputs
//          'no_approved_result'
//          'legacy_result'            — approved before P-022 (no inputs record)
//          'date_added_after_approval'— live date exists; approve a new version
//          'no_date'                  — no date anywhere; add it in Assumptions
//          'invalid_date'
// `liveDateDiffers` flags a live date that differs from the approved one
// (the approved date is still used).
export function resolvePPPFpaBasis(outputRow, liveAssumptions) {
  if (!outputRow) return { status: 'no_approved_result' }
  const result = hydrateModelOutput(outputRow)
  const liveDate = pppStartDateOf(liveAssumptions)
  if (result._persistence.legacy) return { status: 'legacy_result', result, liveDate }
  const approvedDate = pppStartDateOf(result._persistence.inputs_snapshot)
  if (!approvedDate) return { status: liveDate ? 'date_added_after_approval' : 'no_date', result, liveDate }
  if (!parseStartDate(approvedDate)) return { status: 'invalid_date', result, startDate: approvedDate, liveDate }
  return {
    status: 'ok', result, startDate: approvedDate, liveDate,
    liveDateDiffers: liveDate !== approvedDate,
    bounds: pppTimelineBounds(result, approvedDate),
  }
}
