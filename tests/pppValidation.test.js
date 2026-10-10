/**
 * pppValidation.test.js — PPP financing-term and sanity controls
 *   P-024: debt maturity must fall within the concession (blocking)
 */
import { runPPPEngine } from '../src/modules/feasibility/annualEngine.js'

const A = obj => Object.entries(obj).map(([name, value]) => ({ name, value }))
const BASE = {
  'Total Project Cost': 100_000_000, 'Debt %': 80, 'Equity %': 20,
  'Annual Availability Payment': 12_000_000, 'Concession Period': 25,
  'Construction Period': 24, 'OPEX % of Revenue': 5, 'Interest Rate': 7,
  'Loan Tenor': 10, 'Grace Period': 2, 'Tax Rate': 20, 'WACC': 10,
}
const run = o => runPPPEngine(A({ ...BASE, ...o }))
const codeOf = fn => { try { fn(); return null } catch (e) { return e.code } }

describe('P-024 — loan maturity vs concession expiry', () => {
  test('V1: tenor > concession is blocked with a machine-readable code and actionable message', () => {
    let err
    try { run({ 'Concession Period': 8, 'Loan Tenor': 10 }) } catch (e) { err = e }
    expect(err.code).toBe('LOAN_MATURITY_EXCEEDS_CONCESSION')
    expect(err.loan_tenor).toBe(10)
    expect(err.concession).toBe(8)
    expect(err.construction).toBe(2)
    // maturity = project year 2 + 10 = 12; expiry = project year 2 + 8 = 10
    expect(err.message).toMatch(/project year 12/)
    expect(err.message).toMatch(/project year 10/)
    expect(err.message).toMatch(/at most 8 yrs/)
  })

  test('V2: tenor = concession is accepted and fully amortizes by expiry', () => {
    const out = run({ 'Concession Period': 10, 'Loan Tenor': 10 })
    const last = out.debt_schedule[out.debt_schedule.length - 1]
    expect(Math.abs(last.closing)).toBeLessThanOrEqual(1)
  })

  test('V3: grace ≥ tenor is blocked (no repayment period)', () => {
    expect(codeOf(() => run({ 'Grace Period': 10 }))).toBe('GRACE_PERIOD_INVALID')
    expect(codeOf(() => run({ 'Grace Period': 12 }))).toBe('GRACE_PERIOD_INVALID')
    expect(codeOf(() => run({ 'Grace Period': -1 }))).toBe('GRACE_PERIOD_INVALID')
    expect(codeOf(() => run({ 'Grace Period': 9 }))).toBeNull()
  })

  test('V4: zero tenor with debt requested is blocked; harmless when Debt % = 0', () => {
    expect(codeOf(() => run({ 'Loan Tenor': 0 }))).toBe('LOAN_TENOR_INVALID')
    expect(codeOf(() => run({ 'Loan Tenor': 0, 'Debt %': 0, 'Equity %': 100 }))).toBeNull()
    expect(codeOf(() => run({ 'Loan Tenor': 40, 'Debt %': 0, 'Equity %': 100 }))).toBeNull()
  })

  test('V5: randomized — every accepted scenario repays all debt by concession expiry', () => {
    let seed = 24, accepted = 0, blocked = 0
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let i = 0; i < 300; i++) {
      const conc = 1 + Math.floor(rnd() * 30), tenor = 1 + Math.floor(rnd() * 30)
      const grace = Math.floor(rnd() * 5)
      const fx = { 'Concession Period': conc, 'Loan Tenor': tenor, 'Grace Period': grace,
                   'Construction Period': 6 + Math.floor(rnd() * 48), 'Target DSCR': 1 + rnd() }
      const code = codeOf(() => run(fx))
      if (tenor > conc && grace < tenor) expect(code).toBe('LOAN_MATURITY_EXCEEDS_CONCESSION')
      if (code) { blocked++; continue }
      accepted++
      const out = run(fx)
      const last = out.debt_schedule[out.debt_schedule.length - 1]
      expect(Math.abs(last.closing)).toBeLessThanOrEqual(1)
    }
    expect(accepted).toBeGreaterThan(50)
    expect(blocked).toBeGreaterThan(50)
  })
})
