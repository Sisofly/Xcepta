import colors from '../../theme/colors.js'
import { fmtNumber, fmtDSCR, fmtIRR } from '../../utils/format.js'
import { assessResultCurrency } from './resultPersistence.js'

// P-022 / Phase 6: provenance of a saved PPP result plus the funding & debt
// summary read from the SAVED record (never recalculated here). Makes it
// impossible to mistake a historical or outdated approval for a current
// calculation.
const BINDING_LABEL = {
  dscr: 'DSCR capacity (cash-flow constrained)',
  gearing: 'Requested gearing (Debt %)',
  project_cost: 'Project cost (debt funds all capex)',
  none: 'No debt',
}

function Banner({ tone, title, children, action }) {
  const border = tone === 'warn' ? colors.warning : colors.border
  const bg = tone === 'warn' ? colors.warningSoft : colors.surfaceElevated
  return (
    <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: '8px', padding: '0.75rem 1.1rem',
      marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0 }}>
        <p style={{ fontSize: '0.82rem', fontWeight: 600, color: tone === 'warn' ? colors.warning : colors.textSecondary, marginBottom: '0.2rem' }}>{title}</p>
        <div style={{ fontSize: '0.76rem', color: colors.textSecondary, lineHeight: 1.5 }}>{children}</div>
      </div>
      {action}
    </div>
  )
}

export default function PPPResultProvenance({ modelOutput, assumptions, engineVersion, compatibleVersions, onNewDraft, creatingDraft }) {
  const cur = assessResultCurrency(modelOutput, { engineVersion, compatibleVersions, assumptions })
  if (!cur) return null
  const p = modelOutput._persistence
  const when = p.computed_at ? new Date(p.computed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'unknown date'
  const draftBtn = onNewDraft && (
    <button onClick={onNewDraft} disabled={creatingDraft}
      style={{ padding: '0.4rem 1rem', background: colors.warning, color: colors.surfaceMuted, border: 'none', borderRadius: '6px',
        cursor: creatingDraft ? 'not-allowed' : 'pointer', fontSize: '0.78rem', fontWeight: 600, whiteSpace: 'nowrap', opacity: creatingDraft ? 0.6 : 1 }}>
      {creatingDraft ? 'Creating…' : 'New draft to recalculate'}
    </button>
  )
  const ds = modelOutput.debt_sizing
  const periodicity = modelOutput.periodicity || 'annual'
  const rows = ds ? [
    ['Base project cost (input, excl. IDC)', fmtNumber(modelOutput.tdc)],
    ['Capitalised interest during construction (IDC)', fmtNumber(modelOutput.idc_capitalized)],
    ['Total funding requirement', fmtNumber(modelOutput.total_funding_requirement)],
    ['Equity', fmtNumber(modelOutput.equity_amount)],
    ['Senior debt — principal drawn', fmtNumber(ds.principal_drawn)],
    ['Senior debt — balance at COD (principal + IDC)', fmtNumber(modelOutput.debt_amount)],
    ['Debt amount limited by', BINDING_LABEL[ds.binding_constraint] || ds.binding_constraint || '—'],
    ['DSCR — sculpting target / underwriting minimum', fmtDSCR(ds.target_dscr) + ' / ' + (ds.underwriting_dscr === undefined ? '— (not stored)' : fmtDSCR(ds.underwriting_dscr))],
    ['DSCR — achieved minimum / average (' + (ds.dscr_basis || 'annual') + ')', fmtDSCR(ds.min_dscr) + ' / ' + fmtDSCR(ds.avg_dscr)],
    ['Meets underwriting minimum', ds.meets_underwriting === undefined || ds.meets_underwriting === null ? '—' : ds.meets_underwriting ? 'Yes' : 'No'],
    ['Loan tenor from COD / grace / repayment (years)', [ds.loan_tenor_years, ds.grace_years, ds.repayment_years].join(' / ')],
    ['Project IRR (unlevered, post-tax, before financing)', fmtIRR(modelOutput.project_irr)],
    ['Equity IRR (levered)', fmtIRR(modelOutput.irr)],
  ] : null

  return (
    <div style={{ marginBottom: '1.5rem' }}>
      {cur.status === 'legacy' && (
        <Banner tone="warn" title="Historical result — saved before versioned results" action={draftBtn}>
          These figures are shown exactly as approved on {when}; they have not been recalculated. Engine generation
          (inferred from stored fields): {cur.inferred_generation}. Not stored with this result: {p.missing.join(', ')} —
          the debt schedule below is reconstructed from the saved cash flows. The current engine is v{cur.current_engine}.
          To obtain a current result, create a new draft and re-approve; this approval stays in the version history.
        </Banner>
      )}
      {cur.status === 'stale_engine' && (
        <Banner tone="warn" title={`Outdated calculation — engine v${cur.engine_version} (current v${cur.current_engine})`} action={draftBtn}>
          This approved result was produced on {when} by an engine version whose results differ from the current engine.
          It is shown as approved and has not been recalculated. Create a new draft and re-approve to recalculate.
        </Banner>
      )}
      {cur.status === 'current' && (
        <Banner title={`Saved result · engine v${cur.engine_version} · ${periodicity} model · calculated ${when}`}>
          All figures on this tab are read from the approved, saved result.
        </Banner>
      )}
      {cur.inputs_changed && cur.inputs_changed.length > 0 && (
        <Banner tone="warn" title={`Inputs changed since approval (${cur.inputs_changed.length})`} action={draftBtn}>
          The figures reflect the inputs at approval, not the current Assumptions tab:{' '}
          {cur.inputs_changed.slice(0, 8).map(c => `${c.name}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join('; ')}
          {cur.inputs_changed.length > 8 ? ` and ${cur.inputs_changed.length - 8} more` : ''}.
        </Banner>
      )}
      {rows && (
        <div style={{ background: colors.surfaceElevated, border: `1px solid ${colors.border}`, borderRadius: '8px', overflow: 'auto' }}>
          <p style={{ fontSize: '0.75rem', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '0.75rem 1rem 0.25rem' }}>
            Funding &amp; debt summary (JOD, calculated)
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k} style={{ borderTop: `1px solid ${colors.border}` }}>
                  <td style={{ padding: '0.45rem 1rem', color: colors.textSecondary }}>{k}</td>
                  <td style={{ padding: '0.45rem 1rem', color: colors.textPrimary, textAlign: 'right', whiteSpace: 'nowrap' }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
