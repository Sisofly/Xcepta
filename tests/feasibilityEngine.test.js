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

// Variant: effectively zero debt. Same defaults as F-RE-Sale.
// Used by B8/B11/B12 to assert zero-debt invariants.
//
// ENGINE QUIRK (discovered by Batch 1):
//   The engine reads assumptions with the falsy-fallback pattern:
//     var seniorDebtPct = (getVal(assumptions, 'Senior Debt %') || 60) / 100
//   Setting the value literally to 0 makes the LHS falsy, so the
//   `|| 60` branch fires and the engine silently runs with 60% debt.
//   Same pattern applies to every `|| X` default in runEngine, so
//   explicit zero is unreachable via assumptions. A tiny positive
//   epsilon defeats the fallback, and the engine's `outstanding > 0.01`
//   thresholds in interest/principal/DSCR then drive the no-debt path.
const F_NO_DEBT_ASSUMPTIONS = F_RE_SALE_ASSUMPTIONS.map(a => {
  if (a.name === 'Equity %')      return { ...a, value: 100 }
  if (a.name === 'Senior Debt %') return { ...a, value: 1e-7 }
  return a
})

// Variant: 100% rental project. Revenue Model="Rental" → engine sets
// saleSplit=0, rentalSplit=1. All debt becomes rental debt and
// amortizes via level annuity after the grace period.
// Used by B10 to test rental amortization mechanics.
const F_RE_RENTAL_ASSUMPTIONS = F_RE_SALE_ASSUMPTIONS.map(a => {
  if (a.name === 'Revenue Model') return { ...a, value: null, unit: 'Rental' }
  if (a.name === 'Sale Split %')  return { ...a, value: 0 }
  return a
})

// Variant: 50/50 mixed-use. Revenue Model="Mixed" (anything other than
// 'Sale' or 'Rental') triggers the `Sale Split %` path in the engine.
// Used by B16 to test mixed-use revenue/debt partitioning.
const F_RE_MIXED_ASSUMPTIONS = F_RE_SALE_ASSUMPTIONS.map(a => {
  if (a.name === 'Revenue Model') return { ...a, value: null, unit: 'Mixed' }
  if (a.name === 'Sale Split %')  return { ...a, value: 50 }
  return a
})

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

// =====================================================================
// B8 — Interest on outstanding debt
// Engine logic:
//   saleInt  = outSale  > 0.01 ? outSale  * debtRate : 0
//   rentInt  = outRental > 0.01 ? outRental * debtRate : 0
//   interest = saleInt + rentInt
// In F-RE-Sale: saleSplit=1, so all debt is sale-funded. At start of
// ops year 1: outSale = saleDebt = debt × saleSplit × (1+debtRate)^constrYrs
// =====================================================================
describe('B8 — interest on outstanding debt (RE engine)', () => {
  const out = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)

  test('B8.1: construction phase interest is zero (no debt service during build)', () => {
    expect(out.cash_flows[0].interest).toBe(0)
    expect(out.cash_flows[1].interest).toBe(0)
  })

  test('B8.2: ops year 1 interest = saleDebt × debtRate (hand-computed)', () => {
    // From F-RE-Sale defaults:
    //   debt      = TPC × 70%        = 5,733,000
    //   debtRate  = 0.085
    //   constrYrs = 2 (from date diff)
    //   capFactor = (1 + 0.085)^2   = 1.177225
    //   saleDebt  = 5,733,000 × 1.0 × 1.177225
    // Year 1 interest (= cash_flows[2].interest) = saleDebt × debtRate
    const debt = 5_733_000
    const debtRate = 0.085
    const capFactor = Math.pow(1 + debtRate, 2)
    const saleDebt = debt * 1.0 * capFactor
    const expectedY1Interest = saleDebt * debtRate
    expect(out.cash_flows[2].interest).toBeCloseTo(expectedY1Interest, CURR_DP)
  })

  test('B8.3: interest decreases monotonically as debt amortizes', () => {
    // Cash sweep in B9 reduces outstanding each year, so interest must
    // be non-increasing across consecutive ops rows.
    const ops = out.cash_flows.filter(r => r.phase === 'Operations')
    for (let i = 1; i < ops.length; i++) {
      expect(ops[i].interest).toBeLessThanOrEqual(ops[i - 1].interest)
    }
  })

  test('B8.4: zero-debt fixture → interest = 0 in all ops rows', () => {
    const zd = runEngine(F_NO_DEBT_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
    zd.cash_flows.filter(r => r.phase === 'Operations').forEach(r => {
      expect(r.interest).toBe(0)
    })
  })
})

// =====================================================================
// B11 — DSCR formula (RE engine)
// Engine logic (line 154):
//   dscr = (totalDS > 0) ? r2(EBITDA / totalDS) : null
//   where totalDS = interest + principal
// EBITDA-based (NOT CFADS) — distinct from runPPPEngine.
// =====================================================================
describe('B11 — DSCR formula (RE engine)', () => {
  const out = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)

  test('B11.1: construction phase DSCR is null (no debt service yet)', () => {
    out.cash_flows.filter(r => r.phase === 'Construction').forEach(r => {
      expect(r.dscr).toBeNull()
    })
  })

  test('B11.2: internal identity — for each ops row with totalDS > 0, dscr ≈ EBITDA / (interest + principal)', () => {
    // Engine computes from unrounded values then r2's; cfTable stores
    // each field r2'd. Recomputing from cfTable values diverges only in
    // sub-cent rounding — assert within 2 dp tolerance.
    out.cash_flows.filter(r => r.phase === 'Operations').forEach(r => {
      const totalDS = r.interest + r.principal
      if (totalDS > 0) {
        expect(r.dscr).not.toBeNull()
        expect(r.dscr).toBeCloseTo(r.ebitda / totalDS, 2)
      }
    })
  })

  test('B11.3: zero-debt fixture → all ops DSCR are null (no debt service)', () => {
    const zd = runEngine(F_NO_DEBT_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
    zd.cash_flows.filter(r => r.phase === 'Operations').forEach(r => {
      expect(r.dscr).toBeNull()
    })
  })

  test('B11.4: dscr_series records only ops years that had a DSCR ratio', () => {
    // The engine pushes to dscrSeries only when hasDebt (line 155).
    // For F-RE-Sale, all years where outSale > 0.01 at the START of the
    // year should appear; once outSale hits 0, subsequent years drop out
    // unless principal or interest is somehow still positive.
    expect(Array.isArray(out.dscr_series)).toBe(true)
    out.dscr_series.forEach(entry => {
      expect(entry).toHaveProperty('year')
      expect(typeof entry.year).toBe('number')
      // dscr can be null (totalDS = 0 for that year) but the entry is recorded
    })
  })
})

// =====================================================================
// B12 — Equity multiple
// Engine logic (lines 164-166):
//   totalIn  = |sum of negative CFs|
//   totalOut =  sum of positive CFs
//   em       = totalIn > 0 ? r2(totalOut / totalIn) : null
// Computed from internal `cfs` array (unrounded); cfTable.equity_cf is
// r2'd. Sub-cent diffs possible vs. recomputed-from-cfTable.
// =====================================================================
describe('B12 — equity multiple', () => {
  const out = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)

  test('B12.1: equity_multiple is a finite number for F-RE-Sale', () => {
    expect(out.equity_multiple).not.toBeNull()
    expect(Number.isFinite(out.equity_multiple)).toBe(true)
  })

  test('B12.2: internal identity — em ≈ sum(positive equity_cf) / |sum(negative equity_cf)|', () => {
    const sumPos = out.cash_flows
      .filter(r => r.equity_cf > 0)
      .reduce((a, r) => a + r.equity_cf, 0)
    const sumNeg = out.cash_flows
      .filter(r => r.equity_cf < 0)
      .reduce((a, r) => a + r.equity_cf, 0)
    expect(sumNeg).toBeLessThan(0)              // sanity: construction outflows present
    const expectedEM = sumPos / Math.abs(sumNeg)
    expect(out.equity_multiple).toBeCloseTo(expectedEM, 2)
  })

  test('B12.3: F-RE-Sale regression — equity_multiple ≈ 0.71 (lock current behavior)', () => {
    // Hand-derived: construction outflows = 1,285,830 + 1,228,500 = 2,514,330.
    // Ops years 1-2 sweep all net income to debt → equity_cf = 0.
    // Year 3 fully retires debt; residual netInc ≈ 1.79M flows to equity.
    // Years 4-8: GFA sold out → revenue = 0 → equity_cf = 0.
    // EM ≈ 1,788,086 / 2,514,330 ≈ 0.7113 → r2 = 0.71.
    // Locked as a regression check; future engine math changes will surface here.
    expect(out.equity_multiple).toBeCloseTo(0.71, 1)
  })

  test('B12.4: zero-debt fixture — equity_multiple is defined and ≥ 0', () => {
    const zd = runEngine(F_NO_DEBT_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
    expect(zd.equity_multiple).not.toBeNull()
    expect(Number.isFinite(zd.equity_multiple)).toBe(true)
    expect(zd.equity_multiple).toBeGreaterThanOrEqual(0)
  })
})

// =====================================================================
// B9 — Sale debt cash sweep (RE engine)
// Engine logic (line 148):
//   if (outSale > 0.01) {
//     salePrin = Math.min(outSale, Math.max(0, netInc))
//     outSale = Math.max(0, outSale - salePrin)
//   }
// Principal = min(outstanding, max(0, net_income)). Negative netInc → no
// sweep. Once outSale hits 0, no further interest or principal.
// =====================================================================
describe('B9 — sale debt cash sweep (RE engine)', () => {
  const out = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
  const ops = out.cash_flows.filter(r => r.phase === 'Operations')

  test('B9.1: ops year 1 — principal ≤ net_income (sweep cannot exceed earnings)', () => {
    const y1 = ops[0]
    expect(y1.principal).toBeLessThanOrEqual(y1.net_income)
  })

  test('B9.2: principal is always ≥ 0 in every ops row (no negative payments)', () => {
    ops.forEach(r => {
      expect(r.principal).toBeGreaterThanOrEqual(0)
    })
  })

  test('B9.3: sum of principal across ops years ≈ saleDebt (all debt retired)', () => {
    // saleDebt = debt × saleSplit × (1+debtRate)^constrYrs
    // F-RE-Sale: debt=5,733,000, saleSplit=1, constrYrs=2, debtRate=0.085
    const debt = 5_733_000
    const debtRate = 0.085
    const capFactor = Math.pow(1 + debtRate, 2)
    const saleDebt = debt * 1.0 * capFactor
    const totalPrincipal = ops.reduce((a, r) => a + r.principal, 0)
    expect(totalPrincipal).toBeCloseTo(saleDebt, CURR_DP)
  })

  test('B9.4: after debt is retired, subsequent years have interest = 0 and principal = 0', () => {
    let zeroDebtSeen = false
    ops.forEach(r => {
      if (zeroDebtSeen) {
        expect(r.principal).toBe(0)
        expect(r.interest).toBe(0)
      }
      if (r.interest === 0 && r.principal === 0) zeroDebtSeen = true
    })
    // Sanity: at least one zero-debt year exists in F-RE-Sale (debt retires by year 3)
    expect(zeroDebtSeen).toBe(true)
  })
})

// =====================================================================
// B10 — Rental debt annuity post-grace (RE engine)
// Engine logic (line 149):
//   if (outRental > 0.01 && op > graceYrs) {
//     rentPrin = Math.max(0, Math.min(outRental, rentalAnnuity - rentInt))
//   }
// During grace (op ≤ graceYrs): principal = 0, interest still accrues.
// Post-grace: principal = annuity − interest (capped by outstanding).
// rentalAnnuity = annuity(rentalDebt, debtRate, debtTenor − graceYrs).
// F-RE-Rental: 100% rental → all debt is rental debt.
// =====================================================================
describe('B10 — rental debt annuity post-grace (RE engine)', () => {
  const out = runEngine(F_RE_RENTAL_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
  const ops = out.cash_flows.filter(r => r.phase === 'Operations')
  const graceYrs = 2  // matches F_RE_SALE_DEFAULTS grace_period_years

  // Pre-compute the expected rental annuity for post-grace identity tests
  const debt = 5_733_000
  const debtRate = 0.085
  const capFactor = Math.pow(1 + debtRate, 2)
  const rentalDebt = debt * 1.0 * capFactor  // saleSplit=0, rentalSplit=1
  const debtTenor = 15
  const rentalAnnuity = annuity(rentalDebt, debtRate, debtTenor - graceYrs)

  test('B10.1: grace period (op ≤ graceYrs) → principal = 0', () => {
    for (let i = 0; i < graceYrs; i++) {
      expect(ops[i].principal).toBe(0)
    }
  })

  test('B10.2: grace period — interest is non-zero (debt service accrues even without principal)', () => {
    for (let i = 0; i < graceYrs; i++) {
      expect(ops[i].interest).toBeGreaterThan(0)
    }
  })

  test('B10.3: post-grace — principal ≈ rentalAnnuity − interest (level amortization)', () => {
    for (let i = graceYrs; i < ops.length; i++) {
      const expectedPrincipal = rentalAnnuity - ops[i].interest
      expect(ops[i].principal).toBeCloseTo(expectedPrincipal, 1)
    }
  })

  test('B10.4: post-grace — interest + principal ≈ rentalAnnuity (constant debt service)', () => {
    for (let i = graceYrs; i < ops.length; i++) {
      expect(ops[i].interest + ops[i].principal).toBeCloseTo(rentalAnnuity, 1)
    }
  })
})

// =====================================================================
// B13 — Cash-flow reconciliation (RE engine)
// Internal consistency identities across all ops rows:
//   ebitda     = revenue - opex
//   pbt        = ebitda - interest
//   tax        = max(0, pbt × taxRate)
//   net_income = pbt - tax
//   equity_cf  = net_income - principal
// Each field is r2'd individually, so recomputing from rounded inputs
// can diverge by ~0.01 per term. Tolerance: 1 dp (~0.05).
// =====================================================================
describe('B13 — cash-flow reconciliation (RE engine)', () => {
  const out = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
  const ops = out.cash_flows.filter(r => r.phase === 'Operations')
  const taxRate = 0.20  // matches F_RE_SALE_DEFAULTS corporate_income_tax_rate

  test('B13.1: ebitda = revenue − opex (every ops row)', () => {
    ops.forEach(r => {
      expect(r.ebitda).toBeCloseTo(r.revenue - r.opex, 1)
    })
  })

  test('B13.2: pbt = ebitda − interest (every ops row)', () => {
    ops.forEach(r => {
      expect(r.pbt).toBeCloseTo(r.ebitda - r.interest, 1)
    })
  })

  test('B13.3: tax = max(0, pbt × taxRate) — no loss carry-forward, no negative tax', () => {
    ops.forEach(r => {
      const expectedTax = Math.max(0, r.pbt * taxRate)
      expect(r.tax).toBeCloseTo(expectedTax, 1)
    })
  })

  test('B13.4: net_income = pbt − tax (every ops row)', () => {
    ops.forEach(r => {
      expect(r.net_income).toBeCloseTo(r.pbt - r.tax, 1)
    })
  })

  test('B13.5: equity_cf = net_income − principal (every ops row)', () => {
    ops.forEach(r => {
      expect(r.equity_cf).toBeCloseTo(r.net_income - r.principal, 1)
    })
  })
})

// =====================================================================
// B14 — Sale-only project logic (RE engine)
// Revenue Model='Sale' → saleSplit=1, rentalSplit=0, rentalGfa=0.
// Signature: all revenue from sales absorption; no rental tail after
// inventory is depleted; opex has no asset-based maint/insr component.
// F-RE-Sale year 1 hand-calc:
//   sold = min(10000, 10000 × 0.35) = 3500
//   saleRev = 3500 × 1200 × (1.025)^0 = 4,200,000
//   rentRev = 0 (rentalGfa = 0)
// =====================================================================
describe('B14 — sale-only project logic (RE engine)', () => {
  const out = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
  const ops = out.cash_flows.filter(r => r.phase === 'Operations')

  test('B14.1: F-RE-Sale ops year 1 revenue = sold × salePrice = 4,200,000', () => {
    const absRate = 0.35
    const saleGfa = 10000
    const salePrice = 1200
    const expected = (saleGfa * absRate) * salePrice * Math.pow(1 + 0.025, 0)
    expect(ops[0].revenue).toBeCloseTo(expected, CURR_DP)
  })

  test('B14.2: F-RE-Sale — once GFA is depleted, revenue is exactly 0 (no rental tail)', () => {
    // After year 3 (10000 - 3 × 3500 capped), remSaleGfa = 0 → revenue = 0
    // F-RE-Sale has no rental component, so years 4+ produce zero revenue.
    for (let i = 3; i < ops.length; i++) {
      expect(ops[i].revenue).toBe(0)
    }
  })
})

// =====================================================================
// B15 — Rental-only project logic (RE engine)
// Revenue Model='Rental' → saleSplit=0, rentalSplit=1, saleGfa=0.
// All revenue from rental; occupancy ramps 0.55 + 0.15×(op-1), capped
// at maxOcc=0.88; rpsqm = (assetVal/gfa) × rentYield × (1+rentEsc)^(op-1).
// F-RE-Rental year 1 hand-calc:
//   assetVal = 10000 × 1200 = 12,000,000
//   rpsqm    = 1200 × 0.06 × (1.03)^0 = 72
//   occ      = min(0.88, 0.55) = 0.55
//   rentRev  = 10000 × 72 × 0.55 = 396,000
// =====================================================================
describe('B15 — rental-only project logic (RE engine)', () => {
  const out = runEngine(F_RE_RENTAL_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
  const ops = out.cash_flows.filter(r => r.phase === 'Operations')

  test('B15.1: F-RE-Rental ops year 1 revenue ≈ 396,000 (10000 × 72 × 0.55)', () => {
    const gfa = 10000
    const salePrice = 1200
    const rentYield = 0.06
    const rpsqm = (gfa * salePrice / gfa) * rentYield
    const occ = 0.55
    const expected = gfa * rpsqm * occ
    expect(ops[0].revenue).toBeCloseTo(expected, CURR_DP)
  })

  test('B15.2: F-RE-Rental revenue grows monotonically through ramp years (1→2→3→4)', () => {
    // Occupancy: 0.55, 0.70, 0.85, 0.88 (stabilized) — increasing
    // Rent escalation: × 1.03 each year — increasing
    // Both effects pull revenue up during ramp
    for (let i = 1; i < 4 && i < ops.length; i++) {
      expect(ops[i].revenue).toBeGreaterThan(ops[i - 1].revenue)
    }
  })

  test('B15.3: F-RE-Rental year 1 interest = rentalDebt × debtRate (no saleInt component)', () => {
    // saleSplit=0 → saleDebt=0 → saleInt=0
    // All debt is rental: rentalDebt = debt × 1.0 × capFactor
    const debt = 5_733_000
    const debtRate = 0.085
    const capFactor = Math.pow(1 + debtRate, 2)
    const rentalDebt = debt * 1.0 * capFactor
    expect(ops[0].interest).toBeCloseTo(rentalDebt * debtRate, CURR_DP)
  })
})

// =====================================================================
// B16 — Mixed 50/50 project logic (RE engine)
// Revenue Model='Mixed' → engine reads Sale Split %; here saleSplit=0.5.
// Both saleGfa=5000 and rentalGfa=5000; both saleDebt and rentalDebt
// fund the project at half scale; total debt amount unchanged from
// 100% Sale because saleSplit + rentalSplit = 1.
// F-RE-Mixed year 1 hand-calc:
//   saleRev = 5000 × 0.35 × 1200 × 1            = 2,100,000
//   rentRev = 5000 × 72 × 0.55                  =   198,000
//   total                                       = 2,298,000
//   year-1 interest = (saleDebt + rentalDebt) × debtRate
//                   = (debt × capFactor) × debtRate
//                   = same as F-RE-Sale's year-1 interest
// =====================================================================
describe('B16 — mixed 50/50 project logic (RE engine)', () => {
  const out = runEngine(F_RE_MIXED_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
  const ops = out.cash_flows.filter(r => r.phase === 'Operations')

  test('B16.1: F-RE-Mixed year 1 revenue ≈ 2,298,000 (2.1M sale + 0.198M rental)', () => {
    const expected = 2_100_000 + 198_000
    expect(ops[0].revenue).toBeCloseTo(expected, CURR_DP)
  })

  test('B16.2: F-RE-Mixed year 1 interest = (saleDebt + rentalDebt) × debtRate', () => {
    // Total debt × capFactor is preserved regardless of split → year-1 interest
    // is the same as F-RE-Sale's year-1 interest (proven in B8.2).
    const debt = 5_733_000
    const debtRate = 0.085
    const capFactor = Math.pow(1 + debtRate, 2)
    const totalCapDebt = debt * 1.0 * capFactor  // saleSplit + rentalSplit = 1
    expect(ops[0].interest).toBeCloseTo(totalCapDebt * debtRate, CURR_DP)
  })

  test('B16.3: F-RE-Mixed has both revenue streams (year-1 revenue > sale-only and > rental-only would be at half-saleGfa)', () => {
    // Sanity: mixed year-1 should be > rental-only year-1 since it adds sale revenue
    const rentalOnly = runEngine(F_RE_RENTAL_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
    expect(ops[0].revenue).toBeGreaterThan(rentalOnly.cash_flows[2].revenue)
  })
})

// =====================================================================
// B17 — Price escalation (RE engine)
// Engine: saleRev = sold × salePrice × (1 + priceEsc)^(op-1)
// Default priceEsc = 0.025.
// In years where 'sold' is constant (early years before depletion), the
// revenue ratio year-on-year equals exactly (1 + priceEsc).
// F-RE-Sale years 1-2 both have sold = 3500 → ratio = 1.025.
// =====================================================================
describe('B17 — price escalation (RE engine)', () => {
  const out = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
  const ops = out.cash_flows.filter(r => r.phase === 'Operations')

  test('B17.1: F-RE-Sale year-2 / year-1 revenue ratio = (1 + priceEsc) = 1.025', () => {
    const priceEsc = 0.025
    const ratio = ops[1].revenue / ops[0].revenue
    expect(ratio).toBeCloseTo(1 + priceEsc, RATIO_DP)
  })
})

// =====================================================================
// B18 — Rent escalation (RE engine)
// Engine: rpsqm = (assetVal/gfa) × rentYield × (1 + rentEsc)^(op-1)
// Default rentEsc = 0.03.
// In post-stabilization years (occ = maxOcc = 0.88), the only year-on-year
// revenue change comes from rent escalation, so the ratio is exactly
// (1 + rentEsc).
// F-RE-Rental: occ stabilizes at year 4 (op=4 → 0.55+0.15×3 = 1.0 capped at 0.88).
// Years 4 and 5 are both stabilized → ratio = 1.03.
// =====================================================================
describe('B18 — rent escalation (RE engine)', () => {
  const out = runEngine(F_RE_RENTAL_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
  const ops = out.cash_flows.filter(r => r.phase === 'Operations')

  test('B18.1: F-RE-Rental year-5 / year-4 revenue ratio = (1 + rentEsc) = 1.03 (post-stabilization)', () => {
    const rentEsc = 0.03
    // ops[3] = op 4 (stabilized first time), ops[4] = op 5 (stabilized)
    const ratio = ops[4].revenue / ops[3].revenue
    expect(ratio).toBeCloseTo(1 + rentEsc, RATIO_DP)
  })
})

// =====================================================================
// B19 — OPEX composition (RE engine)
// Engine: opex = mgmt + maint + insr
//   mgmt  = revenue × mgmtFee
//   maint = assetVal × (rentalGfa / gfa) × maintPct
//   insr  = assetVal × (rentalGfa / gfa) × insrPct
// maint + insr is INVARIANT across years (asset-based, not revenue-based).
// For F-RE-Sale (rentalGfa=0):   maint + insr = 0
// For F-RE-Rental (rentalGfa=gfa): maint + insr = assetVal × (maintPct + insrPct) = 12M × 0.015 = 180,000
// For F-RE-Mixed (rentalGfa=gfa/2): maint + insr = 90,000
// =====================================================================
describe('B19 — OPEX composition (RE engine)', () => {
  const mgmtFee = 0.05  // matches F_RE_SALE_DEFAULTS property_management_fee_pct

  test('B19.1: F-RE-Sale — opex = revenue × mgmtFee (no asset-based maint/insr)', () => {
    const out = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
    out.cash_flows.filter(r => r.phase === 'Operations').forEach(r => {
      expect(r.opex).toBeCloseTo(r.revenue * mgmtFee, 1)
    })
  })

  test('B19.2: F-RE-Rental — opex − revenue × mgmtFee = 180,000 (asset-based constant)', () => {
    const out = runEngine(F_RE_RENTAL_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
    out.cash_flows.filter(r => r.phase === 'Operations').forEach(r => {
      expect(r.opex - r.revenue * mgmtFee).toBeCloseTo(180_000, 1)
    })
  })

  test('B19.3: F-RE-Mixed — opex − revenue × mgmtFee = 90,000 (half asset)', () => {
    const out = runEngine(F_RE_MIXED_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
    out.cash_flows.filter(r => r.phase === 'Operations').forEach(r => {
      expect(r.opex - r.revenue * mgmtFee).toBeCloseTo(90_000, 1)
    })
  })
})

// =====================================================================
// B20 — Sale revenue depletion (RE engine)
// Engine: each year sold = min(remSaleGfa, saleGfa × absRate);
//         remSaleGfa = max(0, remSaleGfa − sold).
// Once remSaleGfa < 0.01, sale revenue = 0.
// F-RE-Sale: 10000 / (10000 × 0.35) ≈ 2.857 years → depletes by year 3.
// =====================================================================
describe('B20 — sale revenue depletion (RE engine)', () => {
  const out = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
  const ops = out.cash_flows.filter(r => r.phase === 'Operations')

  test('B20.1: F-RE-Sale year 4+ revenue = 0 (inventory fully sold by year 3)', () => {
    for (let i = 3; i < ops.length; i++) {
      expect(ops[i].revenue).toBe(0)
    }
  })

  test('B20.2: F-RE-Sale total units sold across all years = saleGfa (mass conservation)', () => {
    // Per-year sold = revenue / (salePrice × (1+priceEsc)^(op-1))
    const salePrice = 1200
    const priceEsc = 0.025
    let totalSold = 0
    ops.forEach((r, i) => {
      if (r.revenue > 0) {
        const unitPrice = salePrice * Math.pow(1 + priceEsc, i)  // i = op - 1
        totalSold += r.revenue / unitPrice
      }
    })
    const saleGfa = 10_000  // F-RE-Sale: gfa × efficiency × saleSplit = 10000 × 1.0 × 1.0
    expect(totalSold).toBeCloseTo(saleGfa, 0)
  })
})

// =====================================================================
// B21 — Tax behavior (RE engine)
// Engine: tax = Math.max(0, pbt × taxRate)
// Asymmetric: positive PBT taxed at flat rate; negative PBT → tax = 0;
// no loss carry-forward (see memory: annual_engine_no_tax_nol.md).
// Default taxRate = 0.20.
// =====================================================================
describe('B21 — tax behavior (RE engine)', () => {
  const taxRate = 0.20

  test('B21.1: F-RE-Sale year-1 (positive pbt) — tax = pbt × taxRate', () => {
    const out = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
    const ops = out.cash_flows.filter(r => r.phase === 'Operations')
    expect(ops[0].pbt).toBeGreaterThan(0)
    expect(ops[0].tax).toBeCloseTo(ops[0].pbt * taxRate, 1)
  })

  test('B21.2: F-RE-Rental — negative-pbt years have tax = 0 (no NOL credit)', () => {
    const out = runEngine(F_RE_RENTAL_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
    const ops = out.cash_flows.filter(r => r.phase === 'Operations')
    const negPbtRows = ops.filter(r => r.pbt < 0)
    expect(negPbtRows.length).toBeGreaterThan(0)  // sanity: ramp years have negative pbt
    negPbtRows.forEach(r => {
      expect(r.tax).toBe(0)
    })
  })

  test('B21.3: F-RE-Sale — when revenue = 0 (depleted), pbt ≤ 0 and tax = 0', () => {
    const out = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
    const ops = out.cash_flows.filter(r => r.phase === 'Operations')
    ops.filter(r => r.revenue === 0).forEach(r => {
      expect(r.pbt).toBeLessThanOrEqual(0)
      expect(r.tax).toBe(0)
    })
  })
})

// =====================================================================
// Helper: clone F-RE-Sale assumptions with date overrides for B22 tests
// =====================================================================
function withDates(csDateStr, osDateStr) {
  return F_RE_SALE_ASSUMPTIONS.map(a => {
    if (a.name === 'Construction Start Date') return { ...a, value: null, unit: csDateStr }
    if (a.name === 'Operations Start Date')   return { ...a, value: null, unit: osDateStr }
    return a
  })
}

// Helper: clone F-RE-Sale with Project Life Years override (or removal)
function withLifeYears(lifeYears) {
  if (lifeYears === undefined) {
    return F_RE_SALE_ASSUMPTIONS.filter(a => a.name !== 'Project Life Years')
  }
  return F_RE_SALE_ASSUMPTIONS.map(a =>
    a.name === 'Project Life Years' ? { ...a, value: lifeYears } : a
  )
}

// =====================================================================
// B22 — Construction years derived from dates (RE engine)
// Engine logic (lines 69-75):
//   var constrYrs = 2  // default
//   if (csDate && osDate && csDate.length > 4 && osDate.length > 4) {
//     var diff = (new Date(osDate) - new Date(csDate)) / (1000 * 60 * 60 * 24)
//     constrYrs = Math.max(1, Math.round(diff / 365))
//   }
// - Both dates required, both with length > 4 (4 chars or fewer falls through).
// - Rounded to nearest year, clamped to a minimum of 1.
// =====================================================================
describe('B22 — construction years derived from dates (RE engine)', () => {
  test('B22.1: 1-year date diff → constrYrs = 1', () => {
    const out = runEngine(withDates('2024-01-01', '2025-01-01'), F_RE_SALE_DEFAULTS)
    expect(out.construction_years).toBe(1)
  })

  test('B22.2: 5-year date diff → constrYrs = 5', () => {
    const out = runEngine(withDates('2024-01-01', '2029-01-01'), F_RE_SALE_DEFAULTS)
    expect(out.construction_years).toBe(5)
  })

  test('B22.3: same-date diff (0 days) → constrYrs = 1 (clamped from 0)', () => {
    const out = runEngine(withDates('2024-01-01', '2024-01-01'), F_RE_SALE_DEFAULTS)
    expect(out.construction_years).toBe(1)
  })

  test('B22.4: missing dates → constrYrs = 2 (engine default)', () => {
    const assumptions = F_RE_SALE_ASSUMPTIONS.filter(
      a => a.name !== 'Construction Start Date' && a.name !== 'Operations Start Date'
    )
    const out = runEngine(assumptions, F_RE_SALE_DEFAULTS)
    expect(out.construction_years).toBe(2)
  })

  test('B22.5: short-string dates (length ≤ 4) bypass parser → constrYrs = 2 (default)', () => {
    // Engine guard `csDate.length > 4` means strings of length 4 or less fall through
    const out = runEngine(withDates('N/A', 'TBD'), F_RE_SALE_DEFAULTS)
    expect(out.construction_years).toBe(2)
  })
})

// =====================================================================
// B23 — opsYrs = max(1, lifeYears - constrYrs) clamp (RE engine)
// Engine: var opsYrs = Math.max(1, lifeYears - constrYrs)
// Project Life Years uses `|| 20` fallback when assumption missing
// (note: 0 hits the falsy fallback — see annual_engine_falsy_fallback.md).
// =====================================================================
describe('B23 — opsYrs clamp behavior (RE engine)', () => {
  test('B23.1: lifeYears = constrYrs (life=2, constr=2) → opsYrs = 1 (clamp floor)', () => {
    // Use 2yr dates and life=2 → diff = 0 → max(1, 0) = 1
    const assumptions = withLifeYears(2).map(a => {
      if (a.name === 'Construction Start Date') return { ...a, value: null, unit: '2024-01-01' }
      if (a.name === 'Operations Start Date')   return { ...a, value: null, unit: '2026-01-01' }
      return a
    })
    const out = runEngine(assumptions, F_RE_SALE_DEFAULTS)
    expect(out.construction_years).toBe(2)
    expect(out.operations_years).toBe(1)
  })

  test('B23.2: lifeYears < constrYrs (life=1, constr=2) → opsYrs = 1 (negative clamped)', () => {
    // life - constr = -1; max(1, -1) = 1
    const assumptions = withLifeYears(1)
    const out = runEngine(assumptions, F_RE_SALE_DEFAULTS)
    expect(out.construction_years).toBe(2)
    expect(out.operations_years).toBe(1)
  })

  test('B23.3: missing Project Life Years → fallback to 20, opsYrs = 20 - constrYrs = 18', () => {
    const assumptions = withLifeYears(undefined)  // removes the assumption entry
    const out = runEngine(assumptions, F_RE_SALE_DEFAULTS)
    expect(out.construction_years).toBe(2)         // dates still drive this
    expect(out.operations_years).toBe(18)          // fallback life 20 minus 2
    expect(out.cash_flows.length).toBe(20)
  })
})

// =====================================================================
// B24 — Capitalized interest factor scaling (RE engine)
// Engine: capFactor = (1 + debtRate)^constrYrs
//         saleDebt   = debt × saleSplit   × capFactor
//         rentalDebt = debt × rentalSplit × capFactor
// Capitalizes interest during construction at the senior debt rate.
// =====================================================================
describe('B24 — capitalized interest factor scaling (RE engine)', () => {
  const debt = 5_733_000  // TPC × 70%
  const debtRate = 0.085

  test('B24.1: F-RE-Sale (2-yr construction) — saleDebt = debt × (1+r)^2', () => {
    const out = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
    const ops = out.cash_flows.filter(r => r.phase === 'Operations')
    const capFactor = Math.pow(1 + debtRate, 2)
    const expectedSaleDebt = debt * 1.0 * capFactor
    // Year-1 interest = capitalized saleDebt × debtRate
    expect(ops[0].interest).toBeCloseTo(expectedSaleDebt * debtRate, CURR_DP)
  })

  test('B24.2: 5-yr construction — capFactor = (1+r)^5 → year-1 interest scales accordingly', () => {
    const assumptions = withDates('2024-01-01', '2029-01-01')  // 5-yr build
    const out = runEngine(assumptions, F_RE_SALE_DEFAULTS)
    const ops = out.cash_flows.filter(r => r.phase === 'Operations')
    const capFactor5 = Math.pow(1 + debtRate, 5)
    const expectedSaleDebt5 = debt * 1.0 * capFactor5
    expect(out.construction_years).toBe(5)
    expect(ops[0].interest).toBeCloseTo(expectedSaleDebt5 * debtRate, CURR_DP)
  })

  test('B24.3: ratio (5-yr year-1 interest / 2-yr year-1 interest) = (1+r)^3', () => {
    const out2yr = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
    const out5yr = runEngine(withDates('2024-01-01', '2029-01-01'), F_RE_SALE_DEFAULTS)
    const int2 = out2yr.cash_flows.filter(r => r.phase === 'Operations')[0].interest
    const int5 = out5yr.cash_flows.filter(r => r.phase === 'Operations')[0].interest
    const ratio = int5 / int2
    const expected = Math.pow(1 + debtRate, 3)  // (1.085)^5 / (1.085)^2 = (1.085)^3
    expect(ratio).toBeCloseTo(expected, RATIO_DP)
  })
})

// =====================================================================
// P4 — Edge cases & robustness
// Helper: override a default value (with epsilon-defeat for falsy fallbacks)
// =====================================================================
function overrideDefault(key, value) {
  return F_RE_SALE_DEFAULTS.map(d =>
    d.key === key ? { ...d, value } : d
  )
}
function setAssumption(name, value) {
  return F_RE_SALE_ASSUMPTIONS.map(a =>
    a.name === name ? { ...a, value } : a
  )
}

// =====================================================================
// B25 — Zero GFA (degenerate project)
// gfa=0 → tdc=0 → all sizing collapses. Engine should run cleanly and
// produce all-zero output without dividing by zero.
// =====================================================================
describe('B25 — zero GFA degenerate project', () => {
  const out = runEngine(setAssumption('GFA', 0), F_RE_SALE_DEFAULTS)

  test('B25.1: zero GFA → all sizing fields are 0', () => {
    expect(out.tdc).toBe(0)
    expect(out.equity_amount).toBe(0)
    expect(out.debt_amount).toBe(0)
  })

  test('B25.2: zero GFA → all ops rows have revenue=0 and opex=0', () => {
    out.cash_flows.filter(r => r.phase === 'Operations').forEach(r => {
      expect(r.revenue).toBe(0)
      expect(r.opex).toBe(0)
      expect(r.interest).toBe(0)
      expect(r.principal).toBe(0)
    })
  })

  test('B25.3: zero GFA → IRR is null (no positive CFs, no sign change)', () => {
    expect(out.irr).toBeNull()
  })

  test('B25.4: zero GFA → engine returns valid output shape (does not crash)', () => {
    expect(out).toBeDefined()
    expect(Array.isArray(out.cash_flows)).toBe(true)
    expect(typeof out.construction_years).toBe('number')
  })
})

// =====================================================================
// B26 — Zero debt (fully equity financed)
// Uses F_NO_DEBT_ASSUMPTIONS (1e-7 epsilon to defeat `||` fallback).
// Engine's outstanding > 0.01 thresholds then treat debt as zero.
// All operating cash flows should accrue to equity without amortization.
// =====================================================================
describe('B26 — zero debt fully equity financed', () => {
  const out = runEngine(F_NO_DEBT_ASSUMPTIONS, F_RE_SALE_DEFAULTS)

  test('B26.1: zero debt → equity > 0 and debt ≈ 0', () => {
    expect(out.equity_amount).toBeGreaterThan(0)
    expect(out.debt_amount).toBeLessThan(1)  // epsilon: TPC × 1e-9 ≈ 0.008
  })

  test('B26.2: zero debt → equity_multiple > 1 (no debt drag, equity gets all CF)', () => {
    expect(out.equity_multiple).toBeGreaterThan(1)
  })

  test('B26.3: zero debt → IRR is positive (sale project without debt drag profits)', () => {
    expect(out.irr).not.toBeNull()
    expect(out.irr).toBeGreaterThan(0)
  })
})

// =====================================================================
// B27 — 100% debt (zero equity, fully levered)
// Variant: Equity %=1e-7 epsilon, Senior Debt %=100. Construction year-0
// equity outflow is essentially just the arrangement fee.
// =====================================================================
describe('B27 — 100% debt fully levered', () => {
  const F_FULL_DEBT_ASSUMPTIONS = F_RE_SALE_ASSUMPTIONS.map(a => {
    if (a.name === 'Equity %')      return { ...a, value: 1e-7 }
    if (a.name === 'Senior Debt %') return { ...a, value: 100 }
    return a
  })
  const out = runEngine(F_FULL_DEBT_ASSUMPTIONS, F_RE_SALE_DEFAULTS)

  test('B27.1: full debt → equity ≈ 0 (within 1 JOD)', () => {
    expect(out.equity_amount).toBeLessThan(1)
  })

  test('B27.2: full debt → debt ≈ TPC = 8,190,000', () => {
    expect(out.debt_amount).toBeCloseTo(8_190_000, 0)
  })

  test('B27.3: full debt → engine returns numeric output (does not crash)', () => {
    expect(out).toBeDefined()
    expect(Number.isFinite(out.npv)).toBe(true)
    // IRR may or may not be null depending on convergence — just check no crash
  })
})

// =====================================================================
// B28 — Capital structure does not sum to 100% (underfunded)
// Engine reads equityPct and seniorDebtPct independently — does NOT
// validate they sum to 1.0. A 30/50 fixture leaves 20% of TPC silently
// unfunded; equity + debt < TPC. UI catches this; the engine does not.
// =====================================================================
describe('B28 — capital structure < 100% (underfunded, engine does not enforce)', () => {
  const F_UNDERFUNDED_ASSUMPTIONS = F_RE_SALE_ASSUMPTIONS.map(a => {
    if (a.name === 'Equity %')      return { ...a, value: 30 }
    if (a.name === 'Senior Debt %') return { ...a, value: 50 }
    return a
  })
  const out = runEngine(F_UNDERFUNDED_ASSUMPTIONS, F_RE_SALE_DEFAULTS)

  test('B28.1: equity + debt < TPC (engine produces a 20% funding gap silently)', () => {
    const totalSources = out.equity_amount + out.debt_amount
    expect(totalSources).toBeCloseTo(out.tdc * 0.80, 0)  // 30% + 50% = 80% of TPC
    expect(totalSources).toBeLessThan(out.tdc)
  })

  test('B28.2: underfunded fixture → engine runs without error', () => {
    expect(out).toBeDefined()
    expect(Array.isArray(out.cash_flows)).toBe(true)
  })
})

// =====================================================================
// B29 — Absorption rate > 100% (inventory clears in year 1)
// Engine: sold = min(remSaleGfa, saleGfa × absRate). An absRate > 1 still
// caps sold at remaining inventory, so all GFA clears in year 1.
// =====================================================================
describe('B29 — absorption rate above 100%', () => {
  const out = runEngine(
    F_RE_SALE_ASSUMPTIONS,
    overrideDefault('sales_absorption_rate_pct_per_year', 1.5)
  )
  const ops = out.cash_flows.filter(r => r.phase === 'Operations')

  test('B29.1: absRate=1.5 → year 1 revenue clears all saleGfa = 10000 × 1200 = 12,000,000', () => {
    expect(ops[0].revenue).toBeCloseTo(12_000_000, CURR_DP)
  })

  test('B29.2: absRate>1 → years 2+ have revenue = 0 (inventory depleted)', () => {
    for (let i = 1; i < ops.length; i++) {
      expect(ops[i].revenue).toBe(0)
    }
  })
})

// =====================================================================
// B30 — Zero-revenue project
// Construct via F-RE-Rental + rentYield = 1e-9 (epsilon defeats `||`
// fallback). Operating revenue ≈ 0 but debt service still runs full
// → all CFs negative → IRR null.
// =====================================================================
describe('B30 — zero-revenue project', () => {
  const out = runEngine(
    F_RE_RENTAL_ASSUMPTIONS,
    overrideDefault('rental_yield_residential', 1e-9)
  )
  const ops = out.cash_flows.filter(r => r.phase === 'Operations')

  test('B30.1: zero rental yield → ops revenue ≈ 0 (effectively negligible)', () => {
    // With rentYield = 1e-9, unrounded revenue per year is ~0.007 to 0.02 JOD;
    // after r2() rounding some years land at exactly 0.01 or 0.02. Asserting
    // "well below 1 JOD" is the right "effectively zero" test.
    ops.forEach(r => {
      expect(r.revenue).toBeLessThan(1)
    })
  })

  test('B30.2: zero-revenue + active debt service → all ops equity_cf are negative', () => {
    ops.forEach(r => {
      expect(r.equity_cf).toBeLessThan(0)
    })
  })

  test('B30.3: all-negative CFs → irrCalc returns null (no sign change)', () => {
    expect(out.irr).toBeNull()
  })
})

// =====================================================================
// B31 — Very high interest rate (50%)
// Tests stress on the financing math. capFactor balloons; year-1 interest
// dwarfs EBITDA; cash sweep cannot retire debt; DSCR collapses.
// =====================================================================
describe('B31 — very high interest rate (50%)', () => {
  const out = runEngine(
    F_RE_SALE_ASSUMPTIONS,
    overrideDefault('senior_debt_interest_rate', 0.50)
  )
  const ops = out.cash_flows.filter(r => r.phase === 'Operations')

  test('B31.1: 50% rate → engine returns valid numeric output', () => {
    expect(out).toBeDefined()
    expect(typeof out.npv).toBe('number')
    expect(Number.isFinite(out.npv)).toBe(true)
  })

  test('B31.2: 50% rate → year-1 interest is ~10× the 8.5% baseline', () => {
    const baseline = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
    const baselineInt = baseline.cash_flows.filter(r => r.phase === 'Operations')[0].interest
    // (5733000 × 1.5^2 × 0.5) / (5733000 × 1.085^2 × 0.085)
    // = (1.5^2 × 0.5) / (1.085^2 × 0.085)
    // ≈ 1.125 / 0.10 ≈ 11.25× — well above 5×
    expect(ops[0].interest).toBeGreaterThan(baselineInt * 5)
  })

  test('B31.3: 50% rate → year-1 DSCR < 1 (debt service exceeds EBITDA)', () => {
    expect(ops[0].dscr).not.toBeNull()
    expect(ops[0].dscr).toBeLessThan(1)
  })
})

// =====================================================================
// B32 — Very long project life (50 years)
// Stress test: engine should produce a 50-year timeline without numerical
// overflow, infinite loop, or NaN cascade.
// =====================================================================
describe('B32 — very long project life (50 years)', () => {
  const out = runEngine(setAssumption('Project Life Years', 50), F_RE_SALE_DEFAULTS)

  test('B32.1: 50-yr life → cash_flows.length = constrYrs (2) + opsYrs (48) = 50', () => {
    expect(out.cash_flows.length).toBe(50)
  })

  test('B32.2: 50-yr life → all year values are finite (no NaN/Infinity)', () => {
    out.cash_flows.forEach(r => {
      expect(Number.isFinite(r.revenue)).toBe(true)
      expect(Number.isFinite(r.opex)).toBe(true)
      expect(Number.isFinite(r.interest)).toBe(true)
      expect(Number.isFinite(r.equity_cf)).toBe(true)
    })
  })

  test('B32.3: 50-yr life → most years past depletion + debt-retirement are zero CFs', () => {
    const ops = out.cash_flows.filter(r => r.phase === 'Operations')
    const zeroOps = ops.filter(r =>
      r.revenue === 0 && r.opex === 0 && r.interest === 0 && r.equity_cf === 0
    )
    expect(zeroOps.length).toBeGreaterThan(40)  // sale-only depletes year 3, debt retired, leaving ~45 zero years
  })
})

// =====================================================================
// B33 — Missing optional fields / defaults
// Engine uses `getDefault(...) || X` and `getVal(...) || X` fallbacks
// extensively. Empty defaults table → all `|| X` defaults fire.
// Empty assumptions → engine falls back to internal defaults for all.
// (See annual_engine_falsy_fallback.md for the falsy-fallback quirk.)
// =====================================================================
describe('B33 — missing optional fields / defaults', () => {
  test('B33.1: runEngine([], F_RE_SALE_DEFAULTS) → engine does not crash; produces empty-project shape', () => {
    const out = runEngine([], F_RE_SALE_DEFAULTS)
    expect(out).toBeDefined()
    expect(Array.isArray(out.cash_flows)).toBe(true)
    // Empty assumptions → GFA=0 (getVal returns null → || 0) → all sizes 0
    expect(out.tdc).toBe(0)
  })

  test('B33.2: runEngine(F_RE_SALE_ASSUMPTIONS, []) → engine uses all internal default fallbacks', () => {
    // Because F_RE_SALE_DEFAULTS values exactly match the engine's `|| X` defaults,
    // running with empty defaults should produce an identical output.
    const withDefaults    = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
    const withoutDefaults = runEngine(F_RE_SALE_ASSUMPTIONS, [])
    expect(withoutDefaults.tdc).toBe(withDefaults.tdc)
    expect(withoutDefaults.equity_amount).toBe(withDefaults.equity_amount)
    expect(withoutDefaults.debt_amount).toBe(withDefaults.debt_amount)
    expect(withoutDefaults.irr).toBe(withDefaults.irr)
    expect(withoutDefaults.npv).toBe(withDefaults.npv)
    expect(withoutDefaults.equity_multiple).toBe(withDefaults.equity_multiple)
  })

  test('B33.3: runEngine([], []) → fully degenerate (zero project), engine still runs', () => {
    const out = runEngine([], [])
    expect(out).toBeDefined()
    expect(out.tdc).toBe(0)
    expect(out.irr).toBeNull()
    expect(out.cash_flows.length).toBeGreaterThan(0)  // still has constr+ops rows, just all zero
  })
})
