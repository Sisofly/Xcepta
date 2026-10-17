/**
 * pppTax.test.js — P-028 tax depreciation, loss carry-forward and cash-tax
 * timing (engine 2.1.0).
 *
 * Governance §13: expected values come from an INDEPENDENT month-by-month
 * reference implementation written here (calendar Date arithmetic, a FIFO
 * loss queue) that shares no code with pppTax.js or the engine, from
 * hand-worked examples, and from the frozen v2.0.0 engine (regression oracle
 * for 0% tax and Tax Depreciation = None). Nothing is re-baselined to the
 * engine's own output.
 */
import { runPPPEngine, PPP_ENGINE_VERSION, PPP_ENGINE_COMPATIBLE_VERSIONS, solveSupportableDebtTax } from '../src/modules/feasibility/annualEngine.js'
import * as V200 from './fixtures/annualEngine.v2.0.0.js'
import { buildTaxCalendar, createTaxState } from '../src/modules/feasibility/pppTax.js'
import { assessResultCurrency } from '../src/modules/feasibility/resultPersistence.js'
import { pppResultBasis } from '../src/modules/feasibility/pppReporting.js'
import { savePPPApproval, loadLatestModelOutput } from '../src/modules/feasibility/pppResultStore.js'
import { createTestDb, applyP022Migration, supabaseLike } from './helpers/pgliteSupabase.js'
import { exactDiff } from '../scripts/staging/exact-compare.mjs'

const r2 = n => Math.round(n * 100) / 100
const rows = o => Object.entries(o).map(([name, v]) => (typeof v === 'string'
  ? { name, value: null, unit: v, category: 'x' } : { name, value: v, unit: null, category: 'x' }))
const clean = o => JSON.parse(JSON.stringify(o))
const codeOf = f => { try { f(); return null } catch (e) { return e.code || e.message } }
const BASE = { 'Total Project Cost': 100e6, 'Debt %': 80, 'Equity %': 20, 'Annual Availability Payment': 12e6,
  'Concession Period': 25, 'Construction Period': 24, 'OPEX % of Revenue': 5, 'Interest Rate': 7, 'Loan Tenor': 10,
  'Grace Period': 2, 'Tax Rate': 21, 'WACC': 10, 'Target DSCR': 1.2, 'Construction Start Date': '2026-07-01' }
const MADABA_Q = { 'Total Project Cost': 50_788_939, 'Debt %': 84.899, 'Equity %': 15.101, 'Annual Availability Payment': 8_800_000,
  'Concession Period': 10, 'Construction Period': 36, 'OPEX Amount (JOD)': 54_020, 'OPEX Escalation %': 2.015,
  'Interest Rate': 8.25, 'Loan Tenor': 9.5, 'Grace Period': 0, 'Tax Rate': 0, 'WACC': 10, 'Target DSCR': 1.0,
  'Model Periodicity': 'Quarterly',
  'Construction Cost Profile': '6232.8,3008.4,6434.0,6443.8,3654.5,3554.5,3554.5,3554.5,3654.5,3554.5,3554.5,3588.4' }

// ═════════════════════════════════════════════════════════════════════════
// Independent reference: month records with real calendar dates
// ═════════════════════════════════════════════════════════════════════════
function refTax({ periods, M, cod, E, lag, rate, basis, life, N, writeOff }) {
  const nO = periods.length, months = []
  let depLeft = basis
  const perMonth = basis / (life * 12)
  for (let j = 0; j < nO * M; j++) {
    const k = Math.floor(j / M)
    let ty, payOffset
    if (cod) {
      const d = new Date(Date.UTC(cod.y, cod.m - 1 + j, 1))
      const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1
      ty = m > E ? y + 1 : y                                   // tax year named by the year it ends in
      const end = new Date(Date.UTC(ty, E - 1 + lag, 1))       // payment month
      payOffset = (end.getUTCFullYear() - cod.y) * 12 + (end.getUTCMonth() + 1 - cod.m)
    } else {
      ty = Math.floor(j / 12)
      payOffset = 12 * (ty + 1) - 1 + lag
    }
    const dep = Math.min(perMonth, depLeft); depLeft -= dep
    months.push({ k, ty, payOffset, ebitda: periods[k].ebitda / M, interest: periods[k].interest / M, dep })
  }
  const years = []
  for (const mo of months) {
    let y = years[years.length - 1]
    if (!y || y.ty !== mo.ty) years.push(y = { ty: mo.ty, months: 0, ti: 0, payPeriod: Math.min(nO - 1, Math.floor(mo.payOffset / M)), ebitda: 0, interest: 0, dep: 0 })
    y.months++; y.ti += mo.ebitda - mo.interest - mo.dep
    y.ebitda += mo.ebitda; y.interest += mo.interest; y.dep += mo.dep
  }
  if (writeOff) years[years.length - 1].ti -= Math.max(0, depLeft)
  const queue = [], paid = new Array(nO).fill(0)
  years.forEach((y, s) => {
    y.expired = 0
    for (const q of queue) if (q.amt > 0 && q.s + N < s) { y.expired += q.amt; q.amt = 0 }
    y.used = 0
    if (y.ti > 0) for (const q of queue) { const t = Math.min(q.amt, y.ti - y.used); q.amt -= t; y.used += t }
    else if (y.ti < 0) queue.push({ s, amt: -y.ti })
    y.taxable = Math.max(0, y.ti - y.used)
    y.tax = r2(rate * y.taxable)
    y.closing = queue.reduce((a, q) => a + q.amt, 0)
    paid[y.payPeriod] += y.tax
  })
  return { years, paid: paid.map(r2), undepreciated: Math.max(0, depLeft) }
}

const opsRows = out => (out.cash_flows_periodic || out.cash_flows).filter(r => r.phase === 'Operations')
function refFor(out, fx) {
  return refTax({ ...refArgs(out, fx), periods: opsRows(out).map(r => ({ ebitda: r.ebitda, interest: r.interest })) })
}
function expectMatchesReference(out, fx) {
  const ref = refFor(out, fx)
  expect(out.tax_schedule.length).toBe(ref.years.length)
  out.tax_schedule.forEach((s, i) => {
    const y = ref.years[i]
    expect(s.months).toBe(y.months)
    expect(s.payment_period).toBe(y.payPeriod)
    expect(Math.abs(s.taxable_income - y.ti)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(s.losses_used - y.used)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(s.losses_expired - y.expired)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(s.losses_closing - y.closing)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(s.tax_expense - y.tax)).toBeLessThanOrEqual(0.01)
  })
  opsRows(out).forEach((r, k) => expect(Math.abs(r.tax - ref.paid[k])).toBeLessThanOrEqual(0.01))
  return ref
}
const irrBisect = (cfs, p) => {
  const npv = r => cfs.reduce((s, c, t) => s + c / (1 + r) ** t, 0)
  let lo = -0.9, hi = 1
  for (let i = 0; i < 300; i++) { const m = (lo + hi) / 2; npv(m) > 0 ? lo = m : hi = m }
  return ((1 + lo) ** p - 1) * 100
}

// ═════════════════════════════════════════════════════════════════════════
describe('P-028 hand-worked examples (tax state directly)', () => {
  test('H1: 5 tax years — depreciation, loss carry-forward, oldest-first use and 2-year expiry', () => {
    // basis 1000 over 4 yrs → 250/yr in years 1–4, 0 in year 5; rate 20%; N = 2
    //   Y1: 100 − 200 − 250 = −350 → loss L1 = 350                tax 0
    //   Y2: 100 − 150 − 250 = −300 → loss L2 = 300 (pool 650)     tax 0
    //   Y3: 500 − 100 − 250 =  150 → use L1 150 (L1 200 left)     tax 0
    //   Y4: 500 −  50 − 250 =  200 → L1 expires (200); use L2 200 tax 0
    //   Y5: 500 −   0 −   0 =  500 → L2 expires (100)             tax 100
    const cal = buildTaxCalendar({ nO: 5, monthsPerPeriod: 12, codMonthIdx: null, yearEndMonth: 12, lagMonths: 0 })
    const st = createTaxState(cal, { rate: 0.2, basis: 1000, lifeYears: 4, carryForwardYears: 2, writeOff: false })
    const paid = [[100, 200], [100, 150], [500, 100], [500, 50], [500, 0]].map(([e, i], k) => st.step(k, e, i))
    const res = st.finish()
    expect(paid).toEqual([0, 0, 0, 0, 100])
    expect(res.schedule.map(s => [s.taxable_income, s.losses_arising, s.losses_used, s.losses_expired, s.losses_closing, s.tax_expense]))
      .toEqual([[-350, 350, 0, 0, 350, 0], [-300, 300, 0, 0, 650, 0], [150, 0, 150, 0, 500, 0],
                [200, 0, 200, 200, 100, 0], [500, 0, 0, 100, 0, 100]])
    expect(res.total_depreciation).toBe(1000)
  })

  test('H2: partial first and final tax years, 4-month lag, payment after the concession', () => {
    // COD 1 Jul 2028, annual periods (Jul–Jun), tax years = calendar years.
    // EBITDA 1200 per period, no interest or depreciation, rate 10%:
    //   FY2028 Jul–Dec (6 mo of period 0) 600  → tax 60,  paid Apr 2029 → period 0
    //   FY2029 Jan–Dec (6 + 6 mo)        1200 → tax 120, paid Apr 2030 → period 1
    //   FY2030 Jan–Jun (6 mo of period 1) 600  → tax 60,  due Apr 2031 → after the
    //   concession (ends Jun 2030) → paid in the final period
    const cal = buildTaxCalendar({ nO: 2, monthsPerPeriod: 12, codMonthIdx: 2028 * 12 + 6, yearEndMonth: 12, lagMonths: 4 })
    const st = createTaxState(cal, { rate: 0.1, basis: 0, lifeYears: 10, carryForwardYears: 5, writeOff: false })
    expect([st.step(0, 1200, 0), st.step(1, 1200, 0)]).toEqual([60, 180])
    const res = st.finish()
    expect(res.schedule.map(s => [s.tax_year, s.months, s.partial, s.tax_expense, s.payment_month, s.payment_period, s.payment_accelerated]))
      .toEqual([['FY2028', 6, true, 60, '2029-04', 0, false], ['FY2029', 12, false, 120, '2030-04', 1, false],
                ['FY2030', 6, true, 60, '2031-04', 1, true]])
    // Period tax expense: each year allocated by positive taxable income
    expect(res.periods.map(p => p.taxExpense)).toEqual([120, 120])
  })

  test('H3: no terminal deduction by default; write-off only when selected', () => {
    const cal = buildTaxCalendar({ nO: 2, monthsPerPeriod: 12, codMonthIdx: null, yearEndMonth: 12, lagMonths: 0 })
    const run = writeOff => { const st = createTaxState(cal, { rate: 0.2, basis: 1000, lifeYears: 4, carryForwardYears: 5, writeOff })
      st.step(0, 1000, 0); st.step(1, 1000, 0); return st.finish() }
    const no = run(false), yes = run(true)
    expect(no.undepreciated_at_end).toBe(500)                          // 2 of 4 years depreciated
    expect(no.schedule.map(s => s.tax_expense)).toEqual([150, 150])    // (1000 − 250) × 20%
    expect(yes.schedule.map(s => s.write_off)).toEqual([0, 500])
    expect(yes.schedule.map(s => s.tax_expense)).toEqual([150, 50])    // (1000 − 250 − 500) × 20%
  })
})

// ═════════════════════════════════════════════════════════════════════════
describe('P-028 calendar: no circularity, reconciliation across boundaries and lags', () => {
  test('C1: for every COD month, tax-year end, lag and periodicity — no year is paid before it ends; months add up', () => {
    let checked = 0
    for (const M of [12, 3]) for (let codM = 0; codM < 12; codM++) for (let E = 1; E <= 12; E++) for (const lag of [0, 1, 4, 11, 24]) {
      const nO = M === 12 ? 7 : 28
      const cal = buildTaxCalendar({ nO, monthsPerPeriod: M, codMonthIdx: 2030 * 12 + codM, yearEndMonth: E, lagMonths: lag })
      expect(cal.years.reduce((a, y) => a + y.months, 0)).toBe(nO * M)
      cal.years.forEach((y, i) => {
        expect(y.months).toBeLessThanOrEqual(12)
        expect(y.payPeriod).toBeGreaterThanOrEqual(y.lastPeriod)
        if (i > 0 && i < cal.years.length - 1) expect(y.months).toBe(12)  // only first / final may be partial
      })
      checked++
    }
    expect(checked).toBe(2 * 12 * 12 * 5)
  })

  test('C2: tax paid up to period k never depends on interest or cash flows after k', () => {
    const cal = buildTaxCalendar({ nO: 40, monthsPerPeriod: 3, codMonthIdx: 2029 * 12 + 1, yearEndMonth: 12, lagMonths: 4 })
    const mk = () => createTaxState(cal, { rate: 0.21, basis: 5e7, lifeYears: 10, carryForwardYears: 5, writeOff: false })
    for (const k of [3, 11, 20, 33]) {
      const a = mk(), b = mk(), pa = [], pb = []
      for (let t = 0; t < 40; t++) {
        pa.push(a.step(t, 2e6, 9e5))
        pb.push(b.step(t, t > k ? 7e6 : 2e6, t > k ? 1 : 9e5))        // different future
      }
      expect(pb.slice(0, k + 1)).toEqual(pa.slice(0, k + 1))
    }
  })

  test('C3: annual and quarterly engines reconcile with the reference across COD months, year ends and lags', () => {
    let n = 0
    for (const quarterly of [false, true]) for (const start of ['2026-01-01', '2026-04-01', '2026-07-01', '2026-11-01'])
      for (const E of [12, 6]) for (const lag of [0, 4, 11, 24]) {
        const fx = { ...BASE, 'Construction Start Date': start, 'Tax Year End Month': E, 'Tax Payment Lag (months)': lag,
          ...(quarterly ? { 'Model Periodicity': 'Quarterly' } : {}) }
        const out = runPPPEngine(rows(fx))
        expectMatchesReference(out, fx)
        const S = out.tax_schedule
        expect(S.reduce((a, s) => a + s.months, 0)).toBe(25 * 12)
        n++
      }
    expect(n).toBe(64)
  })
})

// ═════════════════════════════════════════════════════════════════════════
const CASES = {
  'annual, COD Jul (partial years)':          BASE,
  'annual, COD Jan':                           { ...BASE, 'Construction Start Date': '2026-01-01' },
  'quarterly, COD Apr':                        { ...BASE, 'Model Periodicity': 'Quarterly', 'Construction Start Date': '2026-04-01' },
  'Madaba quarterly at 21% (early losses)':    { ...MADABA_Q, 'Tax Rate': 21, 'Construction Start Date': '2026-01-01' },
  'losses expire (1-yr carry-forward)':        { ...MADABA_Q, 'Tax Rate': 21, 'Construction Start Date': '2026-01-01', 'Tax Loss Carry-Forward (years)': 1 },
  'life 10 yrs < concession':                  { ...BASE, 'Tax Depreciation Life (years)': 10 },
  'life 50 yrs > concession, no write-off':    { ...BASE, 'Tax Depreciation Life (years)': 50 },
  'life 50 yrs, write-off selected':           { ...BASE, 'Tax Depreciation Life (years)': 50, 'Terminal Tax Write-off': 'Yes' },
  'lag 0':                                     { ...BASE, 'Tax Payment Lag (months)': 0 },
  'lag 24 (payments after concession)':        { ...BASE, 'Tax Payment Lag (months)': 24 },
  'share 70%, IDC eligible 0%':                { ...BASE, 'Depreciable Share %': 70, 'Eligible IDC %': 0 },
  'no start date (fallback tax years)':        (({ 'Construction Start Date': _d, ...o }) => o)(BASE),
  'annuity, escalating revenue':               { ...BASE, 'Repayment Profile': 'Annuity', 'Availability Payment Escalation %': 2.5 },
  'equal principal, quarterly':                { ...BASE, 'Repayment Profile': 'Equal Principal', 'Model Periodicity': 'Quarterly' },
  'unlimited carry-forward':                   { ...MADABA_Q, 'Tax Rate': 21, 'Construction Start Date': '2026-01-01', 'Tax Loss Carry-Forward (years)': 'Unlimited' },
}

describe.each(Object.entries(CASES))('P-028 engine vs independent reference — %s', (label, fx) => {
  const out = runPPPEngine(rows(fx))
  const O = opsRows(out), P = out.periods_per_year

  test('R1: tax schedule and cash tax per period match the independent reference to the cent', () => {
    const ref = expectMatchesReference(out, fx)
    expect(Math.abs(out.tax_assumptions.undepreciated_at_end - ref.undepreciated)).toBeLessThanOrEqual(0.01)
    if (/expire/.test(label)) expect(out.tax_assumptions.losses_expired).toBeGreaterThan(0)
    if (/no write-off/.test(label)) expect(out.tax_schedule.every(s => s.write_off === 0)).toBe(true)
    if (/write-off selected/.test(label)) {
      expect(ref.undepreciated).toBeGreaterThan(0)
      expect(Math.abs(out.tax_schedule.at(-1).write_off - ref.undepreciated)).toBeLessThanOrEqual(0.01)
    }
    if (/share 70%/.test(label)) expect(out.tax_assumptions.levered_basis).toBe(70e6)
  })

  test('R2: identities — Σ paid = Σ expense; CFADS = EBITDA − cash tax (no depreciation); equity CF = CFADS − DS; DSCR', () => {
    const paid = O.reduce((a, r) => a + r.tax, 0), exp = out.tax_schedule.reduce((a, s) => a + s.tax_expense, 0)
    expect(Math.abs(paid - exp)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(O.reduce((a, r) => a + r.tax_expense, 0) - exp)).toBeLessThanOrEqual(0.01)
    O.forEach(r => {
      expect(r.tax).toBeGreaterThanOrEqual(0)
      const cfads = r2(r.ebitda - r.tax), ds = r2(r.interest + r.principal)
      expect(r.equity_cf).toBe(r2(cfads - ds))                          // exact to the cent
      if (r.interest + r.principal > 1) expect(Math.abs(r.dscr - cfads / ds)).toBeLessThanOrEqual(0.006)
      expect(Math.abs(r.pbt - (r.ebitda - r.interest - r.tax_depreciation))).toBeLessThanOrEqual(0.011)
      expect(Math.abs(r.net_income - (r.pbt - r.tax_expense))).toBeLessThanOrEqual(0.011)
    })
    out.tax_schedule.forEach(s => {
      expect(Math.abs(s.losses_closing - (s.losses_opening - s.losses_expired - s.losses_used + s.losses_arising))).toBeLessThanOrEqual(0.03)
      expect(Math.abs(s.tax_expense - r2(out.tax_assumptions.tax_rate * s.taxable_after_losses))).toBeLessThanOrEqual(0.011)
    })
    expect(out.tax_assumptions.total_depreciation).toBeLessThanOrEqual(out.tax_assumptions.levered_basis + 0.01)
    expect(out.integrity.tax.passed).toBe(true)
    if (P > 1) {                                                        // quarterly annual rows reconcile
      ;['tax', 'tax_expense', 'tax_depreciation', 'equity_cf'].forEach(f => {
        const q = O.reduce((a, r) => a + r[f], 0), a = out.cash_flows.filter(r => r.phase === 'Operations').reduce((s, r) => s + r[f], 0)
        expect(Math.abs(q - a)).toBeLessThanOrEqual(0.01 * O.length)
      })
    }
  })

  test('R3: independent re-simulation of operations (interest, principal, cash tax) reproduces the schedule', () => {
    const r = fx['Interest Rate'] / 100 / P, target = fx['Target DSCR']
    const grace = Math.round(fx['Grace Period'] * P), repay = Math.round(fx['Loan Tenor'] * P) - grace
    const profile = (fx['Repayment Profile'] || 'Sculpted').toLowerCase().replace(/\s+/g, '_')
    const sched = (out.debt_schedule_periodic || out.debt_schedule).filter(s => s.phase === 'Operations')
    const known = O.map(x => ({ ebitda: x.ebitda, interest: 0 }))
    let bal = out.debt_amount, level = 0, ep = 0, maxErr = 0
    O.forEach((row, i) => {
      const op = i + 1
      if (op === grace + 1) { level = r === 0 ? bal / repay : bal * r * (1 + r) ** repay / ((1 + r) ** repay - 1); ep = bal / repay }
      const interest = bal > 0.01 ? r2(bal * r) : 0
      known[i].interest = interest
      const taxPaid = refTax({ ...refArgs(out, fx), periods: known }).paid[i]   // depends only on periods ≤ i
      let principal = 0
      if (op > grace && op <= grace + repay && bal > 0.01) {
        const last = op === grace + repay
        if (profile === 'annuity') principal = last ? bal : Math.min(bal, Math.max(0, level - interest))
        else if (profile === 'equal_principal') principal = last ? bal : Math.min(bal, ep)
        else principal = Math.min(bal, Math.max(0, (row.ebitda - taxPaid) / target - interest))
        principal = r2(principal)
      }
      maxErr = Math.max(maxErr, Math.abs(row.interest - interest), Math.abs(row.principal - principal), Math.abs(row.tax - taxPaid),
        Math.abs(sched[i].opening - bal))
      bal = r2(Math.max(0, bal - principal))
    })
    expect(maxErr).toBeLessThanOrEqual(0.011)
  })

  test('R4: Project IRR from an independent unlevered tax run (no interest, basis share × TPC)', () => {
    const rowsP = out.cash_flows_periodic || out.cash_flows
    const unlev = refTax({ ...refArgs(out, fx), periods: O.map(x => ({ ebitda: x.ebitda, interest: 0 })),
      basis: (fx['Depreciable Share %'] ?? 100) / 100 * fx['Total Project Cost'] })
    const cfs = rowsP.map((x, i) => (x.phase === 'Construction' ? -x.capex : x.ebitda - unlev.paid[i - out.construction_periods]))
    expect(Math.abs(out.project_irr - irrBisect(cfs, P))).toBeLessThanOrEqual(0.011)
    expect(out.project_tax_schedule.length).toBe(out.tax_schedule.length)
  })

  test('R5: Equity IRR and NPV recomputed from the actual equity cash flows', () => {
    const cfs = (out.cash_flows_periodic || out.cash_flows).map(x => x.equity_cf)
    if (out.irr !== null) expect(Math.abs(out.irr - irrBisect(cfs, P))).toBeLessThanOrEqual(0.011)
    const w = P === 1 ? fx.WACC / 100 : (1 + fx.WACC / 100) ** (1 / P) - 1
    expect(Math.abs(out.npv - cfs.reduce((s, c, t) => s + c / (1 + w) ** t, 0))).toBeLessThanOrEqual(0.02)
  })
})

function refArgs(out, fx) {
  const M = 12 / out.periods_per_year, sd = fx['Construction Start Date']
  let cod = null
  if (sd) { const [y, m] = sd.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + out.construction_periods * M, 1)); cod = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 } }
  return { M, cod, E: fx['Tax Year End Month'] ?? 12, lag: fx['Tax Payment Lag (months)'] ?? 4, rate: fx['Tax Rate'] / 100,
    basis: (fx['Depreciable Share %'] ?? 100) / 100 * (fx['Total Project Cost'] + (fx['Eligible IDC %'] ?? 100) / 100 * out.idc_capitalized),
    life: fx['Tax Depreciation Life (years)'] ?? fx['Concession Period'],
    N: fx['Tax Loss Carry-Forward (years)'] === 'Unlimited' ? Infinity : (fx['Tax Loss Carry-Forward (years)'] ?? 5),
    writeOff: fx['Terminal Tax Write-off'] === 'Yes' }
}

// ═════════════════════════════════════════════════════════════════════════
describe('P-028 debt sizing — validated across the debt range, IDC convergence', () => {
  // Independent feasibility (sculpted): CFADS from the reference tax with
  // the engine's final depreciation basis; feasible when the debt repays in
  // the tenor with DSCR ≥ target every period (grace: interest covered).
  function feasibleRef(D, out, fx) {
    const P = out.periods_per_year, r = fx['Interest Rate'] / 100 / P, target = fx['Target DSCR']
    const grace = Math.round(fx['Grace Period'] * P), repay = Math.round(fx['Loan Tenor'] * P) - grace
    const O = opsRows(out), known = O.map(x => ({ ebitda: x.ebitda, interest: 0 }))
    let bal = D
    for (let t = 0; t < grace + repay; t++) {
      if (bal <= 1e-9) return true
      const interest = bal * r
      known[t].interest = interest
      const cfads = O[t].ebitda - refTax({ ...refArgs(out, fx), periods: known }).paid[t]
      if (t < grace) { if (interest > cfads / target + 1e-6) return false; continue }
      const principal = cfads / target - interest
      if (principal < -1e-6) return false
      bal -= Math.min(Math.max(0, principal), bal)
    }
    return bal <= 0.5
  }

  test.each([['annual DSCR-bound', BASE], ['quarterly DSCR-bound', { ...BASE, 'Model Periodicity': 'Quarterly' }]])(
    'D1 %s: the solved maximum is feasible, +0.1% is not, and feasibility over a 0–150% grid is a single interval', (_l, fx) => {
      const out = runPPPEngine(rows(fx))
      expect(out.debt_sizing.binding_constraint).toBe('dscr')
      expect(out.debt_sizing.tax_converged).toBe(true)
      expect(out.debt_sizing.tax_iterations).toBeLessThanOrEqual(50)
      expect(out.debt_sizing.debt_range_scan_points).toBe(64)
      const S = out.debt_sizing.supportable_debt
      expect(feasibleRef(S * 0.999, out, fx)).toBe(true)
      expect(feasibleRef(S * 1.001, out, fx)).toBe(false)
      const grid = Array.from({ length: 31 }, (_, i) => S * i * 0.05)
      const f = grid.map(D => feasibleRef(D, out, fx))
      const firstInfeasible = f.indexOf(false)
      expect(firstInfeasible).toBeGreaterThan(0)
      expect(f.slice(firstInfeasible).every(x => x === false)).toBe(true)   // nothing feasible above an infeasible debt
      // sculpted DSCR sits at the target in every full repayment period
      opsRows(out).forEach(r => { if (r.principal > 1 && r.interest + r.principal > 1) expect(r.dscr).toBeGreaterThanOrEqual(fx['Target DSCR'] - 0.011) })
    })

  test('D2: IDC fixed point — the depreciation basis uses the converged IDC', () => {
    const out = runPPPEngine(rows(BASE))
    expect(out.tax_assumptions.levered_basis).toBe(r2(BASE['Total Project Cost'] + out.idc_capitalized))
    expect(Math.abs(out.debt_sizing.idc_capitalized - out.idc_capitalized)).toBeLessThan(0.01)
  })

  test('D3: a non-monotone feasibility region is refused (blocking DEBT_SIZING_UNRESOLVED), never returned', () => {
    // Synthetic tax state that refunds a large amount once interest is high —
    // makes a larger debt (inside the search range) feasible after a smaller
    // one is not. (Real tax states never refund; this proves the guard.)
    const weird = () => ({ step: (t, e, interest) => (interest > 4.5e5 ? -5e6 : 0) })
    const ebitda = Array.from({ length: 10 }, () => 1e6)
    expect(codeOf(() => solveSupportableDebtTax(ebitda, weird, 1.2, 0.07, 0, 10, 'sculpted'))).toBe('DEBT_SIZING_UNRESOLVED')
    // A well-behaved tax state is accepted and validated
    const flat = () => ({ step: () => 0 })
    const ok = solveSupportableDebtTax(ebitda, flat, 1.2, 0.07, 0, 10, 'sculpted')
    expect(ok.debt).toBeGreaterThan(0)
    expect(ok.scan_points).toBe(64)
  })

  test('D4: depreciation effect before and after resizing — tested on the actual cash flows, no assumed direction', () => {
    // Gearing-bound (debt fixed by Debt %): more depreciable share never increases tax.
    const geared = s => runPPPEngine(rows({ ...BASE, 'Debt %': 30, 'Equity %': 70, 'Depreciable Share %': s }))
    const taxes = [0, 25, 50, 75, 100].map(s => { const o = geared(s); expect(o.debt_sizing.binding_constraint).toBe('gearing'); return opsRows(o).reduce((a, r) => a + r.tax, 0) })
    for (let i = 1; i < taxes.length; i++) expect(taxes[i]).toBeLessThanOrEqual(taxes[i - 1] + 0.01)
    // DSCR-bound (debt resized): the Equity IRR is whatever the cash flows give —
    // verified against an independent IRR, not assumed to rise.
    ;[0, 50, 100].forEach(s => {
      const o = runPPPEngine(rows({ ...BASE, 'Depreciable Share %': s }))
      const cfs = o.cash_flows.map(r => r.equity_cf)
      expect(Math.abs(o.irr - irrBisect(cfs, 1))).toBeLessThanOrEqual(0.011)
    })
  })

  test('D5: no debt → Project IRR equals Equity IRR (identity holds under P-028)', () => {
    ;[{}, { 'Model Periodicity': 'Quarterly' }].forEach(o => {
      const out = runPPPEngine(rows({ ...BASE, ...o, 'Debt %': 0, 'Equity %': 100 }))
      expect(out.debt_amount).toBe(0)
      expect(out.project_irr).toBe(out.irr)
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════
describe('P-028 regression — 0% tax and Tax Depreciation = None are bit-identical to engine v2.0.0', () => {
  const strip = o => { const c = clean(o); delete c.engine_version; return c }
  const variants = []
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const pick = a => a[Math.floor(rnd() * a.length)]
  for (let i = 0; i < 40; i++) {
    const conc = pick([10, 15, 25])
    variants.push({ ...BASE, 'Concession Period': conc, 'Loan Tenor': Math.min(pick([8, 10]), conc), 'Grace Period': pick([0, 1, 2]),
      'Construction Period': pick([12, 24, 30, 36]), 'Interest Rate': +(4 + rnd() * 6).toFixed(2),
      'Availability Payment Escalation %': +(rnd() * 4).toFixed(2), 'Repayment Profile': pick(['Sculpted', 'Annuity', 'Equal Principal']),
      ...(rnd() < 0.5 ? { 'Model Periodicity': 'Quarterly' } : {}) })
  }
  test('G1: Madaba quarterly benchmark (0% tax) — every output identical', () => {
    expect(exactDiff(strip(V200.runPPPEngine(rows(MADABA_Q))), strip(runPPPEngine(rows(MADABA_Q)))).differences).toEqual([])
  })
  test('G2: 40 randomized scenarios at 0% tax — identical', () => {
    variants.forEach(v => {
      const fx = { ...v, 'Tax Rate': 0 }
      expect(exactDiff(strip(V200.runPPPEngine(rows(fx))), strip(runPPPEngine(rows(fx)))).differences).toEqual([])
    })
  })
  test('G3: 40 randomized taxable scenarios with Tax Depreciation = None — identical to v2.0.0', () => {
    variants.forEach(v => {
      const fx = { ...v, 'Tax Depreciation': 'None' }
      expect(exactDiff(strip(V200.runPPPEngine(rows(fx))), strip(runPPPEngine(rows(fx)))).differences).toEqual([])
    })
  })
  test('G4: the default for taxable projects is P-028 (results differ from v2.0.0 only through tax)', () => {
    const a = V200.runPPPEngine(rows(BASE)), b = runPPPEngine(rows(BASE))
    expect(b.tax_assumptions.method).toBe('straight_line')
    expect(b.cash_flows.map(r => [r.revenue, r.opex, r.ebitda])).toEqual(a.cash_flows.map(r => [r.revenue, r.opex, r.ebitda]))
    expect(b.warnings.map(w => w.code)).not.toContain('TAX_DEPRECIATION_NOT_MODELLED')
    expect(a.warnings.map(w => w.code)).toContain('TAX_DEPRECIATION_NOT_MODELLED')
  })
})

// ═════════════════════════════════════════════════════════════════════════
describe('P-028 disclosures and validation', () => {
  const codes = o => runPPPEngine(rows(o)).warnings.map(w => w.code)
  test('W1: every taxable P-028 result discloses unconfirmed assumptions, the assumed rate, life and allocation estimate', () => {
    const c = codes(BASE)
    ;['TAX_ASSUMPTIONS_UNCONFIRMED', 'TAX_RATE_ASSUMED', 'TAX_DEPRECIATION_LIFE_PRELIMINARY', 'TAX_BASIS_SHARE_ASSUMED',
      'TAX_LOSS_CLOCK_SIMPLIFIED', 'TAX_EXPENSE_ALLOCATION_ESTIMATE'].forEach(k => expect(c).toContain(k))
    expect(runPPPEngine(rows(BASE)).warnings.find(w => w.code === 'TAX_ASSUMPTIONS_UNCONFIRMED').message).toMatch(/not confirmed Jordanian/)
    expect(runPPPEngine(rows({ ...BASE, 'Model Periodicity': 'Quarterly' })).warnings
      .find(w => w.code === 'TAX_EXPENSE_ALLOCATION_ESTIMATE').message).toMatch(/quarterly allocation.*not an accounting-standard tax provision/)
    expect(codes({ ...BASE, 'Depreciable Share %': 90 })).not.toContain('TAX_BASIS_SHARE_ASSUMED')
    expect(codes({ ...BASE, 'Tax Rate': 0 }).filter(k => k.startsWith('TAX_'))).toEqual([])
  })
  test('W2: condition-specific disclosures', () => {
    expect(codes({ ...BASE, 'Tax Depreciation Life (years)': 50 })).toContain('TAX_UNDEPRECIATED_AT_HANDBACK')
    expect(codes({ ...BASE, 'Tax Depreciation Life (years)': 50, 'Terminal Tax Write-off': 'Yes' })).toContain('TAX_WRITE_OFF_SELECTED')
    expect(codes(CASES['losses expire (1-yr carry-forward)'])).toContain('TAX_LOSSES_EXPIRED')
    expect(codes(CASES['no start date (fallback tax years)'])).toContain('TAX_YEAR_FALLBACK')
    expect(codes({ ...BASE, 'Tax Payment Lag (months)': 24 })).toContain('TAX_PAYMENT_AFTER_CONCESSION')
    expect(runPPPEngine(rows(BASE)).tax_assumptions.confirmed).toBe(false)
  })
  test('V1: blocking validation of the tax inputs', () => {
    const run = o => codeOf(() => runPPPEngine(rows({ ...BASE, ...o })))
    expect(run({ 'Tax Depreciation': 'Declining' })).toBe('TAX_METHOD_INVALID')
    expect(run({ 'Tax Depreciation Life (years)': 0 })).toBe('TAX_DEPRECIATION_LIFE_INVALID')
    expect(run({ 'Depreciable Share %': 120 })).toBe('DEPRECIABLE_SHARE_INVALID')
    expect(run({ 'Eligible IDC %': -1 })).toBe('IDC_ELIGIBLE_SHARE_INVALID')
    expect(run({ 'Tax Loss Carry-Forward (years)': 2.5 })).toBe('LOSS_CARRY_FORWARD_INVALID')
    expect(run({ 'Terminal Tax Write-off': 'Maybe' })).toBe('TAX_WRITE_OFF_INVALID')
    expect(run({ 'Tax Year End Month': 13 })).toBe('TAX_YEAR_END_INVALID')
    expect(run({ 'Tax Payment Lag (months)': 30 })).toBe('TAX_PAYMENT_LAG_INVALID')
    expect(run({ 'Construction Start Date': '2026-02-30' })).toBe('CONSTRUCTION_START_DATE_INVALID')
    // exempt projects do not validate unused tax rows
    expect(run({ 'Tax Rate': 0, 'Tax Depreciation Life (years)': 0 })).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════
describe('P-028 approved results — currency and persistence (PGlite, real jsonb)', () => {
  const VERS = { engineVersion: PPP_ENGINE_VERSION, compatibleVersions: PPP_ENGINE_COMPATIBLE_VERSIONS }
  async function storeWith(engine, version, fx) {
    const pg = await createTestDb(), db = supabaseLike(pg)
    await applyP022Migration(pg)
    const v = (await pg.query("insert into versions (label, status) values ('v1.0 Draft', 'draft') returning *")).rows[0]
    await savePPPApproval(db, { output: engine.runPPPEngine(rows(fx)), assumptions: rows(fx), engineVersion: version,
      versionId: v.version_id, projectId: null, tenantId: null, userId: null, approvedLabel: 'v1.0 Approved' })
    return { pg, db, v }
  }
  test('P1: a 2.0.0 zero-tax approval stays current only by DEMONSTRATED exact reproduction; nothing stored changes', async () => {
    const fx = { ...BASE, 'Tax Rate': 0 }
    const { pg, db, v } = await storeWith(V200, '2.0.0', fx)
    const before = clean((await pg.query('select * from model_outputs')).rows)
    const shown = await loadLatestModelOutput(db, v.version_id)
    const cur = assessResultCurrency(shown, { ...VERS, assumptions: rows(fx), rerun: runPPPEngine })
    expect(cur).toMatchObject({ status: 'current', compatibility: 'demonstrated', engine_version: '2.0.0' })
    expect(assessResultCurrency(shown, { ...VERS, assumptions: rows(fx) }).status).toBe('stale_engine')   // without proof: not current
    expect(pppResultBasis(shown, VERS)).toBe('Saved result, engine v2.0.0 (results identical under v' + PPP_ENGINE_VERSION + ') · annual model')
    expect(exactDiff(before, clean((await pg.query('select * from model_outputs')).rows)).differences).toEqual([])
    await pg.close()
  })
  test('P2: a 2.0.0 TAXABLE approval is outdated; a tampered zero-tax record is not current', async () => {
    const t = await storeWith(V200, '2.0.0', BASE)
    const shownT = await loadLatestModelOutput(t.db, t.v.version_id)
    expect(assessResultCurrency(shownT, { ...VERS, assumptions: rows(BASE), rerun: runPPPEngine }).status).toBe('stale_engine')
    await t.pg.close()
    const fx = { ...BASE, 'Tax Rate': 0 }
    const z = await storeWith(V200, '2.0.0', fx)
    await z.pg.exec("update model_outputs set result_payload = jsonb_set(result_payload, '{debt_amount}', to_jsonb((result_payload->>'debt_amount')::numeric + 0.01))")
    const shownZ = await loadLatestModelOutput(z.db, z.v.version_id)
    expect(assessResultCurrency(shownZ, { ...VERS, assumptions: rows(fx), rerun: runPPPEngine }).status).toBe('stale_engine')
    await z.pg.close()
  })
  test('P3: a P-028 result round-trips through jsonb exactly, including the tax schedules', async () => {
    const { pg, db, v } = await storeWith({ runPPPEngine }, PPP_ENGINE_VERSION, { ...BASE, 'Model Periodicity': 'Quarterly' })
    const shown = await loadLatestModelOutput(db, v.version_id)
    const { _persistence, ...financial } = shown
    expect(_persistence.engine_version).toBe(PPP_ENGINE_VERSION)
    expect(exactDiff(clean(runPPPEngine(rows({ ...BASE, 'Model Periodicity': 'Quarterly' }))), financial).differences).toEqual([])
    expect(financial.tax_schedule.length).toBeGreaterThan(0)
    await pg.close()
  })
})
