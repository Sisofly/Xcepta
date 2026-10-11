/**
 * pppReporting.js — what the Results tab and PDF show for a PPP result
 * ---------------------------------------------------------------------------
 * Pure functions over a (saved, hydrated) model output, so the displayed
 * figures are tested end-to-end. Screen formatting uses utils/format.js;
 * the PDF receives raw values and formats them inside generatePDF
 * (Governance §10).
 * ---------------------------------------------------------------------------
 */
import { fmtNumber, fmtDSCR, fmtIRR } from '../../utils/format.js'
import { isPPPAvailabilityPayment, runPPPEngine } from './annualEngine.js'
import { assessResultCurrency } from './resultPersistence.js'

export const BINDING_LABEL = {
  dscr: 'DSCR capacity (cash-flow constrained)',
  gearing: 'Requested gearing (Debt %)',
  project_cost: 'Project cost (debt funds all capex)',
  none: 'No debt',
}

// Funding & debt summary rows [label, formatted value]; null for results
// that did not store debt sizing (legacy).
export function pppFundingSummaryRows(modelOutput) {
  const ds = modelOutput && modelOutput.debt_sizing
  if (!ds) return null
  return [
    ['Base project cost (input, excl. IDC)', fmtNumber(modelOutput.tdc)],
    ['Capitalised interest during construction (IDC)', fmtNumber(modelOutput.idc_capitalized)],
    ['Total funding requirement', fmtNumber(modelOutput.total_funding_requirement)],
    ['Equity', fmtNumber(modelOutput.equity_amount)],
    ['Senior debt — principal drawn', fmtNumber(ds.principal_drawn)],
    ['Senior debt — balance at COD (principal + IDC)', fmtNumber(modelOutput.debt_amount)],
    ['Debt amount limited by', BINDING_LABEL[ds.binding_constraint] || ds.binding_constraint || '—'],
    ['DSCR — sculpting target / underwriting minimum', fmtDSCR(ds.target_dscr) + ' / ' +
      (ds.underwriting_dscr === undefined ? '— (not stored)' : fmtDSCR(ds.underwriting_dscr))],
    ['DSCR — achieved minimum / average (' + (ds.dscr_basis || 'annual') + ')', fmtDSCR(ds.min_dscr) + ' / ' + fmtDSCR(ds.avg_dscr)],
    ['Meets underwriting minimum', ds.meets_underwriting === undefined || ds.meets_underwriting === null ? '—' : ds.meets_underwriting ? 'Yes' : 'No'],
    ['Loan tenor from COD / grace / repayment (years)', [ds.loan_tenor_years, ds.grace_years, ds.repayment_years].join(' / ')],
    ['Project IRR (unlevered, post-tax, before financing)', fmtIRR(modelOutput.project_irr)],
    ['Equity IRR (levered)', fmtIRR(modelOutput.irr)],
  ]
}

// Plain-text basis of a saved result (screen + PDF): current / outdated
// engine / historical, plus periodicity.
export function pppResultBasis(modelOutput, { engineVersion, compatibleVersions }) {
  const p = modelOutput && modelOutput._persistence
  if (!p) return null
  const period = (modelOutput.periodicity || 'annual') + ' model'
  if (p.legacy) return 'Historical (saved before versioned results; not recalculated) · ' + period
  const cur = assessResultCurrency(modelOutput, { engineVersion, compatibleVersions, rerun: runPPPEngine })
  if (cur.compatibility === 'demonstrated') {
    return 'Saved result, engine v' + p.engine_version + ' (results identical under v' + engineVersion + ') · ' + period
  }
  return (cur.status === 'current'
    ? 'Saved result, engine v' + p.engine_version
    : 'Outdated engine v' + p.engine_version + ' (current v' + engineVersion + ')') + ' · ' + period
}

// Raw values for the PDF Key Metrics PPP rows (formatted in generatePDF).
export function pppPdfMetricValues(modelOutput, versions) {
  if (!modelOutput || !modelOutput._persistence) return null
  return {
    basis: pppResultBasis(modelOutput, versions),
    project_irr: modelOutput.project_irr === undefined ? undefined : modelOutput.project_irr,
    idc_capitalized: modelOutput.idc_capitalized,
    debt_amount: modelOutput.debt_amount,
    underwriting_dscr: modelOutput.debt_sizing ? modelOutput.debt_sizing.underwriting_dscr : undefined,
    meets_underwriting: modelOutput.debt_sizing ? modelOutput.debt_sizing.meets_underwriting : undefined,
  }
}

// Phase 6 / item 4: what the PPP engine does NOT model. Shown with every
// PPP result so unsupported capabilities are never presented as validated.
export const PPP_MODEL_SCOPE_NOTES = [
  'Tax (P-028): straight-line tax depreciation from COD, loss carry-forward and tax-year cash payments are MODELLING ASSUMPTIONS, not confirmed Jordanian tax treatment (see the tax schedule and model checks). The Tax Rate is the combined burden entered by the user. With Tax Depreciation = None, the earlier method (tax on EBITDA − interest each period, no depreciation or loss relief) is used.',
  'No reserve accounts (DSRA / MMRA), distribution lock-up or cash-sweep tests; dividends = CFADS − debt service each period.',
  'Single senior facility; financing fees are not modelled separately (include them in Total Project Cost).',
  'Revenue: availability payment (optionally escalated or seasonal) or a per-year Revenue Profile. Demand estimates are labelled as such and are not contractual.',
]

// Projects created as project finance with a contract model other than
// Availability Payment (e.g. Demand-based, Hybrid, PPA, Merchant) have no
// validated XCEPTA engine: they would otherwise fall through to the real
// estate engine with no inputs. Calculation and approval are disabled.
export function isUnsupportedProjectFinance(project, assumptions) {
  if (!project) return false
  if (isPPPAvailabilityPayment(project, assumptions)) return false
  // project_type is 'Infrastructure / PPP' for every project-finance project
  // (P-020) and never for real estate; delivery_model is not used because
  // real-estate projects may also select a 'PPP' delivery model.
  return project.project_type === 'Infrastructure / PPP'
}

// ── P-028 D1: Results cash-flow table (PPP) ──
// Tax Expense (accrual: Net Income = PBT − Tax Expense) is shown separately
// from Cash Tax Paid (cash: CFADS = EBITDA − Cash Tax Paid; equity CF = CFADS −
// debt service). Results without a tax_expense field (tax-exempt, Tax
// Depreciation = None, earlier engines) charge and pay tax in the same
// period, so their Tax Expense equals the cash tax. Display only: the saved
// rows are not modified. Annual rows of quarterly models carry the summed
// quarterly values. Real-estate results keep their existing table.
export const PPP_CASH_FLOW_HEADERS = ['Year', 'Phase', 'Revenue', 'Opex', 'EBITDA', 'Interest', 'PBT',
  'Tax Expense', 'Cash Tax Paid', 'Net Income', 'Principal', 'Equity CF']
export function pppCashFlowRows(rows) {
  return (rows || []).map(r => ({ ...r, tax_expense: r.tax_expense !== undefined ? r.tax_expense : r.tax }))
}

// ── P-028 D2: PDF "Tax Methodology & Assumptions" section ──
// Content for a saved taxable P-028 result (null otherwise). Raw values;
// generatePDF formats them (Governance §10).
export function pppTaxDisclosure(modelOutput) {
  const ta = modelOutput && modelOutput.tax_assumptions
  if (!ta) return null
  const quarterly = modelOutput.periodicity === 'quarterly'
  const notes = []
  if (ta.loss_carry_forward_years !== 'unlimited') {
    notes.push('Loss expiry is simplified: a tax loss may be used for ' + ta.loss_carry_forward_years + ' tax years after the year it ' +
      'arises (a partial first year counts as a full year), then expires. Jordanian rules count the period from when losses are ' +
      'final and audited, which is usually later, so the modelled expiry is earlier (conservative).')
  }
  notes.push('Cash Tax Paid follows the tax-year payment dates and is used for CFADS, DSCR and equity cash flows. Tax Expense is the ' +
    'accrual used for Net Income. Depreciation is non-cash and is never deducted from CFADS.')
  notes.push((quarterly ? 'Quarterly model: period tax expense allocates each tax year’s tax to quarters'
    : 'Period tax expense allocates each tax year’s tax to model years') +
    ' in proportion to taxable income. This is a modelling estimate, not an accounting-standard tax provision.')
  if (!ta.depreciable_share_given) notes.push('Depreciable share was not entered: 100% of TPC plus eligible IDC is assumed depreciable.')
  return {
    title: 'Tax Methodology & Assumptions',
    status: 'The tax methodology is a modelling assumption, not confirmed Jordanian tax treatment. Confirm the tax rate, asset ' +
      'classification and allowable depreciation period, loss rules and payment dates with a tax adviser before relying on these results.',
    items: [
      { key: 'tax_rate',  label: 'Tax rate (combined income tax + national contribution)', value: ta.tax_rate, unit: 'fraction' },
      { key: 'method',    label: 'Depreciation method', value: 'Straight-line from COD', unit: 'text' },
      { key: 'basis',     label: 'Depreciation basis (share x (TPC + eligible IDC))', value: ta.levered_basis, unit: 'JOD' },
      { key: 'life',      label: 'Depreciation life (preliminary' + (ta.life_is_default ? '; default = concession period' : '') + ')',
        value: ta.depreciation_life_years, unit: 'years' },
      { key: 'share',     label: 'Depreciable share of TPC + eligible IDC', value: ta.depreciable_share, unit: 'fraction' },
      { key: 'idc',       label: 'Eligible capitalised IDC', value: ta.idc_eligible_share, unit: 'fraction' },
      { key: 'losses',    label: 'Tax-loss carry-forward', value: ta.loss_carry_forward_years, unit: 'years' },
      { key: 'lag',       label: 'Tax payment lag after tax-year end', value: ta.payment_lag_months, unit: 'months' },
      { key: 'tax_years', label: 'Tax years', unit: 'text',
        value: ta.tax_year_basis === 'calendar' ? 'Ending month ' + ta.tax_year_end_month + ' (calendar)' : '12-month years from COD (no start date)' },
      { key: 'write_off', label: 'Terminal write-off at hand-back', value: ta.terminal_write_off ? 'Yes (selected)' : 'No', unit: 'text' },
    ],
    notes,
  }
}
