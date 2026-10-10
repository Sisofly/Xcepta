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

describe('P-023 — blocking input controls (mathematically invalid / incomplete)', () => {
  test.each([
    ['missing TPC',               { 'Total Project Cost': null },        'TOTAL_PROJECT_COST_INVALID'],
    ['zero TPC',                  { 'Total Project Cost': 0 },           'TOTAL_PROJECT_COST_INVALID'],
    ['negative AP',               { 'Annual Availability Payment': -1 }, 'AVAILABILITY_PAYMENT_INVALID'],
    ['negative fixed opex',       { 'OPEX Amount (JOD)': -5 },           'OPEX_AMOUNT_INVALID'],
    ['Debt % > 100',              { 'Debt %': 120 },                     'INPUT_OUT_OF_RANGE'],
    ['Equity % < 0',              { 'Equity %': -10 },                   'INPUT_OUT_OF_RANGE'],
    ['OPEX % > 100',              { 'OPEX % of Revenue': 150 },          'INPUT_OUT_OF_RANGE'],
    ['tax = 100%',                { 'Tax Rate': 100 },                   'INPUT_OUT_OF_RANGE'],
    ['negative rate',             { 'Interest Rate': -1 },               'INTEREST_RATE_INVALID'],
    ['construction rate > 100%',  { 'Construction Interest Rate': 150 }, 'INTEREST_RATE_INVALID'],
    ['WACC ≤ −100%',              { 'WACC': -100 },                      'DISCOUNT_RATE_INVALID'],
    ['negative target DSCR',      { 'Target DSCR': -1 },                 'TARGET_DSCR_INVALID'],
    ['fractional tenor (P-025)',  { 'Loan Tenor': 9.5 },                 'PERIOD_NOT_WHOLE_YEARS'],
    ['fractional grace (P-025)',  { 'Grace Period': 1.5 },               'PERIOD_NOT_WHOLE_YEARS'],
    ['fractional concession',     { 'Concession Period': 20.5 },         'PERIOD_NOT_WHOLE_YEARS'],
  ])('B: %s → %s', (_l, o, code) => {
    let err
    try { run(o) } catch (e) { err = e }
    expect(err && err.code).toBe(code)
    expect(err.message.startsWith(code + ':')).toBe(true)
  })

  test('B: boundary values that are valid still run', () => {
    ;[{ 'Debt %': 100, 'Equity %': 0 }, { 'Tax Rate': 0 }, { 'Interest Rate': 0 }, { 'WACC': 0 },
      { 'Target DSCR': 0 }, { 'OPEX Amount (JOD)': 0 }, { 'Annual Availability Payment': 0, 'Debt %': 0, 'Equity %': 100 }]
      .forEach(o => expect(codeOf(() => run(o))).toBeNull())
  })
})

describe('P-023 — output reasonableness warnings (never block)', () => {
  const codes = out => out.warnings.map(w => w.code)

  test('W1: the June "missing zeros" incident (TPC 56,290 vs AP 8.8M) is flagged, not silently scored', () => {
    const out = runPPPEngine(A({
      'Total Project Cost': 56_290, 'Debt %': 85, 'Equity %': 15, 'Annual Availability Payment': 8_800_000,
      'Concession Period': 10, 'Construction Period': 36, 'OPEX % of Revenue': 0, 'Interest Rate': 7,
      'Loan Tenor': 10, 'Grace Period': 2, 'Tax Rate': 20, 'WACC': 10, 'Target DSCR': 1.0,
    }))
    expect(codes(out)).toEqual(expect.arrayContaining(['POSSIBLE_INPUT_SCALE_ERROR']))
    expect(codes(out).some(c => ['IRR_EXTREME', 'EQUITY_MULTIPLE_EXTREME', 'PAYBACK_UNDER_ONE_YEAR', 'DSCR_EXTREME'].includes(c))).toBe(true)
    out.warnings.forEach(w => expect(['warning', 'info']).toContain(w.severity))
  })

  test('W2: DSCR-bound sizing is disclosed with the debt shortfall amount', () => {
    const out = run({})
    const w = out.warnings.find(x => x.code === 'DEBT_LIMITED_BY_DSCR')
    expect(w.severity).toBe('info')
    expect(w.value).toBeCloseTo(out.debt_sizing.debt_shortfall, 2)
  })

  test('W3: no debt capacity is identified, not hidden', () => {
    const out = run({ 'OPEX % of Revenue': 100 })   // EBITDA = 0 → zero capacity
    expect(out.debt_amount).toBeLessThan(1)
    expect(codes(out)).toEqual(expect.arrayContaining(['NO_DEBT_CAPACITY', 'NON_POSITIVE_EBITDA']))
  })

  test('W4: decimal-entered rate (0.07 meant 7%) is flagged', () => {
    expect(codes(run({ 'Interest Rate': 0.07 }))).toContain('INTEREST_COST_IMPLAUSIBLY_LOW')
  })

  test('W5: requested gearing not summing to 100% is informational only', () => {
    const out = run({ 'Debt %': 70, 'Equity %': 20 })
    const w = out.warnings.find(x => x.code === 'INPUT_GEARING_NOT_100')
    expect(w.severity).toBe('info')
  })

  test('W6: target DSCR 0 / below 1 flagged', () => {
    expect(codes(run({ 'Target DSCR': 0 }))).toContain('NO_DSCR_CONSTRAINT')
    expect(codes(run({ 'Target DSCR': 0.9 }))).toContain('TARGET_DSCR_BELOW_ONE')
  })

  test('W7: a clean benchmark-aligned case raises no warnings', () => {
    const out = runPPPEngine(A({
      'Total Project Cost': 50_788_939, 'Debt %': 84.899, 'Equity %': 15.101, 'Annual Availability Payment': 8_800_000,
      'Concession Period': 10, 'Construction Period': 36, 'OPEX Amount (JOD)': 59_190, 'Interest Rate': 8.25,
      'Loan Tenor': 9, 'Grace Period': 0, 'Tax Rate': 0, 'WACC': 10, 'Target DSCR': 1.0,
    }))
    expect(out.warnings).toEqual([])
  })

  test('W8: integrity block is reported and passes', () => {
    const out = run({})
    expect(out.integrity.passed).toBe(true)
    expect(Math.abs(out.integrity.sources_uses_diff)).toBeLessThanOrEqual(out.integrity.tolerance)
    expect(Math.abs(out.integrity.final_balance)).toBeLessThanOrEqual(2)
  })
})
