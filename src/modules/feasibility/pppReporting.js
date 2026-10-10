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
import { isPPPAvailabilityPayment } from './annualEngine.js'

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
  return ((compatibleVersions || [engineVersion]).includes(p.engine_version)
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
  'Tax: statutory rate on (EBITDA − interest) each period. No tax depreciation or amortisation of capitalised cost and no tax-loss carry-forward — tax is overstated (conservative) for taxable projects.',
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
