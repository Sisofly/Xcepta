import React from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { jsPDF } from 'jspdf'

const TABS = ['Actuals Entry', 'Variance Report']

const COA = [
  { code: 'REV_SALE',    name: 'Sale Proceeds' },
  { code: 'REV_RENTAL',  name: 'Rental Income' },
  { code: 'COST_CONST',  name: 'Construction Costs' },
  { code: 'COST_OPEX',   name: 'Operating Expenses' },
  { code: 'COST_FINANCE',name: 'Finance Charges' },
  { code: 'COST_ADMIN',  name: 'Admin & Overheads' },
]

function flagColors(flag) {
  if (flag === 'red')   return { background: '#f8514922', color: '#f85149', border: '1px solid #f85149' }
  if (flag === 'amber') return { background: '#d2992222', color: '#d29922', border: '1px solid #d29922' }
  return { background: '#3fb95022', color: '#3fb950', border: '1px solid #3fb950' }
}
function flagLabel(flag, coaNode, varPct) {
  if (flag === 'red')   return 'Material Variance'
  if (flag === 'amber') return 'Watch'
  if (flag === 'green') {
    if (varPct === null || varPct === undefined) return 'Within Range'
    const vp = Number(varPct), absVp = Math.abs(vp)
    const isRevenue = coaNode && coaNode.startsWith('REV_')
    const favorable = isRevenue ? vp >= 0 : vp <= 0
    if (favorable && absVp >= 10) return 'Outperforming'
    return 'Within Range'
  }
  return 'Within Range'
}
function stripCommas(v) { return String(v).replace(/,/g, '') }
function formatWithCommas(v) {
  const n = parseFloat(stripCommas(v))
  return isNaN(n) ? v : n.toLocaleString('en-US')
}
function toNum(v) { return Number(stripCommas(v)) || 0 }
function fmtN(n)  { return Math.round(Number(n) || 0).toLocaleString('en-US') }
function fmtVarPct(vp) {
  if (vp === null || vp === undefined) return '—'
  const abs = Math.abs(Number(vp))
  if (abs > 1000) return vp > 0 ? '>+1000%' : '>-1000%'
  return (vp >= 0 ? '+' : '') + Number(vp).toFixed(1) + '%'
}

// ── Determine if a period (YYYY-MM) is forecast (≥ current month) ──
function isForecastPeriod(period) {
  if (!period) return false
  const today = new Date()
  const currentYM = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0')
  return period >= currentYM
}

// ── Derive monthly budget from annual cash flows ──
function deriveBudget(period, cashFlows, assumptions) {
  if (!cashFlows || !cashFlows.length || !period) return null

  const osDateA = assumptions.find(a => a.name === 'Operations Start Date')
  const csDateA = assumptions.find(a => a.name === 'Construction Start Date')
  if (!osDateA || !osDateA.unit) return null

  const periodDate = new Date(period + '-01')
  const osDate     = new Date(osDateA.unit)
  const csDate     = csDateA && csDateA.unit ? new Date(csDateA.unit) : null

  const monthsSinceOps = (periodDate.getFullYear() - osDate.getFullYear()) * 12
    + (periodDate.getMonth() - osDate.getMonth())
  const monthsSinceCons = csDate
    ? (periodDate.getFullYear() - csDate.getFullYear()) * 12
      + (periodDate.getMonth() - csDate.getMonth())
    : null

  let cfRow = null
  if (monthsSinceOps >= 0) {
    const opYear = Math.floor(monthsSinceOps / 12) + 1
    const opRows = cashFlows.filter(r => r.phase === 'Operations')
    cfRow = opRows[Math.min(opYear - 1, opRows.length - 1)] || opRows[0]
  } else if (monthsSinceCons !== null && monthsSinceCons >= 0) {
    const conRows = cashFlows.filter(r => r.phase === 'Construction')
    const conYear = Math.floor(monthsSinceCons / 12)
    cfRow = conRows[Math.min(conYear, conRows.length - 1)] || conRows[0]
  }
  if (!cfRow) return null

  const saleSplitA  = assumptions.find(a => a.name === 'Sale Split %')
  const revModelA   = assumptions.find(a => a.name === 'Revenue Model')
  const revenueModel = revModelA ? revModelA.unit : 'Sale'
  const saleSplit = revenueModel === 'Sale' ? 1
    : revenueModel === 'Rental' ? 0
    : saleSplitA ? Number(saleSplitA.value) / 100 : 0.5
  const rentalSplit = 1 - saleSplit

  const rev      = Number(cfRow.revenue  || 0) / 12
  const capex    = Number(cfRow.capex    || 0) / 12
  const opex     = Number(cfRow.opex     || 0) / 12
  const interest = Number(cfRow.interest || 0) / 12

  return {
    REV_SALE:     Math.round(rev * saleSplit),
    REV_RENTAL:   Math.round(rev * rentalSplit),
    COST_CONST:   Math.round(capex),
    COST_OPEX:    Math.round(opex),
    COST_FINANCE: Math.round(interest),
    COST_ADMIN:   0,
  }
}

export default function FPAProject() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const [project, setProject]       = useState(null)
  const [version, setVersion]       = useState(null)
  const [assumptions, setAssumptions] = useState([])
  const [modelOutput, setModelOutput] = useState(null)
  const [tab, setTab]               = useState('Actuals Entry')
  const [loading, setLoading]       = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [period, setPeriod]         = useState('')
  const [rows, setRows]             = useState(
    COA.map(c => ({ coa_node: c.code, account_name: c.name, budget: '', actual: '' }))
  )
  const [variances, setVariances]   = useState([])
  const [drillRow, setDrillRow]     = useState(null)
  const [expandedPeriods, setExpandedPeriods] = useState({})
  const [budgetPreview, setBudgetPreview] = useState(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    async function load() {
      const { data: proj } = await supabase.from('projects').select('*').eq('project_id', projectId).single()
      setProject(proj)

      const { data: scenarios } = await supabase.from('scenarios').select('scenario_id').eq('project_id', projectId)
      if (scenarios && scenarios.length) {
        const { data: versions } = await supabase.from('versions').select('*')
          .eq('scenario_id', scenarios[0].scenario_id).eq('status', 'approved').limit(1)
        if (versions && versions.length) {
          setVersion(versions[0])
          const { data: outputs } = await supabase.from('model_outputs').select('*')
            .eq('version_id', versions[0].version_id).order('computed_at', { ascending: false }).limit(1)
          if (outputs && outputs.length) setModelOutput(outputs[0])
        }
      }

      const { data: assump } = await supabase.from('assumptions').select('*')
        .eq('project_id', projectId).is('scenario_id', null)
      setAssumptions(assump || [])

      const { data: vars } = await supabase.from('variances').select('*')
        .eq('project_id', projectId).order('period', { ascending: true })
      setVariances(vars || [])

      setLoading(false)
    }
    load()
  }, [projectId])

  // Auto-fill budget when period changes
  useEffect(() => {
    if (!period || !modelOutput || !assumptions.length) {
      setBudgetPreview(null)
      setRows(COA.map(c => ({ coa_node: c.code, account_name: c.name, budget: '', actual: '' })))
      return
    }
    const budget = deriveBudget(period, modelOutput.cash_flows, assumptions)
    setBudgetPreview(budget)
    setRows(COA.map(c => ({
      coa_node: c.code, account_name: c.name,
      budget: budget && budget[c.code] !== undefined ? String(budget[c.code]) : '',
      actual: '',
    })))
  }, [period, modelOutput, assumptions])

  async function loadVariances() {
    const { data } = await supabase.from('variances').select('*')
      .eq('project_id', projectId).order('period', { ascending: true })
    setVariances(data || [])
  }

  function updateActual(index, value) {
    setRows(prev => prev.map((r, i) => i === index ? { ...r, actual: value } : r))
  }
  function updateBudget(index, value) {
    setRows(prev => prev.map((r, i) => i === index ? { ...r, budget: value } : r))
  }

  async function handleSubmit() {
    if (!period) return alert('Please select a period.')
    const filled = rows.filter(r => r.actual !== '')
    if (!filled.length) return alert('Please enter at least one actual value.')
    setSubmitting(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const { data: userData } = await supabase.from('users').select('tenant_id').eq('user_id', user.id).single()
      const tenant_id = userData.tenant_id

      const isForecast = isForecastPeriod(period)
      const actualsRows = filled.map(r => ({
        tenant_id, project_id: projectId, period,
        coa_node: r.coa_node, amount: toNum(r.actual),
        currency: project.currency, created_by: user.id,
        is_forecast: isForecast,
      }))
      // Delete existing actuals for this period, then insert fresh
      await supabase.from('actuals').delete()
        .eq('project_id', projectId).eq('period', period)

      const { error: actualsError } = await supabase.from('actuals').insert(actualsRows)
      if (actualsError) throw actualsError

      await supabase.from('variances').delete().eq('project_id', projectId).eq('period', period)

      const varianceRows = filled.map(r => {
        const budget  = toNum(r.budget)
        const actual  = toNum(r.actual)
        const variance_percent = budget !== 0
          ? Math.round(((actual - budget) / Math.abs(budget)) * 10000) / 100
          : null
        const absVp   = Math.abs(variance_percent || 0)
        const isRevenue = r.coa_node.startsWith('REV_')
        const favorable = variance_percent === null ? true
          : isRevenue ? (actual - budget) >= 0 : (actual - budget) <= 0
        const severity_flag = variance_percent === null ? 'green'
          : favorable ? 'green' : (absVp >= 10 ? 'red' : 'amber')
        const sourceAssumption = isRevenue
          ? assumptions.find(a => a.category === 'revenue')
          : assumptions.find(a => a.category === 'capital_structure')
        return {
          tenant_id, project_id: projectId,
          version_id: version ? version.version_id : null,
          period, coa_node: r.coa_node,
          budget_amount: budget, actual_amount: actual,
          severity_flag,
          source_assumption_id: sourceAssumption ? sourceAssumption.assumption_id : null,
          created_by: user.id,
        }
      })
      const { error: varianceError } = await supabase.from('variances').insert(varianceRows)
      if (varianceError) throw varianceError

      setPeriod('')
      setRows(COA.map(c => ({ coa_node: c.code, account_name: c.name, budget: '', actual: '' })))
      await loadVariances()
      setTab('Variance Report')
    } catch (err) {
      alert('Error: ' + err.message)
    } finally {
      setSubmitting(false)
    }
  }

  // ══════════════════════════════════════════════════════
  //  FP&A PDF EXPORT — same layout system as feasibility
  // ══════════════════════════════════════════════════════
  function generateFPAPdf() {
    setExporting(true)
    try {
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
      const pw  = doc.internal.pageSize.getWidth()
      const ph  = doc.internal.pageSize.getHeight()
      const ML  = 16, MR = pw - 16, TW = MR - ML
      const RH  = 9, HH = 8, BL = 5.8
      let y = 0, pageNum = 1

      function safe(s) {
        return String(s == null ? '' : s)
          .replace(/\u2014/g, '\x97').replace(/\u2013/g, '\x96')
          .replace(/[\u2018\u2019]/g, "'")
          .replace(/[\u201c\u201d]/g, '"').replace(/[^\x00-\xFF]/g, '?')
      }
      function newPage() { doc.addPage(); pageNum++; y = 22 }
      function guard(n)  { if (y + n > ph - 22) newPage() }
      function gap(n)    { y += (n === undefined ? 8 : n) }
      function fmtV(n)   { return Math.round(Number(n) || 0).toLocaleString('en-US') }
      const cur = project.currency

      function pageHeader(p) {
        doc.setPage(p)
        doc.setFillColor(15,23,42); doc.rect(0,0,pw,10,'F')
        doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(255,255,255)
        doc.text('XCEPTA', ML, 7)
        doc.setFont('helvetica','normal'); doc.setTextColor(100,116,139)
        doc.text(safe(project.name)+'  |  FP&A Report', MR, 7, {align:'right'})
      }
      function pageFooter(p, total) {
        doc.setPage(p)
        doc.setFillColor(255,255,255); doc.rect(0,ph-14,pw,14,'F')
        doc.setDrawColor(210,215,225); doc.setLineWidth(0.2); doc.line(ML,ph-12,MR,ph-12)
        doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(150,160,175)
        doc.text('XCEPTA \u2014 Confidential', ML, ph-7)
        doc.text(reportDate, pw/2, ph-7, {align:'center'})
        doc.text('Page '+p+' of '+total, MR, ph-7, {align:'right'})
      }
      function secHead(title) {
        guard(22); gap(10)
        doc.setFontSize(8); doc.setFont('helvetica','bold'); doc.setTextColor(31,111,235)
        doc.text(safe(title), ML, y); y += 3
        doc.setDrawColor(31,111,235); doc.setLineWidth(0.6); doc.line(ML,y,ML+22,y)
        doc.setDrawColor(220,225,235); doc.setLineWidth(0.2); doc.line(ML+22,y,MR,y)
        y += 6
      }
      function tHead(cols) {
        guard(HH+RH+4)
        doc.setFillColor(244,246,250); doc.rect(ML,y,TW,HH,'F')
        doc.setDrawColor(205,210,220); doc.setLineWidth(0.2); doc.line(ML,y+HH,MR,y+HH)
        doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(90,95,110)
        var x=ML
        cols.forEach(function(c) {
          var tx=(c.align==='right')?x+c.w-2:x+3
          doc.text(safe(c.label), tx, y+BL-0.5, {align:c.align||'left'})
          x+=c.w
        })
        y+=HH
      }
      function tRow(cols, vals, opts) {
        opts=opts||{}
        guard(RH+4)
        if(opts.shade){doc.setFillColor(249,250,253);doc.rect(ML,y,TW,RH,'F')}
        doc.setFont(opts.bold?'helvetica':'helvetica', opts.bold?'bold':'normal')
        doc.setFontSize(8)
        var clr=opts.color||[30,33,43]
        doc.setTextColor(clr[0],clr[1],clr[2])
        var x=ML
        cols.forEach(function(c,i) {
          var val=safe(vals[i])
          var maxW=c.w-2
          if(maxW>0&&doc.getTextWidth(val)>maxW){
            var t=val; while(t.length>1&&doc.getTextWidth(t+'..')>maxW) t=t.slice(0,-1); val=t+'..'
          }
          var tx=(c.align==='right')?x+c.w-2:x+3
          doc.text(val, tx, y+BL, {align:c.align||'left'})
          x+=c.w
        })
        y+=RH
        doc.setDrawColor(230,233,240); doc.setLineWidth(0.15); doc.line(ML,y,MR,y); doc.setLineWidth(0.2)
      }

      const reportDate = new Date().toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})
      const versionLabel = version ? safe(version.label) : '—'

      // ── Pre-compute totals across all periods ──
      var totRevBudget=0, totRevActual=0, totCostBudget=0, totCostActual=0
      variances.forEach(function(v) {
        var isRev = v.coa_node.startsWith('REV_')
        if(isRev){ totRevBudget+=Number(v.budget_amount); totRevActual+=Number(v.actual_amount) }
        else     { totCostBudget+=Number(v.budget_amount); totCostActual+=Number(v.actual_amount) }
      })
      var netBudget  = totRevBudget  - totCostBudget
      var netActual  = totRevActual  - totCostActual
      var netVar     = netActual - netBudget
      var netVarPct  = netBudget !== 0 ? ((netVar / Math.abs(netBudget)) * 100) : null

      // Executive commentary (one sentence)
      var revVar0 = totRevActual - totRevBudget
      var costVar0 = totCostActual - totCostBudget
      var execCommentary = ''
      if (revVar0 > 0 && netVar < 0) {
        execCommentary = 'Cost overruns exceeded revenue gains, driving negative net performance.'
      } else if (revVar0 > 0 && netVar >= 0) {
        execCommentary = 'Revenue outperformance supported positive net performance.'
      } else if (costVar0 < 0 && netVar >= 0) {
        execCommentary = 'Cost savings supported positive net performance.'
      } else if (revVar0 < 0 && netVar < 0) {
        execCommentary = 'Revenue underperformance contributed to negative net performance.'
      }
      var overallStatus, statusColor, statusBg
      if(netVarPct !== null && netVarPct >= -5) {
        overallStatus='On Track'; statusColor=[21,128,61]; statusBg=[220,252,231]
      } else if(netVarPct !== null && netVarPct >= -15) {
        overallStatus='Watch';    statusColor=[146,90,0];  statusBg=[254,243,199]
      } else {
        overallStatus='At Risk';  statusColor=[185,28,28]; statusBg=[254,226,226]
      }

      // Period groups
      var pGroups = {}
      variances.forEach(function(v){ if(!pGroups[v.period]) pGroups[v.period]=[]; pGroups[v.period].push(v) })
      var sortedPs = Object.keys(pGroups).sort()

      // Key variance drivers
      var allLines = []
      variances.forEach(function(v) {
        var isRev = v.coa_node.startsWith('REV_')
        var va = Number(v.variance_amount)
        var vp = v.variance_percent !== null ? Number(v.variance_percent) : null
        var coa = COA.find(function(c){return c.code===v.coa_node})
        var favorable = isRev ? va >= 0 : va <= 0
        allLines.push({ name: coa?coa.name:v.coa_node, period:v.period, va, vp, favorable, isRev })
      })
      var positive = allLines.filter(function(l){return l.favorable&&Math.abs(l.vp||0)>=5})
        .sort(function(a,b){return Math.abs(b.vp||0)-Math.abs(a.vp||0)}).slice(0,2)
      var negative = allLines.filter(function(l){return !l.favorable&&Math.abs(l.vp||0)>=5})
        .sort(function(a,b){return Math.abs(b.vp||0)-Math.abs(a.vp||0)}).slice(0,2)

      // ══════════════════════════════════════
      //  COVER PAGE
      // ══════════════════════════════════════
      doc.setFillColor(15,23,42); doc.rect(0,0,pw,ph,'F')
      doc.setFillColor(31,111,235); doc.rect(0,0,pw,3,'F')

      // XCEPTA logo mark (jsPDF primitives — same as feasibility)
      var lx=ML, ly=14, ic={cx:lx+14, cy:ly+8, r:11}
      doc.setDrawColor(232,239,246); doc.setLineWidth(0.6); doc.circle(ic.cx,ic.cy,ic.r,'S')
      doc.setLineWidth(2); doc.setDrawColor(232,239,246)
      doc.line(ic.cx-5,ic.cy-5,ic.cx+5,ic.cy+5)
      doc.line(ic.cx-5,ic.cy+5,ic.cx,ic.cy)
      doc.setDrawColor(61,184,150); doc.line(ic.cx,ic.cy,ic.cx+5,ic.cy-5)
      doc.setLineWidth(0.2)
      doc.setFont('helvetica','bold'); doc.setFontSize(13); doc.setTextColor(232,239,246)
      doc.text('XCEPTA', lx+30, ly+10)
      doc.setFont('helvetica','normal'); doc.setFontSize(5.5); doc.setTextColor(122,139,154)
      doc.text('VALUATIONS  FP&A  BOARDS', lx+30, ly+15.5)
      doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(71,85,105)
      doc.text('CONFIDENTIAL', MR, 22, {align:'right'})

      // Document type badge
      doc.setFillColor(31,111,235); doc.rect(ML,35,52,7,'F')
      doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(255,255,255)
      doc.text('PERFORMANCE VS PLAN REPORT', ML+4, 40.5)

      // Title
      doc.setFont('helvetica','bold'); doc.setFontSize(26); doc.setTextColor(248,250,252)
      doc.text(safe(project.name), ML, 62)
      doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(148,163,184)
      var metaLine=[safe(project.project_type),safe(project.country),safe(project.currency)].filter(Boolean).join('  |  ')
      doc.text(metaLine, ML, 71)
      doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(100,116,139)
      doc.text('FP&A Performance Summary \u2014 Approved Version', ML, 78)
      doc.setDrawColor(31,111,235); doc.setLineWidth(0.5); doc.line(ML,83,ML+60,83)
      doc.setDrawColor(51,65,85); doc.setLineWidth(0.2); doc.line(ML+60,83,MR,83)

      // KPI tiles on cover
      var coverKPIs = [
        {label:'Revenue Actual / Forecast', value:fmtV(totRevActual)+' '+cur},
        {label:'Revenue Budget',          value:fmtV(totRevBudget)+' '+cur},
        {label:'Net Variance',            value:(netVar>=0?'+':'')+fmtV(netVar)+' '+cur},
        {label:'Periods Tracked',         value:String(sortedPs.length)},
      ]
      var kpiW=TW/4
      coverKPIs.forEach(function(k,i){
        var sx=ML+i*kpiW
        doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(71,85,105)
        doc.text(k.label, sx, 93)
        doc.setFont('helvetica','bold'); doc.setFontSize(12); doc.setTextColor(248,250,252)
        doc.text(safe(k.value), sx, 103)
      })

      // Overall status box
      doc.setFillColor(statusBg[0],statusBg[1],statusBg[2])
      doc.roundedRect(ML,113,TW,18,2,2,'F')
      doc.setDrawColor(statusColor[0],statusColor[1],statusColor[2]); doc.setLineWidth(0.4)
      doc.rect(ML,113,TW,18,'S'); doc.setLineWidth(0.2)
      doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(100,110,125)
      doc.text('OVERALL STATUS', ML+4, 120)
      doc.setFont('helvetica','bold'); doc.setFontSize(13)
      doc.setTextColor(statusColor[0],statusColor[1],statusColor[2])
      doc.text(safe(overallStatus), ML+4, 128)
      if(netVarPct!==null) {
        doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(100,110,125)
        doc.text('Net variance impact: '+(netVarPct>=0?'+':'')+netVarPct.toFixed(1)+'%', MR-4, 124, {align:'right'})
      }

      // Cover footer
      doc.setFillColor(10,15,28); doc.rect(0,ph-28,pw,28,'F')
      doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(100,116,139)
      doc.text('Prepared by: XCEPTA', ML, ph-17)
      doc.text(reportDate, pw/2, ph-17, {align:'center'})
      doc.text(safe(project.country)+'  |  '+safe(project.currency), MR, ph-17, {align:'right'})
      doc.setFontSize(7); doc.setTextColor(51,65,85)
      doc.text('This document is confidential and intended solely for the named recipients.', pw/2, ph-9, {align:'center'})

      // ── Start report pages ──
      doc.addPage(); pageNum++; y=22

      // ══════════════════════════════════════
      //  EXECUTIVE SUMMARY
      // ══════════════════════════════════════
      secHead('Executive Summary')

      // Project tiles
      var tiles=[
        ['Project',  safe(project.name)],
        ['Sector',   safe(project.project_type)],
        ['Country',  safe(project.country)],
        ['Currency', safe(project.currency)],
        ['Baseline', versionLabel],
        ['Periods',  String(sortedPs.length)+' tracked'],
      ]
      guard(30)
      var tileW=TW/3
      tiles.forEach(function(t,i){
        var col=i%3, row2=Math.floor(i/3)
        var tx2=ML+col*tileW, ty=y+row2*12
        doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(130,140,155)
        doc.text(t[0], tx2+3, ty)
        doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(18,24,38)
        doc.text(t[1], tx2+3, ty+6)
      })
      y+=Math.ceil(tiles.length/3)*12+6

      // Summary KPI table
      var sumCols=[{label:'Metric',w:90,align:'left'},{label:'Budget',w:44,align:'right'},{label:'Actual / Forecast (Reported)',w:44,align:'right'}]
      tHead(sumCols)
      var sumRows=[
        ['Total Revenue', fmtV(totRevBudget)+' '+cur, fmtV(totRevActual)+' '+cur],
        ['Total Costs',   fmtV(totCostBudget)+' '+cur, fmtV(totCostActual)+' '+cur],
        ['Net Position',  fmtV(netBudget)+' '+cur, fmtV(netActual)+' '+cur],
      ]
      sumRows.forEach(function(r,i){
        tRow(sumCols, r, {shade:i%2===1, bold:i===2})
      })

      // Net variance highlight
      gap(6); guard(14)
      doc.setFillColor(statusBg[0],statusBg[1],statusBg[2])
      doc.rect(ML,y,TW,12,'F')
      doc.setDrawColor(statusColor[0],statusColor[1],statusColor[2]); doc.setLineWidth(0.3)
      doc.rect(ML,y,TW,12,'S'); doc.setLineWidth(0.2)
      doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(100,110,125)
      doc.text('Net Variance Impact', ML+4, y+5)
      doc.setFont('helvetica','bold'); doc.setFontSize(10)
      doc.setTextColor(statusColor[0],statusColor[1],statusColor[2])
      doc.text((netVar>=0?'+':'')+fmtV(netVar)+' '+cur+(netVarPct!==null?' ('+(netVarPct>=0?'+':'')+netVarPct.toFixed(1)+'%)':''), ML+4, y+10)
      doc.setFont('helvetica','bold'); doc.setFontSize(10)
      doc.text(safe(overallStatus), MR-4, y+10, {align:'right'})
      y+=16

      // Executive commentary line
      if(execCommentary) {
        guard(10)
        doc.setFont('helvetica','italic'); doc.setFontSize(7.5); doc.setTextColor(100,110,125)
        doc.text(safe(execCommentary), ML+4, y, {maxWidth:TW-8})
        y+=8
      }

      // ══════════════════════════════════════
      //  PERIOD SUMMARY TABLE
      // ══════════════════════════════════════
      secHead('Period Summary')
      var pCols=[
        {label:'Period',            w:26, align:'left'},
        {label:'Type',              w:22, align:'left'},
        {label:'Revenue Variance',  w:32, align:'right'},
        {label:'Cost Variance',     w:32, align:'right'},
        {label:'Net Impact',        w:32, align:'right'},
        {label:'Net %',             w:18, align:'right'},
        {label:'Status',            w:16, align:'right'},
      ]
      tHead(pCols)
      sortedPs.forEach(function(p,idx){
        var pRows=pGroups[p]
        var rv=0,ra=0,cv=0,ca=0
        pRows.forEach(function(v){
          var isRev=v.coa_node.startsWith('REV_')
          if(isRev){rv+=Number(v.budget_amount);ra+=Number(v.actual_amount)}
          else{cv+=Number(v.budget_amount);ca+=Number(v.actual_amount)}
        })
        var revVar=ra-rv, costVar=ca-cv
        var net=(ra-rv)-(ca-cv)
        var netPct=rv-cv!==0?((net/Math.abs(rv-cv))*100):null
        var isForecast=isForecastPeriod(p)
        var st=netPct!==null&&netPct>=-5?'On Track':netPct!==null&&netPct>=-15?'Watch':'At Risk'
        var stClr=st==='On Track'?[21,128,61]:st==='Watch'?[146,90,0]:[185,28,28]
        var netPctStr = netPct===null ? '—' : Math.abs(netPct)>1000 ? (netPct>0?'>+1000%':'>-1000%') : (netPct>=0?'+':'')+netPct.toFixed(1)+'%'
        tRow(pCols,[
          p,
          isForecast?'Forecast':'Actual',
          (revVar>=0?'+':'')+fmtV(revVar),
          (costVar>=0?'+':'')+fmtV(costVar),
          (net>=0?'+':'')+fmtV(net),
          netPctStr,
          st,
        ],{shade:idx%2===1, color:stClr})
      })

      // ══════════════════════════════════════
      //  KEY VARIANCE DRIVERS
      // ══════════════════════════════════════
      if(positive.length||negative.length) {
        secHead('Key Variance Drivers')

        // "were" if account name contains a plural keyword; "was" otherwise
        function verbFor(d) {
          return /costs|charges|expenses/i.test(d.name) ? 'were' : 'was'
        }

        function driverWording(d) {
          var extreme = d.vp !== null && Math.abs(d.vp) > 1000
          var verb = verbFor(d)
          if(d.favorable) {
            if(d.isRev) {
              return extreme
                ? safe(d.name)+' materially exceeded plan in '+d.period+' (favorable)'
                : safe(d.name)+' exceeded plan in '+d.period+' (favorable)'
            } else {
              return extreme
                ? safe(d.name)+' materially below plan in '+d.period+' (favorable)'
                : safe(d.name)+' '+verb+' below plan in '+d.period+' (favorable)'
            }
          } else {
            if(d.isRev) {
              return extreme
                ? safe(d.name)+' materially below plan in '+d.period+' (unfavorable)'
                : safe(d.name)+' '+verb+' below plan in '+d.period+' (unfavorable)'
            } else {
              return extreme
                ? safe(d.name)+' materially above plan in '+d.period+' (unfavorable)'
                : safe(d.name)+' '+verb+' above plan in '+d.period+' (unfavorable)'
            }
          }
        }

        if(positive.length) {
          gap(3); guard(10)
          doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(21,128,61)
          doc.text('Positive Drivers', ML, y); y+=5
          positive.forEach(function(d) {
            guard(8)
            doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(40,52,80)
            doc.text('- '+driverWording(d), ML+3, y, {maxWidth:TW-6}); y+=7
          })
        }
        if(negative.length) {
          gap(4); guard(10)
          doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(185,28,28)
          doc.text('Areas of Concern', ML, y); y+=5
          negative.forEach(function(d) {
            guard(8)
            doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(40,52,80)
            doc.text('- '+driverWording(d), ML+3, y, {maxWidth:TW-6}); y+=7
          })
        }
      }

      // ── Post-process: headers + footers ──
      var totalPages=doc.internal.getNumberOfPages()
      for(var p2=2;p2<=totalPages;p2++) {
        pageHeader(p2)
        pageFooter(p2, totalPages)
      }

      doc.save(safe(project.name).replace(/\s+/g,'_')+'_FPA_Report_'+new Date().toISOString().slice(0,10)+'.pdf')
    } catch(err) { alert('Export error: '+err.message) } finally { setExporting(false) }
  }

  if (loading) return <p style={{ color: '#8b949e', padding: '2rem' }}>Loading...</p>
  if (!project) return <p style={{ color: '#f85149', padding: '2rem' }}>Project not found.</p>

  const hasBudget = !!modelOutput

  // Group variances by period
  const periodGroups = {}
  variances.forEach(v => {
    if (!periodGroups[v.period]) periodGroups[v.period] = []
    periodGroups[v.period].push(v)
  })
  const sortedPeriods = Object.keys(periodGroups).sort()

  function periodSummary(rows) {
    let revBudget = 0, revActual = 0, costBudget = 0, costActual = 0
    rows.forEach(v => {
      const isRev = v.coa_node.startsWith('REV_')
      if (isRev) { revBudget += Number(v.budget_amount); revActual += Number(v.actual_amount) }
      else       { costBudget += Number(v.budget_amount); costActual += Number(v.actual_amount) }
    })
    return {
      revVar:  revActual - revBudget,
      costVar: costActual - costBudget,
      netVar:  (revActual - revBudget) - (costActual - costBudget),
    }
  }

  return (
    <div>
      <button onClick={() => navigate('/fpa')}
        style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', marginBottom: '1.5rem', fontSize: '0.85rem' }}>
        ← Back to FP&A
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: '600', marginBottom: '0.25rem' }}>{project.name}</h1>
          <p style={{ color: '#8b949e', fontSize: '0.85rem' }}>{project.project_type} · {project.country} · {project.currency}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {variances.length > 0 && (
            <button onClick={generateFPAPdf} disabled={exporting}
              style={{ padding: '0.5rem 1.1rem', background: 'none', border: '1px solid #30363d',
                color: '#8b949e', borderRadius: '6px', cursor: exporting ? 'not-allowed' : 'pointer',
                fontSize: '0.8rem', opacity: exporting ? 0.6 : 1 }}>
              {exporting ? 'Exporting...' : '↓ Export FP&A Summary'}
            </button>
          )}
          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: '0.75rem', padding: '3px 10px', borderRadius: '20px',
              background: '#3fb95022', color: '#3fb950', border: '1px solid #3fb950' }}>approved</span>
            {version && <p style={{ fontSize: '0.75rem', color: '#484f58', marginTop: '0.4rem' }}>{version.label}</p>}
          </div>
        </div>
      </div>

      {/* Budget source banner */}
      <div style={{ background: hasBudget ? '#161b22' : '#f8514911',
        border: '1px solid ' + (hasBudget ? '#3fb95033' : '#f85149'),
        borderRadius: '8px', padding: '0.75rem 1.25rem', marginBottom: '1.5rem',
        fontSize: '0.8rem', color: hasBudget ? '#8b949e' : '#f85149' }}>
        {hasBudget
          ? '✓ Budget pre-filled from approved model output · Monthly estimates derived from annual cash flows'
          : 'No approved model output found. Approve a feasibility version first to enable budget pre-fill.'}
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid #21262d', marginBottom: '2rem' }}>
        {TABS.map(t => (
          <button key={t} onClick={() => { setTab(t); setDrillRow(null) }}
            style={{ padding: '0.6rem 1.25rem', background: 'none', border: 'none',
              borderBottom: tab === t ? '2px solid #58a6ff' : '2px solid transparent',
              color: tab === t ? '#58a6ff' : '#8b949e', cursor: 'pointer', fontSize: '0.9rem' }}>{t}</button>
        ))}
      </div>

      {/* ══════════════════ ACTUALS ENTRY ══════════════════ */}
      {tab === 'Actuals Entry' && (
        <div style={{ maxWidth: '800px' }}>
          <div style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: '#8b949e', marginBottom: '0.4rem' }}>Period</label>
              <input type="month" value={period} onChange={e => setPeriod(e.target.value)}
                style={{ padding: '0.5rem 0.75rem', background: '#0d1117', border: '1px solid #30363d',
                  borderRadius: '6px', color: '#e6edf3', fontSize: '0.9rem', width: '200px' }} />
            </div>
            {period && !budgetPreview && hasBudget && (
              <p style={{ fontSize: '0.75rem', color: '#d29922', marginTop: '1.2rem' }}>
                Period outside modelled timeline — enter budget manually
              </p>
            )}
          </div>

          <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '8px', overflow: 'hidden', marginBottom: '1.5rem' }}>
            {period && (
              <div style={{ padding: '0.6rem 1rem', background: isForecastPeriod(period) ? '#1f6feb11' : '#3fb95011',
                borderBottom: '1px solid #21262d', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <span style={{ fontSize: '0.7rem', padding: '2px 8px', borderRadius: '20px',
                  background: isForecastPeriod(period) ? '#1f6feb22' : '#3fb95022',
                  color: isForecastPeriod(period) ? '#58a6ff' : '#3fb950',
                  border: '1px solid ' + (isForecastPeriod(period) ? '#1f6feb' : '#3fb950'),
                  fontWeight: '600' }}>
                  {isForecastPeriod(period) ? 'FORECAST' : 'ACTUAL'}
                </span>
                <span style={{ fontSize: '0.75rem', color: '#484f58' }}>
                  {isForecastPeriod(period)
                    ? 'Future period — values will be saved as forecast'
                    : 'Past period — values will be saved as actuals'}
                </span>
              </div>
            )}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #21262d' }}>
                  <th style={{ padding: '0.75rem 1rem', textAlign: 'left', color: '#8b949e', fontWeight: '500', fontSize: '0.75rem', width: '35%' }}>Account</th>
                  <th style={{ padding: '0.75rem 1rem', textAlign: 'right', color: '#8b949e', fontWeight: '500', fontSize: '0.75rem' }}>
                    Budget ({project.currency})
                    {hasBudget && <span style={{ color: '#3fb95066', marginLeft: '0.4rem', fontSize: '0.68rem' }}>model</span>}
                  </th>
                  <th style={{ padding: '0.75rem 1rem', textAlign: 'right', color: '#8b949e', fontWeight: '500', fontSize: '0.75rem' }}>
                    {period && isForecastPeriod(period) ? 'Forecast' : 'Actual'} ({project.currency})
                  </th>
                  <th style={{ padding: '0.75rem 1rem', textAlign: 'right', color: '#8b949e', fontWeight: '500', fontSize: '0.75rem' }}>Variance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const budgetNum = toNum(r.budget)
                  const actualNum = toNum(r.actual)
                  const variance  = r.actual !== '' ? actualNum - budgetNum : null
                  const isRev     = r.coa_node.startsWith('REV_')
                  const varColor  = variance === null ? '#484f58'
                    : isRev ? (variance >= 0 ? '#3fb950' : '#f85149')
                    : (variance <= 0 ? '#3fb950' : '#f85149')
                  const budgetFromModel = budgetPreview && budgetPreview[r.coa_node] !== undefined

                  return (
                    <tr key={r.coa_node} style={{ borderBottom: '1px solid #21262d' }}>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        <span style={{ display: 'block', color: '#e6edf3', fontWeight: '500' }}>{r.account_name}</span>
                        <span style={{ fontSize: '0.7rem', color: '#484f58' }}>{r.coa_node}</span>
                      </td>
                      <td style={{ padding: '0.5rem 1rem', textAlign: 'right' }}>
                        {budgetFromModel ? (
                          // Read-only pre-filled from model
                          <span style={{ color: '#8b949e', fontSize: '0.875rem' }}>
                            {fmtN(r.budget)}
                          </span>
                        ) : (
                          // Editable if no model data
                          <input type="text" value={r.budget}
                            onChange={e => updateBudget(i, stripCommas(e.target.value))}
                            onBlur={() => { if (r.budget) updateBudget(i, formatWithCommas(r.budget)) }}
                            onFocus={() => updateBudget(i, stripCommas(r.budget))}
                            placeholder="0"
                            style={{ width: '130px', padding: '0.4rem 0.6rem', background: '#0d1117',
                              border: '1px solid #30363d', borderRadius: '6px', color: '#e6edf3',
                              fontSize: '0.875rem', textAlign: 'right' }} />
                        )}
                      </td>
                      <td style={{ padding: '0.5rem 1rem', textAlign: 'right' }}>
                        <input type="text" value={r.actual}
                          onChange={e => updateActual(i, stripCommas(e.target.value))}
                          onBlur={() => { if (r.actual) updateActual(i, formatWithCommas(r.actual)) }}
                          onFocus={() => updateActual(i, stripCommas(r.actual))}
                          placeholder={period && isForecastPeriod(period) ? 'forecast' : '0'}
                          style={{ width: '130px', padding: '0.4rem 0.6rem', background: '#0d1117',
                            border: '1px solid ' + (period && isForecastPeriod(period) ? '#1f6feb44' : '#30363d'),
                            borderRadius: '6px', color: '#e6edf3',
                            fontSize: '0.875rem', textAlign: 'right' }} />
                      </td>
                      <td style={{ padding: '0.75rem 1rem', textAlign: 'right', color: varColor, fontWeight: '500', minWidth: '100px' }}>
                        {variance !== null ? (variance >= 0 ? '+' : '') + fmtN(variance) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <button onClick={handleSubmit} disabled={submitting}
            style={{ padding: '0.55rem 1.4rem', background: '#1f6feb', color: 'white', border: 'none',
              borderRadius: '6px', cursor: submitting ? 'not-allowed' : 'pointer',
              fontSize: '0.875rem', fontWeight: '500', opacity: submitting ? 0.6 : 1 }}>
            {submitting ? 'Saving...' : 'Save Period'}
          </button>
        </div>
      )}

      {/* ══════════════════ VARIANCE REPORT ══════════════════ */}
      {tab === 'Variance Report' && (
        <div>
          {sortedPeriods.length === 0 ? (
            <div style={{ color: '#8b949e', fontSize: '0.875rem' }}>
              No actuals submitted yet. Use Actuals Entry to add your first period.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {/* Cumulative summary row */}
              {sortedPeriods.length > 1 && (() => {
                const allRows = variances
                const s = { revBudget:0, revActual:0, costBudget:0, costActual:0 }
                allRows.forEach(v => {
                  const isRev = v.coa_node.startsWith('REV_')
                  if (isRev) { s.revBudget += Number(v.budget_amount); s.revActual += Number(v.actual_amount) }
                  else       { s.costBudget += Number(v.budget_amount); s.costActual += Number(v.actual_amount) }
                })
                const netVar = (s.revActual - s.revBudget) - (s.costActual - s.costBudget)
                return (
                  <div style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: '8px',
                    padding: '0.9rem 1.25rem', display: 'flex', gap: '2rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.75rem', color: '#484f58', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {sortedPeriods.filter(p => !isForecastPeriod(p)).length} Actual
                      {sortedPeriods.filter(p => isForecastPeriod(p)).length > 0 &&
                        <span style={{ color: '#58a6ff', marginLeft: '0.5rem' }}>
                          + {sortedPeriods.filter(p => isForecastPeriod(p)).length} Forecast
                        </span>
                      }
                    </span>
                    {[
                      { label: 'Total Revenue Budget', value: fmtN(s.revBudget), color: '#8b949e' },
                      { label: 'Total Revenue Actual / Forecast', value: fmtN(s.revActual), color: '#e6edf3' },
                      { label: 'Net Variance', value: (netVar >= 0 ? '+' : '') + fmtN(netVar),
                        color: netVar >= 0 ? '#3fb950' : '#f85149' },
                    ].map(item => (
                      <div key={item.label}>
                        <p style={{ fontSize: '0.68rem', color: '#484f58', marginBottom: '0.2rem' }}>{item.label}</p>
                        <p style={{ fontSize: '0.9rem', fontWeight: '600', color: item.color }}>{item.value}</p>
                      </div>
                    ))}
                  </div>
                )
              })()}

              {sortedPeriods.map(p => {
                const pRows  = periodGroups[p]
                const summary = periodSummary(pRows)
                const isOpen  = expandedPeriods[p] !== false
                return (
                  <div key={p} style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '8px', overflow: 'hidden' }}>
                    {/* Period header */}
                    <div onClick={() => setExpandedPeriods(prev => ({ ...prev, [p]: !isOpen }))}
                      style={{ padding: '1rem 1.25rem', display: 'flex', justifyContent: 'space-between',
                        alignItems: 'center', cursor: 'pointer',
                        borderBottom: isOpen ? '1px solid #21262d' : 'none' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: '600', fontSize: '0.9rem', color: '#e6edf3' }}>{p}</span>
                        {/* Actual vs Forecast badge */}
                        <span style={{ fontSize: '0.68rem', padding: '2px 7px', borderRadius: '20px', fontWeight: '600',
                          background: isForecastPeriod(p) ? '#1f6feb22' : '#3fb95022',
                          color: isForecastPeriod(p) ? '#58a6ff' : '#3fb950',
                          border: '1px solid ' + (isForecastPeriod(p) ? '#1f6feb' : '#3fb950') }}>
                          {isForecastPeriod(p) ? 'FORECAST' : 'ACTUAL'}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: '#8b949e' }}>
                          Revenue: <span style={{ color: summary.revVar >= 0 ? '#3fb950' : '#f85149', fontWeight: '500' }}>
                            {summary.revVar >= 0 ? '+' : ''}{fmtN(summary.revVar)}
                          </span>
                        </span>
                        <span style={{ fontSize: '0.75rem', color: '#8b949e' }}>
                          Costs: <span style={{ color: summary.costVar <= 0 ? '#3fb950' : '#f85149', fontWeight: '500' }}>
                            {summary.costVar >= 0 ? '+' : ''}{fmtN(summary.costVar)}
                          </span>
                        </span>
                        <span style={{ fontSize: '0.75rem', color: '#8b949e' }}>
                          Net: <span style={{ color: summary.netVar >= 0 ? '#3fb950' : '#f85149', fontWeight: '600' }}>
                            {summary.netVar >= 0 ? '+' : ''}{fmtN(summary.netVar)}
                          </span>
                        </span>
                      </div>
                      <span style={{ color: '#484f58', fontSize: '0.75rem' }}>{isOpen ? '▲' : '▼'}</span>
                    </div>

                    {isOpen && (
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid #21262d' }}>
                            {['Account', 'Budget', isForecastPeriod(p) ? 'Forecast' : 'Actual', 'Variance', 'Var %', 'Status'].map(h => (
                              <th key={h} style={{ padding: '0.6rem 1rem',
                                textAlign: h === 'Account' ? 'left' : 'right',
                                color: '#8b949e', fontWeight: '500', fontSize: '0.72rem' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {pRows.map(v => {
                            const coa   = COA.find(c => c.code === v.coa_node)
                            const isSelected = drillRow && drillRow.variance_id === v.variance_id
                            const isRev = v.coa_node.startsWith('REV_')
                            const va    = Number(v.variance_amount)
                            const vp    = v.variance_percent !== null ? Number(v.variance_percent) : null
                            const varColor = vp === null ? '#484f58'
                              : isRev ? (va >= 0 ? '#3fb950' : '#f85149')
                              : (va <= 0 ? '#3fb950' : '#f85149')
                            const fl    = v.severity_flag || 'green'
                            const statusLabel = flagLabel(fl, v.coa_node, vp)
                            return (
                              <React.Fragment key={v.variance_id}>
                                <tr onClick={() => setDrillRow(isSelected ? null : v)}
                                  style={{ borderBottom: isSelected ? 'none' : '1px solid #21262d',
                                    cursor: 'pointer', background: isSelected ? '#1c2128' : 'transparent' }}>
                                  <td style={{ padding: '0.7rem 1rem' }}>
                                    <span style={{ display: 'block', color: '#e6edf3' }}>{coa ? coa.name : v.coa_node}</span>
                                    <span style={{ fontSize: '0.7rem', color: '#484f58' }}>{v.coa_node}</span>
                                  </td>
                                  <td style={{ padding: '0.7rem 1rem', color: '#8b949e', textAlign: 'right' }}>{fmtN(v.budget_amount)}</td>
                                  <td style={{ padding: '0.7rem 1rem', color: '#e6edf3', textAlign: 'right' }}>{fmtN(v.actual_amount)}</td>
                                  <td style={{ padding: '0.7rem 1rem', color: varColor, fontWeight: '500', textAlign: 'right' }}>
                                    {(va >= 0 ? '+' : '') + fmtN(va)}
                                  </td>
                                  <td style={{ padding: '0.7rem 1rem', color: varColor, textAlign: 'right' }}>
                                    {fmtVarPct(vp)}
                                  </td>
                                  <td style={{ padding: '0.7rem 1rem', textAlign: 'right' }}>
                                    <span style={{ fontSize: '0.7rem', padding: '2px 8px', borderRadius: '20px', ...flagColors(fl) }}>
                                      {statusLabel}
                                    </span>
                                  </td>
                                </tr>
                                {isSelected && (
                                  <tr style={{ background: '#0d1117', borderBottom: '1px solid #21262d' }}>
                                    <td colSpan={6} style={{ padding: '1rem 1.5rem' }}>
                                      <p style={{ fontSize: '0.72rem', color: '#484f58', textTransform: 'uppercase',
                                        letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
                                        Variance Detail — {coa ? coa.name : v.coa_node} · {v.period}
                                      </p>
                                      <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                                        {[
                                          { label: 'Budget',   value: fmtN(v.budget_amount), color: '#8b949e' },
                                          { label: isForecastPeriod(v.period) ? 'Forecast' : 'Actual', value: fmtN(v.actual_amount), color: '#e6edf3' },
                                          { label: 'Variance', value: (va >= 0 ? '+' : '') + fmtN(va), color: varColor },
                                          { label: 'Var %',    value: fmtVarPct(vp), color: varColor },
                                          { label: 'Status',   value: statusLabel, color: flagColors(fl).color },
                                        ].map(item => (
                                          <div key={item.label} style={{ minWidth: '90px' }}>
                                            <p style={{ fontSize: '0.72rem', color: '#484f58', marginBottom: '0.3rem' }}>{item.label}</p>
                                            <p style={{ fontSize: '1rem', fontWeight: '600', color: item.color }}>{item.value}</p>
                                          </div>
                                        ))}
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            )
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
