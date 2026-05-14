/**
 * tests/feasibilityEngine.test.js
 *
 * Annual / basic feasibility engine validation suite — P0.
 * Imports from src/modules/feasibility/annualEngine.js.
 *
 * P0 scope:
 *   B1 — annuity (closed-form + edge cases)
 *   B2 — npvCalc (undiscounted t=0, monotonicity, zero-rate identity)
 *   B3 — irrCalc (basic IRR, rejects single-sign streams, NPV identity)
 *   B4 — r2 (rounding to 2dp)
 *   B5 — TDC / Land / Equity / Debt sizing (F-RE-Sale baseline)
 *   B6 — Cash-flow array length (construction + operations)
 *   B7 — Construction-year equity outflows + arrangement fee
 *
 * Tolerance per validation plan:
 *   - Currency:        2 decimal places  (toBeCloseTo(_, 2))
 *   - Ratios / IRR:    4 decimal places  (toBeCloseTo(_, 4))
 *
 * Engine math is NOT modified.
 */

import {
  annuity, npvCalc, irrCalc, r2,
  runEngine,
} from '../src/modules/feasibility/annualEngine.js'

// ─────────────────────────────────────────────────────────────────────
// Tolerance constants
// ─────────────────────────────────────────────────────────────────────
const CURR_DP  = 2  // currency: 2 decimals
const RATIO_DP = 4  // ratios / IRR / DSCR: 4 decimals

// ─────────────────────────────────────────────────────────────────────
// Fixture: F-RE-Sale
// 10,000 sqm pure-sale project, 30/70 equity/debt, 2-yr construction,
// 10-yr life. Used by B5, B6, B7.
// ─────────────────────────────────────────────────────────────────────
const F_RE_SALE_ASSUMPTIONS = [
  { name: 'GFA',                     value: 10000, unit: 'sqm' },
  { name: 'Equity %',                value: 30,    unit: 'percent' },
  { name: 'Senior Debt %',           value: 70,    unit: 'percent' },
  { name: 'Revenue Model',           value: null,  unit: 'Sale' },
  { name: 'Sale Split %',            value: 100,   unit: 'percent' },
  { name: 'Efficiency %',            value: 100,   unit: 'percent' },
  { name: 'Project Life Years',      value: 10,    unit: 'years' },
  { name: 'Construction Start Date', value: null,  unit: '2024-01-01' },
  { name: 'Operations Start Date',   value: null,  unit: '2026-01-01' },
]

const F_RE_SALE_DEFAULTS = [
  { key: 'construction_cost_per_sqm_residential', value: 650 },
  { key: 'contingency_pct',                       value: 0.05 },
  { key: 'land_cost_pct_of_tdc',                  value: 0.20 },
  { key: 'sale_price_per_sqm_residential',        value: 1200 },
  { key: 'sales_absorption_rate_pct_per_year',    value: 0.35 },
  { key: 'rental_yield_residential',              value: 0.06 },
  { key: 'occupancy_rate_stabilized',             value: 0.88 },
  { key: 'rent_escalation_pct_per_year',          value: 0.03 },
  { key: 'price_escalation_pa',                   value: 0.025 },
  { key: 'property_management_fee_pct',           value: 0.05 },
  { key: 'maintenance_cost_pct_of_value',         value: 0.01 },
  { key: 'insurance_pct_of_value',                value: 0.005 },
  { key: 'senior_debt_interest_rate',             value: 0.085 },
  { key: 'loan_tenor_years',                      value: 15 },
  { key: 'grace_period_years',                    value: 2 },
  { key: 'corporate_income_tax_rate',             value: 0.20 },
  { key: 'discount_rate_wacc',                    value: 0.12 },
  { key: 'debt_arrangement_fee_pct',              value: 0.01 },
]

// =====================================================================
// B1 — annuity
// PMT = P * r * (1+r)^n / ((1+r)^n - 1)   when r ≠ 0
// PMT = P / n                              when r = 0
// PMT = 0                                  when guarded (P<=0, n<=0)
// =====================================================================
describe('B1 — annuity', () => {
  test('B1.1: PMT(P=1M, r=5%, n=10) ≈ 129,504.57', () => {
    expect(annuity(1_000_000, 0.05, 10)).toBeCloseTo(129_504.57, CURR_DP)
  })
  test('B1.2: zero rate → P / n (no interest)', () => {
    expect(annuity(1_000_000, 0, 10)).toBe(100_000)
  })
  test('B1.3: zero principal → 0 (guarded)', () => {
    expect(annuity(0, 0.05, 10)).toBe(0)
  })
  test('B1.4: zero tenor → 0 (guarded)', () => {
    expect(annuity(1_000_000, 0.05, 0)).toBe(0)
  })
  test('B1.5: negative principal → 0 (guarded)', () => {
    expect(annuity(-1, 0.05, 10)).toBe(0)
  })
  test('B1.6: negative tenor → 0 (guarded)', () => {
    expect(annuity(1_000_000, 0.05, -1)).toBe(0)
  })
})

// =====================================================================
// B2 — npvCalc
// NPV(rate, cfs) = sum(cfs[t] / (1+rate)^t)  for t = 0..n-1
// =====================================================================
describe('B2 — npvCalc', () => {
  test('B2.1: year 0 is undiscounted (t=0 → divisor (1+r)^0 = 1)', () => {
    expect(npvCalc(0.10, [100])).toBeCloseTo(100, CURR_DP)
  })
  test('B2.2: zero rate → simple sum of cash flows', () => {
    expect(npvCalc(0, [-100, 50, 50, 50])).toBeCloseTo(50, CURR_DP)
  })
  test('B2.3: 10% identity: [-1000, 1100] @ 10% = 0', () => {
    expect(npvCalc(0.10, [-1000, 1100])).toBeCloseTo(0, CURR_DP)
  })
  test('B2.4: monotonicity — higher rate → lower NPV (positive future CFs)', () => {
    const cfs = [-1000, 500, 500, 500]
    expect(npvCalc(0.05, cfs)).toBeGreaterThan(npvCalc(0.15, cfs))
  })
  test('B2.5: empty array → 0', () => {
    expect(npvCalc(0.10, [])).toBe(0)
  })
})

// =====================================================================
// B3 — irrCalc
// Newton-Raphson solver; returns null when:
//   - cfs has no negative or no positive elements
//   - solver fails to converge or rate exits bounds
// =====================================================================
describe('B3 — irrCalc', () => {
  test('B3.1: IRR of [-100, 110] = 0.10 exactly (within 4dp)', () => {
    expect(irrCalc([-100, 110])).toBeCloseTo(0.10, RATIO_DP)
  })
  test('B3.2: all-positive cash flows → null', () => {
    expect(irrCalc([100, 110])).toBeNull()
  })
  test('B3.3: all-negative cash flows → null', () => {
    expect(irrCalc([-100, -110])).toBeNull()
  })
  test('B3.4: empty array → null', () => {
    expect(irrCalc([])).toBeNull()
  })
  test('B3.5: NPV at solved IRR ≈ 0 (cross-check identity)', () => {
    const cfs = [-1000, 200, 300, 400, 500]
    const irr = irrCalc(cfs)
    expect(irr).not.toBeNull()
    // Engine accepts solutions where |NPV| < 10,000; assert tighter (< 1 JOD)
    expect(Math.abs(npvCalc(irr, cfs))).toBeLessThan(1)
  })
})

// =====================================================================
// B4 — r2
// Round to 2 decimal places via Math.round(n * 100) / 100.
// (Direct test possible because r2 is exported from annualEngine.js.)
// =====================================================================
describe('B4 — r2', () => {
  test('B4.1: r2(1.234) = 1.23 (rounds down)', () => {
    expect(r2(1.234)).toBe(1.23)
  })
  test('B4.2: r2(1.236) = 1.24 (rounds up)', () => {
    expect(r2(1.236)).toBe(1.24)
  })
  test('B4.3: r2(-1.234) = -1.23', () => {
    expect(r2(-1.234)).toBe(-1.23)
  })
  test('B4.4: r2(0) = 0', () => {
    expect(r2(0)).toBe(0)
  })
  test('B4.5: r2(1) = 1 (integer pass-through)', () => {
    expect(r2(1)).toBe(1)
  })
})

// =====================================================================
// B5 — Sizing (F-RE-Sale baseline)
// Hand-computed:
//   TDC = 10,000 × 650 × (1 + 0.05)  = 6,825,000
//   Land = TDC × 0.20                 = 1,365,000
//   TPC = TDC + Land                  = 8,190,000   ← reported as out.tdc
//   Equity = TPC × 30%                = 2,457,000
//   Debt = TPC × 70%                  = 5,733,000
// =====================================================================
describe('B5 — sizing (F-RE-Sale)', () => {
  const out = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
  test('B5.1: out.tdc reports TPC (TDC + Land) = 8,190,000', () => {
    expect(out.tdc).toBeCloseTo(8_190_000, CURR_DP)
  })
  test('B5.2: equity_amount = TPC × 30% = 2,457,000', () => {
    expect(out.equity_amount).toBeCloseTo(2_457_000, CURR_DP)
  })
  test('B5.3: debt_amount = TPC × 70% = 5,733,000', () => {
    expect(out.debt_amount).toBeCloseTo(5_733_000, CURR_DP)
  })
  test('B5.4: equity + debt = out.tdc (sources = uses identity)', () => {
    expect(out.equity_amount + out.debt_amount).toBeCloseTo(out.tdc, CURR_DP)
  })
})

// =====================================================================
// B6 — Cash-flow array length
// constrYrs derived from date diff (2024-01-01 → 2026-01-01) = 2 yrs
// opsYrs = max(1, lifeYears − constrYrs) = max(1, 10 − 2) = 8
// cash_flows.length = constrYrs + opsYrs = 10
// =====================================================================
describe('B6 — cash-flow length', () => {
  const out = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
  test('B6.1: construction_years = 2 (derived from date diff)', () => {
    expect(out.construction_years).toBe(2)
  })
  test('B6.2: operations_years = max(1, lifeYears − constrYrs) = 8', () => {
    expect(out.operations_years).toBe(8)
  })
  test('B6.3: cash_flows length = constrYrs + opsYrs = 10', () => {
    expect(out.cash_flows.length).toBe(10)
  })
  test('B6.4: split into 2 construction rows + 8 operations rows', () => {
    const constr = out.cash_flows.filter(r => r.phase === 'Construction')
    const ops    = out.cash_flows.filter(r => r.phase === 'Operations')
    expect(constr.length).toBe(2)
    expect(ops.length).toBe(8)
  })
})

// =====================================================================
// B7 — Construction-year equity outflows + arrangement fee
// equity = 2,457,000;  constrYrs = 2  → equity / constrYrs = 1,228,500
// arrFee = debt × 0.01 = 5,733,000 × 0.01 = 57,330
// Year 0 equity_cf = -(equity / constrYrs) - arrFee = -1,285,830
// Year 1 equity_cf = -(equity / constrYrs)          = -1,228,500
// capex per construction year = tpc / constrYrs = 8,190,000 / 2 = 4,095,000
// =====================================================================
describe('B7 — construction outflows & arrangement fee', () => {
  const out = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
  test('B7.1: year 0 equity_cf includes arrFee = -1,285,830', () => {
    expect(out.cash_flows[0].equity_cf).toBeCloseTo(-1_285_830, CURR_DP)
  })
  test('B7.2: year 1 equity_cf is plain equity slice = -1,228,500', () => {
    expect(out.cash_flows[1].equity_cf).toBeCloseTo(-1_228_500, CURR_DP)
  })
  test('B7.3: construction capex per year = TPC / constrYrs = 4,095,000', () => {
    expect(out.cash_flows[0].capex).toBeCloseTo(4_095_000, CURR_DP)
    expect(out.cash_flows[1].capex).toBeCloseTo(4_095_000, CURR_DP)
  })
  test('B7.4: construction phase has zero revenue and zero opex', () => {
    expect(out.cash_flows[0].revenue).toBe(0)
    expect(out.cash_flows[0].opex).toBe(0)
    expect(out.cash_flows[1].revenue).toBe(0)
    expect(out.cash_flows[1].opex).toBe(0)
  })
  test('B7.5: construction phase DSCR is null', () => {
    expect(out.cash_flows[0].dscr).toBeNull()
    expect(out.cash_flows[1].dscr).toBeNull()
  })
})
