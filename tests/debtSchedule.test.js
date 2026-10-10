/**
 * debtSchedule.test.js — Results-tab debt schedule from PERSISTED outputs.
 *
 * Regression for the post-merge finding on PR #1: model_outputs stores only
 * irr / npv / equity_multiple / dscr_series / cash_flows, so the Results tab
 * never sees debt_schedule and must rebuild it from cash_flows. Before the
 * fix, that rebuild ignored row-level idc, understating the COD balance by
 * the IDC and leaving a −IDC residual.
 */
import { runPPPEngine } from '../src/modules/feasibility/annualEngine.js'
import { buildDebtScheduleRows } from '../src/modules/feasibility/debtSchedule.js'

const A = obj => Object.entries(obj).map(([name, value]) => ({ name, value }))
const BASE = {
  'Total Project Cost': 100_000_000, 'Debt %': 80, 'Equity %': 20,
  'Annual Availability Payment': 12_000_000, 'Concession Period': 25,
  'Construction Period': 24, 'OPEX % of Revenue': 5, 'Interest Rate': 7,
  'Loan Tenor': 10, 'Grace Period': 2, 'Tax Rate': 20, 'WACC': 10,
}
const MADABA_ALIGNED = {
  'Total Project Cost': 50_788_939, 'Debt %': 84.899, 'Equity %': 15.101,
  'Annual Availability Payment': 8_800_000, 'Concession Period': 10,
  'Construction Period': 36, 'OPEX Amount (JOD)': 59_190, 'Interest Rate': 8.25,
  'Loan Tenor': 9, 'Grace Period': 0, 'Tax Rate': 0, 'WACC': 10, 'Target DSCR': 1.0,
}

// Exactly the columns handleApprove / handleApproveScenario insert into model_outputs
const persist = out => ({
  irr: out.irr, npv: out.npv, equity_multiple: out.equity_multiple,
  dscr_series: out.dscr_series, cash_flows: JSON.parse(JSON.stringify(out.cash_flows)),
})

describe.each([['base', BASE], ['madaba aligned', MADABA_ALIGNED], ['48-month build', { ...BASE, 'Construction Period': 48 }]])(
  'debt schedule from a persisted post-IDC output — %s', (_l, fx) => {
    const out  = runPPPEngine(A(fx))
    const rows = buildDebtScheduleRows(persist(out))

    test('DS1: persisted rebuild matches the engine debt_schedule row by row (±1 JOD)', () => {
      expect(rows.length).toBe(out.debt_schedule.length)
      rows.forEach((r, i) => {
        const e = out.debt_schedule[i]
        ;['opening', 'draw', 'idc', 'interest', 'principal', 'closing']
          .forEach(k => expect(Math.abs(r[k] - e[k])).toBeLessThanOrEqual(1))
      })
    })

    test('DS2: COD balance includes capitalized IDC and the loan fully amortizes', () => {
      expect(out.idc_capitalized).toBeGreaterThan(0)
      const cod = rows[out.construction_years - 1].closing
      expect(Math.abs(cod - out.debt_amount)).toBeLessThanOrEqual(1)
      expect(Math.abs(rows[rows.length - 1].closing)).toBeLessThanOrEqual(1)
    })
  })

describe('debt schedule — other stored shapes', () => {
  test('DS3: fresh engine output → debt_schedule returned verbatim', () => {
    const out = runPPPEngine(A(BASE))
    expect(buildDebtScheduleRows(out)).toBe(out.debt_schedule)
  })

  test('DS4: pre-IDC persisted rows (debt_draw, no idc) → unchanged ramp, idc 0', () => {
    const out = runPPPEngine(A({ ...BASE, 'Construction Interest Rate': 0 }))
    const stored = persist(out)
    stored.cash_flows.forEach(r => { delete r.idc })
    const rows = buildDebtScheduleRows(stored)
    rows.forEach(r => expect(r.idc).toBe(0))
    expect(Math.abs(rows[1].closing - out.debt_amount)).toBeLessThanOrEqual(1)
    expect(Math.abs(rows[rows.length - 1].closing)).toBeLessThanOrEqual(1)
  })

  test('DS5: legacy rows (no debt_draw) → every row opens from Σ principal, as before', () => {
    const cash_flows = [
      { year: 0, phase: 'Construction', principal: 0, interest: 0 },
      { year: 1, phase: 'Operations', principal: 600, interest: 70 },
      { year: 2, phase: 'Operations', principal: 400, interest: 28 },
    ]
    const rows = buildDebtScheduleRows({ cash_flows })
    expect(rows.map(r => r.opening)).toEqual([1000, 1000, 400])
    expect(rows[rows.length - 1].closing).toBe(0)
  })

  test('DS6: nothing derivable → null', () => {
    expect(buildDebtScheduleRows(null)).toBeNull()
    expect(buildDebtScheduleRows({ cash_flows: [] })).toBeNull()
    expect(buildDebtScheduleRows({ cash_flows: [{ year: 0, phase: 'Operations', principal: 0 }] })).toBeNull()
  })
})
