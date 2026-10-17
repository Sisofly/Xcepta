/**
 * pppFpaTimeline.test.js — FP&A calendar placement of approved PPP results.
 *
 * Covers: engine invariance (the date never changes a result), construction-
 * period rounding identical to the engine, annual and quarterly models,
 * construction → operations transition, concession expiry, account mapping
 * (Availability Payments), exact whole-currency allocation, and approved-
 * version integrity (date from the approved inputs record only).
 */
import { exactDiff } from '../scripts/staging/exact-compare.mjs'
import { runPPPEngine, PPP_ENGINE_VERSION } from '../src/modules/feasibility/annualEngine.js'
import {
  PPP_START_DATE, PPP_FPA_ACCOUNTS, parseStartDate, addMonthsISO, modelConstructionPeriods,
  derivePPPOperationsStart, pppTimelineBounds, pppMonthlyBudget, resolvePPPFpaBasis,
} from '../src/modules/feasibility/pppTimeline.js'
import { diffInputs } from '../src/modules/feasibility/resultPersistence.js'
import { createTestDb, applyP022Migration, supabaseLike } from './helpers/pgliteSupabase.js'
import { savePPPApproval } from '../src/modules/feasibility/pppResultStore.js'

const rows = o => Object.entries(o).map(([name, v]) => (typeof v === 'string'
  ? { name, value: null, unit: v, category: 'ppp_structure' } : { name, value: v, unit: null, category: 'ppp_structure' }))
const BASE = { 'Total Project Cost': 100e6, 'Debt %': 80, 'Equity %': 20, 'Annual Availability Payment': 12e6,
  'Concession Period': 25, 'Construction Period': 24, 'OPEX % of Revenue': 5, 'Interest Rate': 7, 'Loan Tenor': 10,
  'Grace Period': 2, 'Tax Rate': 20, 'WACC': 10, 'Target DSCR': 1.2 }
const QUARTERLY = { 'Total Project Cost': 50_788_939, 'Debt %': 84.899, 'Equity %': 15.101, 'Annual Availability Payment': 8_800_000,
  'Concession Period': 10, 'Construction Period': 30, 'OPEX Amount (JOD)': 54_020, 'OPEX Escalation %': 2.015,
  'Interest Rate': 8.25, 'Loan Tenor': 9.5, 'Grace Period': 0, 'Tax Rate': 0, 'WACC': 10, 'Target DSCR': 1.0,
  'Model Periodicity': 'Quarterly' }
const CODES = PPP_FPA_ACCOUNTS.map(a => a.code)
const clean = o => JSON.parse(JSON.stringify(o))

// Every calendar month of the timeline, in order
function allMonths(result, start) {
  const b = pppTimelineBounds(result, start), out = []
  let [y, m] = b.constructionStart.split('-').map(Number)
  for (;;) {
    const p = y + '-' + String(m).padStart(2, '0')
    out.push(p)
    if (p === b.concessionEnd) return out
    m++; if (m > 12) { m = 1; y++ }
  }
}

// P-028: for TAXABLE projects the start date also sets the tax-year boundaries,
// so it is a calculation input (T1b). It never changes results of tax-exempt
// projects or of the 2.0.0 tax method (T1).
describe('engine invariance — the start date changes no result of exempt / 2.0.0-tax projects', () => {
  test.each([['annual (tax-exempt)', { ...BASE, 'Tax Rate': 0 }], ['annual (2.0.0 tax method)', { ...BASE, 'Tax Depreciation': 'None' }],
    ['quarterly (tax-exempt)', QUARTERLY], ['variable CFADS (2.0.0 tax method)', { ...BASE, 'Tax Depreciation': 'None', 'Availability Payment Escalation %': 2.5, 'Repayment Profile': 'Annuity' }]])(
    'T1 %s: output with the date is bit-identical to output without it', (_l, inputs) => {
      const without = clean(runPPPEngine(rows(inputs)))
      const withDate = clean(runPPPEngine(rows({ ...inputs, [PPP_START_DATE]: '2026-07-01' })))
      const d = exactDiff(without, withDate)
      expect(d.differences).toEqual([])
    })

  test('T1b taxable (P-028): the date moves only tax timing — operating figures are unchanged', () => {
    const without = clean(runPPPEngine(rows(BASE)))
    const withDate = clean(runPPPEngine(rows({ ...BASE, [PPP_START_DATE]: '2026-07-01' })))
    expect(without.tax_assumptions.tax_year_basis).toBe('cod_anniversary_fallback')
    expect(withDate.tax_assumptions.tax_year_basis).toBe('calendar')
    const pre = o => o.cash_flows.map(r => [r.revenue, r.opex, r.ebitda, r.capex])
    expect(pre(withDate)).toEqual(pre(without))
    expect(withDate.tax_schedule[0].months).toBe(6)                 // COD 2028-07 → partial FY2028
    expect(without.tax_schedule[0].months).toBe(12)
  })
})

describe('dates and model periods', () => {
  test('T2: strict date parsing and month arithmetic (day clamped to month end)', () => {
    expect(parseStartDate('2026-07-01')).toEqual({ year: 2026, month: 7, day: 1 })
    ;['2026-02-30', '2026-7-1', '', null, '01/07/2026', '2026-13-01'].forEach(s => expect(parseStartDate(s)).toBeNull())
    expect(addMonthsISO('2026-01-31', 3)).toBe('2026-04-30')
    expect(addMonthsISO('2024-02-29', 12)).toBe('2025-02-28')
    expect(addMonthsISO('2026-07-01', 24)).toBe('2028-07-01')
  })

  test('T3: construction periods match the engine for annual and quarterly models', () => {
    for (const months of [3, 6, 12, 18, 24, 30, 36]) {
      const a = runPPPEngine(rows({ ...BASE, 'Construction Period': months }))
      expect(modelConstructionPeriods(months, 1)).toBe(a.construction_years)
      const q = runPPPEngine(rows({ ...QUARTERLY, 'Construction Period': months }))
      expect(modelConstructionPeriods(months, 4)).toBe(q.construction_periods)
      // Derived operations start = first month of the first modelled operating period
      const cod = derivePPPOperationsStart(rows({ ...QUARTERLY, 'Construction Period': months, [PPP_START_DATE]: '2026-01-01' }))
      expect(cod.date.slice(0, 7)).toBe(pppTimelineBounds(q, '2026-01-01').operationsStart)
    }
    // 18 months in an annual model is modelled as 2 whole years
    expect(derivePPPOperationsStart(rows({ ...BASE, 'Construction Period': 18, [PPP_START_DATE]: '2026-07-01' })))
      .toEqual({ date: '2028-07-01', modelledMonths: 24, enteredMonths: 18 })
    expect(derivePPPOperationsStart(rows(BASE))).toBeNull()
  })
})

describe('annual model — monthly estimates', () => {
  const out = runPPPEngine(rows(BASE))
  const START = '2026-07-01'

  test('T4: timeline bounds and the construction → operations transition (June 2028)', () => {
    expect(pppTimelineBounds(out, START)).toEqual({ constructionStart: '2026-07', operationsStart: '2028-07',
      concessionEnd: '2053-06', monthsPerPeriod: 12, granularity: 'year' })
    const jun = pppMonthlyBudget(out, START, '2028-06')
    expect(jun).toMatchObject({ status: 'ok', phase: 'Construction', periodIndex: 1, monthInPeriod: 12, periodLabel: 'construction year 2' })
    expect(jun.budget.REV_AVAILABILITY).toBe(0)
    expect(jun.budget.COST_FINANCE).toBe(0)                           // IDC is capitalised, not a finance charge
    expect(jun.budget.COST_CONST).toBe(Math.round(out.cash_flows[1].capex) - Math.round(out.cash_flows[1].capex * 11 / 12))
    const jul = pppMonthlyBudget(out, START, '2028-07')
    expect(jul).toMatchObject({ status: 'ok', phase: 'Operations', periodIndex: 2, monthInPeriod: 1, periodLabel: 'operating year 1' })
    expect(jul.budget).toEqual({ REV_AVAILABILITY: 1_000_000, COST_CONST: 0, COST_OPEX: 50_000,
      COST_FINANCE: Math.round(out.cash_flows[2].interest / 12), COST_ADMIN: 0 })
  })

  test('T5: months outside the modelled timeline (before start, concession expiry)', () => {
    expect(pppMonthlyBudget(out, START, '2026-06').status).toBe('before_start')
    expect(pppMonthlyBudget(out, START, '2026-07').status).toBe('ok')
    const last = pppMonthlyBudget(out, START, '2053-06')
    expect(last).toMatchObject({ status: 'ok', phase: 'Operations', periodLabel: 'operating year 25', monthInPeriod: 12 })
    const after = pppMonthlyBudget(out, START, '2053-07')
    expect(after.status).toBe('after_concession')                    // no longer clamped to the last year
    expect(after.bounds.concessionEnd).toBe('2053-06')
    expect(pppMonthlyBudget(out, START, '2060-01').status).toBe('after_concession')
    expect(pppMonthlyBudget(out, null, '2028-07').status).toBe('no_date')
    expect(pppMonthlyBudget(out, '2026-02-30', '2028-07').status).toBe('invalid_date')
    expect(pppMonthlyBudget(out, START, '2028-13').status).toBe('invalid_period')
  })

  test('T6: account mapping — Availability Payments only; never sale or rental revenue', () => {
    const b = pppMonthlyBudget(out, START, '2030-03').budget
    expect(Object.keys(b)).toEqual(CODES)
    expect(CODES).toEqual(['REV_AVAILABILITY', 'COST_CONST', 'COST_OPEX', 'COST_FINANCE', 'COST_ADMIN'])
    expect(b).not.toHaveProperty('REV_SALE')
    expect(b).not.toHaveProperty('REV_RENTAL')
    expect(PPP_FPA_ACCOUNTS[0]).toEqual({ code: 'REV_AVAILABILITY', name: 'Availability Payments', field: 'revenue' })
  })

  test('T7: the months of every modelled year add up EXACTLY to the year (whole currency)', () => {
    const totals = out.cash_flows.map(() => Object.fromEntries(CODES.map(c => [c, 0])))
    for (const p of allMonths(out, START)) {
      const e = pppMonthlyBudget(out, START, p)
      CODES.forEach(c => { totals[e.periodIndex][c] += e.budget[c] })
    }
    out.cash_flows.forEach((r, i) => {
      expect(totals[i]).toEqual({ REV_AVAILABILITY: Math.round(r.revenue), COST_CONST: Math.round(r.capex),
        COST_OPEX: Math.round(r.opex), COST_FINANCE: Math.round(r.interest), COST_ADMIN: 0 })
    })
  })
})

describe('quarterly model — uses the quarterly cash flows, not annual totals', () => {
  const START = '2026-01-15'

  test('T8: 30-month construction — operations start mid-year; months follow the quarters', () => {
    const out = runPPPEngine(rows(QUARTERLY))
    expect(out.construction_periods).toBe(10)
    expect(pppTimelineBounds(out, START)).toEqual({ constructionStart: '2026-01', operationsStart: '2028-07',
      concessionEnd: '2038-06', monthsPerPeriod: 3, granularity: 'quarter' })
    // Annual row for 2028 mixes 2 construction and 2 operating quarters (labelled Construction);
    // FP&A must not spread it: June 2028 is construction, July 2028 is operations.
    expect(out.cash_flows[2].phase).toBe('Construction')
    const jun = pppMonthlyBudget(out, START, '2028-06')
    const jul = pppMonthlyBudget(out, START, '2028-07')
    expect(jun).toMatchObject({ status: 'ok', phase: 'Construction', periodLabel: 'construction quarter 10', monthInPeriod: 3 })
    expect(jul).toMatchObject({ status: 'ok', phase: 'Operations', periodLabel: 'operating quarter 1', monthInPeriod: 1, periodIndex: 10 })
    const q = out.cash_flows_periodic[10]
    expect(jul.budget.REV_AVAILABILITY).toBe(Math.round(q.revenue / 3))
    expect(jul.budget.COST_FINANCE).toBe(Math.round(q.interest / 3))
    expect(jul.budget.REV_AVAILABILITY).not.toBe(Math.round(out.cash_flows[2].revenue / 12))
    expect(jun.budget.REV_AVAILABILITY).toBe(0)
    expect(pppMonthlyBudget(out, START, '2038-06').status).toBe('ok')
    expect(pppMonthlyBudget(out, START, '2038-07').status).toBe('after_concession')
    expect(pppMonthlyBudget(out, START, '2025-12').status).toBe('before_start')
  })

  test('T9: quarterly revenue weights carry through; every quarter adds up exactly', () => {
    const out = runPPPEngine(rows({ ...QUARTERLY, 'Construction Period': 36, 'Quarterly Revenue Weights': '1,2,3,4' }))
    const P = out.cash_flows_periodic
    const firstOps = P.findIndex(r => r.phase === 'Operations')
    const revs = [0, 1, 2, 3].map(i => P[firstOps + i].revenue)
    expect(new Set(revs).size).toBe(4)                                 // weighted quarters differ
    const totals = P.map(() => Object.fromEntries(CODES.map(c => [c, 0])))
    for (const p of allMonths(out, START)) {
      const e = pppMonthlyBudget(out, START, p)
      CODES.forEach(c => { totals[e.periodIndex][c] += e.budget[c] })
    }
    P.forEach((r, i) => {
      expect(totals[i]).toEqual({ REV_AVAILABILITY: Math.round(r.revenue), COST_CONST: Math.round(r.capex),
        COST_OPEX: Math.round(r.opex), COST_FINANCE: Math.round(r.interest), COST_ADMIN: 0 })
    })
    expect(pppMonthlyBudget(out, START, '2029-01').budget.REV_AVAILABILITY)
      .not.toBe(pppMonthlyBudget(out, START, '2029-04').budget.REV_AVAILABILITY)
  })

  test('T10: a quarterly result without its quarterly detail is not spread from annual totals', () => {
    const out = clean(runPPPEngine(rows(QUARTERLY)))
    delete out.cash_flows_periodic
    expect(pppMonthlyBudget(out, START, '2028-07').status).toBe('no_period_detail')
  })
})

describe('approved-version integrity (real Postgres jsonb, PGlite)', () => {
  test('T11: date added after approval is not used until a new version is approved; v1 is never changed', async () => {
    const pg = await createTestDb(), db = supabaseLike(pg)
    await applyP022Migration(pg)
    const newVersion = async label => (await pg.query("insert into versions (label, status) values ($1, 'draft') returning *", [label])).rows[0]
    const approve = async (v, assumptions) => savePPPApproval(db, { output: runPPPEngine(assumptions), assumptions,
      engineVersion: PPP_ENGINE_VERSION, versionId: v.version_id, projectId: null, tenantId: null, userId: null, approvedLabel: v.label.replace('Draft', 'Approved') })
    const storedRow = async v => (await db.from('model_outputs').select('*').eq('version_id', v.version_id)
      .order('computed_at', { ascending: false }).limit(1)).data[0]

    // 2.0.0 tax method, so the date is not a calculation input here (taxable
    // variant of the integrity rule: T11b)
    // v1 approved without a date
    const live0 = rows({ ...BASE, 'Tax Depreciation': 'None' })
    const v1 = await newVersion('v1.0 Draft')
    await approve(v1, live0)
    const v1Before = clean(await storedRow(v1))
    expect(resolvePPPFpaBasis(v1Before, live0).status).toBe('no_date')

    // Date added to the live assumptions after approval
    const live1 = [...live0, { name: PPP_START_DATE, value: null, unit: '2026-07-01', category: 'ppp_structure' }]
    const b1 = resolvePPPFpaBasis(v1Before, live1)
    expect(b1).toMatchObject({ status: 'date_added_after_approval', liveDate: '2026-07-01' })
    expect(diffInputs(v1Before.inputs_snapshot, live1)).toEqual([{ name: PPP_START_DATE, from: null, to: '2026-07-01' }])

    // New version approved with the date
    const v2 = await newVersion('v2.0 Draft')
    await approve(v2, live1)
    const v2Row = clean(await storedRow(v2))
    const b2 = resolvePPPFpaBasis(v2Row, live1)
    expect(b2).toMatchObject({ status: 'ok', startDate: '2026-07-01', liveDateDiffers: false })
    expect(b2.bounds.operationsStart).toBe('2028-07')
    // Financial results of v2 are bit-identical to v1 (the date is not a calculation input)
    expect(exactDiff(v1Before.result_payload, v2Row.result_payload).differences).toEqual([])
    expect(exactDiff(v1Before.cash_flows, v2Row.cash_flows).differences).toEqual([])

    // v1's stored record (results AND input snapshot) is unchanged after all of this
    expect(exactDiff(v1Before, clean(await storedRow(v1))).differences).toEqual([])
    const vers = (await pg.query('select label, status from versions order by created_at')).rows
    expect(vers).toEqual([{ label: 'v1.0 Approved', status: 'approved' }, { label: 'v2.0 Approved', status: 'approved' }])

    // A later live edit does not move FP&A: the approved date is kept and the difference flagged
    const live2 = live1.map(a => (a.name === PPP_START_DATE ? { ...a, unit: '2027-01-01' } : a))
    expect(resolvePPPFpaBasis(v2Row, live2)).toMatchObject({ status: 'ok', startDate: '2026-07-01', liveDate: '2027-01-01', liveDateDiffers: true })
    await pg.close()
  })

  test('T11b: taxable (P-028) — adding the date and approving v2 changes tax timing; v1 is never changed', async () => {
    const pg = await createTestDb(), db = supabaseLike(pg)
    await applyP022Migration(pg)
    const mk = async label => (await pg.query("insert into versions (label, status) values ($1, 'draft') returning *", [label])).rows[0]
    const approve = async (v, a) => savePPPApproval(db, { output: runPPPEngine(a), assumptions: a, engineVersion: PPP_ENGINE_VERSION,
      versionId: v.version_id, projectId: null, tenantId: null, userId: null, approvedLabel: v.label.replace('Draft', 'Approved') })
    const stored = async v => clean((await db.from('model_outputs').select('*').eq('version_id', v.version_id).limit(1)).data[0])
    const live0 = rows(BASE), live1 = [...live0, { name: PPP_START_DATE, value: null, unit: '2026-07-01', category: 'ppp_structure' }]
    const v1 = await mk('v1.0 Draft'); await approve(v1, live0)
    const v1Before = await stored(v1)
    const v2 = await mk('v2.0 Draft'); await approve(v2, live1)
    const v2Row = await stored(v2)
    expect(v1Before.result_payload.tax_assumptions.tax_year_basis).toBe('cod_anniversary_fallback')
    expect(v2Row.result_payload.tax_assumptions.tax_year_basis).toBe('calendar')
    expect(exactDiff(v1Before.result_payload, v2Row.result_payload).differences.length).toBeGreaterThan(0)
    expect(resolvePPPFpaBasis(v2Row, live1).status).toBe('ok')
    expect(exactDiff(v1Before, await stored(v1)).differences).toEqual([])   // v1 untouched
    await pg.close()
  })

  test('T12: legacy (pre-P-022) results and missing results', () => {
    const out = runPPPEngine(rows(BASE))
    const legacy = { version_id: 'x', irr: out.irr, npv: out.npv, cash_flows: out.cash_flows, dscr_series: out.dscr_series }
    expect(resolvePPPFpaBasis(legacy, rows({ ...BASE, [PPP_START_DATE]: '2026-07-01' })).status).toBe('legacy_result')
    expect(resolvePPPFpaBasis(null, []).status).toBe('no_approved_result')
    const badSnap = { ...legacy, result_payload: clean(out), inputs_snapshot: [{ name: PPP_START_DATE, value: null, unit: '2026-02-30', category: 'ppp_structure' }] }
    expect(resolvePPPFpaBasis(badSnap, []).status).toBe('invalid_date')
  })
})
