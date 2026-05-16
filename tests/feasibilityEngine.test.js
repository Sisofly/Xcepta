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
  runEngine, runPPPEngine, computeRequiredPayment,
  computePPPBankability, PPP_DSCR_FLOOR, PPP_IRR_HURDLE,
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
// B28 — Capital structure must sum to 100% (F08 fix, 2026-05-16)
//
// Before the fix, runEngine read equityPct and seniorDebtPct independently
// and did NOT validate they sum to 1.0 — a 30/50 fixture silently left
// 20% of TPC unfunded. After the F08 fix, runEngine throws a deterministic
// error with code='CAPITAL_STRUCTURE_INVALID' when |sum − 100%| > 0.01 pp.
//
// Tolerance: ±0.01 percentage-points (=1e-4 fraction-space). Wider than the
// UI guard's 1e-6; UI fires first as a friendly precheck, engine is
// defense in depth.
//
// Side-effect of honoring the user's spec (100/0 and 0/100 must pass):
// the validation reads raw values via `=== null` check, so explicit zero
// is respected for Equity % and Senior Debt %. This is a narrow F01
// carve-out for these two fields only; F01 falsy-fallback on the other
// ~16 inputs is unchanged in this batch.
// =====================================================================
describe('B28 — capital structure validation (engine throws on sum ≠ 100%)', () => {
  // Helper: build an underfunded / overfunded assumption set
  function withCapStructure(eqPct, sdPct) {
    return F_RE_SALE_ASSUMPTIONS.map(a => {
      if (a.name === 'Equity %')      return { ...a, value: eqPct }
      if (a.name === 'Senior Debt %') return { ...a, value: sdPct }
      return a
    })
  }

  test('B28.1: underfunded 30/50 (sum 80%) → throws CAPITAL_STRUCTURE_INVALID', () => {
    expect(() => runEngine(withCapStructure(30, 50), F_RE_SALE_DEFAULTS))
      .toThrow(/CAPITAL_STRUCTURE_INVALID/)
  })

  test('B28.2: thrown error carries machine-readable diagnostic fields', () => {
    try {
      runEngine(withCapStructure(30, 50), F_RE_SALE_DEFAULTS)
      throw new Error('runEngine should have thrown')
    } catch (e) {
      expect(e.code).toBe('CAPITAL_STRUCTURE_INVALID')
      expect(e.equity_pct).toBe(30)
      expect(e.senior_debt_pct).toBe(50)
      expect(e.sum).toBe(80)
    }
  })

  test('B28.3: overfunded 60/50 (sum 110%) → throws CAPITAL_STRUCTURE_INVALID', () => {
    expect(() => runEngine(withCapStructure(60, 50), F_RE_SALE_DEFAULTS))
      .toThrow(/CAPITAL_STRUCTURE_INVALID/)
  })

  test('B28.4: 40/40 underfunded (sum 80%) → throws CAPITAL_STRUCTURE_INVALID', () => {
    expect(() => runEngine(withCapStructure(40, 40), F_RE_SALE_DEFAULTS))
      .toThrow(/CAPITAL_STRUCTURE_INVALID/)
  })

  test('B28.5: 100/0 boundary valid (all-equity, explicit zero on debt) → runs', () => {
    // Explicit zero on Senior Debt % is now respected (narrow F01 carve-out).
    // Sum = 100 exact; engine must produce a valid output.
    const out = runEngine(withCapStructure(100, 0), F_RE_SALE_DEFAULTS)
    expect(out).toBeDefined()
    expect(Array.isArray(out.cash_flows)).toBe(true)
    expect(out.equity_amount).toBeCloseTo(out.tdc * 1.0, CURR_DP)
    expect(out.debt_amount).toBeCloseTo(0, CURR_DP)
  })

  test('B28.6: 0/100 boundary valid (all-debt, explicit zero on equity) → runs', () => {
    const out = runEngine(withCapStructure(0, 100), F_RE_SALE_DEFAULTS)
    expect(out).toBeDefined()
    expect(Array.isArray(out.cash_flows)).toBe(true)
    expect(out.equity_amount).toBeCloseTo(0, CURR_DP)
    expect(out.debt_amount).toBeCloseTo(out.tdc * 1.0, CURR_DP)
  })

  test('B28.7: within tolerance — 30 / 69.995 (sum 99.995, gap 0.005 pp) → runs', () => {
    // Comfortably inside the ±0.01 pp window. (Note: 30 + 69.99 sometimes
    // evaluates to 99.989999...01 in IEEE 754, putting gap slightly above
    // 0.01 pp; using 69.995 keeps the test deterministic across hosts.)
    const out = runEngine(withCapStructure(30, 69.995), F_RE_SALE_DEFAULTS)
    expect(out).toBeDefined()
  })

  test('B28.8: just outside tolerance — 30 / 69.98 (sum 99.98, gap 0.02 pp) → throws', () => {
    expect(() => runEngine(withCapStructure(30, 69.98), F_RE_SALE_DEFAULTS))
      .toThrow(/CAPITAL_STRUCTURE_INVALID/)
  })

  test('B28.9: F_NO_DEBT_ASSUMPTIONS (100 + 1e-7) → runs (well inside tolerance)', () => {
    // Regression guard for the ε-debt fixture used by B8.4, B11.3, B12.4, B53.
    const out = runEngine(F_NO_DEBT_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
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
//
// CAPITAL-STRUCTURE NOTE (after F08 fix, 2026-05-16):
// Equity % and Senior Debt % now use a null-aware fallback to 0 (aligned
// with the UI guard in handleApprove / handleApproveScenario). The old
// internal defaults (30 / 60) were themselves a silent funding-gap source
// (sum 90%) and have been removed. Empty assumptions now produce 0 + 0 = 0,
// which fails the F08 sum-to-100% validation; runEngine throws
// CAPITAL_STRUCTURE_INVALID before any output is produced. B33.1 and B33.3
// lock the new throw behavior; B33.2 still runs because F_RE_SALE_ASSUMPTIONS
// provides 30/70 explicitly (sum 100%).
// (See annual_engine_falsy_fallback.md for the broader falsy-fallback quirk.)
// =====================================================================
describe('B33 — missing optional fields / defaults', () => {
  test('B33.1: runEngine([], F_RE_SALE_DEFAULTS) → throws CAPITAL_STRUCTURE_INVALID', () => {
    // Empty assumptions → Equity % and Senior Debt % both default to 0
    // (null-aware fallback). Sum 0 + 0 = 0 fails F08 validation → throws.
    expect(() => runEngine([], F_RE_SALE_DEFAULTS))
      .toThrow(/CAPITAL_STRUCTURE_INVALID/)
  })

  test('B33.2: runEngine(F_RE_SALE_ASSUMPTIONS, []) → engine uses all internal default fallbacks', () => {
    // F_RE_SALE_ASSUMPTIONS supplies Equity %=30 / Senior Debt %=70 explicitly,
    // so F08 validation passes. F_RE_SALE_DEFAULTS values match the engine's
    // `|| X` defaults for all *other* fields, so output should match.
    const withDefaults    = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS)
    const withoutDefaults = runEngine(F_RE_SALE_ASSUMPTIONS, [])
    expect(withoutDefaults.tdc).toBe(withDefaults.tdc)
    expect(withoutDefaults.equity_amount).toBe(withDefaults.equity_amount)
    expect(withoutDefaults.debt_amount).toBe(withDefaults.debt_amount)
    expect(withoutDefaults.irr).toBe(withDefaults.irr)
    expect(withoutDefaults.npv).toBe(withDefaults.npv)
    expect(withoutDefaults.equity_multiple).toBe(withDefaults.equity_multiple)
  })

  test('B33.3: runEngine([], []) → throws CAPITAL_STRUCTURE_INVALID (same root cause as B33.1)', () => {
    // Same as B33.1: missing Equity %/Senior Debt % → null-aware fallback
    // to 0/0 → sum 0 → fails F08 validation → throws.
    expect(() => runEngine([], []))
      .toThrow(/CAPITAL_STRUCTURE_INVALID/)
  })
})

// ═════════════════════════════════════════════════════════════════════
// P5 — PPP Engine Validation (B34–B43)
//
// All tests in P5 target runPPPEngine() from annualEngine.js. The engine
// reads PPP assumptions via pppVal() — a null-aware Number coercion
// helper — and then applies `|| default` fallbacks. The same falsy-
// fallback pattern as runEngine() applies here too (an explicit 0
// collapses to the default, since 0 is falsy).
//
// Engine math is NOT modified — these are pure validation tests.
//
// Sections:
//   B34 — Base scenario sanity (sizing, timeline, cf-row shape)
//   B35 — Grace-period principal behavior
//   B36 — DSCR uses CFADS (ebitda − tax), not EBITDA
//   B37 — Fixed OPEX override (`OPEX Amount (JOD)`)
//   B38 — Zero-debt PPP (falsy-fallback finding + ε workaround)
//   B39 — Construction-month → years rounding (ceil)
//   B40 — 13-mo construction → 2 yr (reinforcement)
//   B41 — Long concession stress (99-year)
//   B42 — Debt amortization completion (Σ principal = debt_amount)
//   B43 — DSCR null when totalDS ≤ 1 JOD threshold
//
// B44 / B45 are BLOCKED. computeRequiredPayment lives in
// src/pages/FeasibilityProject.jsx and is not exported from
// annualEngine.js. See blocked-section placeholder at end of file.
// ═════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// Fixture: P-PPP-Base
// 100M JOD concession PPP, 80/20 debt/equity, 24-mo construction,
// 25-yr concession, 12M JOD/yr availability payment, 10-yr loan with
// 2-yr grace at 7%. Used as baseline by B34–B43.
//
// Note: at this baseline, annual debt service after grace (~13.4M)
// exceeds the 12M availability payment, so DSCR < 1 in repayment
// years. That's fine — P5 tests validate engine mechanics, not
// bankability. (B44/B45 would test the DSCR solver.)
// ─────────────────────────────────────────────────────────────────────
const P_PPP_BASE_ASSUMPTIONS = [
  { name: 'Total Project Cost',          value: 100000000, unit: 'JOD' },
  { name: 'Debt %',                      value: 80,        unit: 'percent' },
  { name: 'Equity %',                    value: 20,        unit: 'percent' },
  { name: 'Annual Availability Payment', value: 12000000,  unit: 'JOD/yr' },
  { name: 'Concession Period',           value: 25,        unit: 'years' },
  { name: 'Construction Period',         value: 24,        unit: 'months' },
  { name: 'OPEX % of Revenue',           value: 5,         unit: 'percent' },
  { name: 'Interest Rate',               value: 7,         unit: 'percent' },
  { name: 'Loan Tenor',                  value: 10,        unit: 'years' },
  { name: 'Grace Period',                value: 2,         unit: 'years' },
  { name: 'Tax Rate',                    value: 20,        unit: 'percent' },
  { name: 'WACC',                        value: 10,        unit: 'percent' },
]

// Helper: clone baseline with one or more field overrides.
function pppWith(overrides) {
  return P_PPP_BASE_ASSUMPTIONS.map(a => {
    if (Object.prototype.hasOwnProperty.call(overrides, a.name)) {
      return { ...a, value: overrides[a.name] }
    }
    return a
  })
}

// =====================================================================
// B34 — PPP base scenario sanity
// Locks down sizing, timeline, and cash-flow row shape for the baseline
// concession scenario.
// =====================================================================
describe('B34 — PPP base scenario sanity', () => {
  const out = runPPPEngine(P_PPP_BASE_ASSUMPTIONS)

  test('B34.1: TDC/debt/equity sizing at 80/20 of 100M', () => {
    expect(out.tdc).toBeCloseTo(100_000_000, CURR_DP)
    expect(out.debt_amount).toBeCloseTo(80_000_000, CURR_DP)
    expect(out.equity_amount).toBeCloseTo(20_000_000, CURR_DP)
  })

  test('B34.2: construction_years = 2 (ceil(24/12)), operations_years = 25', () => {
    expect(out.construction_years).toBe(2)
    expect(out.operations_years).toBe(25)
  })

  test('B34.3: cash_flows has 27 rows (2 constr + 25 ops)', () => {
    expect(out.cash_flows.length).toBe(27)
  })

  test('B34.4: construction rows are zero-revenue with even equity draw & capex split', () => {
    const constrRows = out.cash_flows.filter(r => r.phase === 'Construction')
    expect(constrRows.length).toBe(2)
    constrRows.forEach(r => {
      expect(r.revenue).toBe(0)
      expect(r.opex).toBe(0)
      expect(r.interest).toBe(0)
      expect(r.principal).toBe(0)
      expect(r.equity_cf).toBeCloseTo(-10_000_000, CURR_DP)  // 20M / 2 yrs
      expect(r.capex).toBeCloseTo(50_000_000, CURR_DP)        // 100M / 2 yrs
      expect(r.dscr).toBeNull()
    })
  })

  test('B34.5: irr, npv, equity_multiple are populated finite numbers', () => {
    expect(typeof out.irr).toBe('number')
    expect(typeof out.npv).toBe('number')
    expect(typeof out.equity_multiple).toBe('number')
    expect(Number.isFinite(out.irr)).toBe(true)
    expect(Number.isFinite(out.npv)).toBe(true)
    expect(out.equity_multiple).toBeGreaterThan(0)
  })
})

// =====================================================================
// B35 — Grace-period principal behavior
// During grace (op ≤ gracePeriodYrs), principal=0 regardless of cash
// availability. Interest still accrues on the full outstanding balance.
// Outstanding debt is unchanged through grace.
// =====================================================================
describe('B35 — grace-period principal behavior', () => {
  const out = runPPPEngine(P_PPP_BASE_ASSUMPTIONS)
  const opsRows = out.cash_flows.filter(r => r.phase === 'Operations')

  test('B35.1: principal = 0 for ops years 1 and 2 (grace = 2); > 0 for year 3', () => {
    expect(opsRows[0].principal).toBe(0)
    expect(opsRows[1].principal).toBe(0)
    expect(opsRows[2].principal).toBeGreaterThan(0)  // first post-grace
  })

  test('B35.2: interest each grace year = debt × rate (balance unchanged through grace)', () => {
    const expectedInterest = r2(80_000_000 * 0.07)  // 5,600,000
    expect(opsRows[0].interest).toBeCloseTo(expectedInterest, CURR_DP)
    expect(opsRows[1].interest).toBeCloseTo(expectedInterest, CURR_DP)
    // Op 3 interest is still on full 80M (no principal yet repaid)
    expect(opsRows[2].interest).toBeCloseTo(expectedInterest, CURR_DP)
  })

  test('B35.3: first post-grace principal = annuity − interest', () => {
    const annuityAmt = annuity(80_000_000, 0.07, 8)  // tenor − grace = 8
    const expectedPrincipal = r2(annuityAmt - r2(80_000_000 * 0.07))
    expect(opsRows[2].principal).toBeCloseTo(expectedPrincipal, CURR_DP)
  })
})

// =====================================================================
// B36 — DSCR uses CFADS (ebitda − tax), not EBITDA
// PPP engine computes:
//   cfads   = ebitda − tax
//   dscr    = totalDS > 1 ? cfads / totalDS : null
// Distinguishes the engine from a naive EBITDA / DS metric that ignores
// tax leakage from CFADS.
// =====================================================================
describe('B36 — DSCR uses CFADS, not EBITDA', () => {
  const out = runPPPEngine(P_PPP_BASE_ASSUMPTIONS)
  const opsRows = out.cash_flows.filter(r => r.phase === 'Operations')

  test('B36.1: engine dscr matches r2((ebitda − tax) / (interest + principal))', () => {
    // Ops year 3 — first post-grace year with positive tax & debt service
    const row = opsRows[2]
    const cfads   = row.ebitda - row.tax
    const totalDS = row.interest + row.principal
    const expected = r2(cfads / totalDS)
    expect(row.dscr).toBeCloseTo(expected, RATIO_DP)
  })

  test('B36.2: engine dscr < ebitda/DS in a year with positive tax (CFADS strictly tighter)', () => {
    const row = opsRows[2]
    const totalDS = row.interest + row.principal
    const ebitdaDscr = row.ebitda / totalDS
    expect(row.tax).toBeGreaterThan(0)
    expect(row.dscr).toBeLessThan(ebitdaDscr)
  })
})

// =====================================================================
// B37 — Fixed OPEX override (`OPEX Amount (JOD)`)
// Engine:
//   var opexFixed   = pppVal(assumptions, 'OPEX Amount (JOD)')
//   var useFixedOpex = opexFixed !== null && opexFixed > 0
// When set and > 0  → opex = fixed (regardless of revenue/opex%)
// When 0            → useFixedOpex=false → revenue × opex%
// When null/absent  → pppVal returns null → revenue × opex%
// =====================================================================
describe('B37 — fixed OPEX override', () => {
  test('B37.1: OPEX Amount > 0 overrides percentage opex in every ops year', () => {
    const FIXED_OPEX = 2_500_000
    const fixedAssumps = P_PPP_BASE_ASSUMPTIONS.concat([
      { name: 'OPEX Amount (JOD)', value: FIXED_OPEX, unit: 'JOD' },
    ])
    const out = runPPPEngine(fixedAssumps)
    const opsRows = out.cash_flows.filter(r => r.phase === 'Operations')
    opsRows.forEach(r => {
      expect(r.opex).toBeCloseTo(FIXED_OPEX, CURR_DP)
    })
  })

  test('B37.2: OPEX Amount = 0 falls back to revenue × opex% (useFixedOpex requires > 0)', () => {
    const zeroFixed = P_PPP_BASE_ASSUMPTIONS.concat([
      { name: 'OPEX Amount (JOD)', value: 0, unit: 'JOD' },
    ])
    const out = runPPPEngine(zeroFixed)
    const expectedOpex = r2(12_000_000 * 0.05)  // 600,000
    out.cash_flows.filter(r => r.phase === 'Operations').forEach(r => {
      expect(r.opex).toBeCloseTo(expectedOpex, CURR_DP)
    })
  })

  test('B37.3: OPEX Amount absent → revenue × opex% (5% default)', () => {
    const out = runPPPEngine(P_PPP_BASE_ASSUMPTIONS)  // no OPEX Amount field
    const expectedOpex = r2(12_000_000 * 0.05)
    out.cash_flows.filter(r => r.phase === 'Operations').forEach(r => {
      expect(r.opex).toBeCloseTo(expectedOpex, CURR_DP)
    })
  })
})

// =====================================================================
// B38 — Zero-debt PPP
// Same falsy-fallback quirk as runEngine: explicit `Debt %` = 0
// collapses to the engine default (80). Tiny positive epsilon defeats
// the fallback AND drives debt below the engine's 0.01 hasDebt floor.
// =====================================================================
describe('B38 — zero-debt PPP (falsy-fallback + ε workaround)', () => {
  test('B38.1: ENGINE QUIRK — setting Debt %=0 collapses to default 80%', () => {
    const out = runPPPEngine(pppWith({ 'Debt %': 0 }))
    // (0 || 80) / 100 = 0.8 → debt = 100M * 0.8 = 80M (falsy fallback)
    expect(out.debt_amount).toBeCloseTo(80_000_000, CURR_DP)
  })

  test('B38.2: tiny ε on Debt % drives effective zero-debt (no interest, no principal, null DSCR)', () => {
    // Debt % = 1e-9 → debt = 100M * (1e-9 / 100) = 1e-3 JOD < 0.01 floor.
    // hasDebt = false in every ops year → interest=0, principal=0.
    const out = runPPPEngine(pppWith({ 'Debt %': 1e-9, 'Equity %': 100 }))
    const opsRows = out.cash_flows.filter(r => r.phase === 'Operations')
    opsRows.forEach(r => {
      expect(r.interest).toBe(0)
      expect(r.principal).toBe(0)
      expect(r.dscr).toBeNull()
    })
    expect(out.dscr_series.length).toBe(0)
  })
})

// =====================================================================
// B39 — Construction-month → years rounding
// constrYears = max(1, ceil(constrMonths / 12))
// Verifies the rounding boundary behavior.
// (Note: constrMonths=0 is unreachable — pppVal returns 0 → ||24 fires.)
// =====================================================================
describe('B39 — construction-month rounding', () => {
  test('B39.1: ceil(months/12) maps months to construction_years', () => {
    const cases = [
      { months: 1,  expected: 1 },
      { months: 11, expected: 1 },
      { months: 12, expected: 1 },
      { months: 13, expected: 2 },
      { months: 24, expected: 2 },
      { months: 25, expected: 3 },
      { months: 36, expected: 3 },
      { months: 37, expected: 4 },
    ]
    cases.forEach(c => {
      const out = runPPPEngine(pppWith({ 'Construction Period': c.months }))
      expect(out.construction_years).toBe(c.expected)
    })
  })
})

// =====================================================================
// B40 — 13-month construction → 2 years (reinforcement)
// Specific edge case from B39 with deeper structural assertions.
// =====================================================================
describe('B40 — 13-month construction → 2 years', () => {
  const out = runPPPEngine(pppWith({ 'Construction Period': 13 }))

  test('B40.1: construction_years = 2', () => {
    expect(out.construction_years).toBe(2)
  })

  test('B40.2: cash_flows[0..1] = Construction, cash_flows[2] = Operations', () => {
    expect(out.cash_flows[0].phase).toBe('Construction')
    expect(out.cash_flows[1].phase).toBe('Construction')
    expect(out.cash_flows[2].phase).toBe('Operations')
  })

  test('B40.3: Σ construction equity_cf = −equity_amount', () => {
    const constrRows = out.cash_flows.filter(r => r.phase === 'Construction')
    const sumEqCF = constrRows.reduce((s, r) => s + r.equity_cf, 0)
    expect(sumEqCF).toBeCloseTo(-out.equity_amount, CURR_DP)
  })
})

// =====================================================================
// B41 — Long concession stress (99-year)
// Engine must handle long concessions without crashing or producing
// non-finite values. Years past debt-retirement (op > loanTenor) are
// debt-free steady-state and excluded from dscr_series.
// =====================================================================
describe('B41 — long concession (99-year)', () => {
  const out = runPPPEngine(pppWith({ 'Concession Period': 99 }))

  test('B41.1: operations_years = 99 and cash_flows.length = constr + 99', () => {
    expect(out.operations_years).toBe(99)
    expect(out.cash_flows.length).toBe(out.construction_years + 99)
  })

  test('B41.2: irr and npv are finite numbers', () => {
    expect(Number.isFinite(out.irr)).toBe(true)
    expect(Number.isFinite(out.npv)).toBe(true)
  })

  test('B41.3: post-tenor ops years (op > 10) are debt-free (interest=0, principal=0, dscr=null)', () => {
    const opsRows = out.cash_flows.filter(r => r.phase === 'Operations')
    for (let i = 10; i < opsRows.length; i++) {  // op=11.. → index 10..
      expect(opsRows[i].interest).toBe(0)
      expect(opsRows[i].principal).toBe(0)
      expect(opsRows[i].dscr).toBeNull()
    }
  })
})

// =====================================================================
// B42 — Debt amortization completion
// Annuity is sized over (tenor − grace) = 8 years. Post-grace ops years
// 3..10 should fully amortize the debt. Σ principal ≈ debt_amount;
// year 11+ is debt-free.
// =====================================================================
describe('B42 — debt amortization completion', () => {
  const out = runPPPEngine(P_PPP_BASE_ASSUMPTIONS)
  const opsRows = out.cash_flows.filter(r => r.phase === 'Operations')

  test('B42.1: at ops year 11 (post-tenor), interest=0 and principal=0', () => {
    expect(opsRows[10].interest).toBe(0)
    expect(opsRows[10].principal).toBe(0)
  })

  test('B42.2: Σ principal across all ops years ≈ debt_amount (within ±1 JOD)', () => {
    const sumPrincipal = opsRows.reduce((s, r) => s + r.principal, 0)
    expect(sumPrincipal).toBeCloseTo(out.debt_amount, 0)  // 0dp ≈ ±0.5 JOD
  })

  test('B42.3: no operations row has negative principal (Math.max clamp at 0)', () => {
    opsRows.forEach(r => {
      expect(r.principal).toBeGreaterThanOrEqual(0)
    })
  })
})

// =====================================================================
// B43 — DSCR null when totalDS ≤ 1 JOD
// Engine: dscr = totalDS > 1 ? r2(cfads/totalDS) : null
// Years where interest+principal ≤ 1 JOD (e.g. post-amortization when
// hasDebt=false) yield dscr=null and are excluded from dscr_series.
// =====================================================================
describe('B43 — DSCR null when totalDS ≤ 1 JOD', () => {
  const out = runPPPEngine(P_PPP_BASE_ASSUMPTIONS)
  const opsRows = out.cash_flows.filter(r => r.phase === 'Operations')

  test('B43.1: post-amortization ops years (op > 10) have dscr=null', () => {
    for (let i = 10; i < opsRows.length; i++) {
      expect(opsRows[i].dscr).toBeNull()
    }
  })

  test('B43.2: dscr_series only includes years with totalDS > 1 (ops 1..10)', () => {
    expect(out.dscr_series.length).toBe(10)
    out.dscr_series.forEach(d => {
      expect(d.year).toBeGreaterThanOrEqual(1)
      expect(d.year).toBeLessThanOrEqual(10)
      expect(d.dscr).not.toBeNull()
    })
  })
})

// ═════════════════════════════════════════════════════════════════════
// P5 — PPP Engine Validation (Part 2)
// B44–B45: computeRequiredPayment (DSCR solver)
//
// computeRequiredPayment is a linear search over the annual payment:
//   - starts at currentPayment, steps +10,000 JOD per iteration
//   - max 2000 iterations
//   - returns the first payment where runPPPEngine yields minDSCR ≥ target
//
// Solver semantics (after Fix Batch 1B / F05 + F06, 2026-05-16):
//   - Tests payments at currentPayment + i*step for i = 0..1999
//   - Returns a structured object with five fields:
//       converged          : boolean
//       required_payment   : number (always an actually-evaluated value)
//       payment_gap        : number (required_payment − currentPayment)
//       target_dscr        : number (target after the falsy-fallback)
//       achieved_min_dscr  : number | null (engine minDSCR at last test)
//   - converged=true iff the loop broke because minDSCR ≥ target
//   - converged=false iff the iteration cap was exhausted. required_payment
//     in that case is the LAST tested value (currentPayment + 1999*step),
//     NOT one step past (F06 fix: increment is suppressed at i=1999).
//   - Default target = 1.20 when targetDSCR is null/undefined/0
//     (falsy-fallback: `var target = targetDSCR || 1.20`)
//
// Extracted from FeasibilityProject.jsx in commit be79d46 (2026-05-15).
// API hardened (F05 + F06) in Fix Batch 1B (2026-05-16).
// ═════════════════════════════════════════════════════════════════════

// =====================================================================
// B44 — computeRequiredPayment achievable target
// Baseline P_PPP_BASE has minDSCR ≈ 0.69 (last repayment year), so
// target=1.20 requires solver iteration; target=0.5 is already
// satisfied.
// =====================================================================
describe('B44 — computeRequiredPayment achievable target', () => {
  const BASE_PAYMENT = 12_000_000  // matches P_PPP_BASE_ASSUMPTIONS

  // Helper: run runPPPEngine at a specific payment value and return minDSCR
  function minDscrAt(payment) {
    const tested = P_PPP_BASE_ASSUMPTIONS.map(a =>
      a.name === 'Annual Availability Payment'
        ? { ...a, value: payment }
        : a
    )
    const out = runPPPEngine(tested)
    const dscrs = out.dscr_series
      .filter(d => d.dscr !== null)
      .map(d => d.dscr)
    return dscrs.length ? Math.min.apply(null, dscrs) : null
  }

  test('B44.1: returned payment, fed back into engine, achieves minDSCR ≥ target; converged=true', () => {
    const TARGET = 1.20
    const result = computeRequiredPayment(P_PPP_BASE_ASSUMPTIONS, TARGET)
    expect(result.required_payment).toBeGreaterThan(BASE_PAYMENT)
    expect(minDscrAt(result.required_payment)).toBeGreaterThanOrEqual(TARGET)
    expect(result.converged).toBe(true)
  })

  test('B44.2: payment_gap = required_payment − currentPayment', () => {
    const result = computeRequiredPayment(P_PPP_BASE_ASSUMPTIONS, 1.20)
    expect(result.payment_gap).toBe(result.required_payment - BASE_PAYMENT)
  })

  test('B44.3: default target = 1.20 when targetDSCR omitted; target_dscr is reported', () => {
    const withoutArg  = computeRequiredPayment(P_PPP_BASE_ASSUMPTIONS)
    const withDefault = computeRequiredPayment(P_PPP_BASE_ASSUMPTIONS, 1.20)
    expect(withoutArg.required_payment).toBe(withDefault.required_payment)
    expect(withoutArg.payment_gap).toBe(withDefault.payment_gap)
    expect(withoutArg.target_dscr).toBe(1.20)
    expect(withDefault.target_dscr).toBe(1.20)
  })

  test('B44.4: if currentPayment already meets target, returns it unchanged (gap=0); converged=true', () => {
    // Baseline minDSCR ≈ 0.69 at op=10, so target=0.5 is already satisfied.
    const result = computeRequiredPayment(P_PPP_BASE_ASSUMPTIONS, 0.5)
    expect(result.required_payment).toBe(BASE_PAYMENT)
    expect(result.payment_gap).toBe(0)
    expect(result.converged).toBe(true)
  })

  test('B44.5: payment_gap is a non-negative integer multiple of step (10,000)', () => {
    const result = computeRequiredPayment(P_PPP_BASE_ASSUMPTIONS, 1.20)
    expect(result.payment_gap).toBeGreaterThanOrEqual(0)
    expect(result.payment_gap % 10_000).toBe(0)
  })

  test('B44.6: on convergence, achieved_min_dscr ≥ target_dscr (and is the engine value at exit)', () => {
    const TARGET = 1.20
    const result = computeRequiredPayment(P_PPP_BASE_ASSUMPTIONS, TARGET)
    expect(result.converged).toBe(true)
    expect(result.achieved_min_dscr).not.toBeNull()
    expect(result.achieved_min_dscr).toBeGreaterThanOrEqual(result.target_dscr)
    // Cross-check: feeding required_payment back into the engine
    // reproduces achieved_min_dscr (within rounding).
    expect(minDscrAt(result.required_payment))
      .toBeCloseTo(result.achieved_min_dscr, RATIO_DP)
  })

  test('B44.7: API surface — result has the full structured shape', () => {
    const result = computeRequiredPayment(P_PPP_BASE_ASSUMPTIONS, 1.20)
    expect(result).toHaveProperty('converged')
    expect(result).toHaveProperty('required_payment')
    expect(result).toHaveProperty('payment_gap')
    expect(result).toHaveProperty('target_dscr')
    expect(result).toHaveProperty('achieved_min_dscr')
    expect(typeof result.converged).toBe('boolean')
    expect(typeof result.required_payment).toBe('number')
    expect(typeof result.payment_gap).toBe('number')
    expect(typeof result.target_dscr).toBe('number')
    // achieved_min_dscr is number on any non-degenerate run, null only if
    // every iteration's dscr_series was empty (not the case at baseline).
    expect(result.achieved_min_dscr === null || typeof result.achieved_min_dscr === 'number').toBe(true)
  })
})

// =====================================================================
// B45 — computeRequiredPayment unreachable target  (post Fix Batch 1B)
//
// Target=5.0 requires payment ≈ 88M, way beyond the budget of
// currentPayment + 1999*10K ≈ 31.99M from a 12M base. Solver exhausts
// its 2000-iteration budget without ever achieving minDSCR ≥ target.
//
// After Fix Batch 1B (F05 + F06):
//   - converged is false
//   - required_payment is the LAST tested value (currentPayment + 1999*step),
//     no longer one step past (F06 fix)
//   - achieved_min_dscr reports the engine's minDSCR at the last iteration
// =====================================================================
describe('B45 — computeRequiredPayment unreachable target', () => {
  const BASE_PAYMENT          = 12_000_000
  const STEP                  = 10_000
  const MAX_ITERATIONS        = 2000
  const LAST_TESTED_OFFSET    = (MAX_ITERATIONS - 1) * STEP   // 1999 × 10K = 19,990,000
  const UNREACHABLE           = 5.0

  function minDscrAt(payment) {
    const tested = P_PPP_BASE_ASSUMPTIONS.map(a =>
      a.name === 'Annual Availability Payment'
        ? { ...a, value: payment }
        : a
    )
    const out = runPPPEngine(tested)
    const dscrs = out.dscr_series
      .filter(d => d.dscr !== null)
      .map(d => d.dscr)
    return dscrs.length ? Math.min.apply(null, dscrs) : null
  }

  test('B45.1: unreachable target → converged=false, required_payment is last tested value', () => {
    // F05 + F06: converged flag must be false. required_payment is
    // currentPayment + (maxIterations − 1) × step — the value at the
    // final iteration, NOT one step past (which was the legacy bug).
    const result = computeRequiredPayment(P_PPP_BASE_ASSUMPTIONS, UNREACHABLE)
    expect(result.converged).toBe(false)
    expect(result.required_payment).toBe(BASE_PAYMENT + LAST_TESTED_OFFSET)
    expect(result.payment_gap).toBe(LAST_TESTED_OFFSET)
  })

  test('B45.2: required_payment, fed back into engine, matches achieved_min_dscr (F06: was actually tested)', () => {
    // F06: required_payment is now an actually-evaluated value, so the
    // engine's minDSCR at required_payment must match achieved_min_dscr
    // within rounding. Pre-fix this would have been a value the engine
    // never saw.
    const result = computeRequiredPayment(P_PPP_BASE_ASSUMPTIONS, UNREACHABLE)
    expect(result.converged).toBe(false)
    const reEvaluated = minDscrAt(result.required_payment)
    expect(reEvaluated).not.toBeNull()
    expect(reEvaluated).toBeLessThan(UNREACHABLE)
    expect(reEvaluated).toBeCloseTo(result.achieved_min_dscr, RATIO_DP)
  })

  test('B45.3: one step below required_payment also fails target (confirms budget exhaustion, not edge-case exit)', () => {
    // Confirms the solver exhausted its 2000-iteration budget rather
    // than hitting an early-exit edge case. Testing a second high-
    // payment value (one step below the returned one) shows the engine
    // was genuinely unable to reach the target across multiple inputs.
    const result = computeRequiredPayment(P_PPP_BASE_ASSUMPTIONS, UNREACHABLE)
    const oneStepBelow = result.required_payment - STEP
    const minDSCR = minDscrAt(oneStepBelow)
    expect(minDSCR).not.toBeNull()
    expect(minDSCR).toBeLessThan(UNREACHABLE)
  })

  test('B45.4: F05 — achieved_min_dscr is the engine value at exit and is strictly below target_dscr', () => {
    const result = computeRequiredPayment(P_PPP_BASE_ASSUMPTIONS, UNREACHABLE)
    expect(result.converged).toBe(false)
    expect(result.target_dscr).toBe(UNREACHABLE)
    expect(result.achieved_min_dscr).not.toBeNull()
    expect(result.achieved_min_dscr).toBeLessThan(result.target_dscr)
  })
})

// ═════════════════════════════════════════════════════════════════════
// P6 — PPP Bankability Validation
// B46–B49: computePPPBankability
//
// computePPPBankability(modelOutput, dscrFloor) derives a bankability
// verdict from stored engine output. Pure function — does not re-run
// the PPP engine; reads irr, npv, dscr_series, and cash_flows.
//
// Gate logic (annualEngine.js):
//   irrOk  = irr !== null && irr >= PPP_IRR_HURDLE (10%)
//   npvOk  = npv !== null && npv >= 0
//   dscrOk = minDSCR === null || minDSCR >= floor
//   failures = count of [!irrOk, !npvOk, !dscrOk]
//
// Recommendation tiers:
//   failures=0   → "Proceed"
//   failures=1   → "Proceed with Conditions"
//   failures≥2   → "Do Not Proceed"
//
// dscrFloor guard (not a plain ||, but shares the falsy-0 effect):
//   floor = (dscrFloor != null && dscrFloor > 0) ? dscrFloor : PPP_DSCR_FLOOR
//   → dscrFloor=0 collapses to PPP_DSCR_FLOOR=1.20 (FINDING B46.11)
//
// SSV / liquidity logic (cash_flows ops rows):
//   constrCount = count of phase==='Construction' rows
//   annualOpex  = first positive opex on an ops row
//   liquidityThreshold = annualOpex / 4
//   ssvBalance accumulates equity_cf during trapped years (dscr < floor),
//   resets to 0 on non-trapped years; warning fires when
//   liquidityThreshold > 0 && ssvBalance < liquidityThreshold.
//   FINDING (B48.3): ssvBalance resets to 0 on every non-trapped year;
//   0 < threshold → warning fires on ALL ops years when opex > 0.
//
// Year convention (same as runPPPEngine):
//   construction cash_flows: year=0, 1, ..., constrYears-1
//   operations   cash_flows: year=constrYears + op - 1  (op = 1..opsYears)
//   dscr_series:             { year: op }  (ops-relative, 1-indexed)
//
// Extracted from FeasibilityProject.jsx in commit be79d46 (2026-05-15).
// ═════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// Synthetic modelOutput builder — mirrors runPPPEngine return shape
// ─────────────────────────────────────────────────────────────────────
function makeBankabilityInput({ irr = null, npv = null, dscrSeries = [], cashFlows = [] } = {}) {
  return { irr, npv, dscr_series: dscrSeries, cash_flows: cashFlows }
}

// Build a cash_flows array: 2 construction rows (years 0,1) + ops rows
// from opsSpecs.  Each opsSpec: { dscr, equity_cf, opex }.
// Ops row year: 2 + index (matching runPPPEngine convention for constrYears=2).
function makeOpsFlows(opsSpecs) {
  const constr = [
    { phase: 'Construction', year: 0, opex: 0, equity_cf: -10_000_000, dscr: null },
    { phase: 'Construction', year: 1, opex: 0, equity_cf: -10_000_000, dscr: null },
  ]
  const ops = opsSpecs.map((s, i) => ({
    phase: 'Operations',
    year: 2 + i,               // total year (0-indexed; matches constrYears=2 convention)
    opex:     s.opex     ?? 0,
    equity_cf: s.equity_cf ?? 0,
    dscr:     s.dscr     ?? null,
  }))
  return [...constr, ...ops]
}

// =====================================================================
// B46 — Bankability gates: IRR, NPV, DSCR thresholds
// Tests each gate independently with synthetic modelOutput objects for
// precise boundary control.  Integration test (B46.12) uses the actual
// runPPPEngine output to confirm the plumbing is wired correctly.
// =====================================================================
describe('B46 — bankability gates: IRR, NPV, DSCR thresholds', () => {
  test('B46.1: null modelOutput returns null', () => {
    expect(computePPPBankability(null)).toBeNull()
  })

  test('B46.2: irr = PPP_IRR_HURDLE (10) → irrOk=true', () => {
    const m = makeBankabilityInput({ irr: PPP_IRR_HURDLE, npv: 0 })
    expect(computePPPBankability(m).irrOk).toBe(true)
  })

  test('B46.3: irr just below hurdle (9.99) → irrOk=false', () => {
    const m = makeBankabilityInput({ irr: 9.99, npv: 0 })
    expect(computePPPBankability(m).irrOk).toBe(false)
  })

  test('B46.4: irr=null → irrOk=false', () => {
    const m = makeBankabilityInput({ irr: null, npv: 0 })
    expect(computePPPBankability(m).irrOk).toBe(false)
  })

  test('B46.5: npv=0 (at boundary) → npvOk=true', () => {
    const m = makeBankabilityInput({ irr: PPP_IRR_HURDLE, npv: 0 })
    expect(computePPPBankability(m).npvOk).toBe(true)
  })

  test('B46.6: npv=-1 → npvOk=false', () => {
    const m = makeBankabilityInput({ irr: PPP_IRR_HURDLE, npv: -1 })
    expect(computePPPBankability(m).npvOk).toBe(false)
  })

  test('B46.7: empty dscr_series → minDSCR=null → dscrOk=true (no-debt path)', () => {
    const m = makeBankabilityInput({ irr: PPP_IRR_HURDLE, npv: 0 })
    const b = computePPPBankability(m)
    expect(b.minDSCR).toBeNull()
    expect(b.dscrOk).toBe(true)
  })

  test('B46.8: minDSCR = PPP_DSCR_FLOOR exactly (1.20) → dscrOk=true', () => {
    const m = makeBankabilityInput({
      irr: PPP_IRR_HURDLE, npv: 0,
      dscrSeries: [{ year: 1, dscr: PPP_DSCR_FLOOR }],
    })
    expect(computePPPBankability(m).dscrOk).toBe(true)
  })

  test('B46.9: minDSCR just below floor (1.19) → dscrOk=false', () => {
    const m = makeBankabilityInput({
      irr: PPP_IRR_HURDLE, npv: 0,
      dscrSeries: [{ year: 1, dscr: 1.19 }],
    })
    expect(computePPPBankability(m).dscrOk).toBe(false)
  })

  test('B46.10: custom dscrFloor=1.30 overrides default 1.20', () => {
    const m = makeBankabilityInput({
      irr: PPP_IRR_HURDLE, npv: 0,
      dscrSeries: [{ year: 1, dscr: 1.25 }],   // 1.25 ≥ 1.20 but < 1.30
    })
    expect(computePPPBankability(m).dscrOk).toBe(true)         // default floor=1.20
    expect(computePPPBankability(m, 1.30).dscrOk).toBe(false)  // custom floor=1.30
  })

  test('B46.11: FINDING — dscrFloor=0 collapses to PPP_DSCR_FLOOR=1.20', () => {
    // Guard: (dscrFloor != null && dscrFloor > 0) ? dscrFloor : PPP_DSCR_FLOOR
    // dscrFloor=0 → 0 > 0 is false → falls back to 1.20
    // Callers cannot pass 0 to mean "accept any DSCR".
    const m = makeBankabilityInput({
      irr: PPP_IRR_HURDLE, npv: 0,
      dscrSeries: [{ year: 1, dscr: 1.25 }],   // 1.25 ≥ 1.20 → dscrOk=true at default floor
    })
    const b = computePPPBankability(m, 0)
    expect(b.PPP_DSCR_FLOOR).toBe(PPP_DSCR_FLOOR)  // floor was reset to default 1.20
    expect(b.dscrOk).toBe(true)                      // treated as default, not as "floor=0"
  })

  test('B46.12: integration — runPPPEngine output feeds computePPPBankability correctly', () => {
    // Confirms the two functions are wired: engine output shape matches
    // what the bankability function expects.
    const pppOut = runPPPEngine(P_PPP_BASE_ASSUMPTIONS)
    const b = computePPPBankability(pppOut)
    expect(b).not.toBeNull()
    expect(b.PPP_IRR_HURDLE).toBe(PPP_IRR_HURDLE)   // constants threaded through
    expect(b.PPP_DSCR_FLOOR).toBe(PPP_DSCR_FLOOR)
    expect(typeof b.irrOk).toBe('boolean')
    expect(typeof b.npvOk).toBe('boolean')
    expect(typeof b.dscrOk).toBe('boolean')
    expect(typeof b.failures).toBe('number')
    expect(b.failures).toBeGreaterThanOrEqual(0)
    expect(b.failures).toBeLessThanOrEqual(3)
    expect(['Proceed', 'Proceed with Conditions', 'Do Not Proceed'])
      .toContain(b.recommendation)
  })

  test('B46.13: integration — baseline minDSCR from dscr_series matches bankability minDSCR', () => {
    // Confirms minDSCR is derived from Math.min of dscr_series (not cash_flows.dscr).
    const pppOut = runPPPEngine(P_PPP_BASE_ASSUMPTIONS)
    const dscrVals = pppOut.dscr_series.filter(d => d.dscr !== null).map(d => d.dscr)
    const expectedMin = Math.min.apply(null, dscrVals)
    const b = computePPPBankability(pppOut)
    expect(b.minDSCR).toBeCloseTo(expectedMin, RATIO_DP)
  })
})

// =====================================================================
// B47 — Cash-trap years when DSCR < floor
// cashTrapYears is derived from dscr_series (ops-relative year numbers),
// NOT from cash_flows.dscr.  Years at exactly floor are NOT trapped.
// =====================================================================
describe('B47 — cash-trap years (DSCR < floor)', () => {
  test('B47.1: no entries below floor → cashTrapYears=[]', () => {
    const m = makeBankabilityInput({
      dscrSeries: [
        { year: 1, dscr: 1.50 },
        { year: 2, dscr: 1.80 },
        { year: 3, dscr: 1.20 },   // exactly at floor
      ],
    })
    expect(computePPPBankability(m).cashTrapYears).toEqual([])
  })

  test('B47.2: years with dscr < floor appear in cashTrapYears', () => {
    const m = makeBankabilityInput({
      dscrSeries: [
        { year: 1, dscr: 0.80 },   // trapped
        { year: 2, dscr: 1.20 },   // exactly at floor — NOT trapped
        { year: 3, dscr: 1.50 },   // clear
        { year: 4, dscr: 0.95 },   // trapped
      ],
    })
    expect(computePPPBankability(m).cashTrapYears).toEqual([1, 4])
  })

  test('B47.3: dscr = PPP_DSCR_FLOOR exactly → NOT a trap year (strict <)', () => {
    const m = makeBankabilityInput({
      dscrSeries: [{ year: 5, dscr: PPP_DSCR_FLOOR }],
    })
    expect(computePPPBankability(m).cashTrapYears).toEqual([])
  })

  test('B47.4: null dscr entries in dscr_series excluded from trap calculation', () => {
    // dscr_series can contain null entries; only non-null < floor are trapped.
    const m = makeBankabilityInput({
      dscrSeries: [
        { year: 1, dscr: null },   // no debt service — excluded
        { year: 2, dscr: 0.80 },   // trapped
        { year: 3, dscr: 1.50 },   // clear
      ],
    })
    expect(computePPPBankability(m).cashTrapYears).toEqual([2])
  })

  test('B47.5: custom dscrFloor shifts the trap threshold', () => {
    const m = makeBankabilityInput({
      dscrSeries: [{ year: 3, dscr: 1.25 }],
    })
    // 1.25 is not a trap at default floor=1.20 but is a trap at floor=1.30
    expect(computePPPBankability(m).cashTrapYears).toEqual([])
    expect(computePPPBankability(m, 1.30).cashTrapYears).toEqual([3])
  })

  test('B47.6: all dscr_series entries below floor → all years trapped', () => {
    const m = makeBankabilityInput({
      dscrSeries: [
        { year: 1, dscr: 0.70 },
        { year: 2, dscr: 0.85 },
        { year: 3, dscr: 1.10 },
      ],
    })
    expect(computePPPBankability(m).cashTrapYears).toEqual([1, 2, 3])
  })

  test('B47.7: integration — baseline PPP cashTrapYears come from dscr_series (ops years 1..10)', () => {
    // Baseline payment=12M yields minDSCR ≈ 0.69 in the last repayment year
    // → at least one cash-trap year exists.
    const pppOut = runPPPEngine(P_PPP_BASE_ASSUMPTIONS)
    const b = computePPPBankability(pppOut)
    expect(b.cashTrapYears.length).toBeGreaterThan(0)
    // All trap years are within the ops range (1..opsYears)
    b.cashTrapYears.forEach(yr => {
      expect(yr).toBeGreaterThanOrEqual(1)
    })
  })
})

// =====================================================================
// B48 — Liquidity warnings when SSV balance < 3 months OPEX
//
// SSV (service-support-vehicle) logic in computePPPBankability:
//   constrCount         = count of phase==='Construction' rows
//   annualOpex          = first positive opex from ops rows (iteration stops)
//   liquidityThreshold  = annualOpex / 4   (≈ 3 months of opex)
//   ssvBalance          = accumulates equity_cf in trapped years
//                         resets to 0 on non-trapped years
//   warning when: liquidityThreshold > 0 && ssvBalance < liquidityThreshold
//
// Year fields in the warning:
//   ops_year   = r.year − constrCount + 1
//   total_year = r.year   (raw year from cash_flows row)
//   balance    = Math.round(ssvBalance)
//
// FINDING (B48.3): After every non-trapped year ssvBalance=0.
//   0 < liquidityThreshold (if opex > 0) → warning fires on EVERY
//   non-trapped ops year.  Warnings are not scoped to trap sequences.
// =====================================================================
describe('B48 — liquidity warnings (SSV balance < 3 months OPEX)', () => {
  const OPEX_AMT = 4_000_000          // annual opex → threshold = 1,000,000
  const THRESHOLD = OPEX_AMT / 4      // 1,000,000

  test('B48.1: liquidityThreshold = annualOpex / 4 (first positive ops opex)', () => {
    // Two ops rows: first has opex=0 (skipped), second has OPEX_AMT (anchors threshold)
    const cf = makeOpsFlows([
      { opex: 0,        equity_cf: 0, dscr: 2.00 },  // opex=0 → skipped by engine
      { opex: OPEX_AMT, equity_cf: 0, dscr: 2.00 },  // first positive → threshold=OPEX_AMT/4
    ])
    // No trapped years → all ssvBalance=0 < THRESHOLD → both rows warn
    const b = computePPPBankability(makeBankabilityInput({ cashFlows: cf }))
    // Threshold is OPEX_AMT/4 — confirmed by warnings present on rows with opex=OPEX_AMT
    expect(b.liquidityWarnings.length).toBeGreaterThan(0)
    // Row with opex=0 comes first — balance=0 but threshold=0 at that point,
    // so no warning yet; once threshold anchors on OPEX_AMT row, warnings fire.
    // The concrete check: all warnings have balance < THRESHOLD.
    b.liquidityWarnings.forEach(w => expect(w.balance).toBeLessThan(THRESHOLD))
  })

  test('B48.2: trapped year accumulates equity_cf in SSV; warning fires when balance < threshold', () => {
    const EQUITY_CF = 500_000   // positive equity CF during trap
    const cf = makeOpsFlows([
      { opex: OPEX_AMT, equity_cf: EQUITY_CF, dscr: 0.80 },  // trapped, ssvBalance=500K < 1M
    ])
    const b = computePPPBankability(makeBankabilityInput({ cashFlows: cf }))
    expect(b.liquidityWarnings.length).toBe(1)
    expect(b.liquidityWarnings[0].balance).toBe(Math.round(EQUITY_CF))   // 500,000
    expect(b.liquidityWarnings[0].balance).toBeLessThan(THRESHOLD)
  })

  test('B48.3: FINDING — non-trapped year resets ssvBalance=0; warning fires (0 < threshold)', () => {
    // Scenario: 1 trapped year followed by 3 free-cash years.
    // On each free year: ssvBalance=0 → 0 < THRESHOLD → warning fires.
    // Total warnings = 4 (trapped year + 3 non-trapped years all warn).
    const cf = makeOpsFlows([
      { opex: OPEX_AMT, equity_cf: 500_000,  dscr: 0.80 },  // trapped   → ssvBalance=500K, warning
      { opex: OPEX_AMT, equity_cf: 800_000,  dscr: 1.50 },  // not trapped → ssvBalance=0,  warning (FINDING)
      { opex: OPEX_AMT, equity_cf: 900_000,  dscr: 2.00 },  // not trapped → ssvBalance=0,  warning (FINDING)
      { opex: OPEX_AMT, equity_cf: 1_000_000, dscr: 2.50 }, // not trapped → ssvBalance=0,  warning (FINDING)
    ])
    const b = computePPPBankability(makeBankabilityInput({ cashFlows: cf }))
    // All 4 ops years generate warnings: 1 trapped + 3 non-trapped (balance=0 < 1M)
    expect(b.liquidityWarnings.length).toBe(4)
    // The three non-trapped years all report balance=0
    const nonTrapWarnings = b.liquidityWarnings.slice(1)
    nonTrapWarnings.forEach(w => expect(w.balance).toBe(0))
  })

  test('B48.4: annualOpex=0 → liquidityThreshold=0 → no warnings (guard: threshold > 0)', () => {
    // All ops rows have opex=0: annualOpex stays 0, threshold=0, guard prevents warnings.
    const cf = makeOpsFlows([
      { opex: 0, equity_cf: -200_000, dscr: 0.80 },  // trapped
      { opex: 0, equity_cf:  500_000, dscr: 2.00 },  // not trapped
    ])
    const b = computePPPBankability(makeBankabilityInput({ cashFlows: cf }))
    expect(b.liquidityWarnings).toEqual([])
  })

  test('B48.5: consecutive trapped years accumulate ssvBalance additively', () => {
    // Three trapped years: balances grow; once balance ≥ threshold, warning stops.
    const EQ = 400_000   // equity CF each trapped year
    const cf = makeOpsFlows([
      { opex: OPEX_AMT, equity_cf: EQ, dscr: 0.80 },   // balance=400K < 1M → warn
      { opex: OPEX_AMT, equity_cf: EQ, dscr: 0.80 },   // balance=800K < 1M → warn
      { opex: OPEX_AMT, equity_cf: EQ, dscr: 0.80 },   // balance=1200K ≥ 1M → no warn
    ])
    const b = computePPPBankability(makeBankabilityInput({ cashFlows: cf }))
    // Only first two trapped years are below threshold
    expect(b.liquidityWarnings.length).toBe(2)
    expect(b.liquidityWarnings[0].balance).toBe(EQ)           // 400,000
    expect(b.liquidityWarnings[1].balance).toBe(EQ + EQ)      // 800,000
  })

  test('B48.6: balance in warning is Math.round(ssvBalance) — integer cents dropped', () => {
    const FRACTIONAL_EQ = 333_333.33
    const cf = makeOpsFlows([
      { opex: OPEX_AMT, equity_cf: FRACTIONAL_EQ, dscr: 0.80 },  // trapped
    ])
    const b = computePPPBankability(makeBankabilityInput({ cashFlows: cf }))
    expect(b.liquidityWarnings.length).toBe(1)
    expect(b.liquidityWarnings[0].balance).toBe(Math.round(FRACTIONAL_EQ))
  })

  test('B48.7: warning ops_year and total_year computed from cash_flows row year', () => {
    // With 2 construction rows (year=0,1) and first ops row at year=2:
    //   ops_year   = 2 − 2 + 1 = 1
    //   total_year = 2
    const cf = makeOpsFlows([
      { opex: OPEX_AMT, equity_cf: 200_000, dscr: 0.80 },  // year=2, trapped → warns
    ])
    const b = computePPPBankability(makeBankabilityInput({ cashFlows: cf }))
    expect(b.liquidityWarnings.length).toBe(1)
    expect(b.liquidityWarnings[0].ops_year).toBe(1)
    expect(b.liquidityWarnings[0].total_year).toBe(2)
  })
})

// =====================================================================
// B49 — Recommendation tiers: Proceed / Conditions / Do Not Proceed
//
// Tier logic:
//   failures=0 → "Proceed"
//     investmentCase: irr > PPP_IRR_HURDLE*1.3 (>13) → "Strong Investment Case"
//                     else                            → "Acceptable Investment Case"
//     verdictColor:  '#3fb950'
//   failures=1 → "Proceed with Conditions"
//     investmentCase: "Acceptable Investment Case"
//     verdictColor:  '#d29922'
//   failures≥2 → "Do Not Proceed"
//     investmentCase: "Weak Investment Case"
//     verdictColor:  '#f85149'
// =====================================================================
describe('B49 — recommendation tiers: Proceed / Conditions / Do Not Proceed', () => {
  const STRONG_IRR_THRESHOLD = PPP_IRR_HURDLE * 1.3  // 13 — strong-case boundary

  // All-pass model: irr=15, npv=5M, minDSCR=1.50
  const allPass = makeBankabilityInput({
    irr: 15, npv: 5_000_000,
    dscrSeries: [{ year: 1, dscr: 1.50 }, { year: 2, dscr: 1.80 }],
  })

  // One-failure models (one gate fails, others pass)
  const failIrr  = makeBankabilityInput({ irr: 5,   npv: 5_000_000,  dscrSeries: [{ year: 1, dscr: 1.50 }] })
  const failNpv  = makeBankabilityInput({ irr: 15,  npv: -1_000_000, dscrSeries: [{ year: 1, dscr: 1.50 }] })
  const failDscr = makeBankabilityInput({ irr: 15,  npv: 5_000_000,  dscrSeries: [{ year: 1, dscr: 0.80 }] })

  // Two-failure model: irr fails, npv fails
  const failTwo  = makeBankabilityInput({ irr: 5,   npv: -1_000_000, dscrSeries: [{ year: 1, dscr: 1.50 }] })

  // Three-failure model: all fail
  const failAll  = makeBankabilityInput({ irr: 5,   npv: -1_000_000, dscrSeries: [{ year: 1, dscr: 0.80 }] })

  test('B49.1: 0 failures → recommendation="Proceed", failures=0', () => {
    const b = computePPPBankability(allPass)
    expect(b.recommendation).toBe('Proceed')
    expect(b.failures).toBe(0)
  })

  test('B49.2: 1 failure (irr) → "Proceed with Conditions"', () => {
    const b = computePPPBankability(failIrr)
    expect(b.recommendation).toBe('Proceed with Conditions')
    expect(b.failures).toBe(1)
  })

  test('B49.3: 1 failure (npv) → "Proceed with Conditions"', () => {
    const b = computePPPBankability(failNpv)
    expect(b.recommendation).toBe('Proceed with Conditions')
    expect(b.failures).toBe(1)
  })

  test('B49.4: 1 failure (dscr) → "Proceed with Conditions"', () => {
    const b = computePPPBankability(failDscr)
    expect(b.recommendation).toBe('Proceed with Conditions')
    expect(b.failures).toBe(1)
  })

  test('B49.5: 2 failures → "Do Not Proceed"', () => {
    const b = computePPPBankability(failTwo)
    expect(b.recommendation).toBe('Do Not Proceed')
    expect(b.failures).toBe(2)
  })

  test('B49.6: 3 failures → "Do Not Proceed"', () => {
    const b = computePPPBankability(failAll)
    expect(b.recommendation).toBe('Do Not Proceed')
    expect(b.failures).toBe(3)
  })

  test('B49.7: Proceed — irr > 13 (strong threshold) → "Strong Investment Case"', () => {
    const strong = makeBankabilityInput({
      irr: STRONG_IRR_THRESHOLD + 0.01,  // just above 13
      npv: 5_000_000, dscrSeries: [{ year: 1, dscr: 1.50 }],
    })
    const b = computePPPBankability(strong)
    expect(b.recommendation).toBe('Proceed')
    expect(b.investmentCase).toBe('Strong Investment Case')
  })

  test('B49.8: Proceed — irr = 13 (exactly at strong threshold, not >) → "Acceptable Investment Case"', () => {
    const acceptable = makeBankabilityInput({
      irr: STRONG_IRR_THRESHOLD,   // exactly 13 — irr > 13 is false
      npv: 5_000_000, dscrSeries: [{ year: 1, dscr: 1.50 }],
    })
    const b = computePPPBankability(acceptable)
    expect(b.recommendation).toBe('Proceed')
    expect(b.investmentCase).toBe('Acceptable Investment Case')
  })

  test('B49.9: Proceed with Conditions → "Acceptable Investment Case" regardless of irr', () => {
    // irr=15 (would be "Strong" at Proceed) but failures=1 → fixed "Acceptable"
    const b = computePPPBankability(failDscr)   // irr=15, only dscr fails
    expect(b.recommendation).toBe('Proceed with Conditions')
    expect(b.investmentCase).toBe('Acceptable Investment Case')
  })

  test('B49.10: Do Not Proceed → "Weak Investment Case"', () => {
    const b = computePPPBankability(failAll)
    expect(b.investmentCase).toBe('Weak Investment Case')
  })

  test('B49.11: verdictColor for Proceed = #3fb950', () => {
    expect(computePPPBankability(allPass).verdictColor).toBe('#3fb950')
  })

  test('B49.12: verdictColor for Proceed with Conditions = #d29922', () => {
    expect(computePPPBankability(failIrr).verdictColor).toBe('#d29922')
  })

  test('B49.13: verdictColor for Do Not Proceed = #f85149', () => {
    expect(computePPPBankability(failAll).verdictColor).toBe('#f85149')
  })

  test('B49.14: output always carries PPP_IRR_HURDLE and PPP_DSCR_FLOOR constants', () => {
    const b = computePPPBankability(allPass)
    expect(b.PPP_IRR_HURDLE).toBe(PPP_IRR_HURDLE)
    expect(b.PPP_DSCR_FLOOR).toBe(PPP_DSCR_FLOOR)
  })
})

// ═════════════════════════════════════════════════════════════════════
// P7 — Sensitivity & Monotonicity
// B50–B56
//
// Tests that runEngine and runPPPEngine outputs respond in the correct
// direction when individual inputs are varied, and that sensitivity
// grids contain no directional inversions.
//
// All assertions are relative (A < B < C) rather than absolute, so
// they remain valid even if engine math is later recalibrated.
//
// RE engine leverage note (B53):
//   The sale-debt cash-sweep model (principal = min(outstanding, netInc))
//   directs ALL equity cash flows to debt repayment until the capitalized
//   saleDebt is retired. At baseline (1200/sqm, 8.5%), this takes 2 full
//   ops years, leaving equity with only the year-3 surplus. Because that
//   surplus is less than the equity invested (EM ≈ 0.71, B12.3), the
//   baseline is a LOSS for equity. The unlevered investor (same project,
//   no debt) keeps all post-tax revenue → EM > 1. Negative leverage.
//   At 3000/sqm the debt repays in ops year 1; years 2–3 surplus flows
//   entirely to equity → levered EM >> unlevered EM. Positive leverage.
// ═════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// P7 helpers
// ─────────────────────────────────────────────────────────────────────

// Override a single key in the defaults array (non-mutating).
function withDefault(defs, key, val) {
  return defs.map(d => d.key === key ? { ...d, value: val } : d)
}

// Return the minimum DSCR from a runPPPEngine output object.
function pppMinDscr(out) {
  const vals = out.dscr_series.filter(d => d.dscr !== null).map(d => d.dscr)
  return vals.length ? Math.min.apply(null, vals) : null
}

// =====================================================================
// B50 — Higher sale price → higher IRR / NPV / EM
// Prices chosen above the project's equity-breakeven (~1500/sqm) so
// all three data points produce a positive EM and a computable IRR.
// =====================================================================
describe('B50 — sale price monotonically lifts IRR / NPV / EM', () => {
  const PRICES = [1500, 2000, 2500]   // JOD / sqm
  const outs = PRICES.map(p =>
    runEngine(
      F_RE_SALE_ASSUMPTIONS,
      withDefault(F_RE_SALE_DEFAULTS, 'sale_price_per_sqm_residential', p),
    )
  )

  test('B50.1: IRR is non-null and increases with sale price', () => {
    outs.forEach(o => expect(o.irr).not.toBeNull())
    expect(outs[0].irr).toBeLessThan(outs[1].irr)
    expect(outs[1].irr).toBeLessThan(outs[2].irr)
  })

  test('B50.2: NPV increases with sale price', () => {
    expect(outs[0].npv).toBeLessThan(outs[1].npv)
    expect(outs[1].npv).toBeLessThan(outs[2].npv)
  })

  test('B50.3: equity multiple (EM) increases with sale price', () => {
    expect(outs[0].equity_multiple).toBeLessThan(outs[1].equity_multiple)
    expect(outs[1].equity_multiple).toBeLessThan(outs[2].equity_multiple)
  })
})

// =====================================================================
// B51 — Higher construction cost → lower IRR / NPV / EM
// A sale price of 2000/sqm is used throughout to keep returns
// positive; monotonicity doesn't require positive IRR, but avoids
// the null-IRR edge cases that arise near breakeven.
// =====================================================================
describe('B51 — construction cost monotonically depresses IRR / NPV / EM', () => {
  const BASE_DEFS = withDefault(F_RE_SALE_DEFAULTS, 'sale_price_per_sqm_residential', 2000)
  const COSTS = [500, 650, 800]       // JOD / sqm
  const outs = COSTS.map(c =>
    runEngine(
      F_RE_SALE_ASSUMPTIONS,
      withDefault(BASE_DEFS, 'construction_cost_per_sqm_residential', c),
    )
  )

  test('B51.1: TPC (tdc field) increases with construction cost', () => {
    // Confirms the cost delta reaches the engine; validates other B51 tests.
    expect(outs[0].tdc).toBeLessThan(outs[1].tdc)
    expect(outs[1].tdc).toBeLessThan(outs[2].tdc)
  })

  test('B51.2: IRR decreases with construction cost', () => {
    expect(outs[0].irr).toBeGreaterThan(outs[1].irr)
    expect(outs[1].irr).toBeGreaterThan(outs[2].irr)
  })

  test('B51.3: NPV decreases with construction cost', () => {
    expect(outs[0].npv).toBeGreaterThan(outs[1].npv)
    expect(outs[1].npv).toBeGreaterThan(outs[2].npv)
  })

  test('B51.4: equity multiple (EM) decreases with construction cost', () => {
    expect(outs[0].equity_multiple).toBeGreaterThan(outs[1].equity_multiple)
    expect(outs[1].equity_multiple).toBeGreaterThan(outs[2].equity_multiple)
  })
})

// =====================================================================
// B52 — Higher interest rate → lower equity IRR / EM / NPV
// Revenue is fixed (sale price 2000/sqm). Rising debt rate raises
// capitalized saleDebt, increases interest expense each ops year,
// and delays full debt retirement — depressing equity returns.
// =====================================================================
describe('B52 — interest rate monotonically depresses equity IRR / EM / NPV', () => {
  const BASE_DEFS = withDefault(F_RE_SALE_DEFAULTS, 'sale_price_per_sqm_residential', 2000)
  const RATES = [0.05, 0.085, 0.12]   // 5%, 8.5%, 12%
  const outs = RATES.map(r =>
    runEngine(
      F_RE_SALE_ASSUMPTIONS,
      withDefault(BASE_DEFS, 'senior_debt_interest_rate', r),
    )
  )

  test('B52.1: equity IRR decreases as debt interest rate rises', () => {
    expect(outs[0].irr).toBeGreaterThan(outs[1].irr)
    expect(outs[1].irr).toBeGreaterThan(outs[2].irr)
  })

  test('B52.2: equity multiple (EM) decreases as debt interest rate rises', () => {
    expect(outs[0].equity_multiple).toBeGreaterThan(outs[1].equity_multiple)
    expect(outs[1].equity_multiple).toBeGreaterThan(outs[2].equity_multiple)
  })

  test('B52.3: NPV decreases as debt interest rate rises (equity CFs shrink; WACC fixed)', () => {
    // Higher debt interest → lower equity_cf → NPV at the constant discount
    // rate (WACC) falls.  WACC itself is not varied here — only debtRate.
    expect(outs[0].npv).toBeGreaterThan(outs[1].npv)
    expect(outs[1].npv).toBeGreaterThan(outs[2].npv)
  })
})

// =====================================================================
// B53 — Leverage lift: positive and negative leverage cases
//
// "Leverage sign" = levered_metric − unlevered_metric.
//   Positive leverage: levered IRR > unlevered IRR
//   Negative leverage: levered IRR < unlevered IRR
//
// Positive-leverage scenario (3000/sqm):
//   Debt retires in ops year 1; surplus flows entirely to equity for
//   years 2–3 → levered EM ≈ 6.7× vs unlevered EM ≈ 2.9×.
//
// Negative-leverage scenario (1200/sqm, baseline — FINDING):
//   Cash-sweep locks all equity CF into debt repayment for ops years 1–2.
//   Equity only recovers the year-3 residual, which is LESS than the
//   equity invested (EM ≈ 0.71, locked B12.3). The unlevered investor
//   earns a nominal gain on the same project (EM > 1) — confirming
//   that the baseline runs in negative-leverage territory.
// =====================================================================
describe('B53 — leverage lift (positive and negative)', () => {
  // ── Positive leverage: high-return project (3000/sqm) ──────────────
  const HIGH_DEFS   = withDefault(F_RE_SALE_DEFAULTS, 'sale_price_per_sqm_residential', 3000)
  const levHighOut  = runEngine(F_RE_SALE_ASSUMPTIONS, HIGH_DEFS)
  const unlHighOut  = runEngine(F_NO_DEBT_ASSUMPTIONS, HIGH_DEFS)

  test('B53.1: positive leverage — levered IRR > unlevered IRR at 3000/sqm', () => {
    expect(levHighOut.irr).not.toBeNull()
    expect(unlHighOut.irr).not.toBeNull()
    expect(levHighOut.irr).toBeGreaterThan(unlHighOut.irr)
  })

  test('B53.2: positive leverage — levered EM > unlevered EM at 3000/sqm', () => {
    expect(levHighOut.equity_multiple).toBeGreaterThan(unlHighOut.equity_multiple)
  })

  // ── Negative leverage: baseline (1200/sqm, 8.5%) — FINDING ─────────
  const levBaseOut  = runEngine(F_RE_SALE_ASSUMPTIONS, F_RE_SALE_DEFAULTS) // 70% debt, 8.5%
  const unlBaseOut  = runEngine(F_NO_DEBT_ASSUMPTIONS, F_RE_SALE_DEFAULTS) // ε-debt ≈ all-equity

  test('B53.3: FINDING — baseline shows negative leverage: levered EM < unlevered EM', () => {
    // levered EM ≈ 0.71 (equity loses money — locked B12.3)
    // unlevered EM > 1 (equity gains a nominal positive return)
    // The sale-debt cash-sweep directs all netInc to debt for ops years 1–2;
    // equity recovers only the year-3 residual, which is less than invested.
    expect(levBaseOut.equity_multiple).toBeLessThan(unlBaseOut.equity_multiple)
    expect(levBaseOut.equity_multiple).toBeLessThan(1.0)   // levered equity loses
    expect(unlBaseOut.equity_multiple).toBeGreaterThan(1.0) // unlevered equity gains
  })

  test('B53.4: FINDING — baseline levered NPV < unlevered NPV', () => {
    expect(levBaseOut.npv).toBeLessThan(unlBaseOut.npv)
  })

  test('B53.5: leverage sign flips between low-return (1200) and high-return (3000) scenarios', () => {
    // Low:  levered EM − unlevered EM < 0  (negative leverage)
    // High: levered EM − unlevered EM > 0  (positive leverage)
    const diffLow  = levBaseOut.equity_multiple - unlBaseOut.equity_multiple
    const diffHigh = levHighOut.equity_multiple - unlHighOut.equity_multiple
    expect(diffLow).toBeLessThan(0)
    expect(diffHigh).toBeGreaterThan(0)
  })
})

// =====================================================================
// B54 — PPP higher annual payment → higher IRR / NPV / minDSCR
// Payment drives all three simultaneously: revenue ↑ → EBITDA ↑ →
// CFADS ↑ → DSCR ↑ and equity_cf ↑ → IRR / NPV ↑.
// =====================================================================
describe('B54 — PPP annual payment monotonically lifts IRR / NPV / minDSCR', () => {
  const PAYMENTS = [10_000_000, 12_000_000, 15_000_000]  // JOD / yr
  const outs = PAYMENTS.map(p => runPPPEngine(pppWith({ 'Annual Availability Payment': p })))

  test('B54.1: IRR is non-null and increases with annual availability payment', () => {
    outs.forEach(o => expect(o.irr).not.toBeNull())
    expect(outs[0].irr).toBeLessThan(outs[1].irr)
    expect(outs[1].irr).toBeLessThan(outs[2].irr)
  })

  test('B54.2: NPV increases with annual availability payment', () => {
    expect(outs[0].npv).toBeLessThan(outs[1].npv)
    expect(outs[1].npv).toBeLessThan(outs[2].npv)
  })

  test('B54.3: minDSCR increases with annual availability payment', () => {
    const dscrs = outs.map(pppMinDscr)
    dscrs.forEach(d => expect(d).not.toBeNull())
    expect(dscrs[0]).toBeLessThan(dscrs[1])
    expect(dscrs[1]).toBeLessThan(dscrs[2])
  })
})

// =====================================================================
// B55 — PPP longer concession period → higher IRR / NPV / EM
// A longer concession period adds post-amortization "free-cash" ops
// years (dscr=null, full equity CF). Because the debt tenor (10 yr)
// is fixed, additional years beyond year 12 (constr 2 + ops 10) are
// pure equity income, lifting all three return metrics.
// =====================================================================
describe('B55 — PPP concession period monotonically lifts IRR / NPV / EM', () => {
  const PERIODS = [20, 25, 30]        // years
  const outs = PERIODS.map(p => runPPPEngine(pppWith({ 'Concession Period': p })))

  test('B55.1: IRR is non-null and increases with concession period', () => {
    outs.forEach(o => expect(o.irr).not.toBeNull())
    expect(outs[0].irr).toBeLessThan(outs[1].irr)
    expect(outs[1].irr).toBeLessThan(outs[2].irr)
  })

  test('B55.2: NPV increases with concession period', () => {
    expect(outs[0].npv).toBeLessThan(outs[1].npv)
    expect(outs[1].npv).toBeLessThan(outs[2].npv)
  })

  test('B55.3: equity multiple (EM) increases with concession period', () => {
    expect(outs[0].equity_multiple).toBeLessThan(outs[1].equity_multiple)
    expect(outs[1].equity_multiple).toBeLessThan(outs[2].equity_multiple)
  })
})

// =====================================================================
// B56 — Sensitivity matrix: strict monotonicity, no directional inversions
//
// Two 5-point sweeps:
//   Price sweep: 5 prices at fixed cost 650/sqm. Step = +300/sqm
//     ≈ +3M additional revenue per step → well above the r2() rounding
//     floor for IRR distinguishability.
//   Cost  sweep: 5 costs at fixed price 2000/sqm. Step = +150/sqm
//     ≈ +1.5M additional TPC per step.
//
// Both sweeps check IRR, NPV, and EM for strict monotonicity.
// A cross-check spot-tests price dominance at a mid-range cost.
// =====================================================================
describe('B56 — sensitivity matrix: strict monotonicity, no inversions', () => {
  // ── Price sweep ────────────────────────────────────────────────────
  const PRICE_SWEEP = [1200, 1500, 1800, 2100, 2400]
  const priceOuts = PRICE_SWEEP.map(p =>
    runEngine(
      F_RE_SALE_ASSUMPTIONS,
      withDefault(F_RE_SALE_DEFAULTS, 'sale_price_per_sqm_residential', p),
    )
  )

  test('B56.1: IRR strictly increases across the price sweep (no inversions)', () => {
    for (let i = 1; i < priceOuts.length; i++) {
      expect(priceOuts[i].irr).toBeGreaterThan(priceOuts[i - 1].irr)
    }
  })

  test('B56.2: NPV strictly increases across the price sweep (no inversions)', () => {
    for (let i = 1; i < priceOuts.length; i++) {
      expect(priceOuts[i].npv).toBeGreaterThan(priceOuts[i - 1].npv)
    }
  })

  test('B56.3: EM strictly increases across the price sweep (no inversions)', () => {
    for (let i = 1; i < priceOuts.length; i++) {
      expect(priceOuts[i].equity_multiple).toBeGreaterThan(priceOuts[i - 1].equity_multiple)
    }
  })

  // ── Cost sweep ─────────────────────────────────────────────────────
  const PRICE_FOR_COST_SWEEP = 2000   // fixed; keeps returns positive across the range
  const COST_SWEEP = [450, 600, 750, 900, 1050]
  const BASE_DEFS_COST = withDefault(F_RE_SALE_DEFAULTS, 'sale_price_per_sqm_residential', PRICE_FOR_COST_SWEEP)
  const costOuts = COST_SWEEP.map(c =>
    runEngine(
      F_RE_SALE_ASSUMPTIONS,
      withDefault(BASE_DEFS_COST, 'construction_cost_per_sqm_residential', c),
    )
  )

  test('B56.4: IRR strictly decreases across the cost sweep (no inversions)', () => {
    for (let i = 1; i < costOuts.length; i++) {
      expect(costOuts[i].irr).toBeLessThan(costOuts[i - 1].irr)
    }
  })

  test('B56.5: NPV strictly decreases across the cost sweep (no inversions)', () => {
    for (let i = 1; i < costOuts.length; i++) {
      expect(costOuts[i].npv).toBeLessThan(costOuts[i - 1].npv)
    }
  })

  test('B56.6: EM strictly decreases across the cost sweep (no inversions)', () => {
    for (let i = 1; i < costOuts.length; i++) {
      expect(costOuts[i].equity_multiple).toBeLessThan(costOuts[i - 1].equity_multiple)
    }
  })

  // ── Cross-check: price dominance holds at a mid-range cost ─────────
  test('B56.7: cross-check — price dominance holds at mid-range cost (750/sqm)', () => {
    // Confirm that the price-lift signal survives at a cost different from
    // the default 650/sqm, ruling out a cost-specific coincidence.
    const MID_COST_DEFS = withDefault(
      withDefault(F_RE_SALE_DEFAULTS, 'construction_cost_per_sqm_residential', 750),
      'sale_price_per_sqm_residential', 0,  // placeholder; overridden below
    )
    const p1 = runEngine(F_RE_SALE_ASSUMPTIONS, withDefault(MID_COST_DEFS, 'sale_price_per_sqm_residential', 1400))
    const p2 = runEngine(F_RE_SALE_ASSUMPTIONS, withDefault(MID_COST_DEFS, 'sale_price_per_sqm_residential', 1800))
    const p3 = runEngine(F_RE_SALE_ASSUMPTIONS, withDefault(MID_COST_DEFS, 'sale_price_per_sqm_residential', 2200))
    expect(p1.irr).toBeLessThan(p2.irr)
    expect(p2.irr).toBeLessThan(p3.irr)
  })
})
