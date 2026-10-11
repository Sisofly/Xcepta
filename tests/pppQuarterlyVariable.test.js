/**
 * pppQuarterlyVariable.test.js — P-016 quarterly modelling and Phase 3
 * variable-CFADS validation. Expectations come from closed-form formulas,
 * independent re-simulation, or identities — never from engine read-back.
 */
import { runPPPEngine, npvCalc } from '../src/modules/feasibility/annualEngine.js'

const A = obj => Object.entries(obj).map(([name, value]) =>
  (typeof value === 'string' ? { name, value: null, unit: value } : { name, value }))
const BASE = {
  'Total Project Cost': 100_000_000, 'Debt %': 80, 'Equity %': 20,
  'Annual Availability Payment': 12_000_000, 'Concession Period': 25,
  'Construction Period': 24, 'OPEX % of Revenue': 5, 'Interest Rate': 7,
  'Loan Tenor': 10, 'Grace Period': 2, 'Tax Rate': 20, 'WACC': 10,
}
const Q = { 'Model Periodicity': 'Quarterly' }
const run = o => runPPPEngine(A({ ...BASE, ...o }))
// P-028: tests marked LEGACY_TAX verify the 2.0.0 tax method (tax on EBITDA −
// interest, no depreciation or loss relief), now selected explicitly with Tax
// Depreciation = None. Their assertions and expected values are unchanged; the
// default P-028 method is covered independently in tests/pppTax.test.js.
const LEGACY_TAX = { 'Tax Depreciation': 'None' }
const sum = (rows, k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0)
const tolN = n => Math.max(1, 0.01 * n)
const codeOf = fn => { try { fn(); return null } catch (e) { return e.code } }

// Independent re-check of every operating period's debt rule, using only
// the documented conventions (not engine helpers). Each period is anchored on
// that period's reported opening balance (continuity of the balances is
// proven separately in Q3/I6), so 2-dp rounding of the COD balance cannot
// drift through the check: interest = opening × r/p; principal per profile.
function resimulateOps(out, fx) {
  const p = out.periods_per_year
  const rows = (out.cash_flows_periodic || out.cash_flows).filter(r => r.phase === 'Operations')
  const sched = (out.debt_schedule_periodic || out.debt_schedule).filter(r => r.phase === 'Operations')
  const r = fx['Interest Rate'] / 100 / p, tax = (fx['Tax Rate'] ?? 20) / 100, target = fx['Target DSCR'] ?? 1.2
  const grace = Math.round(fx['Grace Period'] * p), repay = Math.round(fx['Loan Tenor'] * p) - grace
  const profile = (fx['Repayment Profile'] || 'Sculpted').toLowerCase().replace(/\s+/g, '_')
  let level = 0, ep = 0, maxErr = 0
  rows.forEach((row, i) => {
    const op = i + 1, bal = sched[i].opening
    if (op === grace + 1) { level = r === 0 ? bal / repay : bal * r * (1 + r) ** repay / ((1 + r) ** repay - 1); ep = bal / repay }
    const interest = bal > 0.01 ? Math.round(bal * r * 100) / 100 : 0
    let principal = 0
    if (op > grace && op <= grace + repay && bal > 0.01) {
      const last = op === grace + repay
      if (profile === 'annuity') principal = last ? bal : Math.min(bal, Math.max(0, level - interest))
      else if (profile === 'equal_principal') principal = last ? bal : Math.min(bal, ep)
      else {
        const cfads = row.ebitda - Math.max(0, (row.ebitda - interest) * tax)
        principal = Math.min(bal, Math.max(0, cfads / target - interest))
      }
      principal = Math.round(principal * 100) / 100
    }
    maxErr = Math.max(maxErr, Math.abs(row.interest - interest), Math.abs(row.principal - principal))
  })
  return maxErr
}

// ═════════════════════════════════════════════════════════════════════════
// P-016 — quarterly identities, aggregation and conversions
// ═════════════════════════════════════════════════════════════════════════
const QFIX = {
  'quarterly base':               { ...BASE, ...Q },
  'quarterly no grace':           { ...BASE, ...Q, 'Grace Period': 0 },
  'quarterly 30-month build':     { ...BASE, ...Q, 'Construction Period': 30 },
  'quarterly 9.5-yr tenor':       { ...BASE, ...Q, 'Loan Tenor': 9.5, 'Grace Period': 0.75 },
  'quarterly gearing-bound':      { ...BASE, ...Q, 'Debt %': 40, 'Equity %': 60 },
  'quarterly seasonal revenue':   { ...BASE, ...Q, 'Quarterly Revenue Weights': '40,20,20,20' },
  'quarterly escalating + fixed': { ...BASE, ...Q, 'Availability Payment Escalation %': 2.5, 'OPEX Amount (JOD)': 900_000, 'OPEX Escalation %': 4 },
  'quarterly annuity':            { ...BASE, ...Q, 'Repayment Profile': 'Annuity' },
  // Madaba inputs traced from the Etihad workbook (FINDINGS §9/§11): its own
  // quarterly construction-cost timing (k JOD per quarter) and SPV opex.
  'madaba quarterly (benchmark timing)': {
    ...Q, 'Total Project Cost': 50_788_939, 'Debt %': 84.899, 'Equity %': 15.101,
    'Annual Availability Payment': 8_800_000, 'Concession Period': 10, 'Construction Period': 36,
    'Construction Cost Profile': '6232.8,3008.4,6434.0,6443.8,3654.5,3554.5,3554.5,3554.5,3654.5,3554.5,3554.5,3588.4',
    'OPEX Amount (JOD)': 54_020, 'OPEX Escalation %': 2.015, 'Interest Rate': 8.25, 'Loan Tenor': 9.5,
    'Grace Period': 0, 'Tax Rate': 0, 'WACC': 10, 'Target DSCR': 1.0 },
}

describe.each(Object.entries(QFIX))('P-016 quarterly identities — %s', (_l, fx) => {
  const out = runPPPEngine(A(fx))
  const P = out.cash_flows_periodic, S = out.debt_schedule_periodic
  const C = P.filter(r => r.phase === 'Construction'), O = P.filter(r => r.phase === 'Operations')
  const rq = fx['Interest Rate'] / 100 / 4

  test('Q1: structure — periods, labels, annual rows', () => {
    expect(out.periodicity).toBe('quarterly')
    expect(out.periods_per_year).toBe(4)
    expect(C.length).toBe(Math.ceil(fx['Construction Period'] / 3))
    expect(O.length).toBe(fx['Concession Period'] * 4)
    expect(out.cash_flows.length).toBe(Math.ceil(C.length / 4) + fx['Concession Period'])
  })

  test('Q2: funding — sources = uses, equity first, IDC = r/4 × (opening + ½ draw)', () => {
    expect(Math.abs(sum(C, 'equity_draw') + sum(C, 'debt_draw') + sum(C, 'idc') - (fx['Total Project Cost'] + out.idc_capitalized))).toBeLessThanOrEqual(tolN(C.length))
    let open = 0, eqLeft = out.equity_amount
    C.forEach(r => {
      if (eqLeft - r.equity_draw > 1) expect(r.debt_draw).toBeLessThanOrEqual(1)
      eqLeft -= r.equity_draw
      expect(Math.abs(r.idc - rq * (open + 0.5 * r.debt_draw))).toBeLessThanOrEqual(1)
      open += r.debt_draw + r.idc
    })
    expect(Math.abs(open - out.debt_amount)).toBeLessThanOrEqual(tolN(C.length))
  })

  test('Q3: debt roll-forward, COD handoff, quarterly interest on opening balance, full repayment', () => {
    const out = runPPPEngine(A({ ...fx, ...LEGACY_TAX }))
    const P = out.cash_flows_periodic, S = out.debt_schedule_periodic
    const C = P.filter(r => r.phase === 'Construction'), O = P.filter(r => r.phase === 'Operations')
    S.forEach((s, i) => {
      expect(Math.abs(s.closing - (s.opening + s.draw + s.idc - s.principal))).toBeLessThanOrEqual(1)
      if (i > 0) expect(Math.abs(s.opening - S[i - 1].closing)).toBeLessThanOrEqual(1)
    })
    expect(Math.abs(S[C.length].opening - out.debt_amount)).toBeLessThanOrEqual(1)
    expect(Math.abs(sum(O, 'principal') - out.debt_amount)).toBeLessThanOrEqual(2)
    expect(Math.abs(S[S.length - 1].closing)).toBeLessThanOrEqual(2)
    expect(resimulateOps(out, fx)).toBeLessThanOrEqual(0.011)
  })

  test('Q4: DSCR target maintained in every quarter of repayment (where debt is DSCR-sized)', () => {
    const tgt = out.debt_sizing.target_dscr
    O.forEach(r => {
      const ds = r.interest + r.principal
      if (ds > 1) expect(r.dscr).toBeGreaterThanOrEqual(tgt - 0.01)
    })
  })

  test('Q5: annual rows aggregate quarters — flows summed, balances as stocks, DSCR = ΣCFADS/ΣDS', () => {
    const nCY = Math.ceil(C.length / 4)
    out.cash_flows.forEach((row, k) => {
      const a = row.phase === 'Construction' ? k * 4 : C.length + (k - nCY) * 4
      const qs = P.slice(a, a + row.periods)
      ;['revenue', 'opex', 'ebitda', 'interest', 'tax', 'principal', 'capex', 'equity_draw', 'debt_draw', 'idc', 'equity_cf']
        .forEach(f => expect(Math.abs(row[f] - sum(qs, f))).toBeLessThanOrEqual(0.011))
      const ds = sum(qs, 'interest') + sum(qs, 'principal')
      if (row.phase === 'Operations' && ds > 1) {
        expect(Math.abs(row.dscr - (sum(qs, 'ebitda') - sum(qs, 'tax')) / ds)).toBeLessThanOrEqual(0.006)
      }
      const sc = out.debt_schedule[k]
      expect(sc.opening).toBe(S[a].opening)
      expect(sc.closing).toBe(S[a + row.periods - 1].closing)
    })
  })

  test('Q6: returns — periodic NPV at (1+WACC)^(1/4)−1; annualised IRR zeroes the quarterly NPV', () => {
    const cfs = P.map(r => r.equity_cf)
    expect(Math.abs(out.npv - npvCalc((1 + fx.WACC / 100) ** 0.25 - 1, cfs))).toBeLessThanOrEqual(1)
    // IRR is reported to 2 dp of a percent: the quarterly NPV must change
    // sign within ±0.005 pp of the reported annual IRR.
    const npvAt = annualPct => npvCalc((1 + annualPct / 100) ** 0.25 - 1, cfs)
    expect(npvAt(out.irr - 0.005) * npvAt(out.irr + 0.005)).toBeLessThanOrEqual(0)
    const inflow = cfs.filter(c => c > 0).reduce((a, b) => a + b, 0), outflow = -cfs.filter(c => c < 0).reduce((a, b) => a + b, 0)
    expect(Math.abs(out.equity_multiple - inflow / outflow)).toBeLessThanOrEqual(0.01)
  })
})

describe('P-016 — annual vs quarterly consistency', () => {
  test('X1: with zero interest and tax, DSCR capacity is periodicity-invariant (Σ CFADS / target)', () => {
    const z = { 'Interest Rate': 0, 'Tax Rate': 0, 'Construction Interest Rate': 0 }
    const a = run(z), q = run({ ...z, ...Q })
    const expected = 12_000_000 * 0.95 * 8 / 1.2       // 8 repayment years of EBITDA at 1.20×
    expect(Math.abs(a.debt_sizing.supportable_debt - expected)).toBeLessThanOrEqual(1)
    expect(Math.abs(q.debt_sizing.supportable_debt - expected)).toBeLessThanOrEqual(1)
    expect(Math.abs(q.equity_amount - a.equity_amount)).toBeLessThanOrEqual(2)
  })

  test('X2: totals are periodicity-invariant — revenue, opex, capex', () => {
    const a = run({}), q = run(Q)
    ;['revenue', 'opex', 'capex'].forEach(k => expect(Math.abs(sum(a.cash_flows, k) - sum(q.cash_flows, k))).toBeLessThanOrEqual(5))
    expect(sum(q.cash_flows, 'revenue')).toBeCloseTo(12_000_000 * 25, 0)
  })

  test('X3: with interest, quarterly sculpting supports more debt (earlier cash) and IDC accrues per quarter', () => {
    const a = run({}), q = run(Q)
    expect(q.debt_sizing.supportable_debt).toBeGreaterThan(a.debt_sizing.supportable_debt)
    // Quarterly rate r/4 on a ½-period draw vs annual r on a ½-year draw: both accrue on drawn balances.
    expect(q.idc_capitalized).toBeGreaterThan(0)
    expect(q.debt_sizing.min_dscr).toBeCloseTo(1.2, 2)
    expect(q.debt_sizing.dscr_basis).toBe('quarterly')
  })

  test('X4: quarter-year terms are accepted quarterly and blocked annually', () => {
    expect(codeOf(() => run({ 'Loan Tenor': 9.5 }))).toBe('PERIOD_NOT_WHOLE_YEARS')
    expect(codeOf(() => run({ ...Q, 'Loan Tenor': 9.5 }))).toBeNull()
    expect(codeOf(() => run({ ...Q, 'Loan Tenor': 9.6 }))).toBe('PERIOD_NOT_WHOLE_QUARTERS')
    expect(codeOf(() => run({ ...Q, 'Concession Period': 8, 'Loan Tenor': 9 }))).toBe('LOAN_MATURITY_EXCEEDS_CONCESSION')
  })

  test('X5: seasonal weights keep annual revenue at the contractual AP and size debt per quarter', () => {
    const q = run({ ...Q, 'Quarterly Revenue Weights': '40,20,20,20', ...LEGACY_TAX })
    q.cash_flows.filter(r => r.phase === 'Operations').forEach(r => expect(r.revenue).toBeCloseTo(12_000_000, 0))
    const o = q.cash_flows_periodic.filter(r => r.phase === 'Operations')
    expect(o[0].revenue).toBeCloseTo(4_800_000, 0)
    expect(q.debt_sizing.sizing_method).toBe('per_period_sculpted')
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Phase 3 — variable CFADS: closed-form benchmarks
// ═════════════════════════════════════════════════════════════════════════
describe('Phase 3 — closed-form debt capacity (independent benchmark)', () => {
  // Zero tax, sculpted, no grace, EBITDA_t = E (1+g)^(t-1): capacity is the
  // PV at the loan rate of the sculpted debt service CFADS_t / target:
  //   D = (E / target) × [1 − ((1+g)/(1+r))^n] / (r − g)
  const pvGrowing = (E, g, r, n, target) => (E / target) * (1 - ((1 + g) / (1 + r)) ** n) / (r - g)

  test.each([
    ['2% escalation, 8% rate, 15 yrs, 1.30×',  0.02, 8, 15, 1.30],
    ['5% escalation, 6% rate, 10 yrs, 1.20×',  0.05, 6, 10, 1.20],
    ['-3% (declining), 9% rate, 12 yrs, 1.40×', -0.03, 9, 12, 1.40],
  ])('B1: %s', (_l, g, ratePct, n, target) => {
    const out = run({ 'Tax Rate': 0, 'OPEX % of Revenue': 0, 'Availability Payment Escalation %': g * 100,
      'Interest Rate': ratePct, 'Loan Tenor': n, 'Grace Period': 0, 'Concession Period': 25, 'Target DSCR': target })
    const D = pvGrowing(12_000_000, g, ratePct / 100, n, target)
    expect(Math.abs(out.debt_sizing.supportable_debt - D)).toBeLessThanOrEqual(1)
  })

  test('B2: with grace, capacity = PV of sculpted service after grace, subject to interest-only coverage', () => {
    // 2 interest-only years then 8 sculpted years; zero tax, 3% escalation, 7%.
    const g = 0.03, r = 0.07, target = 1.2, E = 12_000_000
    const after = Array.from({ length: 8 }, (_, t) => E * (1 + g) ** (t + 2) / target)
    const D = after.reduce((s, ds, t) => s + ds / (1 + r) ** (t + 1), 0)
    expect(D * r).toBeLessThanOrEqual(E / target)          // grace coverage not binding here
    const out = run({ 'Tax Rate': 0, 'OPEX % of Revenue': 0, 'Availability Payment Escalation %': 3, 'Target DSCR': 1.2 })
    expect(Math.abs(out.debt_sizing.supportable_debt - D)).toBeLessThanOrEqual(1)
  })

  test('B3: quarterly closed form — PV at r/4 of quarterly sculpted service (flat, zero tax)', () => {
    const r = 0.07 / 4, n = 32, E = 12_000_000 * 0.95 / 4, target = 1.2
    const D = (E / target) * (1 - (1 + r) ** -n) / r
    const out = run({ ...Q, 'Tax Rate': 0, 'Grace Period': 0, 'Loan Tenor': 8 })
    expect(Math.abs(out.debt_sizing.supportable_debt - D)).toBeLessThanOrEqual(1)
  })

  test('B4: annuity capacity is bound by the weakest period: level DS = min CFADS / target', () => {
    // Declining revenue (-4%/yr), zero tax: the last repayment year has the lowest CFADS.
    const out = run({ 'Tax Rate': 0, 'OPEX % of Revenue': 0, 'Availability Payment Escalation %': -4,
      'Repayment Profile': 'Annuity', 'Grace Period': 0, 'Loan Tenor': 10 })
    const minCF = 12_000_000 * 0.96 ** 9, level = minCF / 1.2, r = 0.07
    const D = level * (1 - (1 + r) ** -10) / r
    expect(Math.abs(out.debt_sizing.supportable_debt - D)).toBeLessThanOrEqual(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Phase 3 — variable CFADS behaviour
// ═════════════════════════════════════════════════════════════════════════
describe('Phase 3 — variable CFADS structures', () => {
  test('V1: escalating AP and variable OPEX — sculpting tracks CFADS at the target DSCR', () => {
    const out = run({ 'Availability Payment Escalation %': 3, 'OPEX Amount (JOD)': 1_000_000, 'OPEX Escalation %': 6 })
    const ops = out.cash_flows.filter(r => r.phase === 'Operations')
    expect(ops[5].revenue).toBeCloseTo(12_000_000 * 1.03 ** 5, 0)
    expect(ops[5].opex).toBeCloseTo(1_000_000 * 1.06 ** 5, 0)
    const repay = ops.slice(2, 9)
    repay.forEach(r => expect(r.dscr).toBeCloseTo(1.2, 2))
    const ds = repay.map(r => r.interest + r.principal)
    expect(Math.max(...ds) - Math.min(...ds)).toBeGreaterThan(100_000)    // service varies with CFADS
  })

  test('V2: demand-based revenue profile (ramp-up then decline) — labelled as an estimate, DSCR ≥ target', () => {
    const profile = Array.from({ length: 25 }, (_, i) => Math.round(6e6 + 8e6 * Math.min(1, i / 4) - 150_000 * Math.max(0, i - 8)))
    const out = run({ 'Revenue Profile': profile.join(','), 'Revenue Basis': 'Demand Estimate' })
    expect(out.revenue_basis).toBe('demand_estimate')
    expect(out.warnings.map(w => w.code)).toContain('DEMAND_REVENUE_ESTIMATE')
    out.cash_flows.filter(r => r.phase === 'Operations').forEach((r, i) => {
      expect(r.revenue).toBeCloseTo(profile[i], 0)
      if (r.interest + r.principal > 1) expect(r.dscr).toBeGreaterThanOrEqual(1.19)
    })
    expect(Math.abs(out.debt_schedule.at(-1).closing)).toBeLessThanOrEqual(2)
  })

  test('V3: CFADS insufficient during the loan life → financing constraint identified, no bankable result manufactured', () => {
    // (a) zero-revenue year in operating year 5, inside the tenor: capacity
    // is limited to debt that is fully repaid BEFORE the shortfall at the
    // target DSCR — no debt is outstanding when CFADS is zero.
    const profile = Array(25).fill(12_000_000); profile[4] = 0
    const out = run({ 'Revenue Profile': profile.join(','), 'Revenue Basis': 'Demand Estimate' })
    const ops = out.cash_flows.filter(r => r.phase === 'Operations')
    expect(out.debt_schedule[out.construction_years + 3].closing).toBeLessThanOrEqual(1)   // repaid by end of year 4
    expect(ops[4].interest + ops[4].principal).toBe(0)
    ops.slice(2, 4).forEach(r => expect(r.dscr).toBeCloseTo(1.2, 2))
    expect(out.debt_sizing.binding_constraint).toBe('dscr')
    expect(out.warnings.map(w => w.code)).toContain('DEBT_LIMITED_BY_DSCR')
    expect(out.debt_amount).toBeLessThan(run({}).debt_amount)
    // (b) zero revenue during the interest-only grace period: no debt can be
    // serviced at any size → zero capacity, flagged.
    const early = Array(25).fill(12_000_000); early[0] = 0
    const out0 = run({ 'Revenue Profile': early.join(',') })
    expect(out0.debt_amount).toBeLessThan(1)
    expect(out0.warnings.map(w => w.code)).toContain('NO_DEBT_CAPACITY')
    // Moving the shortfall after the loan matures restores capacity
    const later = Array(25).fill(12_000_000); later[20] = 0
    expect(run({ 'Revenue Profile': later.join(',') }).debt_amount).toBeGreaterThan(40_000_000)
  })

  test('V4: a weak period during grace limits capacity via interest-only coverage', () => {
    const profile = Array(25).fill(12_000_000); profile[0] = 2_000_000          // weak first operating year (grace)
    const out = run({ 'Revenue Profile': profile.join(','), 'Tax Rate': 0, 'OPEX % of Revenue': 0 })
    const y1 = out.cash_flows.filter(r => r.phase === 'Operations')[0]
    expect(y1.principal).toBe(0)
    expect(y1.dscr).toBeGreaterThanOrEqual(1.19)                            // interest ≤ CFADS / 1.20
    expect(out.debt_amount).toBeLessThanOrEqual(2_000_000 / 1.2 / 0.07 + 1)
  })

  test('V5: irregular construction spending follows the profile; IDC and equity-first respect it', () => {
    const out = run({ 'Construction Cost Profile': '30,70' })
    const c = out.cash_flows.filter(r => r.phase === 'Construction')
    expect(c[0].capex).toBeCloseTo(30_000_000, 0)
    expect(c[1].capex).toBeCloseTo(70_000_000, 0)
    expect(Math.abs(c[1].idc - 0.07 * (c[0].debt_draw + c[0].idc + 0.5 * c[1].debt_draw))).toBeLessThanOrEqual(1)
    expect(codeOf(() => run({ 'Construction Cost Profile': '30,30,40' }))).toBe('CONSTRUCTION_PROFILE_INVALID')
    expect(codeOf(() => run({ ...Q, 'Construction Cost Profile': '1,2,3,4,5,6,7,8' }))).toBeNull()
  })

  test('V6: repayment profiles — sculpted DSCR = target; annuity level DS; equal principal', () => {
    const sc = run({}), an = run({ 'Repayment Profile': 'Annuity' }), ep = run({ 'Repayment Profile': 'Equal Principal' })
    const rep = o => o.cash_flows.filter(r => r.phase === 'Operations').slice(2, 10)
    rep(sc).slice(0, -1).forEach(r => expect(r.dscr).toBeCloseTo(1.2, 2))
    const ads = rep(an).map(r => r.interest + r.principal)
    expect(Math.max(...ads) - Math.min(...ads)).toBeLessThanOrEqual(1)
    rep(an).forEach(r => expect(r.dscr).toBeGreaterThanOrEqual(1.19))
    const ps = rep(ep).map(r => r.principal)
    expect(Math.max(...ps) - Math.min(...ps)).toBeLessThanOrEqual(1)
    rep(ep).forEach(r => expect(r.dscr).toBeGreaterThanOrEqual(1.19))
    // For flat CFADS, sculpting maximises capacity
    expect(sc.debt_sizing.supportable_debt).toBeGreaterThan(an.debt_sizing.supportable_debt)
    expect(an.debt_sizing.supportable_debt).toBeGreaterThan(ep.debt_sizing.supportable_debt)
  })

  test('V7: monotonicity — more escalation ↑ capacity; higher target ↓ capacity', () => {
    const caps = [0, 1, 2, 4].map(g => run({ 'Availability Payment Escalation %': g }).debt_sizing.supportable_debt)
    for (let i = 1; i < caps.length; i++) expect(caps[i]).toBeGreaterThan(caps[i - 1])
    const t = [1.1, 1.2, 1.4].map(x => run({ 'Availability Payment Escalation %': 2, 'Target DSCR': x }).debt_sizing.supportable_debt)
    expect(t[0]).toBeGreaterThan(t[1]); expect(t[1]).toBeGreaterThan(t[2])
  })

  test('V8: randomized variable-CFADS scenarios (annual and quarterly) — identities and DSCR hold', () => {
    let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const pick = a => a[Math.floor(rnd() * a.length)]
    let ran = 0
    for (let i = 0; i < 150; i++) {
      const conc = pick([10, 15, 20]), quarterly = rnd() < 0.5
      const fx = { ...BASE, ...LEGACY_TAX, 'Concession Period': conc, 'Loan Tenor': Math.min(pick([8, 10, 12]), conc), 'Grace Period': pick([0, 1, 2]),
        'Availability Payment Escalation %': +(rnd() * 6 - 2).toFixed(2), 'Interest Rate': +(3 + rnd() * 8).toFixed(2),
        'Target DSCR': pick([1.1, 1.2, 1.35]), 'Repayment Profile': pick(['Sculpted', 'Annuity', 'Equal Principal']),
        'Construction Period': pick([12, 24, 30, 36]) }
      if (rnd() < 0.5) { fx['OPEX Amount (JOD)'] = Math.round(rnd() * 3e6); fx['OPEX Escalation %'] = +(rnd() * 6).toFixed(2) }
      if (quarterly) { fx['Model Periodicity'] = 'Quarterly'; if (rnd() < 0.5) fx['Quarterly Revenue Weights'] = '30,20,25,25' }
      if (rnd() < 0.3) fx['Revenue Profile'] = Array.from({ length: conc }, () => Math.round(6e6 + rnd() * 10e6)).join(',')
      const out = runPPPEngine(A(fx))            // integrity gate inside the engine would throw on any break
      ran++
      const rows = (out.cash_flows_periodic || out.cash_flows).filter(r => r.phase === 'Operations')
      rows.forEach(r => { if (r.interest + r.principal > 1 && r.principal >= 0) expect(r.dscr).toBeGreaterThanOrEqual(fx['Target DSCR'] - 0.011) })
      expect(Math.abs(out.debt_schedule.at(-1).closing)).toBeLessThanOrEqual(2)
      expect(resimulateOps(out, fx)).toBeLessThanOrEqual(0.011)
    }
    expect(ran).toBe(150)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Phase 4 — project IRR (unlevered, post-tax, before financing)
// ═════════════════════════════════════════════════════════════════════════
describe('Phase 4 — project IRR', () => {
  const irrBisect = (cfs, p) => {
    const npv = r => cfs.reduce((s, c, t) => s + c / (1 + r) ** t, 0)
    let lo = -0.5, hi = 1
    for (let i = 0; i < 300; i++) { const m = (lo + hi) / 2; npv(m) > 0 ? lo = m : hi = m }
    return ((1 + lo) ** p - 1) * 100
  }
  test.each([['annual', {}], ['quarterly', Q], ['quarterly escalating', { ...Q, 'Availability Payment Escalation %': 2 }]])(
    'PI1: %s — matches an independent IRR on (−capex, EBITDA − tax on EBITDA)', (_l, o) => {
      const out = run({ ...o, ...LEGACY_TAX }), p = out.periods_per_year
      const rows = out.cash_flows_periodic || out.cash_flows
      const cfs = rows.map(r => r.phase === 'Construction' ? -r.capex : r.ebitda - Math.max(0, r.ebitda * 0.2))
      expect(Math.abs(out.project_irr - irrBisect(cfs, p))).toBeLessThanOrEqual(0.011)
    })

  test('PI2: with no debt, project IRR equals equity IRR (identity)', () => {
    ;[{ 'Debt %': 0, 'Equity %': 100 }, { ...Q, 'Debt %': 0, 'Equity %': 100 }].forEach(o => {
      const out = run(o)
      expect(out.debt_amount).toBe(0)
      expect(out.project_irr).toBeCloseTo(out.irr, 2)
    })
  })

  test('PI3: project IRR ignores financing — invariant to Debt %, target DSCR and interest rate', () => {
    const ref = run({}).project_irr
    ;[{ 'Debt %': 30, 'Equity %': 70 }, { 'Target DSCR': 1.5 }, { 'Interest Rate': 11 }]
      .forEach(o => expect(run(o).project_irr).toBe(ref))
  })
})
