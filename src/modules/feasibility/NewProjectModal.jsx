import { useState } from 'react'
import { supabase } from '../../lib/supabase'

// ── Section titles ──
const RE_SECTIONS        = ['Project Identity', 'Capital Structure', 'Revenue & Market', 'Costs (Optional)']
const PF_AP_SECTIONS     = ['Project Identity', 'Project Financials', 'Revenue & Payments', 'Financing Terms']
const PF_OTHER_SECTIONS  = ['Project Identity', 'Confirm & Create']

// ── Layer 2: sectors by model type ──
const PF_SECTORS = ['Infrastructure', 'Energy', 'Healthcare', 'Industrial']

// ── Layer 3: revenue options by sector ──
const revenueOptions = {
  'Real Estate':    ['Sales', 'Rental / Yield'],
  'Infrastructure': ['Availability Payment', 'Demand-based', 'Hybrid'],
  'Energy':         ['PPA', 'Availability Payment', 'Demand-based'],
  'Healthcare':     ['Availability Payment', 'Demand-based'],
  'Industrial':     ['Contracted Revenue', 'Merchant Revenue'],
}

// ── Derived helpers ──
function getFinancingStructure(modelType) {
  return modelType === 'Project Finance' ? 'Project Finance' : 'Corporate Finance'
}

function getLegacyProjectType(modelType, sector, revenueModel) {
  if (modelType === 'Real Estate') return 'Real Estate'
  if (sector === 'Infrastructure' && revenueModel === 'Availability Payment') return 'Infrastructure / PPP'
  return sector
}

function isAPEngine(revenueModel) {
  return revenueModel === 'Availability Payment'
}

export default function NewProjectModal({ onClose }) {
  const [step, setStep] = useState(0)
  const [form, setForm] = useState({
    // ── Layer 1 ──
    model_type: 'Real Estate',        // 'Real Estate' | 'Project Finance'
    // ── Layer 2 ──
    sector: 'Real Estate',            // RE: 'Real Estate' | PF: 'Infrastructure' | 'Energy' | 'Healthcare' | 'Industrial'
    // ── Layer 3 ──
    top_revenue_model: 'Sales',       // goes to projects.revenue_model

    // ── Shared ──
    name: '',
    country: 'Jordan',
    currency: 'JOD',

    // ── Real Estate ──
    project_subtype: 'Residential',
    construction_start_date: '',
    operations_start_date: '',
    project_life_years: 20,
    gfa_sqm: '',
    efficiency_pct: 85,
    delivery_model: 'Traditional',
    equity_pct: 30,
    senior_debt_pct: 70,
    sub_debt_pct: 0,
    shareholder_loan_pct: 0,
    debt_type: 'Amortizing',
    re_revenue_model: 'Sale',         // RE sub-model for assumptions only
    sale_split_pct: 50,
    sale_price_override: '',
    rental_yield_override: '',
    absorption_override: '',
    land_cost_pct: '',
    construction_cost_override: '',

    // ── Project Finance ──
    ppp_tpc: '',
    ppp_debt_pct: 80,
    ppp_equity_pct: 20,
    ppp_annual_payment: '',
    ppp_concession_years: 25,
    ppp_construction_months: 24,
    ppp_opex_pct: 5,
    ppp_interest_rate: 7,
    ppp_loan_tenor_years: 10,
    ppp_grace_period_years: 2,
    ppp_tax_rate: 20,
    ppp_wacc: 10,
    target_dscr: 1.20,
  })

  function update(field, value) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  function updateModelType(newType) {
    if (newType === 'Real Estate') {
      setForm(prev => ({
        ...prev,
        model_type: 'Real Estate',
        sector: 'Real Estate',
        top_revenue_model: 'Sales',
      }))
    } else {
      const firstSector = PF_SECTORS[0]
      setForm(prev => ({
        ...prev,
        model_type: 'Project Finance',
        sector: firstSector,
        top_revenue_model: revenueOptions[firstSector][0],
      }))
    }
  }

  function updateSector(newSector) {
    setForm(prev => ({
      ...prev,
      sector: newSector,
      top_revenue_model: revenueOptions[newSector]?.[0] || '',
    }))
  }

  // ── Derived flags ──
  const isRE      = form.model_type === 'Real Estate'
  const isPF      = form.model_type === 'Project Finance'
  const isAP      = isAPEngine(form.top_revenue_model)
  const financing = getFinancingStructure(form.model_type)

  const SECTIONS = isRE ? RE_SECTIONS : isAP ? PF_AP_SECTIONS : PF_OTHER_SECTIONS

  // ── RE validation ──
  const capitalTotal   = Number(form.equity_pct) + Number(form.senior_debt_pct) +
                         Number(form.sub_debt_pct) + Number(form.shareholder_loan_pct)
  const rentalSplitPct = 100 - Number(form.sale_split_pct)
  const splitValid     = Number(form.sale_split_pct) >= 0 && Number(form.sale_split_pct) <= 100
  const isMixed        = form.re_revenue_model === 'Mixed (Sale + Rental)'

  // ── PF validation ──
  const pfCapTotal = Number(form.ppp_debt_pct) + Number(form.ppp_equity_pct)
  const pfCapValid = pfCapTotal === 100

  // ── Step gate ──
  const canNext = isRE
    ? [
        !!(form.name && form.gfa_sqm),
        capitalTotal === 100,
        !!(form.re_revenue_model && (!isMixed || splitValid)),
        true,
      ]
    : isAP
      ? [
          !!(form.name && form.sector && form.top_revenue_model),
          pfCapValid && Number(form.ppp_tpc) > 0,
          Number(form.ppp_annual_payment) > 0 &&
            Number(form.ppp_concession_years) > 0 &&
            Number(form.ppp_construction_months) > 0,
          true,
        ]
      : [
          !!(form.name && form.sector && form.top_revenue_model),
          true,
        ]

  // ── Submit ──
  async function handleSubmit() {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const { data: userData, error: userError } = await supabase
        .from('users').select('tenant_id').eq('user_id', user.id).single()
      if (userError) throw userError
      const tenant_id = userData.tenant_id

      const { data: project, error: projectError } = await supabase
        .from('projects').insert({
          tenant_id,
          name:                form.name,
          country:             form.country,
          currency:            form.currency,
          sector:              form.sector,
          revenue_model:       form.top_revenue_model,
          financing_structure: financing,
          project_type:        getLegacyProjectType(form.model_type, form.sector, form.top_revenue_model),
          delivery_model:      isRE
                                 ? form.delivery_model
                                 : form.top_revenue_model === 'Availability Payment'
                                   ? 'PPP'
                                   : 'Project Finance',
          forecast_horizon:    isRE
                                 ? Number(form.project_life_years)
                                 : Number(form.ppp_concession_years),
          created_by:          user.id,
        }).select().single()
      if (projectError) throw projectError

      const { data: scenario, error: scenarioError } = await supabase
        .from('scenarios').insert({
          project_id:    project.project_id,
          name:          'Base',
          label:         'Base',
          scenario_type: 'base',
          type:          'base',
        }).select().single()
      if (scenarioError) throw scenarioError

      const { data: version, error: versionError } = await supabase
        .from('versions').insert({
          scenario_id: scenario.scenario_id,
          label:       'v1.0 Draft',
          status:      'draft',
          created_by:  user.id,
        }).select().single()
      if (versionError) throw versionError

      await supabase.from('intake_state').insert({
        version_id:                version.version_id,
        section_completion_status: { identity: true, capital: true, revenue: true },
        validation_flags:          {},
      })

      const base = {
        tenant_id,
        project_id:     project.project_id,
        module_origin:  'feasibility',
        source_type:    'user_entry',
        confidence:     'indicative',
        author_user_id: user.id,
      }

      let allAssumptions

      if (isPF) {
        const identityRows = [
          { name: 'Project Type',   category: 'sizing',  value: null, unit: getLegacyProjectType(form.model_type, form.sector, form.top_revenue_model) },
          { name: 'Project Sector', category: 'sizing',  value: null, unit: form.sector },
          { name: 'Contract Model', category: 'revenue', value: null, unit: form.top_revenue_model },
        ]
        const financialRows = isAP ? [
          { name: 'Total Project Cost',          category: 'ppp_structure', value: Number(form.ppp_tpc),                 unit: 'JOD' },
          { name: 'Debt %',                      category: 'ppp_structure', value: Number(form.ppp_debt_pct),            unit: 'percent' },
          { name: 'Equity %',                    category: 'ppp_structure', value: Number(form.ppp_equity_pct),          unit: 'percent' },
          { name: 'Concession Period',           category: 'ppp_structure', value: Number(form.ppp_concession_years),    unit: 'years' },
          { name: 'Construction Period',         category: 'ppp_structure', value: Number(form.ppp_construction_months), unit: 'months' },
          { name: 'Annual Availability Payment', category: 'ppp_revenue',   value: Number(form.ppp_annual_payment),      unit: 'JOD' },
          { name: 'OPEX % of Revenue',           category: 'ppp_revenue',   value: Number(form.ppp_opex_pct),            unit: 'percent' },
          { name: 'Interest Rate',               category: 'ppp_financing', value: Number(form.ppp_interest_rate),       unit: 'percent' },
          { name: 'Loan Tenor',                  category: 'ppp_financing', value: Number(form.ppp_loan_tenor_years),    unit: 'years' },
          { name: 'Grace Period',                category: 'ppp_financing', value: Number(form.ppp_grace_period_years),  unit: 'years' },
          { name: 'Tax Rate',                    category: 'ppp_financing', value: Number(form.ppp_tax_rate),            unit: 'percent' },
          { name: 'WACC',                        category: 'ppp_financing', value: Number(form.ppp_wacc),                unit: 'percent' },
          { name: 'Target DSCR',                 category: 'ppp_financing', value: Number(form.target_dscr),             unit: 'ratio' },
        ] : []
        allAssumptions = [...identityRows, ...financialRows]
      } else {
        allAssumptions = [
          { name: 'Equity %',            category: 'capital_structure', value: Number(form.equity_pct),           unit: 'percent' },
          { name: 'Senior Debt %',       category: 'capital_structure', value: Number(form.senior_debt_pct),      unit: 'percent' },
          { name: 'Subordinated Debt %', category: 'capital_structure', value: Number(form.sub_debt_pct),         unit: 'percent' },
          { name: 'Shareholder Loan %',  category: 'capital_structure', value: Number(form.shareholder_loan_pct), unit: 'percent' },
          { name: 'Debt Type',           category: 'capital_structure', value: null, unit: form.debt_type },
          { name: 'Revenue Model',       category: 'revenue',           value: null, unit: form.re_revenue_model },
          ...(isMixed ? [{ name: 'Sale Split %', category: 'revenue', value: Number(form.sale_split_pct), unit: 'percent' }] : []),
          { name: 'GFA',              category: 'sizing', value: Number(form.gfa_sqm),        unit: 'sqm' },
          { name: 'Project Sub-type', category: 'sizing', value: null,                        unit: form.project_subtype },
          { name: 'Efficiency %',     category: 'sizing', value: Number(form.efficiency_pct), unit: 'percent' },
          { name: 'Construction Start Date', category: 'timeline', value: null, unit: form.construction_start_date || null },
          { name: 'Operations Start Date',   category: 'timeline', value: null, unit: form.operations_start_date || null },
          { name: 'Project Life Years',      category: 'timeline', value: Number(form.project_life_years), unit: 'years' },
          ...(form.sale_price_override        ? [{ name: 'sale_price_per_sqm_residential',       category: 'benchmark_override', value: Number(form.sale_price_override),        unit: null }]      : []),
          ...(form.rental_yield_override      ? [{ name: 'rental_yield_residential',              category: 'benchmark_override', value: Number(form.rental_yield_override) / 100, unit: 'decimal' }] : []),
          ...(form.absorption_override        ? [{ name: 'sales_absorption_rate_pct_per_year',    category: 'benchmark_override', value: Number(form.absorption_override) / 100,   unit: 'decimal' }] : []),
          ...(form.land_cost_pct              ? [{ name: 'land_cost_pct_of_tdc',                  category: 'benchmark_override', value: Number(form.land_cost_pct) / 100,         unit: 'decimal' }] : []),
          ...(form.construction_cost_override ? [{ name: 'construction_cost_per_sqm_residential', category: 'benchmark_override', value: Number(form.construction_cost_override),  unit: null }]      : []),
        ]
      }

      const { error: assumpError } = await supabase.from('assumptions').insert(
        allAssumptions.map(a => ({ ...base, ...a }))
      )
      if (assumpError) throw assumpError

      onClose({ projectId: project.project_id, projectName: form.name })
    } catch (err) {
      alert('Error: ' + err.message)
    }
  }

  // ── Financing Structure badge ──
  const financingBadgeColor = financing === 'Project Finance' ? '#58a6ff' : '#3fb950'

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div style={{
        background: '#1a2235', border: '1px solid #30363d', borderRadius: '10px',
        width: '600px', maxHeight: '88vh', overflowY: 'auto', padding: '2rem',
      }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
          <div>
            <h2 style={{ fontSize: '1.1rem', fontWeight: '600' }}>New Feasibility Study</h2>
            <p style={{ color: '#8b949e', fontSize: '0.8rem', marginTop: '0.25rem' }}>
              Step {step + 1} of {SECTIONS.length} — {SECTIONS[step]}
            </p>
          </div>
          <button onClick={() => onClose()}
            style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: '1.2rem' }}>
            ✕
          </button>
        </div>

        {/* Progress */}
        <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '2rem' }}>
          {SECTIONS.map((_, i) => (
            <div key={i} style={{
              flex: 1, height: '3px', borderRadius: '2px',
              background: i <= step ? '#1f6feb' : '#21262d',
            }} />
          ))}
        </div>

        {/* ══════════════════════════════════════════
            STEP 0 — Project Identity
        ══════════════════════════════════════════ */}
        {step === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

            <Field label="Project Name" required>
              <input
                value={form.name}
                onChange={e => update('name', e.target.value)}
                placeholder={isRE ? 'e.g. Al Rabwa Residential Tower' : 'e.g. Al Nadeem Hospital PPP'}
                style={inputStyle}
              />
            </Field>

            {/* Layer 1 — Model Type toggle */}
            <Field label="Model Type" required>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                {['Real Estate', 'Project Finance'].map(opt => (
                  <button key={opt} onClick={() => updateModelType(opt)}
                    style={{
                      flex: 1, padding: '0.55rem', borderRadius: '6px', cursor: 'pointer',
                      background: form.model_type === opt ? '#1f6feb' : 'none',
                      border: '1px solid ' + (form.model_type === opt ? '#1f6feb' : '#30363d'),
                      color: form.model_type === opt ? 'white' : '#8b949e',
                      fontSize: '0.875rem',
                    }}>
                    {opt}
                  </button>
                ))}
              </div>
            </Field>

            {/* Layer 2 — Sector (Project Finance only) */}
            {isPF && (
              <Field label="Sector" required>
                <select value={form.sector} onChange={e => updateSector(e.target.value)} style={inputStyle}>
                  {PF_SECTORS.map(s => (
                    <option key={s} value={s}>
                      {s === 'Industrial' ? 'Industrial (Coming Soon)' : s}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {/* Layer 3 — Revenue / Contract Model */}
            <Field label="Revenue / Contract Model" required>
              <select
                value={form.top_revenue_model}
                onChange={e => update('top_revenue_model', e.target.value)}
                style={inputStyle}
              >
                {(revenueOptions[form.sector] || []).map(m => <option key={m}>{m}</option>)}
              </select>
            </Field>

            {/* Financing Structure — read-only badge */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: '#0f1520', border: '1px solid #21262d',
              borderRadius: '6px', padding: '0.6rem 1rem',
            }}>
              <span style={{ fontSize: '0.75rem', color: '#8b949e' }}>Financing Structure</span>
              <span style={{
                fontSize: '0.75rem', fontWeight: '600', color: financingBadgeColor,
                background: financingBadgeColor + '18',
                border: '1px solid ' + financingBadgeColor + '44',
                borderRadius: '20px', padding: '2px 10px',
              }}>
                {financing}
              </span>
            </div>

            {/* PPP clarity helper */}
            {isAP && (
              <p style={{ fontSize: '0.75rem', color: '#8b949e', marginTop: '-0.5rem' }}>
                PPP Model (Availability Payment)
              </p>
            )}

            {/* Non-AP inline notice */}
            {isPF && !isAP && (
              <div style={{
                background: '#0f1520', border: '1px solid #21262d', borderRadius: '6px',
                padding: '0.85rem 1rem',
              }}>
                <p style={{ fontSize: '0.8rem', color: '#8b949e', lineHeight: 1.6 }}>
                  Financial engine for{' '}
                  <strong style={{ color: '#e6edf3' }}>{form.top_revenue_model}</strong>{' '}
                  is planned for a later phase. You can proceed to create the project now.
                </p>
              </div>
            )}

            {/* RE-specific fields */}
            {isRE && (
              <>
                <div style={{ display: 'flex', gap: '1rem' }}>
                  <Field label="Project Sub-type">
                    <select value={form.project_subtype} onChange={e => update('project_subtype', e.target.value)} style={inputStyle}>
                      {['Residential', 'Mixed-Use', 'Retail', 'Villas', 'Commercial'].map(o => <option key={o}>{o}</option>)}
                    </select>
                  </Field>
                  <Field label="Delivery Model">
                    <select value={form.delivery_model} onChange={e => update('delivery_model', e.target.value)} style={inputStyle}>
                      {['Traditional', 'Design & Build', 'PPP', 'Turnkey'].map(o => <option key={o}>{o}</option>)}
                    </select>
                  </Field>
                </div>
                <div style={{ display: 'flex', gap: '1rem' }}>
                  <Field label="Country"><input value="Jordan" disabled style={{ ...inputStyle, opacity: 0.45 }} /></Field>
                  <Field label="Currency"><input value="JOD" disabled style={{ ...inputStyle, opacity: 0.45 }} /></Field>
                </div>
                <div style={{ display: 'flex', gap: '1rem' }}>
                  <Field label="GFA — Gross Floor Area (sqm)" required>
                    <input type="number" value={form.gfa_sqm}
                      onChange={e => update('gfa_sqm', e.target.value)}
                      placeholder="e.g. 5000" style={inputStyle} />
                  </Field>
                  <Field label="Efficiency % (saleable / GFA)">
                    <input type="number" min="40" max="100" value={form.efficiency_pct}
                      onChange={e => update('efficiency_pct', e.target.value)} style={inputStyle} />
                  </Field>
                </div>
                {form.gfa_sqm && form.efficiency_pct && (
                  <p style={{ fontSize: '0.75rem', color: '#484f58', marginTop: '-0.5rem' }}>
                    Saleable / leasable area:{' '}
                    <strong style={{ color: '#8b949e' }}>
                      {Math.round(Number(form.gfa_sqm) * Number(form.efficiency_pct) / 100).toLocaleString('en-US')} sqm
                    </strong>
                  </p>
                )}
                <div style={{ display: 'flex', gap: '1rem' }}>
                  <Field label="Construction Start Date">
                    <input type="date" value={form.construction_start_date}
                      onChange={e => update('construction_start_date', e.target.value)} style={inputStyle} />
                  </Field>
                  <Field label="Operations Start Date">
                    <input type="date" value={form.operations_start_date}
                      onChange={e => update('operations_start_date', e.target.value)} style={inputStyle} />
                  </Field>
                </div>
                <Field label="Project Life (Years)">
                  <input type="number" value={form.project_life_years}
                    onChange={e => update('project_life_years', e.target.value)} style={inputStyle} />
                </Field>
              </>
            )}

            {/* PF: country + currency */}
            {isPF && (
              <div style={{ display: 'flex', gap: '1rem' }}>
                <Field label="Country"><input value="Jordan" disabled style={{ ...inputStyle, opacity: 0.45 }} /></Field>
                <Field label="Currency"><input value="JOD" disabled style={{ ...inputStyle, opacity: 0.45 }} /></Field>
              </div>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════
            STEP 1 — RE: Capital Structure
        ══════════════════════════════════════════ */}
        {step === 1 && isRE && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ fontSize: '0.8rem', color: '#8b949e' }}>
              Must sum to 100%. Current total:{' '}
              <strong style={{ color: capitalTotal === 100 ? '#3fb950' : '#f85149' }}>{capitalTotal}%</strong>
            </p>
            {[
              { label: 'Equity %',            field: 'equity_pct' },
              { label: 'Senior Debt %',       field: 'senior_debt_pct' },
              { label: 'Subordinated Debt %', field: 'sub_debt_pct' },
              { label: 'Shareholder Loan %',  field: 'shareholder_loan_pct' },
            ].map(({ label, field }) => (
              <Field key={field} label={label}>
                <input type="number" min="0" max="100" value={form[field]}
                  onChange={e => update(field, e.target.value)} style={inputStyle} />
              </Field>
            ))}
            <Field label="Debt Repayment Type">
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                {['Amortizing', 'Bullet'].map(type => (
                  <button key={type} onClick={() => update('debt_type', type)}
                    style={{
                      flex: 1, padding: '0.5rem', borderRadius: '6px', cursor: 'pointer',
                      background: form.debt_type === type ? '#1f6feb' : 'none',
                      border: '1px solid ' + (form.debt_type === type ? '#1f6feb' : '#30363d'),
                      color: form.debt_type === type ? 'white' : '#8b949e', fontSize: '0.875rem',
                    }}>
                    {type}
                  </button>
                ))}
              </div>
              <p style={{ fontSize: '0.72rem', color: '#484f58', marginTop: '0.4rem' }}>
                {form.debt_type === 'Bullet'
                  ? 'Principal repaid in full at loan maturity.'
                  : 'Principal repaid progressively over the loan tenor.'}
              </p>
            </Field>
          </div>
        )}

        {/* ══════════════════════════════════════════
            STEP 1 — PF AP: Project Financials
        ══════════════════════════════════════════ */}
        {step === 1 && isPF && isAP && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Field label="Total Project Cost (JOD)" required>
              <input type="number" value={form.ppp_tpc}
                onChange={e => update('ppp_tpc', e.target.value)}
                placeholder="e.g. 54,500,000" style={inputStyle} />
            </Field>
            {form.ppp_tpc && Number(form.ppp_tpc) > 0 && (
              <p style={{ fontSize: '0.75rem', color: '#484f58', marginTop: '-0.5rem' }}>
                {Number(form.ppp_tpc).toLocaleString('en-US')} JOD
              </p>
            )}
            <div style={{ background: '#0f1520', border: '1px solid #30363d', borderRadius: '8px', padding: '1rem' }}>
              <p style={{ fontSize: '0.78rem', color: '#8b949e', marginBottom: '0.75rem' }}>
                Capital Structure — must sum to 100%.{' '}
                <strong style={{ color: pfCapValid ? '#3fb950' : '#f85149' }}>Current: {pfCapTotal}%</strong>
              </p>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <Field label="Debt %">
                  <input type="number" min="0" max="100" value={form.ppp_debt_pct}
                    onChange={e => {
                      const v = Math.min(100, Math.max(0, Number(e.target.value)))
                      setForm(prev => ({ ...prev, ppp_debt_pct: v, ppp_equity_pct: 100 - v }))
                    }} style={inputStyle} />
                </Field>
                <Field label="Equity %">
                  <input type="number" min="0" max="100" value={form.ppp_equity_pct}
                    onChange={e => {
                      const v = Math.min(100, Math.max(0, Number(e.target.value)))
                      setForm(prev => ({ ...prev, ppp_equity_pct: v, ppp_debt_pct: 100 - v }))
                    }} style={inputStyle} />
                </Field>
              </div>
              {form.ppp_tpc && Number(form.ppp_tpc) > 0 && pfCapValid && (
                <div style={{ display: 'flex', gap: '1rem', marginTop: '0.75rem' }}>
                  <p style={{ fontSize: '0.75rem', color: '#484f58', flex: 1 }}>
                    Debt: <strong style={{ color: '#8b949e' }}>{Math.round(Number(form.ppp_tpc) * Number(form.ppp_debt_pct) / 100).toLocaleString('en-US')} JOD</strong>
                  </p>
                  <p style={{ fontSize: '0.75rem', color: '#484f58', flex: 1 }}>
                    Equity: <strong style={{ color: '#8b949e' }}>{Math.round(Number(form.ppp_tpc) * Number(form.ppp_equity_pct) / 100).toLocaleString('en-US')} JOD</strong>
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════
            STEP 1 — PF non-AP: Coming Soon
        ══════════════════════════════════════════ */}
        {step === 1 && isPF && !isAP && (
          <ComingSoon model={form.top_revenue_model} projectName={form.name} sector={form.sector} />
        )}

        {/* ══════════════════════════════════════════
            STEP 2 — RE: Revenue & Market
        ══════════════════════════════════════════ */}
        {step === 2 && isRE && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Field label="Revenue Model">
              <select value={form.re_revenue_model}
                onChange={e => update('re_revenue_model', e.target.value)} style={inputStyle}>
                {['Sale', 'Rental', 'Mixed (Sale + Rental)'].map(o => <option key={o}>{o}</option>)}
              </select>
            </Field>
            {isMixed && (
              <div style={{ background: '#0f1520', border: '1px solid #30363d', borderRadius: '8px', padding: '1rem' }}>
                <p style={{ fontSize: '0.78rem', color: '#8b949e', marginBottom: '0.75rem' }}>GFA Split</p>
                <div style={{ display: 'flex', gap: '1rem' }}>
                  <Field label="Sale %">
                    <input type="number" min="0" max="100" value={form.sale_split_pct}
                      onChange={e => update('sale_split_pct', e.target.value)} style={inputStyle} />
                  </Field>
                  <Field label="Rental %">
                    <input value={rentalSplitPct} disabled style={{ ...inputStyle, opacity: 0.45 }} />
                  </Field>
                </div>
              </div>
            )}
            <div style={{ borderTop: '1px solid #21262d', paddingTop: '1rem' }}>
              <p style={{ fontSize: '0.78rem', color: '#8b949e', marginBottom: '1rem' }}>
                Optional — leave blank to use Jordan RE benchmark defaults
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {(form.re_revenue_model === 'Sale' || isMixed) && (
                  <Field label="Sale Price per saleable sqm — JOD (override)">
                    <input type="number" value={form.sale_price_override}
                      onChange={e => update('sale_price_override', e.target.value)}
                      placeholder="Default ~2,200 JOD/sqm" style={inputStyle} />
                    <p style={{ fontSize: '0.75rem', color: '#8b949e', marginTop: '0.35rem' }}>
                      Enter price per net saleable area, after Efficiency %. Do not enter a per-gross-sqm price.
                    </p>
                  </Field>
                )}
                {(form.re_revenue_model === 'Rental' || isMixed) && (
                  <Field label="Rental Yield % (override)">
                    <input type="number" step="0.1" value={form.rental_yield_override}
                      onChange={e => update('rental_yield_override', e.target.value)}
                      placeholder="Default 6.0%" style={inputStyle} />
                  </Field>
                )}
                {(form.re_revenue_model === 'Sale' || isMixed) && (
                  <Field label="Sales Absorption Rate % per year (override)">
                    <input type="number" step="1" value={form.absorption_override}
                      onChange={e => update('absorption_override', e.target.value)}
                      placeholder="Default 30%" style={inputStyle} />
                  </Field>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════
            STEP 2 — PF AP: Revenue & Payments
        ══════════════════════════════════════════ */}
        {step === 2 && isPF && isAP && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Field label="Annual Availability Payment (JOD)" required>
              <input type="number" value={form.ppp_annual_payment}
                onChange={e => update('ppp_annual_payment', e.target.value)}
                placeholder="e.g. 8,980,000" style={inputStyle} />
            </Field>
            {form.ppp_annual_payment && Number(form.ppp_annual_payment) > 0 && (
              <p style={{ fontSize: '0.75rem', color: '#484f58', marginTop: '-0.5rem' }}>
                {Number(form.ppp_annual_payment).toLocaleString('en-US')} JOD per year
              </p>
            )}
            <div style={{ display: 'flex', gap: '1rem' }}>
              <Field label="Operations / Revenue Period (Concession) — years" required>
                <input type="number" value={form.ppp_concession_years}
                  onChange={e => update('ppp_concession_years', e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Construction Period (months)" required>
                <input type="number" value={form.ppp_construction_months}
                  onChange={e => update('ppp_construction_months', e.target.value)} style={inputStyle} />
              </Field>
            </div>
            {form.ppp_concession_years && form.ppp_construction_months && (
              <p style={{ fontSize: '0.75rem', color: '#484f58', marginTop: '-0.5rem' }}>
                {(() => {
                  const c = Math.ceil(Number(form.ppp_construction_months) / 12)
                  const o = Number(form.ppp_concession_years)
                  return `Total timeline: ${c + o} years = ${c} yr${c !== 1 ? 's' : ''} construction + ${o} yr${o !== 1 ? 's' : ''} operations / revenue`
                })()}
              </p>
            )}
            <Field label="OPEX % of Annual Payment">
              <input type="number" step="0.5" min="0" max="100" value={form.ppp_opex_pct}
                onChange={e => update('ppp_opex_pct', e.target.value)}
                placeholder="Default 5%" style={inputStyle} />
            </Field>
            <p style={{ fontSize: '0.72rem', color: '#484f58', marginTop: '-0.5rem', lineHeight: 1.5 }}>
              Annual operating costs as a % of the availability payment. Covers O&amp;M, facility management, insurance, and administration.
            </p>
          </div>
        )}

        {/* ══════════════════════════════════════════
            STEP 3 — RE: Costs (Optional)
        ══════════════════════════════════════════ */}
        {step === 3 && isRE && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ background: '#0f1520', border: '1px solid #21262d', borderRadius: '6px', padding: '0.75rem 1rem' }}>
              <p style={{ fontSize: '0.78rem', color: '#484f58' }}>
                All fields optional. Leave blank to use Jordan RE defaults.
                Overrides can also be adjusted later in the Assumptions tab.
              </p>
            </div>
            <Field label="Land Cost % of Total Development Cost">
              <input type="number" step="0.5" value={form.land_cost_pct}
                onChange={e => update('land_cost_pct', e.target.value)}
                placeholder="Default ~20%" style={inputStyle} />
            </Field>
            <Field label="Construction Cost per sqm — JOD">
              <input type="number" value={form.construction_cost_override}
                onChange={e => update('construction_cost_override', e.target.value)}
                placeholder="Default ~850 JOD/sqm" style={inputStyle} />
            </Field>
            {form.gfa_sqm && (form.land_cost_pct || form.construction_cost_override) && (
              <div style={{ background: '#1a2235', border: '1px solid #30363d', borderRadius: '6px', padding: '0.75rem 1rem' }}>
                <p style={{ fontSize: '0.72rem', color: '#8b949e', marginBottom: '0.3rem' }}>Estimated Total Development Cost</p>
                {(() => {
                  const cc  = form.construction_cost_override ? Number(form.construction_cost_override) : 850
                  const tdc = Number(form.gfa_sqm) * cc * 1.05
                  const lp  = form.land_cost_pct ? Number(form.land_cost_pct) / 100 : 0.20
                  return <p style={{ fontSize: '1rem', color: '#e6edf3', fontWeight: '600' }}>{Math.round(tdc + tdc * lp).toLocaleString('en-US')} JOD</p>
                })()}
              </div>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════
            STEP 3 — PF AP: Financing Terms
        ══════════════════════════════════════════ */}
        {step === 3 && isPF && isAP && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <Field label="Interest Rate (%)">
                <input type="number" step="0.1" value={form.ppp_interest_rate}
                  onChange={e => update('ppp_interest_rate', e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Loan Tenor (years)">
                <input type="number" value={form.ppp_loan_tenor_years}
                  onChange={e => update('ppp_loan_tenor_years', e.target.value)} style={inputStyle} />
              </Field>
            </div>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <Field label="Grace Period (years)">
                <input type="number" value={form.ppp_grace_period_years}
                  onChange={e => update('ppp_grace_period_years', e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Tax Rate (%)">
                <input type="number" step="0.5" value={form.ppp_tax_rate}
                  onChange={e => update('ppp_tax_rate', e.target.value)} style={inputStyle} />
              </Field>
            </div>
            <Field label="WACC — Weighted Average Cost of Capital (%)">
              <input type="number" step="0.1" value={form.ppp_wacc}
                onChange={e => update('ppp_wacc', e.target.value)} style={inputStyle} />
            </Field>
            <p style={{ fontSize: '0.72rem', color: '#484f58', marginTop: '-0.5rem', lineHeight: 1.5 }}>
              Used as the NPV discount rate. Enter the blended cost of capital for this project manually.
            </p>

            <Field label="Target Minimum DSCR">
              <input type="number" step="0.01" min="1.00" value={form.target_dscr}
                onChange={e => update('target_dscr', e.target.value)} style={inputStyle} />
            </Field>
            <p style={{ fontSize: '0.72rem', color: '#484f58', marginTop: '-0.5rem', lineHeight: 1.5 }}>
              Used to compute the required availability payment. Default 1.20x (lender bankability threshold).
            </p>
            {/* Deal summary */}
            {form.ppp_tpc && Number(form.ppp_tpc) > 0 && form.ppp_annual_payment && Number(form.ppp_annual_payment) > 0 && (
              <div style={{ background: '#0f1520', border: '1px solid #21262d', borderRadius: '8px', padding: '1rem', marginTop: '0.5rem' }}>
                <p style={{ fontSize: '0.7rem', color: '#8b949e', marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Deal Summary
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem 2rem' }}>
                  {[
                    ['Total Project Cost',              Number(form.ppp_tpc).toLocaleString('en-US') + ' JOD'],
                    ['Debt (' + form.ppp_debt_pct + '%)', Math.round(Number(form.ppp_tpc) * Number(form.ppp_debt_pct)   / 100).toLocaleString('en-US') + ' JOD'],
                    ['Equity (' + form.ppp_equity_pct + '%)', Math.round(Number(form.ppp_tpc) * Number(form.ppp_equity_pct) / 100).toLocaleString('en-US') + ' JOD'],
                    ['Annual Payment',                  Number(form.ppp_annual_payment).toLocaleString('en-US') + ' JOD / yr'],
                    ['Operations / Revenue Period',     form.ppp_concession_years + ' years'],
                    ['Sector',                          form.sector],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <p style={{ fontSize: '0.68rem', color: '#484f58', marginBottom: '0.15rem' }}>{k}</p>
                      <p style={{ fontSize: '0.85rem', color: '#e6edf3', fontWeight: '500' }}>{v}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════
            NAVIGATION
        ══════════════════════════════════════════ */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2rem' }}>
          <button
            onClick={() => step > 0 ? setStep(step - 1) : onClose()}
            style={{
              padding: '0.5rem 1.25rem', background: 'transparent',
              border: '1px solid #30363d', color: '#8b949e',
              borderRadius: '6px', cursor: 'pointer',
            }}>
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            {step === SECTIONS.length - 1 && (isRE || isAP) && (
              <button onClick={handleSubmit}
                style={{
                  padding: '0.5rem 1.25rem', background: 'none',
                  border: '1px solid #30363d', color: '#8b949e',
                  borderRadius: '6px', cursor: 'pointer',
                }}>
                Skip &amp; Create
              </button>
            )}
            <button
              onClick={() => step < SECTIONS.length - 1 ? setStep(step + 1) : handleSubmit()}
              disabled={!canNext[step]}
              style={{
                padding: '0.5rem 1.5rem', background: '#1f6feb', color: 'white',
                border: 'none', borderRadius: '6px', cursor: 'pointer',
                opacity: !canNext[step] ? 0.5 : 1,
              }}>
              {step < SECTIONS.length - 1 ? 'Next' : 'Create Project'}
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}

function ComingSoon({ model, projectName, sector }) {
  return (
    <div style={{ background: '#0f1520', border: '1px solid #21262d', borderRadius: '8px', padding: '2rem', textAlign: 'center' }}>
      <p style={{ fontSize: '0.95rem', color: '#e6edf3', fontWeight: '500', marginBottom: '0.5rem' }}>Engine not yet available</p>
      <p style={{ fontSize: '0.82rem', color: '#8b949e', lineHeight: 1.6, maxWidth: '360px', margin: '0 auto' }}>
        Financial modelling for <strong style={{ color: '#e6edf3' }}>{model}</strong> is planned for a later phase.
      </p>
      {projectName && sector && (
        <div style={{ marginTop: '1.25rem', padding: '0.75rem 1.25rem', background: '#1a2235', border: '1px solid #30363d', borderRadius: '6px', display: 'inline-block', textAlign: 'left' }}>
          <p style={{ fontSize: '0.7rem', color: '#484f58', marginBottom: '0.3rem' }}>Project will be created as:</p>
          <p style={{ fontSize: '0.85rem', color: '#8b949e' }}>
            <strong style={{ color: '#c9d1d9' }}>{projectName}</strong>{' · '}{sector}{' · '}{model}
          </p>
        </div>
      )}
      <p style={{ fontSize: '0.75rem', color: '#484f58', marginTop: '1.25rem' }}>
        Click <strong style={{ color: '#8b949e' }}>Create Project</strong> below to save and return later.
      </p>
    </div>
  )
}

function Field({ label, required, children }) {
  return (
    <div style={{ flex: 1 }}>
      <label style={{ display: 'block', fontSize: '0.75rem', color: '#8b949e', marginBottom: '0.4rem' }}>
        {label}{required && <span style={{ color: '#f85149' }}> *</span>}
      </label>
      {children}
    </div>
  )
}

const inputStyle = {
  width: '100%', padding: '0.5rem 0.75rem',
  background: '#0f1520', border: '1px solid #30363d',
  borderRadius: '6px', color: '#e6edf3', fontSize: '0.9rem',
  boxSizing: 'border-box',
}
