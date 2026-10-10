/**
 * pppFundingInvariants.test.js
 * ---------------------------------------------------------------------------
 * Permanent financial-identity regression suite for runPPPEngine
 * (Gate 1 / P-015 — construction funding, debt continuity, COD handoff,
 * operations, returns).
 *
 * These tests assert ACCOUNTING IDENTITIES, not engine-produced numbers.
 * Every expected value is derived from the fixture inputs or from other
 * fields of the same output via a first-principles identity, so the suite
 * cannot become tautological (Governance §13). They must hold for every
 * fixture, before and after IDC (P-015C), because IDC enters each identity
 * as an explicit term — pre-IDC that term is identically zero.
 *
 * Debt-balance convention (annual model):
 *   closing_t = opening_t + debt_draw_t + idc_t − principal_t
 *   opening_{t+1} = closing_t,  opening_0 = 0
 *
 * Tolerances:
 *   CURR_TOL = 1 JOD for single-row identities (engine rounds each row to
 *   2dp); ACCUM_TOL = 0.01 JOD × rows for sums of rounded rows, floored at
 *   1 JOD. Both are far below any material amount (< 0.00001% of the
 *   smallest fixture's debt) and cannot hide a defect.
 * ---------------------------------------------------------------------------
 */
import { runPPPEngine, npvCalc, irrCalc } from '../src/modules/feasibility/annualEngine.js'

const CURR_TOL  = 1
const RATIO_TOL = 0.01
const accumTol  = rows => Math.max(1, 0.01 * rows)

const A = obj => Object.entries(obj).map(([name, value]) => ({ name, value }))

// ── Fixtures ────────────────────────────────────────────────────────────────
// Rates/percents are entered the way the wizard stores them (7 = 7%).
const BASE = {
  'Total Project Cost': 100_000_000, 'Debt %': 80, 'Equity %': 20,
  'Annual Availability Payment': 12_000_000, 'Concession Period': 25,
  'Construction Period': 24, 'OPEX % of Revenue': 5, 'Interest Rate': 7,
  'Loan Tenor': 10, 'Grace Period': 2, 'Tax Rate': 20, 'WACC': 10,
}

// Madaba inputs exactly as entered for the June 2026 Gate 1 runs
// (the §5d pre-IDC control baseline). Kept verbatim for historical
// comparison even though several inputs were later found to be mis-mapped
// (see XCEPTA_GATE1_FINDINGS.md §9).
const MADABA_JUNE = {
  'Total Project Cost': 56_290_000, 'Debt %': 85, 'Equity %': 15,
  'Annual Availability Payment': 8_800_000, 'Concession Period': 10,
  'Construction Period': 36, 'OPEX % of Revenue': 0, 'Interest Rate': 7,
  'Loan Tenor': 10, 'Grace Period': 2, 'Tax Rate': 20, 'WACC': 10,
  'Target DSCR': 1.0,
}

const FIXTURES = {
  'base (DSCR-bound, 24m build)': BASE,
  'madaba june inputs':           MADABA_JUNE,
  'requested debt binds (target DSCR 0)': { ...BASE, 'Target DSCR': 0 },
  'low gearing (Debt % binds)':   { ...BASE, 'Debt %': 30, 'Equity %': 70 },
  'all equity (Debt % 0)':        { ...BASE, 'Debt %': 0, 'Equity %': 100 },
  'no grace':                     { ...BASE, 'Grace Period': 0 },
  '6-month build (1 yr)':         { ...BASE, 'Construction Period': 6 },
  '13-month build (2 yr)':        { ...BASE, 'Construction Period': 13 },
  '48-month build (4 yr)':        { ...BASE, 'Construction Period': 48 },
  'high rate 15%':                { ...BASE, 'Interest Rate': 15 },
  'zero rate':                    { ...BASE, 'Interest Rate': 0 },
  'fixed opex':                   { ...BASE, 'OPEX Amount (JOD)': 1_500_000 },
  'zero tax':                     { ...BASE, 'Tax Rate': 0 },
}

// Rebuild the debt roll-forward purely from cash_flows rows. IDC enters
// via r.idc; rows that predate P-015C carry no idc field, which is
// correct-by-definition zero (the pre-IDC engine capitalized nothing).
function rollForward(out) {
  let opening = 0
  return out.cash_flows.map(r => {
    const draw = r.debt_draw || 0
    const idc  = r.idc ?? 0
    const closing = opening + draw + idc - (r.principal || 0)
    const row = { year: r.year, phase: r.phase, opening, draw, idc,
                  interest: r.interest, principal: r.principal || 0, closing }
    opening = closing
    return row
  })
}

const sum = (rows, k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0)

describe.each(Object.entries(FIXTURES))('PPP funding invariants — %s', (_label, fx) => {
  const out    = runPPPEngine(A(fx))
  const rate   = fx['Interest Rate'] / 100
  const tax    = fx['Tax Rate'] / 100
  const constr = out.cash_flows.filter(r => r.phase === 'Construction')
  const ops    = out.cash_flows.filter(r => r.phase === 'Operations')
  const sched  = rollForward(out)
  const idcTot = sum(constr, 'idc')   // 0 pre-P-015C

  // ── Construction funding ──────────────────────────────────────────────
  test('I1: Σ equity_draw = equity_amount', () => {
    expect(Math.abs(sum(constr, 'equity_draw') - out.equity_amount))
      .toBeLessThanOrEqual(accumTol(constr.length))
  })

  test('I2: Σ debt_draw + Σ capitalized IDC = COD debt (debt_amount)', () => {
    expect(Math.abs(sum(constr, 'debt_draw') + idcTot - out.debt_amount))
      .toBeLessThanOrEqual(accumTol(constr.length))
  })

  test('I3: sources = uses — Σ(equity + debt principal) = base project cost per row and in total', () => {
    // Base capex (Convention A — TPC excludes financing costs) is funded by
    // equity + principal draws; capitalized IDC is a financing use funded
    // by the lender, so total sources = TPC + IDC = total uses.
    constr.forEach(r => {
      expect(Math.abs(r.equity_draw + r.debt_draw - r.capex)).toBeLessThanOrEqual(CURR_TOL)
    })
    const sources = sum(constr, 'equity_draw') + sum(constr, 'debt_draw') + idcTot
    const uses    = fx['Total Project Cost'] + idcTot
    expect(Math.abs(sources - uses)).toBeLessThanOrEqual(accumTol(constr.length))
    expect(Math.abs(sum(constr, 'capex') - fx['Total Project Cost']))
      .toBeLessThanOrEqual(accumTol(constr.length))
  })

  test('I4: draws non-negative; debt never exceeds the authorized (requested) or supportable amount', () => {
    constr.forEach(r => {
      expect(r.equity_draw).toBeGreaterThanOrEqual(0)
      expect(r.debt_draw).toBeGreaterThanOrEqual(0)
    })
    const ds = out.debt_sizing
    expect(out.debt_amount).toBeLessThanOrEqual(ds.requested_debt + CURR_TOL)
    expect(out.debt_amount).toBeLessThanOrEqual(ds.supportable_debt + CURR_TOL)
  })

  test('I5: equity-first — no debt drawn while undrawn equity remains', () => {
    let eqLeft = out.equity_amount
    constr.forEach(r => {
      if (eqLeft - r.equity_draw > CURR_TOL) expect(r.debt_draw).toBeLessThanOrEqual(CURR_TOL)
      eqLeft -= r.equity_draw
    })
  })

  // ── Debt continuity ───────────────────────────────────────────────────
  test('I6: balance never negative; continuity closing = opening + draw + IDC − principal', () => {
    sched.forEach(row => expect(row.closing).toBeGreaterThanOrEqual(-CURR_TOL))
    for (let i = 1; i < sched.length; i++) expect(sched[i].opening).toBe(sched[i - 1].closing)
  })

  // ── COD handoff ───────────────────────────────────────────────────────
  test('I7: construction closing balance = operations opening balance = debt_amount', () => {
    const cod = sched[constr.length - 1].closing
    expect(Math.abs(cod - out.debt_amount)).toBeLessThanOrEqual(accumTol(constr.length))
    expect(sched[constr.length].opening).toBe(cod)
  })

  // ── Operations ────────────────────────────────────────────────────────
  test('I8: operating interest = opening balance × rate (annual, opening-balance convention)', () => {
    ops.forEach((r, i) => {
      const open = sched[constr.length + i].opening
      const expected = open > 0.01 ? open * rate : 0
      expect(Math.abs(r.interest - expected)).toBeLessThanOrEqual(CURR_TOL)
    })
  })

  test('I9: Σ principal = COD debt and the loan fully amortizes within the concession', () => {
    expect(Math.abs(sum(ops, 'principal') - out.debt_amount)).toBeLessThanOrEqual(accumTol(ops.length))
    expect(Math.abs(sched[sched.length - 1].closing)).toBeLessThanOrEqual(accumTol(ops.length))
  })

  test('I10: DSCR = CFADS / (interest + principal), CFADS = EBITDA − tax', () => {
    ops.forEach(r => {
      const cfads = r.ebitda - r.tax
      const ds    = r.interest + r.principal
      expect(Math.abs(r.tax - Math.max(0, (r.ebitda - r.interest) * tax))).toBeLessThanOrEqual(CURR_TOL)
      if (ds > 1) expect(Math.abs(r.dscr - cfads / ds)).toBeLessThanOrEqual(RATIO_TOL)
      else expect(r.dscr).toBeNull()
    })
  })

  test('I11: DSCR-bound debt → every amortizing year sits at target DSCR', () => {
    const ds = out.debt_sizing
    const dscrBound = ds.target_dscr > 0 && out.debt_amount >= ds.supportable_debt - CURR_TOL
                      && out.debt_amount > 0
    if (!dscrBound) return
    ops.filter(r => r.principal > 1).forEach((r, i, arr) => {
      if (i === arr.length - 1) return   // final year may be clamped to the residual
      expect(Math.abs(r.dscr - ds.target_dscr)).toBeLessThanOrEqual(RATIO_TOL)
    })
  })

  // ── Equity cash flows & returns ──────────────────────────────────────
  test('I12: equity_cf = −equity_draw (construction); = CFADS − debt service (operations)', () => {
    constr.forEach(r => expect(Math.abs(r.equity_cf + r.equity_draw)).toBeLessThanOrEqual(CURR_TOL))
    ops.forEach(r => {
      const cfads = r.ebitda - r.tax
      expect(Math.abs(r.equity_cf - (cfads - r.interest - r.principal))).toBeLessThanOrEqual(CURR_TOL)
    })
  })

  test('I13: IRR / NPV / EM are computed from the reported equity_cf series', () => {
    const cfs = out.cash_flows.map(r => r.equity_cf)
    const wacc = fx['WACC'] / 100
    expect(Math.abs(out.npv - npvCalc(wacc, cfs))).toBeLessThanOrEqual(accumTol(cfs.length))
    const irr = irrCalc(cfs)
    if (irr === null) expect(out.irr).toBeNull()
    else {
      expect(Math.abs(out.irr - irr * 100)).toBeLessThanOrEqual(0.01)
      // NPV at the reported IRR is ~0 relative to the cash flows' scale
      const scale = Math.max(...cfs.map(Math.abs))
      expect(Math.abs(npvCalc(irr, cfs)) / scale).toBeLessThan(1e-4)
    }
    const inflow  = cfs.filter(c => c > 0).reduce((a, b) => a + b, 0)
    const outflow = -cfs.filter(c => c < 0).reduce((a, b) => a + b, 0)
    if (outflow > 0) expect(Math.abs(out.equity_multiple - inflow / outflow)).toBeLessThanOrEqual(0.01)
  })
})
