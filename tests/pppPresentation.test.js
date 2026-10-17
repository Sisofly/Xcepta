/**
 * pppPresentation.test.js — P-028 D1 (Results cash-flow table) and D2 (PDF
 * Tax Methodology & Assumptions). Display only: the engine and saved outputs
 * are not changed.
 */
import { readFileSync } from 'fs'
import { runPPPEngine } from '../src/modules/feasibility/annualEngine.js'
import { PPP_CASH_FLOW_HEADERS, pppCashFlowRows, pppTaxDisclosure } from '../src/modules/feasibility/pppReporting.js'

const rows = o => Object.entries(o).map(([name, v]) => (typeof v === 'string'
  ? { name, value: null, unit: v, category: 'x' } : { name, value: v, unit: null, category: 'x' }))
const clean = o => JSON.parse(JSON.stringify(o))
const BASE = { 'Total Project Cost': 100e6, 'Debt %': 80, 'Equity %': 20, 'Annual Availability Payment': 12e6,
  'Concession Period': 25, 'Construction Period': 24, 'OPEX % of Revenue': 5, 'Interest Rate': 7, 'Loan Tenor': 10,
  'Grace Period': 2, 'Tax Rate': 21, 'WACC': 10, 'Target DSCR': 1.2, 'Construction Start Date': '2026-07-01',
  'Depreciable Share %': 95 }
const QUARTERLY = { ...BASE, 'Model Periodicity': 'Quarterly' }

describe('D1 — Results cash-flow table separates Tax Expense from Cash Tax Paid', () => {
  test('T1: PPP headers — "Tax Expense" and "Cash Tax Paid", no ambiguous "Tax" column', () => {
    expect(PPP_CASH_FLOW_HEADERS).toEqual(['Year', 'Phase', 'Revenue', 'Opex', 'EBITDA', 'Interest', 'PBT',
      'Tax Expense', 'Cash Tax Paid', 'Net Income', 'Principal', 'Equity CF'])
    expect(PPP_CASH_FLOW_HEADERS).not.toContain('Tax')
  })

  test.each([['annual', BASE, 1], ['quarterly (annual rows aggregated from quarters)', QUARTERLY, 4]])(
    'T2 %s: PBT − Tax Expense = Net Income; CFADS and Equity CF use Cash Tax Paid', (_l, fx, p) => {
      const out = runPPPEngine(rows(fx))
      const before = clean(out.cash_flows)
      const shown = pppCashFlowRows(out.cash_flows)
      const tol = 0.01 * p                                             // existing 2-dp rounding (summed per period)
      shown.filter(r => r.phase === 'Operations').forEach(r => {
        expect(Math.abs(r.pbt - r.tax_expense - r.net_income)).toBeLessThanOrEqual(tol + 1e-9)
        expect(Math.abs((r.ebitda - r.tax) - (r.interest + r.principal) - r.equity_cf)).toBeLessThanOrEqual(2 * tol + 1e-9)
      })
      // the two tax figures genuinely differ in the first operating year (partial FY2028, 4-month lag)
      const first = shown.find(r => r.phase === 'Operations')
      expect(first.tax_expense).not.toBe(first.tax)
      // over the life they reconcile: Σ cash tax = Σ tax expense
      const sum = k => shown.reduce((a, r) => a + r[k], 0)
      expect(Math.abs(sum('tax') - sum('tax_expense'))).toBeLessThanOrEqual(0.01 * shown.length)
      // display only: saved rows unchanged
      expect(clean(out.cash_flows)).toEqual(before)
    })

  test('T3: results without a tax_expense field (tax-exempt, Tax Depreciation = None) show Tax Expense = cash tax', () => {
    ;[{ ...BASE, 'Tax Rate': 0 }, { ...BASE, 'Tax Depreciation': 'None' }].forEach(fx => {
      const out = runPPPEngine(rows(fx))
      expect(out.cash_flows[0].tax_expense).toBeUndefined()
      pppCashFlowRows(out.cash_flows).filter(r => r.phase === 'Operations').forEach(r => {
        expect(r.tax_expense).toBe(r.tax)
        expect(Math.abs(r.pbt - r.tax_expense - r.net_income)).toBeLessThanOrEqual(0.01)
      })
    })
  })

  test('T4: the page renders the PPP headers and a Tax Expense cell for PPP only (real-estate table unchanged)', () => {
    const src = readFileSync('src/pages/FeasibilityProject.jsx', 'utf8')
    expect(src).toMatch(/\(pppAP \? PPP_CASH_FLOW_HEADERS : \['Year','Phase','Revenue','Opex','EBITDA','Interest','PBT','Tax','Net Income','Principal','Equity CF'\]\)/)
    expect(src).toMatch(/\(pppAP \? pppCashFlowRows\(cfRows\) : cfRows\)/)
    expect(src).toMatch(/\{pppAP && <td[^>]*>\{fmtNumber\(row\.tax_expense\)\}<\/td>\}/)
  })
})

describe('D2 — PDF Tax Methodology & Assumptions', () => {
  test.each([['annual', BASE], ['quarterly', QUARTERLY]])('P1 %s: disclosure content from the saved result', (label, fx) => {
    const out = clean(runPPPEngine(rows(fx)))
    const d = pppTaxDisclosure(out)
    expect(d.title).toBe('Tax Methodology & Assumptions')
    expect(d.status).toMatch(/modelling assumption, not confirmed Jordanian tax treatment/)
    const it = Object.fromEntries(d.items.map(i => [i.key, i]))
    const ta = out.tax_assumptions
    expect(it.tax_rate.value).toBe(0.21)
    expect(it.basis.value).toBe(ta.levered_basis)
    expect(it.life.value).toBe(25)
    expect(it.life.label).toMatch(/preliminary/)
    expect(it.share.value).toBe(0.95)
    expect(it.idc.value).toBe(1)
    expect(it.losses.value).toBe(5)
    expect(it.lag.value).toBe(4)
    expect(Object.keys(it)).toEqual(['tax_rate', 'method', 'basis', 'life', 'share', 'idc', 'losses', 'lag', 'tax_years', 'write_off'])
    expect(d.notes.join(' ')).toMatch(/final and audited/)                      // simplified loss-expiry clock
    expect(d.notes.join(' ')).toMatch(/never deducted from CFADS/)
    const alloc = d.notes.find(n => /accounting-standard tax provision/.test(n))
    expect(alloc).toBeDefined()
    if (label === 'quarterly') expect(alloc).toMatch(/^Quarterly model:/)
  })

  test('P2: no section for tax-exempt or Tax Depreciation = None results; assumed share disclosed when not entered', () => {
    expect(pppTaxDisclosure(runPPPEngine(rows({ ...BASE, 'Tax Rate': 0 })))).toBeNull()
    expect(pppTaxDisclosure(runPPPEngine(rows({ ...BASE, 'Tax Depreciation': 'None' })))).toBeNull()
    const noShare = { ...BASE }; delete noShare['Depreciable Share %']
    expect(pppTaxDisclosure(runPPPEngine(rows(noShare))).notes.join(' ')).toMatch(/100% of TPC plus eligible IDC is assumed/)
    const unl = pppTaxDisclosure(runPPPEngine(rows({ ...BASE, 'Tax Loss Carry-Forward (years)': 'Unlimited' })))
    expect(unl.notes.join(' ')).not.toMatch(/final and audited/)
  })

  test('P3: generatePDF renders the section (title, status, every item, every note) for PPP results', () => {
    const src = readFileSync('src/pages/FeasibilityProject.jsx', 'utf8')
    const start = src.indexOf('// ── P-028 (D2): Tax Methodology & Assumptions')
    const block = src.slice(start, src.indexOf('// ── IRR interpretation notes ──', start))
    expect(start).toBeGreaterThan(src.indexOf('function generatePDF'))
    expect(block).toMatch(/var taxDisc = pppAP && modelOutput \? pppTaxDisclosure\(modelOutput\) : null/)
    expect(block).toMatch(/secHead\(taxDisc\.title\)/)
    expect(block).toMatch(/splitTextToSize\(safe\(taxDisc\.status\)/)
    expect(block).toMatch(/taxDisc\.items\.forEach/)
    expect(block).toMatch(/taxDisc\.notes\.forEach/)
  })
})
