/**
 * DevEngineTab.jsx
 * Real Estate Development Cash Flow Engine — UI tab for FeasibilityProject.jsx
 *
 * Props:
 *   assumptions:    array from Supabase (same as parent)
 *   defaults:       array from Supabase (same as parent)
 *   onEngineResult: callback(result) — called after every successful run
 */

import { useState, useMemo } from 'react'
import { runCashFlowEngine } from '../modules/feasibility/cashflowEngine.js'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as ReTooltip, Legend, ResponsiveContainer,
  BarChart, Bar, Cell,
} from 'recharts'

// ─── helpers ─────────────────────────────────────────────────────────────────

function getVal(assumptions, name) {
  const a = assumptions.find(a => a.name === name)
  return a ? Number(a.value) : null
}
function getUnit(assumptions, name) {
  const a = assumptions.find(a => a.name === name)
  return a ? a.unit : null
}
function getDef(defaults, key, fallback) {
  const d = defaults.find(d => d.key === key)
  return d ? Number(d.value) : fallback
}
function fmt(n, decimals = 0) {
  if (n == null || isNaN(n)) return '—'
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return '—'
  return (Number(n) * 100).toFixed(2) + '%'
}

// ─── derive initial config from assumptions + defaults ────────────────────────

function deriveConfig(assumptions, defaults) {
  const gfa        = getVal(assumptions, 'GFA') || 5000
  const equityPct  = (getVal(assumptions, 'Equity %') || 30) / 100
  const debtPct    = (getVal(assumptions, 'Senior Debt %') || 60) / 100
  const csDate     = getUnit(assumptions, 'Construction Start Date')
  const osDate     = getUnit(assumptions, 'Operations Start Date')

  let T = 18
  if (csDate && osDate && csDate.length > 4 && osDate.length > 4) {
    const diffDays = (new Date(osDate) - new Date(csDate)) / (1000 * 60 * 60 * 24)
    T = Math.max(6, Math.round(diffDays / 30))
  }

  const constCostSqm = getDef(defaults, 'construction_cost_per_sqm_residential', 650)
  const contingency  = getDef(defaults, 'contingency_pct', 0.05)
  const landPct      = getDef(defaults, 'land_cost_pct_of_tdc', 0.20)
  const salePriceSqm = getDef(defaults, 'sale_price_per_sqm_residential', 1200)
  const debtRate     = getDef(defaults, 'senior_debt_interest_rate', 0.085)
  const wacc         = getDef(defaults, 'discount_rate_wacc', 0.12)

  const hardCostTotal = gfa * constCostSqm * (1 + contingency)
  const softCostTotal = hardCostTotal * 0.12
  const landCost      = hardCostTotal * landPct
  const tpc           = hardCostTotal + softCostTotal + landCost
  const totalGDV      = gfa * salePriceSqm

  return {
    T,
    landCost:           Math.round(landCost),
    hardCostTotal:      Math.round(hardCostTotal),
    softCostTotal:      Math.round(softCostTotal),
    upfrontSoftCosts:   Math.round(softCostTotal * 0.15),
    sCurveAlpha:        1.0,
    softCostMode:       'flat',
    totalGDV:           Math.round(totalGDV),
    phaseWeights:       { pre: 0.30, during: 0.50, post: 0.20 },
    paymentSchedule:    { deposit: 0.10, installments: 0.70, handover: 0.20 },
    postSaleMonths:     6,
    duringSalePattern:  'linear',
    equityAmount:       Math.round(tpc * equityPct),
    loanAmount:         Math.round(tpc * debtPct),
    annualInterestRate: debtRate,
    capitalizeInterest: true,
    exitMethod:         'gdv',
    exitDelay:          0,
    sellingCostRate:    0.02,
    discountRate:       wacc,
    // ── Regional extension placeholder ─────────────────────────────────────────
    // Values: 'Jordan' | 'KSA' | 'UAE'
    // When taxModule(region) is implemented in cashflowEngine.js, this field
    // will drive jurisdiction-specific tax rates, GST/VAT, and PPP structures.
    // Keep neutral (no tax adjustment) until regional modules are built.
    region:             'Jordan',
  }
}

// ─── Tooltip (hover info icon) ────────────────────────────────────────────────

function Tooltip({ text }) {
  const [vis, setVis] = useState(false)
  return (
    <span
      style={{ position: 'relative', display: 'inline-block', marginLeft: '0.35rem', cursor: 'help' }}
      onMouseEnter={() => setVis(true)}
      onMouseLeave={() => setVis(false)}
    >
      <span style={{ color: '#484f58', fontSize: '0.7rem', lineHeight: 1 }}>ⓘ</span>
      {vis && (
        <div style={{
          position: 'absolute', bottom: '130%', left: '50%', transform: 'translateX(-50%)',
          background: '#2d333b', border: '1px solid #444c56', borderRadius: '6px',
          padding: '0.45rem 0.65rem', fontSize: '0.71rem', color: '#c9d1d9',
          whiteSpace: 'normal', width: '210px', zIndex: 200, marginBottom: '4px',
          lineHeight: '1.45', boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        }}>
          {text}
          <div style={{
            position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
            width: 0, height: 0,
            borderLeft: '5px solid transparent', borderRight: '5px solid transparent',
            borderTop: '5px solid #444c56',
          }} />
        </div>
      )}
    </span>
  )
}

// ─── Input with right-side suffix ────────────────────────────────────────────

function SuffixInput({ suffix, style: extraStyle, ...rest }) {
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <input style={{ ...extraStyle, paddingRight: '2.8rem', flex: 1 }} {...rest} />
      <span style={{
        position: 'absolute', right: '0.6rem', fontSize: '0.72rem', color: '#484f58',
        pointerEvents: 'none', userSelect: 'none',
      }}>
        {suffix}
      </span>
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = {
  card: {
    background: '#1a2235',
    border: '1px solid #30363d',
    borderRadius: '8px',
    padding: '1.25rem',
  },
  label: {
    fontSize: '0.72rem',
    color: '#8b949e',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: '0.3rem',
    display: 'block',
  },
  input: {
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: '6px',
    color: '#e6edf3',
    fontSize: '0.82rem',
    padding: '0.4rem 0.6rem',
    width: '100%',
    boxSizing: 'border-box',
  },
  select: {
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: '6px',
    color: '#e6edf3',
    fontSize: '0.82rem',
    padding: '0.4rem 0.6rem',
    width: '100%',
  },
  section: {
    fontSize: '0.72rem',
    color: '#8b949e',
    textTransform: 'uppercase',
    letterSpacing: '0.07em',
    marginBottom: '0.75rem',
    paddingBottom: '0.4rem',
    borderBottom: '1px solid #21262d',
  },
  kpiCard: (accent) => ({
    background: '#161b22',
    border: `1px solid ${accent}33`,
    borderRadius: '8px',
    padding: '1rem 1.25rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  }),
  kpiVal: (accent) => ({
    fontSize: '1.4rem',
    fontWeight: '700',
    color: accent,
    fontVariantNumeric: 'tabular-nums',
  }),
  kpiLabel: {
    fontSize: '0.72rem',
    color: '#8b949e',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
}

// ─── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, accent = '#58a6ff', sub }) {
  return (
    <div style={S.kpiCard(accent)}>
      <div style={S.kpiLabel}>{label}</div>
      <div style={S.kpiVal(accent)}>{value}</div>
      {sub && <div style={{ fontSize: '0.72rem', color: '#484f58' }}>{sub}</div>}
    </div>
  )
}

// ─── Field wrapper ────────────────────────────────────────────────────────────

function Field({ label, children, tooltip }) {
  return (
    <div>
      <span style={S.label}>
        {label}
        {tooltip && <Tooltip text={tooltip} />}
      </span>
      {children}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function DevEngineTab({ assumptions, defaults, onEngineResult }) {
  const initial = useMemo(() => deriveConfig(assumptions, defaults), [assumptions, defaults])
  const [cfg, setCfg]           = useState(initial)
  const [output, setOutput]     = useState(null)
  const [error, setError]       = useState(null)
  const [innerTab, setInnerTab] = useState('inputs')

  function set(key, val) {
    setCfg(prev => ({ ...prev, [key]: val }))
  }
  function setNested(key, subkey, val) {
    setCfg(prev => ({ ...prev, [key]: { ...prev[key], [subkey]: val } }))
  }

  // ── Run engine — guards against null result and engine exceptions ──
  function runModel() {
    setError(null)
    try {
      const result = runCashFlowEngine({ projectName: 'Dev Engine Run', ...cfg })
      if (!result) {
        setError('Engine failed to return results')
        return
      }

      // ── IRR Sensitivity Matrix ──
      // Computed at run-time and stored in result so the PDF
      // can read it from version.dev_engine_results without recalculating.
      const PRICE_STEPS = [-0.05, 0, 0.05]
      const COST_STEPS  = [-0.05, 0, 0.05]
      const sensitivityMatrix = COST_STEPS.map(costAdj =>
        PRICE_STEPS.map(priceAdj => {
          try {
            const adjusted = runCashFlowEngine({
              projectName: 'Sensitivity',
              ...cfg,
              totalGDV:       cfg.totalGDV       * (1 + priceAdj),
              hardCostTotal:  cfg.hardCostTotal  * (1 + costAdj),
              softCostTotal:  cfg.softCostTotal  * (1 + costAdj),
            })
            return { costAdj, priceAdj, irr: adjusted?.summary?.leveragedIRR ?? null }
          } catch { return { costAdj, priceAdj, irr: null } }
        })
      )
      result.sensitivityMatrix = sensitivityMatrix

      setOutput(result)
      setInnerTab('kpis')
      if (onEngineResult) onEngineResult(result)
    } catch (e) {
      setError(e.message)
    }
  }

  // Derived — safe with optional chaining; null when output is not yet set
  const s      = output?.summary
  const loanOk = !s?.loanCapacityBreached

  function irrColor(pctStr) {
    const v = parseFloat(pctStr)
    if (isNaN(v)) return '#8b949e'
    if (v >= 15)  return '#3fb950'
    if (v >= 10)  return '#d29922'
    return '#f85149'
  }

  // ── Chart data ──
  // net_cf and cumulative are not native engine fields — computed here so
  // Recharts dataKeys resolve correctly without modifying the engine.
  const chartSchedule = (() => {
    if (!output?.schedule) return []
    const result = []
    let cumulative = 0
    for (let i = 0; i < output.schedule.length; i++) {
      const row           = output.schedule[i]
      const totalCostDraw = (row.hardCostDraw || 0) + (row.softCostDraw || 0)
      const net_cf        = (row.salesInflow  || 0) - totalCostDraw
      cumulative         += net_cf
      result.push({ ...row, totalCostDraw, net_cf, cumulative })
    }
    return result
  })()

  // Peak funding gap — most negative cumulative point
  const peakGapRow = chartSchedule.length
    ? chartSchedule.reduce((min, row) => row.cumulative < min.cumulative ? row : min, chartSchedule[0])
    : null
  const hasFundingGap = peakGapRow && peakGapRow.cumulative < 0

  // ── Waterfall data — computed from output.schedule, safe when output is null ──
  const waterfallData = output?.schedule ? (() => {
    const totalCosts   = output.schedule.reduce((a, r) => a + ((r.hardCostDraw || 0) + (r.softCostDraw || 0)), 0)
    const totalSales   = output.schedule.reduce((a, r) => a + (r.salesInflow  || 0), 0)
    const totalEquity  = output.schedule.reduce((a, r) => a + (r.equityDraw   || 0), 0)
    const totalDebt    = output.schedule.reduce((a, r) => a + (r.loanDraw     || 0), 0)
    const finalDebt    = output.schedule.length ? (output.schedule[output.schedule.length - 1].loanBalance || 0) : 0
    const equityReturn = totalSales - totalCosts - finalDebt

    // Bridge waterfall: each bar sits on a transparent base so bars
    // flow continuously from 0 → equity return like an investor bridge chart.
    const steps = [
      { name: 'Equity In',      raw:  totalEquity   },
      { name: 'Debt In',        raw:  totalDebt     },
      { name: 'Cost Out',       raw: -totalCosts    },
      { name: 'Sales In',       raw:  totalSales    },
      { name: 'Debt Repaid',    raw: -finalDebt     },
      { name: 'Equity Return',  raw:  equityReturn  },
    ]
    let running = 0
    return steps.map((step, i) => {
      const isLast   = i === steps.length - 1
      const positive = step.raw >= 0
      // base: for positive bars, start from current running total
      //       for negative bars, start from running + raw (the lower edge)
      const base  = isLast ? 0 : (positive ? running : running + step.raw)
      const bar   = isLast ? equityReturn : Math.abs(step.raw)
      running    += step.raw
      return { name: step.name, base, bar, raw: step.raw, isLast }
    })
  })() : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <p style={{ fontSize: '0.95rem', color: '#e6edf3', fontWeight: '600', margin: 0 }}>
            Real Estate Development Cash Flow Engine
          </p>
          <p style={{ fontSize: '0.8rem', color: '#8b949e', margin: '0.2rem 0 0' }}>
            Monthly construction drawdown · S-curve · Equity-first funding · Leveraged &amp; unleveraged IRR
          </p>
        </div>
        <button
          onClick={runModel}
          style={{
            background: '#1f6feb', color: '#fff', border: 'none', borderRadius: '6px',
            padding: '0.5rem 1.4rem', fontSize: '0.875rem', fontWeight: '600', cursor: 'pointer',
          }}
        >
          Run Engine
        </button>
      </div>

      {/* ── Error block — always visible when set ── */}
      {error && (
        <div style={{
          background: '#3a1a1a', border: '1px solid #f85149', borderRadius: '6px',
          padding: '0.75rem 1rem', fontSize: '0.82rem', color: '#f85149',
        }}>
          {error}
        </div>
      )}

      {/* ── Inner tab bar ── */}
      <div style={{ display: 'flex', gap: '0.25rem', borderBottom: '1px solid #21262d' }}>
        {['inputs', 'kpis', 'schedule', 'sensitivity'].map(t => (
          <button key={t} onClick={() => setInnerTab(t)}
            style={{
              background: 'none', border: 'none',
              borderBottom: innerTab === t ? '2px solid #1f6feb' : '2px solid transparent',
              color: innerTab === t ? '#e6edf3' : '#8b949e',
              fontSize: '0.82rem', fontWeight: innerTab === t ? '600' : '400',
              padding: '0.4rem 0.9rem', cursor: 'pointer', textTransform: 'capitalize',
            }}>
            {t === 'kpis' ? 'KPI Summary' : t === 'schedule' ? 'Monthly Schedule' : t === 'sensitivity' ? 'Sensitivity' : 'Inputs'}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════
          INPUTS TAB
      ══════════════════════════════════════════════════════ */}
      {innerTab === 'inputs' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.25rem' }}>

          {/* Construction */}
          <div style={S.card}>
            <div style={S.section}>Construction</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <Field label="Construction Months (T)">
                <input style={S.input} type="number" value={cfg.T}
                  onChange={e => set('T', Number(e.target.value))} />
              </Field>
              <Field label="Land Cost">
                <SuffixInput suffix="JOD" style={S.input} type="number" value={cfg.landCost}
                  onChange={e => set('landCost', Number(e.target.value))} />
              </Field>
              <Field label="Hard Cost Total">
                <SuffixInput suffix="JOD" style={S.input} type="number" value={cfg.hardCostTotal}
                  onChange={e => set('hardCostTotal', Number(e.target.value))} />
              </Field>
              <Field label="Soft Cost Total">
                <SuffixInput suffix="JOD" style={S.input} type="number" value={cfg.softCostTotal}
                  onChange={e => set('softCostTotal', Number(e.target.value))} />
              </Field>
              <Field label="Upfront Soft Costs">
                <SuffixInput suffix="JOD" style={S.input} type="number" value={cfg.upfrontSoftCosts}
                  onChange={e => set('upfrontSoftCosts', Number(e.target.value))} />
              </Field>
              <Field
                label="S-Curve Shape (α)"
                tooltip="Controls how construction spending is distributed over time. Front-loaded means more cost early; back-loaded means more cost late."
              >
                <select style={S.select} value={cfg.sCurveAlpha}
                  onChange={e => set('sCurveAlpha', Number(e.target.value))}>
                  <option value={0.7}>0.7 — Front-loaded</option>
                  <option value={1.0}>1.0 — Symmetric</option>
                  <option value={1.5}>1.5 — Back-loaded</option>
                </select>
              </Field>
              <Field
                label="Soft Cost Distribution"
                tooltip="Determines how soft costs are spread across the construction timeline."
              >
                <select style={S.select} value={cfg.softCostMode}
                  onChange={e => set('softCostMode', e.target.value)}>
                  <option value="flat">Flat (equal monthly)</option>
                  <option value="front">Front-loaded (60/30/10)</option>
                  <option value="proportional">Proportional (follows S-curve)</option>
                </select>
              </Field>
            </div>
          </div>

          {/* Sales */}
          <div style={S.card}>
            <div style={S.section}>Sales</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <Field label="Total GDV">
                <SuffixInput suffix="JOD" style={S.input} type="number" value={cfg.totalGDV}
                  onChange={e => set('totalGDV', Number(e.target.value))} />
              </Field>
              <Field
                label="Pre-Construction Sales %"
                tooltip="Defines when units are sold across project lifecycle. Pre-construction sales happen before work begins."
              >
                <SuffixInput suffix="%" style={S.input} type="number" step="1" min="0" max="100"
                  value={Math.round(cfg.phaseWeights.pre * 100)}
                  onChange={e => {
                    const pre    = Math.min(100, Math.max(0, Number(e.target.value))) / 100
                    const rem    = Math.max(0, 1 - pre)
                    const during = Math.min(cfg.phaseWeights.during, rem)
                    setNested('phaseWeights', 'pre', pre)
                    setNested('phaseWeights', 'during', Math.round(during * 100) / 100)
                    setNested('phaseWeights', 'post', Math.round((rem - during) * 100) / 100)
                  }} />
              </Field>
              <Field label="During-Construction Sales %">
                <SuffixInput suffix="%" style={S.input} type="number" step="1" min="0" max="100"
                  value={Math.round(cfg.phaseWeights.during * 100)}
                  onChange={e => {
                    const duringPct = Math.min(
                      100 - Math.round(cfg.phaseWeights.pre * 100),
                      Math.max(0, Number(e.target.value))
                    )
                    const during = duringPct / 100
                    setNested('phaseWeights', 'during', during)
                    setNested('phaseWeights', 'post',
                      Math.round((1 - cfg.phaseWeights.pre - during) * 100) / 100)
                  }} />
              </Field>
              <Field label="Post-Completion Sales % (auto)">
                <SuffixInput suffix="%" style={{ ...S.input, opacity: 0.5 }} type="number" readOnly
                  value={Math.round((1 - cfg.phaseWeights.pre - cfg.phaseWeights.during) * 100)} />
              </Field>
              <Field label="Post-Sale Close-Out Months">
                <input style={S.input} type="number" value={cfg.postSaleMonths}
                  onChange={e => set('postSaleMonths', Number(e.target.value))} />
              </Field>
              <Field label="Deposit %">
                <SuffixInput suffix="%" style={S.input} type="number" step="1" min="0" max="100"
                  value={Math.round(cfg.paymentSchedule.deposit * 100)}
                  onChange={e => setNested('paymentSchedule', 'deposit',
                    Math.min(100, Math.max(0, Number(e.target.value))) / 100)} />
              </Field>
              <Field label="Installments %">
                <SuffixInput suffix="%" style={S.input} type="number" step="1" min="0" max="100"
                  value={Math.round(cfg.paymentSchedule.installments * 100)}
                  onChange={e => setNested('paymentSchedule', 'installments',
                    Math.min(100, Math.max(0, Number(e.target.value))) / 100)} />
              </Field>
              <Field label="Handover %">
                <SuffixInput suffix="%" style={S.input} type="number" step="1" min="0" max="100"
                  value={Math.round(cfg.paymentSchedule.handover * 100)}
                  onChange={e => setNested('paymentSchedule', 'handover',
                    Math.min(100, Math.max(0, Number(e.target.value))) / 100)} />
              </Field>
            </div>
          </div>

          {/* Financing & Exit */}
          <div style={S.card}>
            <div style={S.section}>Financing</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <Field label="Equity Amount">
                <SuffixInput suffix="JOD" style={S.input} type="number" value={cfg.equityAmount}
                  onChange={e => set('equityAmount', Number(e.target.value))} />
              </Field>
              <Field label="Loan Facility">
                <SuffixInput suffix="JOD" style={S.input} type="number" value={cfg.loanAmount}
                  onChange={e => set('loanAmount', Number(e.target.value))} />
              </Field>
              <Field label="Annual Interest Rate">
                <SuffixInput suffix="%" style={S.input} type="number" step="0.1" min="0" max="100"
                  value={parseFloat((cfg.annualInterestRate * 100).toFixed(3))}
                  onChange={e => set('annualInterestRate',
                    Math.min(100, Math.max(0, Number(e.target.value))) / 100)} />
              </Field>
              <Field
                label="Capitalize Interest"
                tooltip="If enabled, monthly interest charges are added to the outstanding loan balance rather than paid in cash."
              >
                <select style={S.select} value={cfg.capitalizeInterest ? 'yes' : 'no'}
                  onChange={e => set('capitalizeInterest', e.target.value === 'yes')}>
                  <option value="yes">Yes — roll into loan balance</option>
                  <option value="no">No — pay cash monthly</option>
                </select>
              </Field>
              <Field label="Discount Rate (WACC)">
                <SuffixInput suffix="%" style={S.input} type="number" step="0.1" min="0" max="100"
                  value={parseFloat((cfg.discountRate * 100).toFixed(3))}
                  onChange={e => set('discountRate',
                    Math.min(100, Math.max(0, Number(e.target.value))) / 100)} />
              </Field>
            </div>

            <div style={{ ...S.section, marginTop: '1.5rem' }}>Exit</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <Field
                label="Exit Method"
                tooltip="Defines how value is realized at project end. GDV uses residual sale proceeds; Cap Rate capitalises net operating income."
              >
                <select style={S.select} value={cfg.exitMethod}
                  onChange={e => set('exitMethod', e.target.value)}>
                  <option value="gdv">GDV (for-sale / residual)</option>
                  <option value="cap_rate">Cap Rate (income-producing)</option>
                </select>
              </Field>
              {cfg.exitMethod === 'cap_rate' && (
                <>
                  <Field label="Gross Rental Income">
                    <SuffixInput suffix="JOD/yr" style={S.input} type="number"
                      value={cfg.grossRentalIncome || 0}
                      onChange={e => set('grossRentalIncome', Number(e.target.value))} />
                  </Field>
                  <Field label="Vacancy Rate">
                    <SuffixInput suffix="%" style={S.input} type="number" step="0.5" min="0" max="100"
                      value={parseFloat(((cfg.vacancyRate || 0.05) * 100).toFixed(2))}
                      onChange={e => set('vacancyRate',
                        Math.min(100, Math.max(0, Number(e.target.value))) / 100)} />
                  </Field>
                  <Field label="Operating Expenses">
                    <SuffixInput suffix="JOD/yr" style={S.input} type="number"
                      value={cfg.operatingExpenses || 0}
                      onChange={e => set('operatingExpenses', Number(e.target.value))} />
                  </Field>
                  <Field label="Exit Cap Rate">
                    <SuffixInput suffix="%" style={S.input} type="number" step="0.1" min="0" max="100"
                      value={parseFloat(((cfg.exitCapRate || 0.07) * 100).toFixed(2))}
                      onChange={e => set('exitCapRate',
                        Math.min(100, Math.max(0, Number(e.target.value))) / 100)} />
                  </Field>
                </>
              )}
              <Field label="Selling Cost Rate">
                <SuffixInput suffix="%" style={S.input} type="number" step="0.1" min="0" max="100"
                  value={parseFloat((cfg.sellingCostRate * 100).toFixed(2))}
                  onChange={e => set('sellingCostRate',
                    Math.min(100, Math.max(0, Number(e.target.value))) / 100)} />
              </Field>
              <Field label="Exit Delay (months after completion)">
                <input style={S.input} type="number" value={cfg.exitDelay}
                  onChange={e => set('exitDelay', Number(e.target.value))} />
              </Field>
              <Field
                label="Region"
                tooltip="Jurisdiction for future tax and regulatory modules. Currently neutral — no tax adjustment applied."
              >
                <select style={S.select} value={cfg.region || 'Jordan'}
                  onChange={e => set('region', e.target.value)}>
                  <option value="Jordan">Jordan</option>
                  <option value="KSA">KSA (Saudi Arabia)</option>
                  <option value="UAE">UAE</option>
                </select>
              </Field>
            </div>
          </div>

        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          KPI SUMMARY TAB
          Safe render: if (!output) show prompt only, never crash
      ══════════════════════════════════════════════════════ */}
      {innerTab === 'kpis' && !output && (
        <p style={{ fontSize: '0.85rem', color: '#8b949e' }}>Run the engine first to see KPIs.</p>
      )}

      {innerTab === 'kpis' && output && output.summary && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

          {/* Returns */}
          <div>
            <p style={S.section}>Returns</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem' }}>
              <KpiCard label="Unleveraged IRR"  value={s.unleveragedIRR}            accent={irrColor(s.unleveragedIRR)} sub="Project-level" />
              <KpiCard label="Leveraged IRR"    value={s.leveragedIRR}              accent={irrColor(s.leveragedIRR)}   sub="Equity-level" />
              <KpiCard label="Leverage Lift"    value={s.leverageLift}              accent="#a371f7" />
              <KpiCard label="Project NPV"      value={'JOD ' + fmt(s.projectNPV)} accent="#58a6ff" sub={`@${(cfg.discountRate * 100).toFixed(1)}% WACC`} />
              <KpiCard label="Equity NPV"       value={'JOD ' + fmt(s.equityNPV)}  accent="#58a6ff" />
              <KpiCard label="Peak Funding Gap" value={peakGapRow ? 'JOD ' + fmt(Math.abs(peakGapRow.cumulative)) : '—'} accent="#f85149" sub={peakGapRow && hasFundingGap ? 'Month ' + peakGapRow.month : 'No gap'} />
            </div>
          </div>

          {/* Profitability */}
          <div>
            <p style={S.section}>Profitability</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem' }}>
              <KpiCard label="Development Profit" value={'JOD ' + fmt(s.developmentProfit)} accent="#3fb950" />
              <KpiCard label="Profit on Cost"      value={s.profitOnCostPct}                 accent="#3fb950" />
              <KpiCard label="Profit on GDV"       value={s.profitOnGDVpct}                  accent="#3fb950" />
              <KpiCard label="Total GDV"           value={'JOD ' + fmt(s.totalGDV)}          accent="#8b949e" />
              <KpiCard label="Net Exit Proceeds"   value={'JOD ' + fmt(s.netExitProceeds)}   accent="#8b949e" />
            </div>
          </div>

          {/* Cost Breakdown */}
          <div>
            <p style={S.section}>Cost Breakdown</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem' }}>
              <KpiCard label="Total Dev Cost"  value={'JOD ' + fmt(s.totalDevelopmentCost)} accent="#d29922" />
              <KpiCard label="Land Cost"       value={'JOD ' + fmt(s.landCost)}             accent="#8b949e" />
              <KpiCard label="Hard Cost"       value={'JOD ' + fmt(s.totalHardCost)}        accent="#8b949e" />
              <KpiCard label="Soft Cost"       value={'JOD ' + fmt(s.totalSoftCost)}        accent="#8b949e" />
              <KpiCard label="Financing Cost"  value={'JOD ' + fmt(s.totalFinancingCost)}   accent="#8b949e" sub="Cap. interest" />
            </div>
          </div>

          {/* Financing */}
          <div>
            <p style={S.section}>Financing</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem' }}>
              <KpiCard label="Equity Deployed"    value={'JOD ' + fmt(s.totalEquityDeployed)} accent="#58a6ff" />
              <KpiCard label="Loan Drawn"         value={'JOD ' + fmt(s.totalLoanDrawn)}      accent="#58a6ff" />
              <KpiCard label="Final Loan Balance" value={'JOD ' + fmt(s.finalLoanBalance)}    accent={s.finalLoanBalance > 0 ? '#d29922' : '#3fb950'} />
              <KpiCard label="LTV"                value={fmtPct(s.ltv)}                       accent="#8b949e" />
              <KpiCard
                label="Loan Capacity"
                value={loanOk ? 'OK' : 'BREACHED'}
                accent={loanOk ? '#3fb950' : '#f85149'}
                sub={s.equityShortfall > 0 ? 'Shortfall: JOD ' + fmt(s.equityShortfall) : undefined}
              />
            </div>
          </div>

          {/* Cap Rate exit detail — only when relevant */}
          {cfg.exitMethod === 'cap_rate' && s.exitDetail && (
            <div>
              <p style={S.section}>Exit — Cap Rate Detail</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem' }}>
                <KpiCard label="Gross Rental Income" value={'JOD ' + fmt(s.exitDetail.grossRentalIncome)} accent="#8b949e" />
                <KpiCard label="NOI"                 value={'JOD ' + fmt(s.exitDetail.noi)}               accent="#3fb950" />
                <KpiCard label="Exit Cap Rate"       value={fmtPct(s.exitDetail.exitCapRate)}              accent="#8b949e" />
                <KpiCard label="Gross Exit Value"    value={'JOD ' + fmt(s.grossExitValue)}               accent="#58a6ff" />
              </div>
            </div>
          )}

          {chartSchedule.length > 0 && (
            <div style={{ height: 300, marginTop: '1.25rem' }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartSchedule}>
                  <CartesianGrid stroke="#30363d" strokeDasharray="3 3" />
                  <XAxis dataKey="month" stroke="#8b949e" />
                  <YAxis stroke="#8b949e" tick={{ fill: '#8b949e', fontSize: 10 }} width={54} tickFormatter={v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'K' : String(v)} />
                  <ReTooltip />
                  <Legend />
                  <Line type="monotone" dataKey="cumulative" stroke="#58a6ff" name="Funding Gap" strokeWidth={2} />
                  <Line type="monotone" dataKey="net_cf" stroke="#d29922" name="Net Cash Flow" />
                  <Line type="monotone" dataKey="salesInflow" stroke="#3fb950" name="Sales" />
                  <Line type="monotone" dataKey="totalCostDraw" stroke="#f85149" name="Cost" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* ── Investment Waterfall — true bridge chart ── */}
          {waterfallData.length > 0 && (
            <div style={{ marginTop: '1.5rem' }}>
              <p style={{ ...S.section, marginBottom: '0.75rem' }}>Investment Waterfall</p>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={waterfallData} barCategoryGap="30%">
                  <CartesianGrid strokeDasharray="3 3" stroke="#30363d" vertical={false} />
                  <XAxis dataKey="name" stroke="#8b949e" tick={{ fill: '#8b949e', fontSize: 10 }} />
                  <YAxis stroke="#8b949e" tick={{ fill: '#8b949e', fontSize: 10 }} width={54}
                    tickFormatter={v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'K' : String(v)} />
                  <ReTooltip
                    contentStyle={{ background: '#1c2128', border: '1px solid #30363d', borderRadius: '6px', fontSize: '0.75rem' }}
                    labelStyle={{ color: '#8b949e' }}
                    formatter={(v, name, props) => {
                      if (name === 'base') return null
                      const raw = props?.payload?.raw
                      return [
                        new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(raw) + ' JOD',
                        props?.payload?.name,
                      ]
                    }}
                  />
                  {/* Transparent base — lifts each coloured bar to its correct Y position */}
                  <Bar dataKey="base" stackId="bridge" fill="transparent" legendType="none" />
                  {/* Coloured value bar stacked on top of the base */}
                  <Bar dataKey="bar" stackId="bridge" radius={[3, 3, 0, 0]}>
                    {waterfallData.map((entry, index) => (
                      <Cell
                        key={index}
                        fill={
                          entry.isLast
                            ? (entry.raw >= 0 ? '#58a6ff' : '#f85149')   // final: blue positive, red negative
                            : (entry.raw >= 0 ? '#3fb950' : '#f85149')   // interim: green positive, red negative
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              {/* Legend */}
              <div style={{ display: 'flex', gap: '1.25rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
                {[
                  { color: '#3fb950', label: 'Inflow'       },
                  { color: '#f85149', label: 'Outflow'      },
                  { color: '#58a6ff', label: 'Equity Return' },
                ].map(l => (
                  <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <div style={{ width: 10, height: 10, borderRadius: 2, background: l.color }} />
                    <span style={{ fontSize: '0.72rem', color: '#8b949e' }}>{l.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          MONTHLY SCHEDULE TAB
          Safe render: if (!output) show prompt only, never crash
      ══════════════════════════════════════════════════════ */}
      {innerTab === 'schedule' && !output && (
        <p style={{ fontSize: '0.85rem', color: '#8b949e' }}>Run the engine first to see the monthly schedule.</p>
      )}

      {innerTab === 'schedule' && output && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: '0.76rem', width: '100%', minWidth: '900px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #30363d' }}>
                {['Month', 'Hard Cost', 'Soft Cost', 'Sales Inflow', 'Equity Draw', 'Loan Draw', 'Loan Balance', 'Cap. Interest', 'Unlev. CF', 'Lev. CF', 'Exit'].map(h => (
                  <th key={h} style={{ padding: '0.5rem 0.6rem', textAlign: 'right', color: '#8b949e', fontWeight: '500', whiteSpace: 'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {output.schedule.map((row, i) => {
                const isConst = row.month >= 1 && row.month <= cfg.T
                const isExit  = row.exitProceeds > 0
                const rowBg   = isExit ? '#1a2a1a' : isConst ? '#1a1f2e' : 'transparent'
                const cfColor = (v) => v > 0 ? '#3fb950' : v < 0 ? '#f85149' : '#484f58'
                return (
                  <tr key={i} style={{ borderBottom: '1px solid #1a1f2e', background: rowBg }}>
                    <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', color: '#8b949e', fontVariantNumeric: 'tabular-nums' }}>
                      {row.month}
                      {row.month === 0 && <span style={{ marginLeft: '4px', fontSize: '0.65rem', color: '#484f58' }}>pre</span>}
                      {isConst && <span style={{ marginLeft: '4px', fontSize: '0.65rem', color: '#30a3d4' }}>const</span>}
                      {isExit  && <span style={{ marginLeft: '4px', fontSize: '0.65rem', color: '#3fb950' }}>exit</span>}
                    </td>
                    <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', color: row.hardCostDraw > 0 ? '#d29922' : '#484f58', fontVariantNumeric: 'tabular-nums' }}>
                      {row.hardCostDraw > 0 ? fmt(row.hardCostDraw) : '—'}
                    </td>
                    <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', color: row.softCostDraw > 0 ? '#d29922' : '#484f58', fontVariantNumeric: 'tabular-nums' }}>
                      {row.softCostDraw > 0 ? fmt(row.softCostDraw) : '—'}
                    </td>
                    <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', color: row.salesInflow > 0 ? '#3fb950' : '#484f58', fontVariantNumeric: 'tabular-nums' }}>
                      {row.salesInflow > 0 ? fmt(row.salesInflow) : '—'}
                    </td>
                    <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', color: row.equityDraw > 0 ? '#58a6ff' : '#484f58', fontVariantNumeric: 'tabular-nums' }}>
                      {row.equityDraw > 0 ? fmt(row.equityDraw) : '—'}
                    </td>
                    <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', color: row.loanDraw > 0 ? '#a371f7' : '#484f58', fontVariantNumeric: 'tabular-nums' }}>
                      {row.loanDraw > 0 ? fmt(row.loanDraw) : '—'}
                    </td>
                    <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', color: row.loanBalance > 0 ? '#e6edf3' : '#484f58', fontVariantNumeric: 'tabular-nums' }}>
                      {row.loanBalance > 0 ? fmt(row.loanBalance) : '—'}
                    </td>
                    <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', color: row.capitalizedInterest > 0 ? '#f85149' : '#484f58', fontVariantNumeric: 'tabular-nums' }}>
                      {row.capitalizedInterest > 0 ? fmt(row.capitalizedInterest) : '—'}
                    </td>
                    <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', color: cfColor(row.unleveragedCF), fontVariantNumeric: 'tabular-nums', fontWeight: '500' }}>
                      {row.unleveragedCF !== 0 ? fmt(row.unleveragedCF) : '—'}
                    </td>
                    <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', color: cfColor(row.leveragedCF), fontVariantNumeric: 'tabular-nums', fontWeight: '500' }}>
                      {row.leveragedCF !== 0 ? fmt(row.leveragedCF) : '—'}
                    </td>
                    <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', color: isExit ? '#3fb950' : '#484f58', fontVariantNumeric: 'tabular-nums', fontWeight: isExit ? '600' : '400' }}>
                      {isExit ? fmt(row.exitProceeds) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <div style={{ marginTop: '1rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            {[
              { color: '#30a3d4', label: 'Construction months' },
              { color: '#3fb950', label: 'Positive cash flow' },
              { color: '#f85149', label: 'Negative / cap. interest' },
              { color: '#1a2a1a', label: 'Exit month' },
            ].map(l => (
              <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: l.color }} />
                <span style={{ fontSize: '0.72rem', color: '#8b949e' }}>{l.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          SENSITIVITY TAB
          Section 1: Market Sensitivity — Price vs Absorption (9×9, live from cfg)
          Section 2: Cost vs Price Sensitivity (3×3, stored in output.sensitivityMatrix)
          Export reads source.sensitivityMatrix — no recalculation on export.
      ══════════════════════════════════════════════════════ */}
      {innerTab === 'sensitivity' && !output && (
        <p style={{ fontSize: '0.85rem', color: '#8b949e' }}>Run the engine first to generate the sensitivity analysis.</p>
      )}

      {innerTab === 'sensitivity' && output && (() => {

        // ── Shared helpers (both tables) ──────────────────────────────────────
        const STEPS = [-0.20, -0.15, -0.10, -0.05, 0, 0.05, 0.10, 0.15, 0.20]
        function fmtStep(s) { return (s >= 0 ? '+' : '') + (s * 100).toFixed(0) + '%' }

        function cellIrrColor(v) {
          if (v === null) return { bg: '#21262d', text: '#484f58' }
          if (v >= 15)   return { bg: '#1a2e1a', text: '#3fb950' }
          if (v >= 10)   return { bg: '#2a2210', text: '#d29922' }
          return               { bg: '#2e1a1a', text: '#f85149' }
        }
        function irrLabel(v) {
          if (v === null || isNaN(v)) return '—'
          return v.toFixed(1) + '%'
        }

        const LEGEND = [
          { color: '#3fb950', bg: '#1a2e1a', label: 'Strong  (IRR ≥ 15%)' },
          { color: '#d29922', bg: '#2a2210', label: 'Review  (10–15%)'    },
          { color: '#f85149', bg: '#2e1a1a', label: 'Weak  (< 10%)'       },
        ]
        function IrrLegend() {
          return (
            <div style={{ display: 'flex', gap: '1.25rem', marginTop: '0.9rem', flexWrap: 'wrap' }}>
              {LEGEND.map(l => (
                <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <div style={{ width: 12, height: 12, borderRadius: 2, background: l.bg, border: '1px solid ' + l.color }} />
                  <span style={{ fontSize: '0.72rem', color: '#8b949e' }}>{l.label}</span>
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <div style={{ width: 12, height: 12, borderRadius: 2, background: '#1c2a3a', border: '2px solid #1f6feb' }} />
                <span style={{ fontSize: '0.72rem', color: '#8b949e' }}>Base case</span>
              </div>
            </div>
          )
        }

        // ── Shared header / axis cell styles ─────────────────────────────────
        const thStyle = {
          padding: '0.55rem 0.5rem', textAlign: 'center', fontSize: '0.72rem',
          color: '#8b949e', fontWeight: '500', background: '#161b22',
          border: '1px solid #30363d', whiteSpace: 'nowrap',
        }
        const cornerStyle = {
          padding: '0.55rem 0.75rem', textAlign: 'center', fontSize: '0.68rem',
          color: '#484f58', background: '#161b22', border: '1px solid #30363d',
          verticalAlign: 'bottom',
        }
        const axisRowStyle = (isBase) => ({
          padding: '0.55rem 0.75rem', fontSize: '0.72rem', whiteSpace: 'nowrap',
          color: isBase ? '#58a6ff' : '#8b949e', fontWeight: isBase ? '700' : '500',
          background: '#161b22', border: '1px solid #30363d',
        })

        // ══════════════════════════════════════════════════════════════════════
        //  SECTION 1 — Market Sensitivity: Sales Price vs Absorption
        //  Row axis:  Total GDV (±20% in 9 steps) — proxy for market pricing
        //  Col axis:  Pre-construction sales % (±20% shift) — proxy for absorption
        //  Both use runCashFlowEngine so logic is identical to the main run.
        // ══════════════════════════════════════════════════════════════════════
        const basePre    = cfg.phaseWeights.pre
        const baseDuring = cfg.phaseWeights.during
        const basePost   = cfg.phaseWeights.post

        function shiftAbsorption(absStep) {
          // Shift pre-sale weight, redistribute remainder proportionally to during/post
          const newPre    = Math.max(0.01, Math.min(0.95, basePre * (1 + absStep)))
          const oldRem    = Math.max(0.001, 1 - basePre)
          const newRem    = 1 - newPre
          const ratio     = newRem / oldRem
          const newDuring = Math.max(0, baseDuring * ratio)
          const newPost   = Math.max(0, 1 - newPre - newDuring)
          return { pre: newPre, during: newDuring, post: newPost }
        }

        const marketGrid = STEPS.map(priceStep =>
          STEPS.map(absStep => {
            try {
              const r = runCashFlowEngine({
                projectName:    'MktSens',
                ...cfg,
                totalGDV:       cfg.totalGDV * (1 + priceStep),
                phaseWeights:   shiftAbsorption(absStep),
              })
              const v = r?.summary?.leveragedIRR ? parseFloat(r.summary.leveragedIRR) : null
              return isNaN(v) ? null : v
            } catch { return null }
          })
        )

        // ══════════════════════════════════════════════════════════════════════
        //  SECTION 2 — Cost vs Price Sensitivity (3×3 from output.sensitivityMatrix)
        // ══════════════════════════════════════════════════════════════════════
        const PRICE_LABELS = ['−5% Price', 'Base Price', '+5% Price']
        const COST_LABELS  = ['−5% Cost',  'Base Cost',  '+5% Cost' ]

        function irrNum3x3(cell) {
          if (!cell || cell.irr === null) return null
          return parseFloat(cell.irr)
        }

        return (
          <div style={{ maxWidth: '1000px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '0' }}>

            {/* ── SECTION 1: Market Sensitivity ────────────────────────────── */}
            <div style={{ marginBottom: '40px' }}>
              <div style={{ marginBottom: '1rem' }}>
                <p style={{ fontSize: '1.05rem', fontWeight: '600', color: '#e6edf3', marginBottom: '0.3rem' }}>
                  Market Sensitivity — Price vs Absorption
                </p>
                <p style={{ fontSize: '0.8rem', color: '#8b949e' }}>
                  Impact of market conditions on IRR across multiple pricing and absorption scenarios.
                  Row: Sales price adjustment · Col: Pre-construction absorption rate adjustment.
                  Base: GDV {fmt(cfg.totalGDV)} JOD · {Math.round(basePre * 100)}% pre-sale absorption.
                </p>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                  <thead>
                    <tr>
                      <td style={cornerStyle}>
                        <div>Price ↓</div>
                        <div>Absorption →</div>
                      </td>
                      {STEPS.map(cs => (
                        <th key={cs} style={{ ...thStyle, color: cs === 0 ? '#58a6ff' : '#8b949e', fontWeight: cs === 0 ? '700' : '500' }}>
                          {fmtStep(cs)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {STEPS.map((rs, ri) => (
                      <tr key={rs}>
                        <td style={axisRowStyle(rs === 0)}>
                          {fmtStep(rs)}
                          <span style={{ fontSize: '0.65rem', color: '#484f58', marginLeft: '0.35rem' }}>
                            ({fmt(Math.round(cfg.totalGDV * (1 + rs)))})
                          </span>
                        </td>
                        {STEPS.map((cs, ci) => {
                          const v      = marketGrid[ri][ci]
                          const col    = cellIrrColor(v)
                          const isBase = rs === 0 && cs === 0
                          return (
                            <td key={cs} style={{
                              padding: '0.5rem 0.45rem', textAlign: 'center', minWidth: '60px',
                              background: isBase ? '#1c2a3a' : col.bg,
                              border:     isBase ? '2px solid #1f6feb' : '1px solid #21262d',
                              color:      isBase ? '#58a6ff' : col.text,
                              fontWeight: isBase ? '700' : '500',
                              fontSize:   '0.8rem', fontVariantNumeric: 'tabular-nums',
                            }}>
                              {irrLabel(v)}
                              {isBase && <div style={{ fontSize: '0.58rem', color: '#484f58', fontWeight: '400', marginTop: '1px' }}>Base</div>}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <IrrLegend />
              <div style={{ marginTop: '0.65rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                <p style={{ fontSize: '0.71rem', color: '#484f58' }}>
                  Row axis: Total GDV — each step is a % change from the base case value of {fmt(cfg.totalGDV)} JOD
                </p>
                <p style={{ fontSize: '0.71rem', color: '#484f58' }}>
                  Col axis: Pre-construction sales weight — each step shifts the absorption profile ±% from base of {Math.round(basePre * 100)}%
                </p>
              </div>
            </div>

            {/* ── SECTION 2: Cost vs Price Sensitivity (3×3) ───────────────── */}
            <div>
              <div style={{ marginBottom: '1rem' }}>
                <p style={{ fontSize: '1.05rem', fontWeight: '600', color: '#e6edf3', marginBottom: '0.3rem' }}>
                  Cost vs Price Sensitivity
                </p>
                <p style={{ fontSize: '0.8rem', color: '#8b949e' }}>
                  Impact of construction cost and pricing changes on IRR.
                  Each cell shows Leveraged IRR. Base case highlighted in blue.
                </p>
              </div>

              {output.sensitivityMatrix ? (() => {
                return (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: '0.82rem', tableLayout: 'fixed', width: '100%' }}>
                      <thead>
                        <tr>
                          <th style={{ padding: '1.25rem 1.75rem', textAlign: 'left', color: '#8b949e', fontWeight: '500',
                            background: '#161b22', border: '1px solid #30363d', fontSize: '0.85rem' }}>
                            Cost ↓ / Price →
                          </th>
                          {PRICE_LABELS.map(l => (
                            <th key={l} style={{ padding: '1.25rem 1.75rem', textAlign: 'center', color: '#c9d1d9',
                              fontWeight: '600', background: '#161b22', border: '1px solid #30363d', whiteSpace: 'nowrap', fontSize: '0.85rem' }}>
                              {l}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {output.sensitivityMatrix.map((row, ri) => (
                          <tr key={ri}>
                            <td style={{ padding: '1.25rem 1.75rem', color: '#c9d1d9', fontWeight: '600',
                              background: '#161b22', border: '1px solid #30363d', whiteSpace: 'nowrap' }}>
                              {COST_LABELS[ri]}
                            </td>
                            {row.map((cell, ci) => {
                              const v      = irrNum3x3(cell)
                              const col    = cellIrrColor(v)
                              const isBase = ri === 1 && ci === 1
                              return (
                                <td key={ci} style={{
                                  padding: '1.25rem 1.75rem', textAlign: 'center',
                                  background: isBase ? '#1c2a3a' : col.bg,
                                  border:     isBase ? '2px solid #1f6feb' : '1px solid #30363d',
                                  color:      isBase ? '#58a6ff' : col.text,
                                  fontWeight: isBase ? '700' : '600',
                                  fontSize:   '1.1rem', fontVariantNumeric: 'tabular-nums',
                                }}>
                                  {irrLabel(v)}
                                  {isBase && <div style={{ fontSize: '0.6rem', color: '#484f58', fontWeight: '400', marginTop: '2px' }}>Base</div>}
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              })() : (
                <p style={{ fontSize: '0.82rem', color: '#f85149' }}>
                  Cost vs price matrix not available — re-run the engine to generate it.
                </p>
              )}
              <IrrLegend />
            </div>

          </div>
        )
      })()}

    </div>
  )
}
