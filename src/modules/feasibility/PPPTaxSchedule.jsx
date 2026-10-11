import { useState } from 'react'
import colors from '../../theme/colors.js'
import { fmtNumber, fmtPct } from '../../utils/format.js'

// P-028: tax schedule of a saved PPP result (one row per tax year). Shown
// only for taxable results calculated with tax depreciation. Read-only.
export default function PPPTaxSchedule({ modelOutput }) {
  const [open, setOpen] = useState(false)
  const sched = modelOutput && modelOutput.tax_schedule
  const ta = modelOutput && modelOutput.tax_assumptions
  if (!Array.isArray(sched) || !sched.length || !ta) return null
  const cell = { padding: '0.45rem 0.6rem', textAlign: 'right', whiteSpace: 'nowrap' }
  const cols = [
    ['Tax year', s => s.tax_year + (s.partial ? ' (' + s.months + ' mo)' : '')],
    ['EBITDA', s => fmtNumber(s.ebitda)],
    ['Interest', s => fmtNumber(s.interest)],
    ['Tax depreciation', s => fmtNumber(s.depreciation + (s.write_off || 0))],
    ['Taxable income', s => fmtNumber(s.taxable_income)],
    ['Losses used', s => fmtNumber(s.losses_used)],
    ['Losses expired', s => fmtNumber(s.losses_expired)],
    ['Losses c/f', s => fmtNumber(s.losses_closing)],
    ['Tax expense', s => fmtNumber(s.tax_expense)],
    ['Paid', s => (s.payment_month || 'period ' + (s.payment_period + 1)) + (s.payment_accelerated ? ' *' : '')],
  ]
  const cf = ta.loss_carry_forward_years === 'unlimited' ? 'unlimited' : ta.loss_carry_forward_years + ' tax years'
  return (
    <div style={{ marginBottom: '2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
        <h3 style={{ fontSize: '0.8rem', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Tax Schedule (JOD) — modelling assumptions
        </h3>
        <button onClick={() => setOpen(!open)}
          style={{ padding: '0.25rem 0.7rem', background: 'none', border: `1px solid ${colors.border}`, borderRadius: '4px',
            color: colors.textSecondary, cursor: 'pointer', fontSize: '0.72rem' }}>
          {open ? 'Hide tax years' : 'Show tax years'}
        </button>
      </div>
      <p style={{ fontSize: '0.74rem', color: colors.textMuted, lineHeight: 1.5, marginBottom: '0.6rem' }}>
        Straight-line tax depreciation over {String(ta.depreciation_life_years)} years from COD on
        {' '}{fmtNumber(ta.levered_basis)} ({fmtPct(ta.depreciable_share * 100)} of TPC + {fmtPct(ta.idc_eligible_share * 100)} of IDC);
        loss carry-forward {cf}; tax years {ta.tax_year_basis === 'calendar' ? 'ending in month ' + ta.tax_year_end_month : 'from COD (no start date)'};
        tax paid {ta.payment_lag_months} months after each tax-year end. Combined tax rate {fmtPct(ta.tax_rate * 100)}.
        These are modelling assumptions, not confirmed Jordanian tax treatment. Period tax expense is an allocation estimate,
        not an accounting-standard tax provision; CFADS uses the cash tax paid.
      </p>
      {open && (
        <div style={{ overflowX: 'auto', border: `1px solid ${colors.border}`, borderRadius: '8px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                {cols.map(([h]) => <th key={h} style={{ ...cell, color: colors.textSecondary, fontWeight: 500 }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {sched.map((s, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {cols.map(([h, f]) => <td key={h} style={{ ...cell, color: colors.textPrimary }}>{f(s)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {ta.payment_accelerated && (
            <p style={{ fontSize: '0.7rem', color: colors.textMuted, padding: '0.5rem 0.75rem' }}>
              * Due after the concession ends; paid in the final operating period (conservative).
            </p>
          )}
        </div>
      )}
    </div>
  )
}
