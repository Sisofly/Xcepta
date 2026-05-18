import { useParams, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { jsPDF } from 'jspdf'
import DevEngineTab from './DevEngineTab'
import {
  getVal, pppVal, runEngine, runPPPEngine,
  PPP_DSCR_FLOOR, PPP_IRR_HURDLE,
  isPPPAvailabilityPayment, computePPPBankability, computeRequiredPayment,
} from '../modules/feasibility/annualEngine'
import colors from '../theme/colors.js'
import {
  fmtCurrency, fmtPct, fmtDSCR, fmtMultiple,
  fmtIRR, fmtNumber,
} from '../utils/format.js'
import { getRecommendation } from '../utils/recommend.js'

// ── Assumption edit-type helpers ──
const DROPDOWN_OPTIONS = { 'Revenue Model': ['Sale', 'Rental', 'Mixed'] }
const DATE_FIELDS = ['Construction Start Date', 'Operations Start Date']
function editType(name) {
  if (DROPDOWN_OPTIONS[name]) return 'dropdown'
  if (DATE_FIELDS.includes(name)) return 'date'
  return 'number'
}
function isEditable(a) { return editType(a.name) !== 'number' || a.value !== null }
function displayVal(a) {
  if (a.value !== null) return a.value
  if (a.unit) return a.unit
  return '---'
}
function editVal(a) {
  if (editType(a.name) === 'number') return String(a.value ?? '')
  return a.unit || ''
}

// ── Assumption groups ──
const ASSUMPTION_GROUPS = [
  { key: 'sizing',            label: 'Sizing' },
  { key: 'timeline',          label: 'Timeline' },
  { key: 'revenue',           label: 'Revenue' },
  { key: 'capital_structure', label: 'Capital Structure' },
]

const PPP_ASSUMPTION_GROUPS = [
  { key: 'sizing',        label: 'Project Identity' },
  { key: 'revenue',       label: 'Contract Model' },
  { key: 'ppp_structure', label: 'Project Structure' },
  { key: 'ppp_revenue',   label: 'Revenue & Payments' },
  { key: 'ppp_financing', label: 'Financing Terms' },
]

// Display-only label overrides for PPP assumptions.
// Stored DB name never changes — only the UI label.
const PPP_DISPLAY_LABELS = {
  'Concession Period':           'Operations / Revenue Period (Concession)',
  'Construction Period':         'Construction Period (months)',
  'Annual Availability Payment': 'Annual Availability Payment (JOD)',
  'Total Project Cost':          'Total Project Cost (JOD)',
  'OPEX % of Revenue':           'OPEX % of Annual Payment',
}

function fmtPPPAssumptionValue(a) {
  if (a.value === null || a.value === undefined) return a.unit || '---'
  var n = Number(a.value)
  if (a.unit === 'percent') return fmtPct(n)
  if (a.unit === 'JOD')     return fmtCurrency(n)
  if (a.unit === 'years')   return n + ' yrs'
  if (a.unit === 'months')  return n + ' mo'
  return String(a.value)
}

// ── Merge benchmark overrides into defaults array ──
function getMergedDefaults(defaults, overrides) {
  return defaults.map(d => ({
    ...d,
    value: overrides[d.key] !== undefined ? overrides[d.key] : d.value,
    _overridden: overrides[d.key] !== undefined,
  }))
}

const TABS = ['Assumptions', 'Results', 'Scenarios', 'Development Cash Flow', 'Export']
const COA_NAMES = {
  REV_SALE: 'Sale Proceeds', REV_RENTAL: 'Rental Income',
  COST_CONST: 'Construction Costs', COST_OPEX: 'Operating Expenses',
  COST_FINANCE: 'Finance Charges', COST_ADMIN: 'Admin & Overheads',
}
const IRR_HURDLE = 15

function dscrColor(v) {
  if (v === null) return colors.textMuted
  if (v >= 1.25) return colors.success
  if (v >= 1.0) return colors.warning
  return colors.danger
}

export default function FeasibilityProject() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const [project, setProject] = useState(null)
  const [version, setVersion] = useState(null)
  const [assumptions, setAssumptions] = useState([])
  const [defaults, setDefaults] = useState([])
  const [variances, setVariances] = useState([])
  const [modelOutput, setModelOutput] = useState(null)
  const [tab, setTab] = useState('Assumptions')
  const [loading, setLoading] = useState(true)
  const [approving, setApproving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [showFullCF, setShowFullCF] = useState(false)
  const [latestApprovedOutput, setLatestApprovedOutput] = useState(null)
  const [latestApprovedVersion, setLatestApprovedVersion] = useState(null)

  // ── Scenarios ──
  const [scenariosData, setScenariosData] = useState([])
  const [scenariosLoading, setScenariosLoading] = useState(false)
  const [showCreateScenario, setShowCreateScenario] = useState(false)
  const [newScenarioType, setNewScenarioType] = useState('bull')
  const [newScenarioLabel, setNewScenarioLabel] = useState('Bull Case')
  const [newScenarioSource, setNewScenarioSource] = useState(null)
  const [creatingScenario, setCreatingScenario] = useState(false)
  const [expandedScenario, setExpandedScenario] = useState(null)
  const [scEditingId, setScEditingId] = useState(null)
  const [scEditingValue, setScEditingValue] = useState('')
  const [scSaving, setScSaving] = useState(false)
  const [scApproving, setScApproving] = useState(null)
  const [scDeletingId, setScDeletingId] = useState(null)
  const [scDriverEditKey, setScDriverEditKey] = useState(null)  // 'scenarioId:driverKey'
  const [scDriverEditValue, setScDriverEditValue] = useState('')
  const [scDriverSaving, setScDriverSaving] = useState(false)

  // ── Assumption editing ──
  const [editingId, setEditingId] = useState(null)
  const [editingValue, setEditingValue] = useState('')
  const [assumptionsModified, setAssumptionsModified] = useState(false)
  const [creatingDraft, setCreatingDraft] = useState(false)
  const [savingAssumption, setSavingAssumption] = useState(false)

  // ── Archive ──
  const [archiving, setArchiving] = useState(false)
  const [isArchived, setIsArchived] = useState(false)

  // ── Benchmark overrides ──
  const [overrides, setOverrides] = useState({})
  const [editingOverrideKey, setEditingOverrideKey] = useState(null)
  const [editingOverrideValue, setEditingOverrideValue] = useState('')
  const [savingOverride, setSavingOverride] = useState(false)
  const [openGroups, setOpenGroups] = useState({ 'Market Dynamics': true })
  const [preparedBy, setPreparedBy] = useState('')

  useEffect(() => {
    async function load() {
      const { data: proj } = await supabase.from('projects').select('*').eq('project_id', projectId).single()
      setProject(proj)
      setIsArchived(proj?.archived === true)
      const { data: scenarios } = await supabase.from('scenarios').select('scenario_id').eq('project_id', projectId)
      let versionData = null
      if (scenarios && scenarios.length) {
        const { data: versions } = await supabase.from('versions').select('*')
          .eq('scenario_id', scenarios[0].scenario_id).order('created_at', { ascending: false }).limit(1)
        if (versions && versions.length) { versionData = versions[0]; setVersion(versionData) }
      }
      // User assumptions — base only (scenario_id IS NULL), excludes cloned scenario rows
      const { data: assump } = await supabase.from('assumptions').select('*')
        .eq('project_id', projectId)
        .is('scenario_id', null)
        .neq('category', 'benchmark_override')
        .order('category')
      setAssumptions(assump || [])
      // Benchmark overrides — base only
      const { data: overrideRows } = await supabase.from('assumptions').select('*')
        .eq('project_id', projectId)
        .is('scenario_id', null)
        .eq('category', 'benchmark_override')
      const overrideMap = {}
      ;(overrideRows || []).forEach(a => { overrideMap[a.name] = a.value })
      setOverrides(overrideMap)

      const { data: defs } = await supabase.from('static_defaults').select('*').eq('country', 'Jordan').eq('sector', 'Real Estate')
      setDefaults(defs || [])
      const { data: vars } = await supabase.from('variances').select('*').eq('project_id', projectId).order('period', { ascending: false })
      setVariances(vars || [])
      if (versionData && versionData.status === 'approved') {
        const { data: outputs } = await supabase.from('model_outputs').select('*')
          .eq('version_id', versionData.version_id).order('computed_at', { ascending: false }).limit(1)
        if (outputs && outputs.length) setModelOutput(outputs[0])
      }
      // Always load latest approved output for PDF (works even when current version is draft)
      if (scenarios && scenarios.length) {
        const { data: approvedVers } = await supabase.from('versions').select('*')
          .eq('scenario_id', scenarios[0].scenario_id).eq('status', 'approved')
          .order('approved_at', { ascending: false }).limit(1)
        if (approvedVers && approvedVers.length) {
          setLatestApprovedVersion(approvedVers[0])
          const { data: approvedOutputs } = await supabase.from('model_outputs').select('*')
            .eq('version_id', approvedVers[0].version_id).order('computed_at', { ascending: false }).limit(1)
          if (approvedOutputs && approvedOutputs.length) setLatestApprovedOutput(approvedOutputs[0])
        }
      }
      // Prepared By
      const { data: { user: authUser } } = await supabase.auth.getUser()
      if (authUser) {
        const { data: userRow } = await supabase.from('users').select('*').eq('user_id', authUser.id).single()
        setPreparedBy((userRow && (userRow.full_name || userRow.name)) ? (userRow.full_name || userRow.name) : authUser.email || '')
      }
      setLoading(false)
    }
    load()
  }, [projectId])

  async function handleSaveAssumption(assumptionId, name) {
    setSavingAssumption(true)
    const type = editType(name)
    const isUnitField = type === 'dropdown' || type === 'date'
    let payload, updatedFields
    if (isUnitField) {
      payload = { unit: editingValue }; updatedFields = { unit: editingValue }
    } else {
      const parsed = editingValue !== '' && !isNaN(Number(editingValue)) ? Number(editingValue) : editingValue
      payload = { value: parsed }; updatedFields = { value: parsed }
    }
    const { error } = await supabase.from('assumptions').update(payload).eq('assumption_id', assumptionId)
    if (!error) {
      setAssumptions(prev => prev.map(a => a.assumption_id === assumptionId ? { ...a, ...updatedFields } : a))
      if (version && version.status === 'approved') setAssumptionsModified(true)
    } else { alert('Save failed: ' + error.message) }
    setEditingId(null); setEditingValue(''); setSavingAssumption(false)
  }

  async function handleSaveOverride(key) {
    setSavingOverride(true)
    const val = parseFloat(editingOverrideValue)
    if (isNaN(val)) { alert('Please enter a valid number'); setSavingOverride(false); return }
    const { data: existing } = await supabase.from('assumptions').select('assumption_id')
      .eq('project_id', projectId).eq('category', 'benchmark_override').eq('name', key).maybeSingle()
    let error
    if (existing) {
      ;({ error } = await supabase.from('assumptions').update({ value: val }).eq('assumption_id', existing.assumption_id))
    } else {
      ;({ error } = await supabase.from('assumptions').insert({
        project_id: projectId, name: key, category: 'benchmark_override',
        value: val, unit: null, confidence: 'indicative',
      }))
    }
    if (!error) {
      setOverrides(prev => ({ ...prev, [key]: val }))
      if (version && version.status === 'approved') setAssumptionsModified(true)
    } else { alert('Override failed: ' + error.message) }
    setEditingOverrideKey(null); setEditingOverrideValue(''); setSavingOverride(false)
  }

  async function handleRemoveOverride(key) {
    const { data: existing } = await supabase.from('assumptions').select('assumption_id')
      .eq('project_id', projectId).eq('category', 'benchmark_override').eq('name', key).maybeSingle()
    if (existing) await supabase.from('assumptions').delete().eq('assumption_id', existing.assumption_id)
    setOverrides(prev => { const n = { ...prev }; delete n[key]; return n })
    if (version && version.status === 'approved') setAssumptionsModified(true)
  }

  // ── Load all scenarios for this project ──
  async function loadScenarios() {
    setScenariosLoading(true)
    const { data: scList } = await supabase.from('scenarios').select('*')
      .eq('project_id', projectId).order('created_at', { ascending: true })
    if (!scList) { setScenariosLoading(false); return }
    const enriched = await Promise.all(scList.map(async s => {
      const { data: vers } = await supabase.from('versions').select('*')
        .eq('scenario_id', s.scenario_id).order('created_at', { ascending: false }).limit(1)
      const latestVer = vers && vers.length ? vers[0] : null
      let output = null
      if (latestVer && latestVer.status === 'approved') {
        const { data: outs } = await supabase.from('model_outputs').select('*')
          .eq('version_id', latestVer.version_id).order('computed_at', { ascending: false }).limit(1)
        output = outs && outs.length ? outs[0] : null
      }
      const { data: scAssump } = await supabase.from('assumptions').select('*')
        .eq('project_id', projectId).eq('scenario_id', s.scenario_id)
        .neq('category', 'benchmark_override').order('category')
      // Load scenario-level key driver overrides
      const { data: scDrivers } = await supabase.from('assumptions').select('*')
        .eq('project_id', projectId).eq('scenario_id', s.scenario_id)
        .eq('category', 'benchmark_override')
      const driverMap = {}
      ;(scDrivers || []).forEach(d => { driverMap[d.name] = { value: d.value, assumption_id: d.assumption_id } })
      const assumpToUse = scAssump && scAssump.length > 0 ? scAssump : assumptions
      return { ...s, latestVersion: latestVer, modelOutput: output, assumptions: assumpToUse, drivers: driverMap }
    }))
    setScenariosData(enriched)
    setScenariosLoading(false)
  }

  // ── Create a new scenario by cloning assumptions from source ──
  async function handleCreateScenario() {
    setCreatingScenario(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const { data: userData } = await supabase.from('users').select('tenant_id').eq('user_id', user.id).single()
      // Create scenario record
      const { data: newSc, error: scErr } = await supabase.from('scenarios').insert({
        project_id: projectId,
        name: newScenarioLabel || 'New Scenario',
        label: newScenarioLabel || 'New Scenario',
        scenario_type: newScenarioType,
      }).select().single()
      if (scErr) throw scErr
      // Always clone from base project-level assumptions (scenario_id = null)
      let sourceAssump = assumptions
      const cloned = sourceAssump.map(a => ({
        tenant_id: userData.tenant_id,
        project_id: projectId,
        scenario_id: newSc.scenario_id,
        name: a.name, category: a.category,
        value: a.value, unit: a.unit, confidence: a.confidence,
        module_origin: 'feasibility',
        source_type: 'user_entry',
        author_user_id: user.id,
      }))
      const { error: aErr } = await supabase.from('assumptions').insert(cloned)
      if (aErr) throw aErr
      // Create draft version
      const { error: vErr } = await supabase.from('versions').insert({
        scenario_id: newSc.scenario_id, label: 'v1.0 Draft', status: 'draft',
      })
      if (vErr) throw vErr
      setShowCreateScenario(false)
      setNewScenarioLabel('Bull Case')
      setNewScenarioType('bull')
      setExpandedScenario(newSc.scenario_id)
      await loadScenarios()
    } catch (err) { alert('Error creating scenario: ' + err.message) }
    finally { setCreatingScenario(false) }
  }

  // ── Save a single assumption value for a scenario ──
  async function handleSaveScenarioAssumption(assumptionId, name, scenarioAssumptions) {
    setScSaving(true)
    const type = editType(name)
    const isUnitField = type === 'dropdown' || type === 'date'
    const payload = isUnitField ? { unit: scEditingValue } : {
      value: scEditingValue !== '' && !isNaN(Number(scEditingValue)) ? Number(scEditingValue) : scEditingValue
    }
    const { error } = await supabase.from('assumptions').update(payload).eq('assumption_id', assumptionId)
    if (!error) {
      setScenariosData(prev => prev.map(s => ({
        ...s,
        assumptions: s.assumptions.map(a =>
          a.assumption_id === assumptionId ? { ...a, ...payload } : a
        )
      })))
    } else { alert('Save failed: ' + error.message) }
    setScEditingId(null); setScEditingValue(''); setScSaving(false)
  }

  // ── Delete a scenario ──
  async function handleDeleteScenario(sc) {
    const isBase = sc.scenario_type === 'base' || !sc.scenario_type
    const msg = isBase
      ? 'This is the Base scenario. Deleting it will also remove all its assumptions and model outputs.\n\nAre you sure?'
      : 'Delete scenario "' + (sc.label || sc.name) + '"? This cannot be undone.'
    if (!window.confirm(msg)) return
    setScDeletingId(sc.scenario_id)
    try {
      if (sc.latestVersion) {
        await supabase.from('model_outputs').delete().eq('version_id', sc.latestVersion.version_id)
        await supabase.from('versions').delete().eq('scenario_id', sc.scenario_id)
      }
      await supabase.from('assumptions').delete()
        .eq('project_id', projectId).eq('scenario_id', sc.scenario_id)
      await supabase.from('scenarios').delete().eq('scenario_id', sc.scenario_id)
      await loadScenarios()
    } catch (err) { alert('Delete failed: ' + err.message) }
    finally { setScDeletingId(null) }
  }

  // ── Save a key driver override for a scenario ──
  async function handleSaveScenarioDriver(sc, driverKey, rawValue) {
    setScDriverSaving(true)
    const val = parseFloat(rawValue)
    if (isNaN(val)) { alert('Please enter a valid number'); setScDriverSaving(false); return }
    const { data: { user } } = await supabase.auth.getUser()
    const { data: userData } = await supabase.from('users').select('tenant_id').eq('user_id', user.id).single()
    const existing = sc.drivers && sc.drivers[driverKey]
    let error
    if (existing) {
      ;({ error } = await supabase.from('assumptions').update({ value: val })
        .eq('assumption_id', existing.assumption_id))
    } else {
      ;({ error } = await supabase.from('assumptions').insert({
        project_id: projectId,
        scenario_id: sc.scenario_id,
        name: driverKey,
        category: 'benchmark_override',
        value: val, unit: null, confidence: 'indicative',
        tenant_id: userData.tenant_id,
        author_user_id: user.id,
        module_origin: 'feasibility',
        source_type: 'user_entry',
      }))
    }
    if (!error) { await loadScenarios() }
    else { alert('Save failed: ' + error.message) }
    setScDriverEditKey(null); setScDriverEditValue(''); setScDriverSaving(false)
  }

  // ── Reset a scenario key driver back to project default ──
  async function handleResetScenarioDriver(sc, driverKey) {
    const existing = sc.drivers && sc.drivers[driverKey]
    if (!existing) return
    await supabase.from('assumptions').delete().eq('assumption_id', existing.assumption_id)
    await loadScenarios()
  }

  // ── Approve and run a scenario (uses scenario-level drivers) ──
  async function handleApproveScenario(sc) {
    if (!sc.latestVersion) return
    // ── B2: Capital structure validation (RE / non-PPP only) ──
    if (!isPPPAvailabilityPayment(project, sc.assumptions || assumptions)) {
      const eqRaw = getVal(sc.assumptions || assumptions, 'Equity %')
      const sdRaw = getVal(sc.assumptions || assumptions, 'Senior Debt %')
      const equityPct     = (eqRaw === null ? 0 : Number(eqRaw)) / 100
      const seniorDebtPct = (sdRaw === null ? 0 : Number(sdRaw)) / 100
      if (Math.abs(equityPct + seniorDebtPct - 1) > 1e-6) {
        const x = eqRaw === null ? 0 : Number(eqRaw)
        const y = sdRaw === null ? 0 : Number(sdRaw)
        alert('Equity % (' + x + '%) and Senior Debt % (' + y + '%) must sum to 100%. They currently sum to ' + (x + y) + '%. Please correct before continuing.')
        return
      }
    }
    const confirmed = window.confirm('Approve and run this scenario? The model will be computed with current assumptions and key drivers.')
    if (!confirmed) return
    setScApproving(sc.scenario_id)
    try {
      const newLabel = sc.latestVersion.label.replace('Draft', 'Approved')
      await supabase.from('versions').update({
        status: 'approved', approved_at: new Date().toISOString(), label: newLabel,
      }).eq('version_id', sc.latestVersion.version_id)
      const { data: { user } } = await supabase.auth.getUser()
      const { data: userData } = await supabase.from('users').select('tenant_id').eq('user_id', user.id).single()
      // Merge: project-level defaults → project-level overrides → scenario-level driver overrides
      const scenarioDriverOverrides = {}
      if (sc.drivers) {
        Object.entries(sc.drivers).forEach(([k, v]) => { scenarioDriverOverrides[k] = v.value })
      }
      const mergedDefs = getMergedDefaults(
        getMergedDefaults(defaults, overrides),  // project-level overrides first
        scenarioDriverOverrides                   // scenario-level on top
      )
      const scPPPAP = isPPPAvailabilityPayment(project, sc.assumptions || assumptions)
      const output = scPPPAP
        ? runPPPEngine(sc.assumptions || assumptions)
        : runEngine(sc.assumptions, mergedDefs)
      await supabase.from('model_outputs').insert({
        version_id: sc.latestVersion.version_id, project_id: projectId,
        tenant_id: userData.tenant_id, irr: output.irr, npv: output.npv,
        equity_multiple: output.equity_multiple, dscr_series: output.dscr_series,
        cash_flows: output.cash_flows, created_by: user.id,
      })
      await loadScenarios()
    } catch (err) { alert('Error: ' + err.message) }
    finally { setScApproving(null) }
  }

  async function handleArchive() {
    const confirmed = window.confirm(
      'This project will be archived and hidden from the active list. You can restore it at any time.'
    )
    if (!confirmed) return
    setArchiving(true)
    const { error } = await supabase.from('projects').update({ archived: true }).eq('project_id', projectId)
    if (error) alert('Archive failed: ' + error.message)
    else { setIsArchived(true) }
    setArchiving(false)
  }

  async function handleRestore() {
    setArchiving(true)
    const { error } = await supabase.from('projects').update({ archived: false }).eq('project_id', projectId)
    if (error) alert('Restore failed: ' + error.message)
    else { setIsArchived(false) }
    setArchiving(false)
  }

  // ── Save dev engine result to version record (single source of truth for export) ──
  async function handleEngineResult(result) {
    if (!version) return
    // Update local state immediately — Export can read results even if DB write
    // is blocked (e.g. RLS on approved versions) or slow.
    setVersion(prev => ({ ...prev, dev_engine_results: result }))
    // Attempt to persist; failure is non-fatal, local state is already set.
    const { error } = await supabase
      .from('versions')
      .update({ dev_engine_results: result })
      .eq('version_id', version.version_id)
    if (error) {
      console.warn('Dev engine results not persisted to DB:', error.message)
    }
  }

  async function handleCreateDraft() {
    setCreatingDraft(true)
    try {
      const { data: scenarios } = await supabase.from('scenarios').select('scenario_id').eq('project_id', projectId)
      if (!scenarios || !scenarios.length) throw new Error('No scenario found')
      const { data: allVersions } = await supabase.from('versions').select('label').eq('scenario_id', scenarios[0].scenario_id)
      const vNum = allVersions ? allVersions.length + 1 : 2
      const { data: newVersion, error } = await supabase.from('versions').insert({
        scenario_id: scenarios[0].scenario_id, label: 'v' + vNum + '.0 Draft', status: 'draft',
      }).select().single()
      if (error) throw error
      setVersion(newVersion); setModelOutput(null); setAssumptionsModified(false); setTab('Assumptions')
    } catch (err) { alert('Error creating draft: ' + err.message) }
    finally { setCreatingDraft(false) }
  }

  // Refresh post-approval state from the server. Mirrors the load-effect queries
  // for version + modelOutput + latestApprovedVersion + latestApprovedOutput.
  // Called after handleApprove to fix stale Results / export state without a page reload.
  async function refreshApprovalState(scenarioId) {
    if (!scenarioId) return
    const { data: versions } = await supabase.from('versions').select('*')
      .eq('scenario_id', scenarioId).order('created_at', { ascending: false }).limit(1)
    const latestVer = versions && versions.length ? versions[0] : null
    if (latestVer) setVersion(latestVer)
    if (latestVer && latestVer.status === 'approved') {
      const { data: outputs } = await supabase.from('model_outputs').select('*')
        .eq('version_id', latestVer.version_id).order('computed_at', { ascending: false }).limit(1)
      if (outputs && outputs.length) setModelOutput(outputs[0])
    }
    const { data: approvedVers } = await supabase.from('versions').select('*')
      .eq('scenario_id', scenarioId).eq('status', 'approved')
      .order('approved_at', { ascending: false }).limit(1)
    if (approvedVers && approvedVers.length) {
      setLatestApprovedVersion(approvedVers[0])
      const { data: approvedOutputs } = await supabase.from('model_outputs').select('*')
        .eq('version_id', approvedVers[0].version_id).order('computed_at', { ascending: false }).limit(1)
      if (approvedOutputs && approvedOutputs.length) setLatestApprovedOutput(approvedOutputs[0])
    }
  }

  async function handleApprove() {
    if (!version) return
    // ── B2: Capital structure validation (RE / non-PPP only) ──
    if (!isPPPAvailabilityPayment(project, assumptions)) {
      const eqRaw = getVal(assumptions, 'Equity %')
      const sdRaw = getVal(assumptions, 'Senior Debt %')
      const equityPct     = (eqRaw === null ? 0 : Number(eqRaw)) / 100
      const seniorDebtPct = (sdRaw === null ? 0 : Number(sdRaw)) / 100
      if (Math.abs(equityPct + seniorDebtPct - 1) > 1e-6) {
        const x = eqRaw === null ? 0 : Number(eqRaw)
        const y = sdRaw === null ? 0 : Number(sdRaw)
        alert('Equity % (' + x + '%) and Senior Debt % (' + y + '%) must sum to 100%. They currently sum to ' + (x + y) + '%. Please correct before continuing.')
        return
      }
    }
    const confirmed = window.confirm('Approve this version? This is irreversible - the baseline will be locked for variance tracking.')
    if (!confirmed) return
    setApproving(true)
    try {
      // ── Run the annual / basic feasibility engine first.
      // If it throws, the version stays a draft (no DB writes happen below).
      const mergedDefs = getMergedDefaults(defaults, overrides)
      const isPPP = isPPPAvailabilityPayment(project, assumptions)
      const output = isPPP ? runPPPEngine(assumptions) : runEngine(assumptions, mergedDefs)

      // ── Engine succeeded — flip the version to approved ──
      const newLabel = version.label ? version.label.replace('Draft', 'Approved') : version.label
      const { error } = await supabase.from('versions').update({
        status: 'approved', approved_at: new Date().toISOString(), label: newLabel,
      }).eq('version_id', version.version_id)
      if (error) throw error

      // ── Persist engine output to model_outputs so the Results tab can render it ──
      const { data: { user } } = await supabase.auth.getUser()
      const { data: userData } = await supabase.from('users')
        .select('tenant_id').eq('user_id', user.id).single()
      const { error: insertError } = await supabase.from('model_outputs').insert({
        version_id: version.version_id, project_id: projectId,
        tenant_id: userData.tenant_id,
        irr: output.irr, npv: output.npv, equity_multiple: output.equity_multiple,
        dscr_series: output.dscr_series, cash_flows: output.cash_flows,
        created_by: user.id,
      })
      if (insertError) throw insertError

      const approvedVersion = { ...version, status: 'approved', approved_at: new Date().toISOString(), label: newLabel }
      setVersion(approvedVersion)
      await refreshApprovalState(version.scenario_id)
      setTab('Results')
    } catch (err) { alert('Error: ' + err.message) }
    finally { setApproving(false) }
  }

  function generatePDF() {
    setExporting(true)
    try {
      // ── Guard: must have dev engine results ──
      if (!version || !version.dev_engine_results) {
        alert('No results found.\n\nOpen the Development Cash Flow tab and click "Run Engine" first.')
        setExporting(false)
        return
      }

      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
      const pw  = doc.internal.pageSize.getWidth()
      const ph  = doc.internal.pageSize.getHeight()
      const ML  = 16, MR = pw - 16, TW = MR - ML
      const RH  = 9,  HH = 8,  BL = 5.8
      let y = 0, pageNum = 1

      // ── Single source of truth ──
      var source   = version.dev_engine_results
      var sm       = source.summary  || {}
      var schedule = source.schedule || []

      // ── ASCII-safe ──
      function safe(s) {
        return String(s == null ? '' : s)
          .replace(/[\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'")
          .replace(/[\u201c\u201d]/g, '"').replace(/\u00d7/g, 'x')
          .replace(/[^\x00-\xFF]/g, '?')
      }

      // ── Formatters ──
      function fmtN(n, dec) {
        if (n == null || isNaN(Number(n))) return 'N/A'
        return Number(n).toLocaleString('en-US', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 })
      }
      function fmtPct(v) {
        if (v == null) return 'N/A'
        var n = parseFloat(v)
        return isNaN(n) ? safe(String(v)) : n.toFixed(2) + '%'
      }
      function fmtJOD(n) { return n != null && !isNaN(Number(n)) ? fmtN(n) + ' JOD' : 'N/A' }

      // ── Pre-compute key values from source.summary ──
      var levIRR   = sm.leveragedIRR   ? parseFloat(sm.leveragedIRR)   : null   // raw number
      var unlevIRR = sm.unleveragedIRR ? parseFloat(sm.unleveragedIRR) : null
      var npvVal   = sm.projectNPV     != null ? Number(sm.projectNPV)  : null
      var devProfit      = sm.developmentProfit      != null ? Number(sm.developmentProfit)      : null
      var totalDevCost   = sm.totalDevelopmentCost   != null ? Number(sm.totalDevelopmentCost)   : null
      var totalGDV       = sm.totalGDV               != null ? Number(sm.totalGDV)               : null
      var equityDeployed = sm.totalEquityDeployed    != null ? Number(sm.totalEquityDeployed)     : null
      var loanDrawn      = sm.totalLoanDrawn         != null ? Number(sm.totalLoanDrawn)          : null
      var ltvVal         = sm.ltv                    != null ? Number(sm.ltv)                    : null

      // ── Total sales inflow from schedule ──
      var totalSalesInflow = schedule.reduce(function(s, r) { return s + (r.salesInflow || 0) }, 0)
      var totalHardCost    = schedule.reduce(function(s, r) { return s + (r.hardCostDraw || 0) }, 0)
      var totalSoftCost    = schedule.reduce(function(s, r) { return s + (r.softCostDraw || 0) }, 0)
      var totalCostFromSch = totalHardCost + totalSoftCost

      // ── Peak Funding Gap (cumulative net CF minimum) ──
      var cumCF = 0, peakGap = 0, peakGapMonth = 0
      schedule.forEach(function(row) {
        var net = (row.salesInflow || 0) - ((row.hardCostDraw || 0) + (row.softCostDraw || 0))
        cumCF += net
        if (cumCF < peakGap) { peakGap = cumCF; peakGapMonth = row.month }
      })
      var hasFundingGap = peakGap < 0
      var peakFundingGap = Math.abs(peakGap)

      // ── Investment verdict ──
      var verdictLabel, verdictSub, verdictColor, verdictBg
      if (levIRR !== null && levIRR >= 15 && npvVal !== null && npvVal >= 0) {
        verdictLabel = 'PROCEED';        verdictSub = 'Strong Investment Case'
        verdictColor = [21, 128, 61];    verdictBg = [220, 252, 231]
      } else if (levIRR !== null && levIRR >= 10) {
        verdictLabel = 'REVIEW';         verdictSub = 'Acceptable Investment Case'
        verdictColor = [146, 90, 0];     verdictBg = [254, 243, 199]
      } else {
        verdictLabel = 'DO NOT PROCEED'; verdictSub = 'Weak Investment Case'
        verdictColor = [185, 28, 28];    verdictBg = [254, 226, 226]
      }

      // ── Meta ──
      var reportDate   = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      var versionLabel = version ? safe(version.label || 'Draft') : 'Draft'

      // ── Page helpers ──
      function newPage()  { doc.addPage(); pageNum++; y = 22 }
      function guard(n)   { if (y + n > ph - 22) newPage() }
      // ensureSpace: semantic alias of guard — call before any dynamic block
      function ensureSpace(h) { guard(h) }
      function gap(n)     { y += (n === undefined ? 8 : n) }

      function pageHeader(p) {
        doc.setPage(p)
        doc.setFillColor(15, 23, 42); doc.rect(0, 0, pw, 10, 'F')
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(255, 255, 255)
        doc.text('XCEPTA', ML, 7)
        doc.setFont('helvetica', 'normal'); doc.setTextColor(100, 116, 139)
        doc.text(safe(project.name) + '  |  ' + versionLabel, MR, 7, { align: 'right' })
      }
      function pageFooter(p, total) {
        doc.setPage(p)
        doc.setFillColor(255, 255, 255); doc.rect(0, ph - 14, pw, 14, 'F')
        doc.setDrawColor(210, 215, 225); doc.setLineWidth(0.2); doc.line(ML, ph - 12, MR, ph - 12)
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(150, 160, 175)
        doc.text('XCEPTA  |  Confidential', ML, ph - 7)
        doc.text(versionLabel + '   |   ' + reportDate, pw / 2, ph - 7, { align: 'center' })
        doc.text('Page ' + p + ' of ' + total, MR, ph - 7, { align: 'right' })
      }
      function secHead(title) {
        guard(22); gap(10)
        doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(31, 111, 235)
        doc.text(safe(title), ML, y); y += 3
        doc.setDrawColor(31, 111, 235); doc.setLineWidth(0.6); doc.line(ML, y, ML + 22, y)
        doc.setDrawColor(220, 225, 235); doc.setLineWidth(0.2); doc.line(ML + 22, y, MR, y)
        y += 6
      }
      function tHead(cols) {
        guard(HH + RH + 4)
        doc.setFillColor(244, 246, 250); doc.rect(ML, y, TW, HH, 'F')
        doc.setDrawColor(205, 210, 220); doc.setLineWidth(0.2); doc.line(ML, y + HH, MR, y + HH)
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(90, 95, 110)
        var x = ML
        cols.forEach(function(c) {
          doc.text(safe(c.label), c.align === 'right' ? x + c.w - 2 : x + 3, y + BL - 0.5, { align: c.align || 'left' })
          x += c.w
        })
        y += HH
      }
      function tRow(cols, vals, opts) {
        opts = opts || {}
        guard(RH + 4)
        if (opts.shade) { doc.setFillColor(249, 250, 253); doc.rect(ML, y, TW, RH, 'F') }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
        var clr = opts.color || [30, 33, 43]; doc.setTextColor(clr[0], clr[1], clr[2])
        var x = ML
        cols.forEach(function(c, i) {
          if (opts.rightCol !== undefined && opts.rightCol === i) { x += c.w; return }
          var val = safe(vals[i])
          if (doc.getTextWidth(val) > c.w - 4) { while (val.length > 1 && doc.getTextWidth(val + '..') > c.w - 4) val = val.slice(0, -1); val += '..' }
          doc.text(val, c.align === 'right' ? x + c.w - 2 : x + 3, y + BL, { align: c.align || 'left' })
          x += c.w
        })
        if (opts.rightCol !== undefined && opts.rightText) {
          var rc = cols[opts.rightCol]; var rx = ML; for (var ri = 0; ri < opts.rightCol; ri++) rx += cols[ri].w
          doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5)
          doc.setTextColor(opts.rightColor[0], opts.rightColor[1], opts.rightColor[2])
          doc.text(safe(opts.rightText), rx + rc.w - 2, y + BL, { align: 'right' })
        }
        y += RH
        doc.setDrawColor(230, 233, 240); doc.setLineWidth(0.15); doc.line(ML, y, MR, y); doc.setLineWidth(0.2)
      }

      // ══════════════════════════════════════════════════════════════════
      //  PAGE 1 — COVER
      // ══════════════════════════════════════════════════════════════════
      doc.setFillColor(15, 23, 42); doc.rect(0, 0, pw, ph, 'F')
      doc.setFillColor(31, 111, 235); doc.rect(0, 0, pw, 3, 'F')

      // XCEPTA logo mark
      var lx = ML, ly = 14
      var ic = { cx: lx + 14, cy: ly + 8, r: 11 }
      doc.setDrawColor(232, 239, 246); doc.setLineWidth(0.6)
      doc.circle(ic.cx, ic.cy, ic.r, 'S')
      doc.setLineWidth(2); doc.setDrawColor(232, 239, 246)
      doc.line(ic.cx - 5, ic.cy - 5, ic.cx + 5, ic.cy + 5)
      doc.line(ic.cx - 5, ic.cy + 5, ic.cx, ic.cy)
      doc.setDrawColor(61, 184, 150)
      doc.line(ic.cx, ic.cy, ic.cx + 5, ic.cy - 5)
      doc.setLineWidth(0.2)
      doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(232, 239, 246)
      doc.text('XCEPTA', lx + 30, ly + 10)
      doc.setFont('helvetica', 'normal'); doc.setFontSize(5.5); doc.setTextColor(122, 139, 154)
      doc.text('VALUATIONS  FP&A  BOARDS', lx + 30, ly + 15.5)
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(71, 85, 105)
      doc.text('CONFIDENTIAL', MR, 22, { align: 'right' })

      // Report type badge
      doc.setFillColor(31, 111, 235); doc.rect(ML, 35, 75, 7, 'F')
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(255, 255, 255)
      doc.text('INVESTMENT FEASIBILITY REPORT', ML + 4, 40.5)

      // Project name
      doc.setFont('helvetica', 'bold'); doc.setFontSize(26); doc.setTextColor(248, 250, 252)
      doc.text(safe(project.name), ML, 62)

      // Project meta line
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(148, 163, 184)
      var coverMeta = [
        project.sector || safe(project.project_type),
        safe(project.country),
        safe(project.currency),
        safe(project.delivery_model),
      ].filter(Boolean).join('  |  ')
      doc.text(coverMeta, ML, 71)
      doc.setDrawColor(31, 111, 235); doc.setLineWidth(0.5); doc.line(ML, 77, ML + 60, 77)
      doc.setDrawColor(51, 65, 85); doc.setLineWidth(0.2); doc.line(ML + 60, 77, MR, 77)

      // KPI strip from source.summary
      var coverKPIs = [
        { label: 'Leveraged IRR',     value: levIRR   !== null ? levIRR.toFixed(1) + '%' : '--' },
        { label: 'Unleveraged IRR',   value: unlevIRR !== null ? unlevIRR.toFixed(1) + '%' : '--' },
        { label: 'NPV (JOD)',         value: npvVal   !== null ? fmtN(npvVal) : '--' },
        { label: 'Dev Profit (JOD)',  value: devProfit !== null ? fmtN(devProfit) : '--' },
      ]
      var statW = TW / 4
      coverKPIs.forEach(function(s, i) {
        var sx = ML + i * statW
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(71, 85, 105)
        doc.text(s.label, sx, 88)
        doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(248, 250, 252)
        doc.text(safe(s.value), sx, 98)
      })

      // Verdict box
      doc.setFillColor(verdictBg[0], verdictBg[1], verdictBg[2])
      doc.roundedRect(ML, 108, TW, 26, 2, 2, 'F')
      doc.setDrawColor(verdictColor[0], verdictColor[1], verdictColor[2]); doc.setLineWidth(0.4)
      doc.rect(ML, 108, TW, 26, 'S'); doc.setLineWidth(0.2)
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(100, 110, 125)
      doc.text('INVESTMENT VERDICT', ML + 4, 116)
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(verdictColor[0], verdictColor[1], verdictColor[2])
      doc.text(verdictLabel, ML + 4, 126)
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(100, 110, 125)
      doc.text('INVESTMENT CASE', MR - 4, 116, { align: 'right' })
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(verdictColor[0], verdictColor[1], verdictColor[2])
      doc.text(safe(verdictSub), MR - 4, 126, { align: 'right' })

      // Cover footer
      doc.setFillColor(10, 15, 28); doc.rect(0, ph - 28, pw, 28, 'F')
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(100, 116, 139)
      doc.text('Prepared by: ' + safe(preparedBy || 'XCEPTA'), ML, ph - 17)
      doc.text(versionLabel + '   |   ' + reportDate, pw / 2, ph - 17, { align: 'center' })
      doc.text(safe(project.country) + '  |  ' + safe(project.currency), MR, ph - 17, { align: 'right' })
      doc.setFontSize(7); doc.setTextColor(51, 65, 85)
      doc.text('This document is confidential and intended solely for the named recipients. Not for distribution.', pw / 2, ph - 9, { align: 'center', maxWidth: TW })

      // ══════════════════════════════════════════════════════════════════
      //  PAGE 2 — EXECUTIVE SUMMARY
      // ══════════════════════════════════════════════════════════════════
      doc.addPage(); pageNum++; y = 22

      // ── Section A: Investment Verdict ──
      secHead('Investment Verdict')
      guard(20)
      doc.setFillColor(verdictBg[0], verdictBg[1], verdictBg[2])
      doc.rect(ML, y, TW, 18, 'F')
      doc.setDrawColor(verdictColor[0], verdictColor[1], verdictColor[2]); doc.setLineWidth(0.4)
      doc.rect(ML, y, TW, 18, 'S'); doc.setLineWidth(0.2)
      doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(verdictColor[0], verdictColor[1], verdictColor[2])
      doc.text(verdictLabel, ML + 5, y + 12)
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(verdictColor[0], verdictColor[1], verdictColor[2])
      doc.text(safe(verdictSub), MR - 5, y + 8, { align: 'right' })
      // IRR threshold key
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(100, 110, 125)
      doc.text('IRR >= 15% + NPV >= 0  =  Proceed   |   IRR 10-15%  =  Review   |   IRR < 10%  =  Do Not Proceed', MR - 5, y + 15, { align: 'right' })
      y += 24

      // ── Section B: Key Metrics ──
      secHead('Key Metrics')
      var kmCols = [{ label: 'Metric', w: 100, align: 'left' }, { label: 'Value', w: TW - 100, align: 'right' }]
      tHead(kmCols)

      function irrPassColor(irr) {
        if (irr === null) return [130, 135, 145]
        if (irr >= 15)  return [21, 128, 61]
        if (irr >= 10)  return [146, 90, 0]
        return [185, 28, 28]
      }

      var kmRows = [
        { label: 'Leveraged IRR (Equity)',   value: levIRR   !== null ? levIRR.toFixed(2)   + '%' : 'N/A', color: irrPassColor(levIRR) },
        { label: 'Unleveraged IRR (Project)', value: unlevIRR !== null ? unlevIRR.toFixed(2) + '%' : 'N/A', color: irrPassColor(unlevIRR) },
        { label: 'Project NPV',               value: fmtJOD(npvVal),   color: npvVal !== null && npvVal >= 0 ? [21, 128, 61] : [185, 28, 28] },
        { label: 'Development Profit',        value: fmtJOD(devProfit), color: devProfit !== null && devProfit >= 0 ? [21, 128, 61] : [185, 28, 28] },
        { label: 'Total Development Cost (incl. Land & Financing)', value: fmtJOD(totalDevCost), color: [30, 33, 43] },
        { label: 'Gross Development Value',   value: fmtJOD(totalGDV),     color: [30, 33, 43] },
        { label: 'Peak Equity Requirement',
          value: hasFundingGap ? fmtJOD(peakFundingGap) + ' at Month ' + peakGapMonth : 'None',
          color: hasFundingGap ? [185, 28, 28] : [21, 128, 61] },
      ]
      kmRows.forEach(function(row, idx) {
        guard(RH + 2)
        if (idx % 2 === 0) { doc.setFillColor(249, 250, 253); doc.rect(ML, y, TW, RH, 'F') }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(60, 66, 80)
        doc.text(safe(row.label), ML + 3, y + BL)
        doc.setFont('helvetica', 'bold'); doc.setTextColor(row.color[0], row.color[1], row.color[2])
        doc.text(safe(row.value), MR - 2, y + BL, { align: 'right' })
        y += RH
        doc.setDrawColor(230, 233, 240); doc.setLineWidth(0.15); doc.line(ML, y, MR, y); doc.setLineWidth(0.2)
      })
      gap(6)

      // ── IRR interpretation notes ──
      var noDebt  = (loanDrawn || 0) <= 0
      var highIRR = (levIRR !== null && levIRR > 75) || (unlevIRR !== null && unlevIRR > 75)
      if (noDebt) {
        ensureSpace(8)
        doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor(100, 110, 125)
        doc.text('No debt utilized - leveraged and unleveraged IRR are equivalent in this scenario.', ML + 3, y, { maxWidth: TW })
        y += 7
      }
      if (highIRR) {
        ensureSpace(12)
        doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor(100, 110, 125)
        doc.text('High IRR is driven by pre-sales timing and low peak equity deployment. Profit on Cost and Equity Multiple should also be reviewed.', ML + 3, y, { maxWidth: TW })
        y += 10
      }

      // ── Section C: Cash Flow Summary ──
      ensureSpace(60)
      secHead('Cash Flow Summary')
      var cfCols = [{ label: 'Item', w: 100, align: 'left' }, { label: 'Amount (JOD)', w: TW - 100, align: 'right' }]
      tHead(cfCols)
      var cfSummaryRows = [
        { label: 'Total Sales Inflow',   value: fmtN(totalSalesInflow), color: [21, 128, 61] },
        { label: 'Total Hard Cost Draw', value: fmtN(totalHardCost),    color: [185, 28, 28] },
        { label: 'Total Soft Cost Draw', value: fmtN(totalSoftCost),    color: [185, 28, 28] },
        { label: 'Total Cost Draw',      value: fmtN(totalCostFromSch), color: [185, 28, 28] },
        { label: 'Development Profit (GDV minus TDC)', value: fmtN(devProfit),         color: devProfit !== null && devProfit >= 0 ? [21, 128, 61] : [185, 28, 28] },
      ]
      cfSummaryRows.forEach(function(row, idx) {
        guard(RH + 2)
        if (idx % 2 === 0) { doc.setFillColor(249, 250, 253); doc.rect(ML, y, TW, RH, 'F') }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(60, 66, 80)
        doc.text(safe(row.label), ML + 3, y + BL)
        doc.setFont('helvetica', 'bold'); doc.setTextColor(row.color[0], row.color[1], row.color[2])
        doc.text(safe(row.value), MR - 2, y + BL, { align: 'right' })
        y += RH
        doc.setDrawColor(230, 233, 240); doc.setLineWidth(0.15); doc.line(ML, y, MR, y); doc.setLineWidth(0.2)
      })
      gap(6)

      // ── Section D: Funding Analysis ──
      ensureSpace(85)
      secHead('Funding Analysis')
      var faCols = [{ label: 'Item', w: 100, align: 'left' }, { label: 'Value', w: TW - 100, align: 'right' }]
      tHead(faCols)
      var totalFunding = (equityDeployed || 0) + (loanDrawn || 0)
      var equityPct = totalFunding > 0 ? ((equityDeployed || 0) / totalFunding * 100).toFixed(1) + '%' : 'N/A'
      var debtPct   = totalFunding > 0 ? ((loanDrawn    || 0) / totalFunding * 100).toFixed(1) + '%' : 'N/A'
      var faRows = [
        { label: 'Peak Equity Requirement',  value: hasFundingGap ? fmtJOD(peakFundingGap) : 'None (positive CF throughout)',  color: hasFundingGap ? [185, 28, 28] : [21, 128, 61] },
        { label: 'Month of Peak Equity Requirement', value: hasFundingGap ? 'Month ' + peakGapMonth : '--',  color: [30, 33, 43] },
        { label: 'Equity Deployed',          value: fmtJOD(equityDeployed),  color: [30, 33, 43] },
        { label: 'Loan Drawn',               value: fmtJOD(loanDrawn),       color: [30, 33, 43] },
        { label: 'Equity %',                 value: equityPct,                color: [30, 33, 43] },
        { label: 'Debt %',                   value: debtPct,                  color: [30, 33, 43] },
        { label: 'Loan-to-Value (LTV)',      value: ltvVal !== null ? (ltvVal * 100).toFixed(1) + '%' : 'N/A', color: [30, 33, 43] },
      ]
      faRows.forEach(function(row, idx) {
        guard(RH + 2)
        if (idx % 2 === 0) { doc.setFillColor(249, 250, 253); doc.rect(ML, y, TW, RH, 'F') }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(60, 66, 80)
        doc.text(safe(row.label), ML + 3, y + BL)
        doc.setFont('helvetica', 'bold'); doc.setTextColor(row.color[0], row.color[1], row.color[2])
        doc.text(safe(row.value), MR - 2, y + BL, { align: 'right' })
        y += RH
        doc.setDrawColor(230, 233, 240); doc.setLineWidth(0.15); doc.line(ML, y, MR, y); doc.setLineWidth(0.2)
      })

      // ══════════════════════════════════════════════════════════════════
      //  PAGE 3 — MONTHLY CASH FLOW SCHEDULE
      // ══════════════════════════════════════════════════════════════════
      if (schedule.length > 0) {
        doc.addPage(); pageNum++; y = 22
        secHead('Monthly Cash Flow Schedule')

        var schCols = [
          { label: 'Mo',          w: 14, align: 'left'  },
          { label: 'Hard Cost',   w: 30, align: 'right' },
          { label: 'Soft Cost',   w: 28, align: 'right' },
          { label: 'Sales',       w: 30, align: 'right' },
          { label: 'Eq. Draw',    w: 27, align: 'right' },
          { label: 'Loan Draw',   w: 25, align: 'right' },
          { label: 'Net CF',      w: 25, align: 'right' },
        ]
        tHead(schCols)

        // Every 3rd month + exit month(s)
        var printRows = schedule.filter(function(r, i) {
          return i % 3 === 0 || (r.exitProceeds && r.exitProceeds > 0)
        })
        printRows.forEach(function(row, idx) {
          var net_cf = (row.salesInflow || 0) - ((row.hardCostDraw || 0) + (row.softCostDraw || 0))
          var cfColor = net_cf >= 0 ? [21, 128, 61] : [185, 28, 28]
          tRow(schCols, [
            'M' + row.month + (row.exitProceeds > 0 ? '*' : ''),
            row.hardCostDraw  > 0 ? fmtN(row.hardCostDraw)  : '-',
            row.softCostDraw  > 0 ? fmtN(row.softCostDraw)  : '-',
            row.salesInflow   > 0 ? fmtN(row.salesInflow)   : '-',
            row.equityDraw    > 0 ? fmtN(row.equityDraw)    : '-',
            row.loanDraw      > 0 ? fmtN(row.loanDraw)      : '-',
            net_cf !== 0 ? fmtN(net_cf) : '-',
          ], { shade: idx % 2 === 1, color: net_cf < 0 ? cfColor : [30, 33, 43] })
        })

        // Footnote
        gap(4)
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(130, 135, 145)
        doc.text('* Exit month   |   Every 3rd month shown   |   All values in JOD', ML, y)
        y += 6

        // KPI strip footnote
        gap(3)
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(100, 110, 125)
        var summaryLine = 'Development Cash Flow Summary  —  '
          + 'Leveraged IRR: ' + (sm.leveragedIRR || 'N/A')
          + '  |  Unleveraged IRR: ' + (sm.unleveragedIRR || 'N/A')
          + '  |  Dev Profit: ' + fmtJOD(devProfit)
          + '  |  Total Dev Cost: ' + fmtJOD(totalDevCost)
        doc.text(safe(summaryLine), ML, y, { maxWidth: TW })
        y += 9
      }

      // ══════════════════════════════════════════════════════════════════
      //  PAGE 4 — FINANCIALS (Financial Summary / Sources & Uses / Waterfall)
      //  ALL values computed from source.schedule only — no recalculation
      // ══════════════════════════════════════════════════════════════════
      var totalCosts  = schedule.reduce(function(a, r) { return a + ((r.hardCostDraw || 0) + (r.softCostDraw || 0)) }, 0)
      var totalSales  = schedule.reduce(function(a, r) { return a + (r.salesInflow  || 0) }, 0)
      var netProfit   = totalSales - totalCosts
      var totalEquity = schedule.reduce(function(a, r) { return a + (r.equityDraw   || 0) }, 0)
      var totalDebt   = schedule.reduce(function(a, r) { return a + (r.loanDraw     || 0) }, 0)
      var finalDebt   = schedule.length ? (schedule[schedule.length - 1].loanBalance || 0) : 0
      var equityReturn = totalSales - totalCosts - finalDebt

      doc.addPage(); pageNum++; y = 22

      // ─── helper: two-column label / value row ───────────────────────
      function finRow(label, value, opts) {
        opts = opts || {}
        guard(10)
        var clr = opts.color || [30, 33, 43]
        if (opts.shade) { doc.setFillColor(249, 250, 253); doc.rect(ML, y, TW, 9, 'F') }
        if (opts.bold)  { doc.setFont('helvetica', 'bold') }
        else            { doc.setFont('helvetica', 'normal') }
        doc.setFontSize(8.5); doc.setTextColor(clr[0], clr[1], clr[2])
        doc.text(safe(label), ML + 3, y + 6.2)
        doc.setFont('helvetica', 'bold')
        doc.text(safe(value), MR - 3, y + 6.2, { align: 'right' })
        y += 9
        doc.setDrawColor(230, 233, 240); doc.setLineWidth(0.15); doc.line(ML, y, MR, y); doc.setLineWidth(0.2)
      }

      // ─── helper: sub-label (indented, lighter) ───────────────────────
      function finSub(label, value, opts) {
        opts = opts || {}
        guard(9)
        var clr = opts.color || [80, 90, 110]
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(clr[0], clr[1], clr[2])
        doc.text(safe(label), ML + 8, y + 6)
        doc.setFont('helvetica', 'bold'); doc.setTextColor(clr[0], clr[1], clr[2])
        doc.text(safe(value), MR - 3, y + 6, { align: 'right' })
        y += 9
        doc.setDrawColor(238, 240, 245); doc.setLineWidth(0.1); doc.line(ML + 6, y, MR, y); doc.setLineWidth(0.2)
      }

      // ─── helper: divider line ────────────────────────────────────────
      function finDiv() {
        guard(4)
        doc.setDrawColor(180, 188, 205); doc.setLineWidth(0.4); doc.line(ML, y + 1, MR, y + 1); doc.setLineWidth(0.2)
        y += 5
      }

      // ══ A. FINANCIAL SUMMARY ══════════════════════════════════════════
      secHead('Financial Summary')

      finRow('Total Cost Draw (Hard + Soft Costs)', fmtJOD(totalCosts),  { shade: false })
      finRow('Total Sales Inflow',       fmtJOD(totalSales),  { shade: true,  color: [21, 128, 61] })
      finDiv()
      finRow('Gross Margin (Sales minus Cost Draw)', fmtJOD(netProfit),
        { bold: true, color: netProfit >= 0 ? [21, 128, 61] : [185, 28, 28] })

      gap(6)

      // Profit margin annotation
      var marginPct = totalSales > 0 ? (netProfit / totalSales * 100).toFixed(1) + '%' : 'N/A'
      var marginOnCost = totalCosts > 0 ? (netProfit / totalCosts * 100).toFixed(1) + '%' : 'N/A'
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(100, 110, 125)
      doc.text('Profit on Sales: ' + marginPct + '   |   Profit on Cost: ' + marginOnCost, ML + 3, y)
      y += 10

      // ══ B. SOURCES & USES ════════════════════════════════════════════
      ensureSpace(95)
      secHead('Sources & Uses')

      // Sources
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(90, 96, 112)
      doc.text('SOURCES', ML + 3, y); y += 7
      finSub('Equity',                fmtJOD(totalEquity))
      finSub('Debt',                  fmtJOD(totalDebt))
      finDiv()
      finRow('Total Sources',         fmtJOD(totalEquity + totalDebt), { bold: true })

      gap(4)

      // Uses
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(90, 96, 112)
      doc.text('USES', ML + 3, y); y += 7
      finSub('Hard Cost',             fmtJOD(totalHardCost))
      finSub('Soft Cost',             fmtJOD(totalSoftCost))
      finDiv()
      finRow('Total Project Cost',    fmtJOD(totalCosts), { bold: true })

      gap(6)

      // Sources & Uses scope note
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(100, 110, 125)
      doc.text(
        'Pre-sales may fund part of construction. Sources shown represent peak external capital requirement, not total project uses.',
        ML + 3, y, { maxWidth: TW }
      )
      y += 11

      // ══ C. INVESTMENT WATERFALL ══════════════════════════════════════
      ensureSpace(80)
      secHead('Investment Waterfall')

      // Debt Repayment = loan principal retired during the project (drawn minus residual).
      // Guarded to >= 0 defensively; the engine should never produce finalDebt > totalDebt.
      var debtRepaid = Math.max(0, totalDebt - finalDebt)
      var waterfallRows = [
        { label: '1.  Equity Invested',   value: fmtJOD(totalEquity),                        color: [30,  90, 185], shade: false },
        { label: '2.  Debt Drawn',         value: fmtJOD(totalDebt),                          color: [80,  90, 110], shade: true  },
        { label: '3.  Construction Cost (Hard + Soft)', value: fmtJOD(totalCosts),                color: [185, 28,  28], shade: false },
        { label: '4.  Total Sales',        value: fmtJOD(totalSales),                         color: [21, 128,  61], shade: true  },
        { label: '5.  Debt Repayment',     value: fmtJOD(debtRepaid),                         color: [80,  90, 110], shade: false },
        { label: '6.  Net Development Profit', value: fmtJOD(devProfit),
          color: devProfit !== null && devProfit >= 0 ? [21, 128, 61] : [185, 28, 28],                               shade: true  },
      ]

      waterfallRows.forEach(function(row) {
        guard(10)
        if (row.shade) { doc.setFillColor(249, 250, 253); doc.rect(ML, y, TW, 9, 'F') }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(50, 58, 72)
        doc.text(safe(row.label), ML + 3, y + 6.2)
        doc.setFont('helvetica', 'bold'); doc.setTextColor(row.color[0], row.color[1], row.color[2])
        doc.text(safe(row.value), MR - 3, y + 6.2, { align: 'right' })
        y += 9
        doc.setDrawColor(230, 233, 240); doc.setLineWidth(0.15); doc.line(ML, y, MR, y); doc.setLineWidth(0.2)
      })

      // Equity multiple annotation
      finDiv()
      var eqMultiple = totalEquity > 0 ? (equityReturn / totalEquity).toFixed(2) + 'x' : 'N/A'
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(100, 110, 125)
      doc.text('Equity Multiple (Return / Invested): ' + eqMultiple, ML + 3, y)
      y += 9

      // ══════════════════════════════════════════════════════════════════
      //  PAGE 5 — SENSITIVITY ANALYSIS
      //  Reads source.sensitivityMatrix stored at run time — no recalculation
      // ══════════════════════════════════════════════════════════════════
      var sensMatrix = source.sensitivityMatrix
      if (sensMatrix && Array.isArray(sensMatrix) && sensMatrix.length === 3) {
        doc.addPage(); pageNum++; y = 22
        secHead('IRR Sensitivity Analysis')

        // Description
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(100, 110, 125)
        doc.text(
          'Leveraged IRR across +/- 5% adjustments to Sales Price (columns) and Construction Cost (rows). ' +
          'Values computed at engine run time and stored as part of this version.',
          ML, y, { maxWidth: TW }
        )
        y += 12

        // Column headers
        var PRICE_LABELS = ['-5% Price', 'Base Price', '+5% Price']
        var COST_LABELS  = ['-5% Cost',  'Base Cost',  '+5% Cost' ]
        var colW  = (TW - 36) / 3   // three data columns
        var rowH  = 11
        var labelW = 36

        // Header row
        guard(rowH + 4)
        doc.setFillColor(244, 246, 250); doc.rect(ML, y, TW, rowH, 'F')
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(90, 95, 110)
        doc.text('Cost \ Price', ML + 3, y + 7.5)
        PRICE_LABELS.forEach(function(label, ci) {
          var cx = ML + labelW + ci * colW + colW / 2
          doc.text(safe(label), cx, y + 7.5, { align: 'center' })
        })
        y += rowH

        // Data rows
        sensMatrix.forEach(function(row, ri) {
          guard(rowH + 2)
          // Row label
          doc.setFillColor(244, 246, 250); doc.rect(ML, y, labelW, rowH, 'F')
          doc.setDrawColor(210, 215, 225); doc.setLineWidth(0.15)
          doc.rect(ML, y, labelW, rowH, 'S')
          doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(60, 66, 80)
          doc.text(safe(COST_LABELS[ri]), ML + 3, y + 7.5)

          // Data cells
          row.forEach(function(cell, ci) {
            var isBase = ri === 1 && ci === 1
            var irrRaw = cell && cell.irr !== null ? parseFloat(cell.irr) : null
            var irrStr = irrRaw !== null ? irrRaw.toFixed(1) + '%' : 'N/A'

            // Cell background
            var cellBg, textRgb
            if (isBase)           { cellBg = [235, 243, 255]; textRgb = [31, 111, 235] }
            else if (irrRaw === null) { cellBg = [245, 246, 248]; textRgb = [150, 155, 165] }
            else if (irrRaw >= 15)    { cellBg = [220, 252, 231]; textRgb = [21, 128, 61]  }
            else if (irrRaw >= 10)    { cellBg = [254, 243, 199]; textRgb = [146, 90, 0]   }
            else                      { cellBg = [254, 226, 226]; textRgb = [185, 28, 28]  }

            var cx = ML + labelW + ci * colW
            doc.setFillColor(cellBg[0], cellBg[1], cellBg[2])
            doc.rect(cx, y, colW, rowH, 'F')
            doc.setDrawColor(210, 215, 225); doc.setLineWidth(isBase ? 0.4 : 0.15)
            if (isBase) doc.setDrawColor(31, 111, 235)
            doc.rect(cx, y, colW, rowH, 'S')
            doc.setLineWidth(0.15); doc.setDrawColor(210, 215, 225)

            doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5)
            doc.setTextColor(textRgb[0], textRgb[1], textRgb[2])
            doc.text(safe(irrStr), cx + colW / 2, y + 7.5, { align: 'center' })
          })
          y += rowH
        })

        // Legend
        gap(6)
        var legends = [
          { label: 'Strong (IRR >= 15%)', r: 220, g: 252, b: 231, tr: 21,  tg: 128, tb: 61  },
          { label: 'Review (10-15%)',     r: 254, g: 243, b: 199, tr: 146, tg: 90,  tb: 0   },
          { label: 'Weak (< 10%)',        r: 254, g: 226, b: 226, tr: 185, tg: 28,  tb: 28  },
          { label: 'Base Case',           r: 235, g: 243, b: 255, tr: 31,  tg: 111, tb: 235 },
        ]
        var legX = ML
        legends.forEach(function(l) {
          doc.setFillColor(l.r, l.g, l.b); doc.rect(legX, y, 8, 5, 'F')
          doc.setDrawColor(l.tr, l.tg, l.tb); doc.setLineWidth(0.3); doc.rect(legX, y, 8, 5, 'S'); doc.setLineWidth(0.2)
          doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(80, 88, 105)
          doc.text(safe(l.label), legX + 10, y + 4)
          legX += 46
        })
        y += 10

        // Note
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(130, 135, 145)
        doc.text('Values computed at engine run time from stored inputs. Export reads stored matrix — no recalculation.', ML, y, { maxWidth: TW })
        y += 8

        // Base values footer
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(90, 95, 110)
        doc.text('Base case:', ML, y)
        doc.setFont('helvetica', 'normal'); doc.setTextColor(100, 110, 125)
        doc.text(
          'GDV ' + fmtJOD(totalGDV) +
          '   |   Hard Cost ' + fmtJOD(totalHardCost) +
          '   |   Soft Cost ' + fmtJOD(totalSoftCost),
          ML + 18, y
        )
        y += 6
      } else {
        // Matrix not available — note in PDF without crashing
        gap(6)
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(185, 28, 28)
        doc.text('Sensitivity matrix not available. Re-run Development Cash Flow to generate it.', ML, y)
        y += 10
      }

      // ── Post-process: headers + footers on all report pages (skip cover = page 1) ──
      var totalPages = doc.internal.getNumberOfPages()
      for (var p = 2; p <= totalPages; p++) {
        pageHeader(p)
        pageFooter(p, totalPages)
      }

      doc.save(safe(project.name).replace(/\s+/g, '_') + '_BoardPack_' + new Date().toISOString().slice(0, 10) + '.pdf')

    } catch (err) {
      console.error('PDF generation failed:', err)
      alert('PDF generation failed: ' + err.message)
    } finally {
      setExporting(false)
    }
  }

  if (loading) return <p style={{color:colors.textSecondary,padding:'2rem'}}>Loading...</p>
  if (!project) return <p style={{color:colors.danger,padding:'2rem'}}>Project not found.</p>

  // ── Project-type branch — drives engine selection and all conditional UI ──
  const pppAP = isPPPAvailabilityPayment(project, assumptions)

  // ── Target DSCR — user-defined or default 1.20 ──
  const targetDSCR = pppAP ? (pppVal(assumptions, 'Target DSCR') || 1.20) : null

  // ── PPP bankability — uses user-defined target DSCR as floor ──
  const pppBankability = pppAP ? computePPPBankability(modelOutput || latestApprovedOutput, targetDSCR) : null

  // ── Required payment solver ──
  const requiredPaymentResult = pppAP && assumptions.length
    ? computeRequiredPayment(assumptions, targetDSCR)
    : null

  // Stale output: detect stored DSCR values from old engine runs (threshold was 0.01, not 1)
  // These produce absurd ratios (100M+). Flag so user knows to re-approve.
  const hasStalePPPOutput = pppAP && modelOutput && (modelOutput.dscr_series || []).some(
    d => d.dscr !== null && d.dscr > 1000
  )

  const isApproved = version && version.status === 'approved'
  const cfRows = modelOutput && modelOutput.cash_flows
    ? (showFullCF ? modelOutput.cash_flows : modelOutput.cash_flows.slice(0, 6)) : []
  const mergedDefaults = getMergedDefaults(defaults, overrides)

  // ── Derived KPIs computed from stored model output (no re-approval needed) ──
  let extraKPIs = null
  if (modelOutput && modelOutput.cash_flows) {
    // Equity invested = construction-phase outflows only (not operations shortfalls)
    const equityInvested = Math.abs(
      modelOutput.cash_flows
        .filter(r => r.phase === 'Construction' && Number(r.equity_cf) < 0)
        .reduce((sum, r) => sum + Number(r.equity_cf), 0)
    )

    // Fix 2: payback = first year cumulative equity CF turns non-negative
    let cumCF = 0, paybackYear = null
    for (let i = 0; i < modelOutput.cash_flows.length; i++) {
      cumCF += Number(modelOutput.cash_flows[i].equity_cf) || 0
      if (cumCF >= 0 && paybackYear === null) {
        paybackYear = modelOutput.cash_flows[i].year
        break
      }
    }

    const totalRevenue = modelOutput.cash_flows.reduce((s, r) => s + (Number(r.revenue) || 0), 0)
    const totalCost    = modelOutput.cash_flows.reduce((s, r) => s + (Number(r.opex) || 0) + (Number(r.capex) || 0), 0)

    // Fix 3&4: exclude null DSCR from min and breach detection
    const dscrVals   = (modelOutput.dscr_series || []).filter(d => d.dscr !== null)
    const minDSCR    = dscrVals.length > 0 ? Math.min(...dscrVals.map(d => d.dscr)) : null
    const dscrFloor  = pppAP ? PPP_DSCR_FLOOR : 1.0
    const breachEntry = dscrVals.find(d => d.dscr < dscrFloor)

    extraKPIs = {
      paybackYear,
      totalRevenue: Math.round(totalRevenue),
      totalCost:    Math.round(totalCost),
      equityInvested: equityInvested > 0 ? Math.round(equityInvested) : null,
      minDSCR,
      dscrBreachYear: breachEntry ? breachEntry.year : null,
    }
  }

  const irrPass = pppAP
    ? (modelOutput !== null && modelOutput !== undefined && Number(modelOutput.irr) >= PPP_IRR_HURDLE)
    : (modelOutput !== null && modelOutput !== undefined && Number(modelOutput.irr) >= IRR_HURDLE)
  const npvPass = modelOutput !== null && modelOutput !== undefined && Number(modelOutput.npv) >= 0
  const dscrPass = pppAP
    ? (extraKPIs !== null && extraKPIs.minDSCR !== null && extraKPIs.minDSCR >= PPP_DSCR_FLOOR)
    : (extraKPIs !== null && extraKPIs.minDSCR !== null && extraKPIs.minDSCR >= 1.0)

  return (
    <div>
      <button onClick={() => navigate('/feasibility')}
        style={{background:'none',border:'none',color:colors.textSecondary,cursor:'pointer',marginBottom:'1.5rem',fontSize:'0.85rem'}}>
        ← Back to Projects
      </button>

      {/* Archived banner */}
      {isArchived && (
        <div style={{background:colors.surfaceElevated,border:`1px solid ${colors.border}`,borderRadius:'8px',
          padding:'0.75rem 1.25rem',marginBottom:'1.5rem',
          display:'flex',justifyContent:'space-between',alignItems:'center',gap:'1rem'}}>
          <p style={{fontSize:'0.82rem',color:colors.textSecondary}}>
            This project is archived and hidden from the active list.
          </p>
          <button onClick={handleRestore} disabled={archiving}
            style={{padding:'0.35rem 0.9rem',background:'none',border:`1px solid ${colors.accent}`,
              color:colors.accent,borderRadius:'5px',cursor:'pointer',fontSize:'0.78rem',
              whiteSpace:'nowrap',opacity:archiving?0.5:1}}>
            {archiving ? '...' : 'Restore Project'}
          </button>
        </div>
      )}

      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:'2rem'}}>
        <div>
          <h1 style={{fontSize:'1.75rem',fontWeight:'600',marginBottom:'0.25rem'}}>{project.name}</h1>
          <p style={{color:colors.textSecondary,fontSize:'0.85rem'}}>
            {project.sector ? `${project.sector} · ${project.revenue_model}` : project.project_type}
            {' · '}{project.country} · {project.currency} · {project.delivery_model}
          </p>
        </div>
        <div style={{textAlign:'right'}}>
          <span style={{fontSize:'0.75rem',padding:'3px 10px',borderRadius:'20px',
            background:isApproved?colors.successSoft:colors.accentBgSubtle,color:isApproved?colors.success:colors.accent,
            border:isApproved?`1px solid ${colors.success}`:`1px solid ${colors.accent}`}}>
            {version ? version.status : 'draft'}
          </span>
          <p style={{fontSize:'0.75rem',color:colors.textMuted,marginTop:'0.4rem'}}>{version ? version.label : ''}</p>
          {isApproved && version.approved_at && (
            <p style={{fontSize:'0.7rem',color:colors.textMuted,marginTop:'0.2rem'}}>
              Approved {new Date(version.approved_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}
            </p>
          )}
          {!isArchived && (
            <button onClick={handleArchive} disabled={archiving}
              style={{marginTop:'0.6rem',padding:'0.3rem 0.8rem',background:'none',
                border:`1px solid ${colors.border}`,borderRadius:'5px',color:colors.textMuted,
                cursor:'pointer',fontSize:'0.72rem',opacity:archiving?0.5:1}}>
              {archiving ? '...' : 'Archive Project'}
            </button>
          )}
        </div>
      </div>

      <div style={{display:'flex',gap:'0',borderBottom:`1px solid ${colors.border}`,marginBottom:'2rem'}}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{padding:'0.6rem 1.25rem',background:'none',border:'none',
              borderBottom:tab===t?`2px solid ${colors.accent}`:'2px solid transparent',
              color:tab===t?colors.accent:colors.textSecondary,cursor:'pointer',fontSize:'0.9rem'}}>
            {t}
          </button>
        ))}
      </div>

      {/* ══════════════════ ASSUMPTIONS TAB ══════════════════ */}
      {tab === 'Assumptions' && (
        <div>
          {isApproved && assumptionsModified && (
            <div style={{background:colors.warningSoft,border:`1px solid ${colors.warning}`,borderRadius:'8px',
              padding:'1rem 1.5rem',marginBottom:'1.5rem',display:'flex',
              justifyContent:'space-between',alignItems:'center',gap:'1rem',flexWrap:'wrap'}}>
              <div>
                <p style={{fontSize:'0.875rem',color:colors.warning,fontWeight:'500',marginBottom:'0.2rem'}}>Inputs updated</p>
                <p style={{fontSize:'0.8rem',color:colors.textSecondary}}>Create a new draft version to re-run the model with these inputs.</p>
              </div>
              <button onClick={handleCreateDraft} disabled={creatingDraft}
                style={{padding:'0.45rem 1.1rem',background:colors.warning,color:colors.surfaceMuted,border:'none',
                  borderRadius:'6px',cursor:creatingDraft?'not-allowed':'pointer',
                  fontSize:'0.8rem',fontWeight:'600',whiteSpace:'nowrap',opacity:creatingDraft?0.6:1}}>
                {creatingDraft ? 'Creating...' : 'Create New Draft'}
              </button>
            </div>
          )}
          {isApproved && !assumptionsModified && (
            <div style={{background:colors.surfaceElevated,border:`1px solid ${colors.border}`,borderRadius:'8px',
              padding:'0.75rem 1.25rem',marginBottom:'1.5rem',
              display:'flex',justifyContent:'space-between',alignItems:'center',gap:'1rem'}}>
              <p style={{fontSize:'0.8rem',color:colors.textMuted}}>
                This version is approved. Edit any value below, then create a new draft to re-run the model.
              </p>
              <button onClick={handleCreateDraft} disabled={creatingDraft}
                style={{padding:'0.4rem 1rem',background:'none',border:`1px solid ${colors.border}`,color:colors.textSecondary,
                  borderRadius:'6px',cursor:creatingDraft?'not-allowed':'pointer',fontSize:'0.78rem',whiteSpace:'nowrap'}}>
                {creatingDraft ? 'Creating...' : '+ New Draft Version'}
              </button>
            </div>
          )}

          {/* ── Grouped user inputs ── */}
          {(pppAP ? PPP_ASSUMPTION_GROUPS : ASSUMPTION_GROUPS).map(group => {
            const groupAssumptions = assumptions.filter(a => a.category === group.key)
            if (!groupAssumptions.length) return null
            return (
              <div key={group.key} style={{marginBottom:'2rem'}}>
                <h3 style={{fontSize:'0.8rem',color:colors.textSecondary,marginBottom:'0.75rem',
                  textTransform:'uppercase',letterSpacing:'0.05em'}}>{group.label}</h3>
                <div style={{background:colors.surfaceElevated,border:`1px solid ${colors.border}`,borderRadius:'8px',overflow:'hidden'}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.875rem',tableLayout:'fixed'}}>
                    <thead><tr style={{borderBottom:`1px solid ${colors.border}`}}>
                      {[
                        {label:'Assumption',width:'35%'},
                        {label:'Value',     width:'25%'},
                        {label:'Unit',      width:'15%'},
                        {label:'Confidence',width:'15%'},
                        {label:'',          width:'10%'},
                      ].map((h,i) => (
                        <th key={i} style={{padding:'0.65rem 1rem',textAlign:'left',color:colors.textSecondary,fontWeight:'500',fontSize:'0.72rem',width:h.width}}>{h.label}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {groupAssumptions.map(a => {
                        const type = editType(a.name)
                        const editable = isEditable(a)
                        const isEditing = editingId === a.assumption_id
                        return (
                          <tr key={a.assumption_id} style={{borderBottom:`1px solid ${colors.border}`,background:isEditing?colors.surfaceMuted:'transparent'}}>
                            <td style={{padding:'0.7rem 1rem',color:colors.textPrimary}}>
                              {pppAP ? (PPP_DISPLAY_LABELS[a.name] || a.name) : a.name}
                            </td>
                            <td style={{padding:'0.7rem 1rem',color:colors.textPrimary}}>
                              {isEditing ? (
                                type === 'dropdown' ? (
                                  <select value={editingValue} onChange={e => setEditingValue(e.target.value)} autoFocus
                                    style={{background:colors.surfaceMuted,border:`1px solid ${colors.accent}`,borderRadius:'4px',color:colors.textPrimary,padding:'0.2rem 0.5rem',fontSize:'0.875rem'}}>
                                    {DROPDOWN_OPTIONS[a.name].map(opt => <option key={opt} value={opt}>{opt}</option>)}
                                  </select>
                                ) : type === 'date' ? (
                                  <input type="date" value={editingValue} onChange={e => setEditingValue(e.target.value)} autoFocus
                                    style={{background:colors.surfaceMuted,border:`1px solid ${colors.accent}`,borderRadius:'4px',color:colors.textPrimary,padding:'0.2rem 0.5rem',fontSize:'0.875rem'}} />
                                ) : (
                                  <input type="number" value={editingValue} onChange={e => setEditingValue(e.target.value)} autoFocus
                                    onKeyDown={e => { if(e.key==='Enter') handleSaveAssumption(a.assumption_id,a.name); if(e.key==='Escape'){setEditingId(null);setEditingValue('')} }}
                                    style={{background:colors.surfaceMuted,border:`1px solid ${colors.accent}`,borderRadius:'4px',color:colors.textPrimary,padding:'0.2rem 0.5rem',fontSize:'0.875rem',width:'110px'}} />
                                )
                              ) : pppAP ? fmtPPPAssumptionValue(a) : displayVal(a)}
                            </td>
                            <td style={{padding:'0.7rem 1rem',color:colors.textSecondary}}>{type==='number'?(a.value!==null?a.unit:'---'):'---'}</td>
                            <td style={{padding:'0.7rem 1rem'}}>
                              <span style={{fontSize:'0.7rem',padding:'2px 8px',borderRadius:'20px',
                                background:a.confidence==='validated'?colors.successSoft:colors.warningSoft,
                                color:a.confidence==='validated'?colors.success:colors.warning,
                                border:a.confidence==='validated'?`1px solid ${colors.success}`:`1px solid ${colors.warning}`}}>
                                {a.confidence}
                              </span>
                            </td>
                            <td style={{padding:'0.7rem 0.75rem',textAlign:'right',whiteSpace:'nowrap'}}>
                              {isEditing ? (
                                <div style={{display:'flex',gap:'0.4rem',justifyContent:'flex-end'}}>
                                  <button onClick={() => handleSaveAssumption(a.assumption_id,a.name)} disabled={savingAssumption}
                                    style={{padding:'0.25rem 0.7rem',background:colors.success,color:'white',border:'none',borderRadius:'4px',cursor:'pointer',fontSize:'0.75rem'}}>
                                    {savingAssumption ? '...' : 'Save'}
                                  </button>
                                  <button onClick={() => {setEditingId(null);setEditingValue('')}}
                                    style={{padding:'0.25rem 0.7rem',background:'none',color:colors.textSecondary,border:`1px solid ${colors.border}`,borderRadius:'4px',cursor:'pointer',fontSize:'0.75rem'}}>
                                    Cancel
                                  </button>
                                </div>
                              ) : editable ? (
                                <button onClick={() => {setEditingId(a.assumption_id);setEditingValue(editVal(a))}}
                                  style={{padding:'0.25rem 0.75rem',background:colors.surfaceElevated,color:colors.textSecondary,border:`1px solid ${colors.border}`,borderRadius:'4px',cursor:'pointer',fontSize:'0.75rem'}}>
                                  Edit
                                </button>
                              ) : null}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })}

          {/* ── PPP Timeline Summary ── */}
          {pppAP && (() => {
            const constrA = assumptions.find(a => a.name === 'Construction Period')
            const concA   = assumptions.find(a => a.name === 'Concession Period')
            const constrYrs = constrA ? Math.ceil(Number(constrA.value) / 12) : null
            const opsYrs    = concA   ? Number(concA.value) : null
            const totalYrs  = (constrYrs !== null && opsYrs !== null) ? constrYrs + opsYrs : null
            if (!constrYrs && !opsYrs) return null
            return (
              <div style={{
                background: colors.surfaceMuted, border: `1px solid ${colors.border}`,
                borderRadius: '8px', padding: '1rem 1.25rem', marginBottom: '2rem',
              }}>
                <p style={{fontSize:'0.72rem',color:colors.textSecondary,textTransform:'uppercase',letterSpacing:'0.05em',marginBottom:'0.75rem'}}>
                  Timeline Structure
                </p>
                <div style={{display:'flex',gap:'2rem',flexWrap:'wrap'}}>
                  {[
                    { label: 'Construction Phase',          value: constrYrs !== null ? constrYrs + ' years' : '—', color: colors.textMuted },
                    { label: 'Operations / Revenue Period', value: opsYrs    !== null ? opsYrs    + ' years' : '—', color: colors.textSecondary },
                    { label: 'Total Project Life',          value: totalYrs  !== null ? totalYrs  + ' years' : '—', color: colors.textPrimary },
                  ].map(item => (
                    <div key={item.label}>
                      <p style={{fontSize:'0.68rem',color:colors.textMuted,marginBottom:'0.2rem'}}>{item.label}</p>
                      <p style={{fontSize:'0.95rem',fontWeight:'600',color:item.color}}>{item.value}</p>
                    </div>
                  ))}
                </div>
                <p style={{fontSize:'0.72rem',color:colors.textMuted,marginTop:'0.75rem',lineHeight:1.5}}>
                  {constrYrs !== null && opsYrs !== null && totalYrs !== null
                    ? `Total timeline: ${totalYrs} years = ${constrYrs} year${constrYrs !== 1 ? 's' : ''} construction + ${opsYrs} year${opsYrs !== 1 ? 's' : ''} operations / revenue`
                    : 'Enter Construction Period and Operations / Revenue Period above to see the full timeline.'
                  }
                </p>
              </div>
            )
          })()}

          {/* ── Benchmarks — grouped accordion (RE only) ── */}
          {!pppAP && (
          <div style={{marginBottom:'2rem'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'0.5rem'}}>
              <h3 style={{fontSize:'0.8rem',color:colors.textSecondary,textTransform:'uppercase',letterSpacing:'0.05em'}}>
                Jordan RE Benchmarks
              </h3>
              {Object.keys(overrides).length > 0 && (
                <span style={{fontSize:'0.72rem',color:colors.warning}}>
                  {Object.keys(overrides).length} override{Object.keys(overrides).length > 1 ? 's' : ''} active
                </span>
              )}
            </div>
            <p style={{fontSize:'0.72rem',color:colors.textMuted,marginBottom:'0.9rem',lineHeight:'1.5'}}>
              System defaults are used unless an override is applied. Expand a group to review or adjust assumptions for this project.
            </p>

            {(() => {
              // ── Group definitions — ordered, keys map to d.key values ──
              const BENCH_GROUPS = [
                {
                  name: 'Market Dynamics',
                  keys: [
                    'inflation_rate','price_escalation_pa','demand_growth_pa',
                    'rent_escalation_pct_per_year','salary_escalation_pa',
                    'gdp_growth_rate','population_growth_rate',
                  ],
                },
                {
                  name: 'Operational Drivers',
                  keys: [
                    'utilisation_year1','utilisation_year2','utilisation_steady_state',
                    'occupancy_rate_stabilized','downtime_pct',
                  ],
                },
                {
                  name: 'Revenue Drivers',
                  keys: [
                    'sale_price_per_sqm_residential','sale_price_per_sqm_commercial',
                    'rental_yield_residential','rental_yield_commercial',
                    'sales_absorption_rate_pct_per_year',
                  ],
                },
                {
                  name: 'Cost Drivers & OPEX',
                  keys: [
                    'construction_cost_per_sqm_residential','construction_cost_per_sqm_commercial',
                    'capex_contingency','revenue_contingency_pct',
                    'property_management_fee_pct','maintenance_cost_pct_of_value','maintenance_capex_pct',
                    'insurance_pct_of_value','land_cost_pct_of_tdc',
                  ],
                },
                {
                  name: 'CapEx & Development',
                  keys: [
                    'hard_cost_pct_of_tdc','soft_cost_pct_of_tdc','infrastructure_cost_pct',
                    'construction_period_months','pre_sales_pct_required',
                  ],
                },
                {
                  name: 'Financing Structure',
                  keys: [
                    'equity_pct','senior_debt_pct','shareholder_loan_pct',
                    'senior_debt_interest_rate',
                    'loan_tenor_years','grace_period_years','dsra_months',
                    'debt_arrangement_fee_pct',
                  ],
                },
                {
                  name: 'Taxes & Fees',
                  keys: [
                    'corporate_tax_rate','corporate_income_tax_rate',
                    'vat_rate','withholding_tax_pct',
                    'land_registration_fee_pct','transfer_tax_pct',
                  ],
                },
                {
                  name: 'Working Capital',
                  keys: [
                    'receivables_days','receivable_days',
                    'payables_days','payable_days',
                    'inventory_months','inventory_days',
                    'retention_pct','retention_receivable_pct',
                    'mobilisation_advance_pct',
                  ],
                },
                {
                  name: 'Exit & Valuation',
                  keys: [
                    'discount_rate_wacc','risk_free_rate',
                    'irr_hurdle_equity_min','irr_hurdle_equity_max',
                    'exit_cap_rate','terminal_cap_rate','terminal_growth_rate',
                    'exit_year','exit_costs_pct',
                  ],
                },
                {
                  name: 'Accounting & Depreciation',
                  keys: [
                    'depreciation_rate_buildings','depreciation_rate_fitout',
                    'useful_life_years','useful_life_civil_works','useful_life_equipment','useful_life_intangibles',
                    'salvage_value_pct',
                  ],
                },
                {
                  name: 'Risk & Thresholds',
                  keys: [
                    'dscr_floor','loan_to_cost_max','loan_to_value_max',
                    'stress_vacancy_pct','sensitivity_range_pct',
                    'variance_threshold_amber','variance_threshold_red',
                  ],
                },
              ]

              // Deduplicate: if a key appears in multiple groups, keep only the first occurrence
              const seenKeys = new Set()
              const DEDUPED_GROUPS = BENCH_GROUPS.map(g => ({
                ...g,
                keys: g.keys.filter(k => { if (seenKeys.has(k)) return false; seenKeys.add(k); return true }),
              }))

              // Clean label map
              const LABEL_MAP = {
                // Market Dynamics
                inflation_rate:                       'Inflation Rate',
                price_escalation_pa:                  'Price Growth (p.a.)',
                demand_growth_pa:                     'Demand Growth (p.a.)',
                rent_escalation_pct_per_year:         'Rent Escalation (p.a.)',
                salary_escalation_pa:                 'Salary Escalation (p.a.)',
                gdp_growth_rate:                      'GDP Growth Rate',
                population_growth_rate:               'Population Growth Rate',
                // Operational Drivers
                utilisation_year1:                    'Utilisation — Year 1',
                utilisation_year2:                    'Utilisation — Year 2',
                utilisation_steady_state:             'Stabilised Utilisation',
                occupancy_rate_stabilized:            'Stabilised Occupancy Rate',
                downtime_pct:                         'Downtime %',
                // Revenue
                sale_price_per_sqm_residential:       'Sale Price — Residential (per saleable sqm)',
                sale_price_per_sqm_commercial:        'Sale Price — Commercial (per sqm)',
                rental_yield_residential:             'Rental Yield — Residential',
                rental_yield_commercial:              'Rental Yield — Commercial',
                sales_absorption_rate_pct_per_year:   'Sales Absorption Rate (p.a.)',
                // Cost & OPEX
                construction_cost_per_sqm_residential:'Construction Cost — Residential (per sqm)',
                construction_cost_per_sqm_commercial: 'Construction Cost — Commercial (per sqm)',
                capex_contingency:                    'Construction Contingency %',
                revenue_contingency_pct:              'Revenue Downside Buffer %',
                property_management_fee_pct:          'Property Management Fee',
                maintenance_cost_pct_of_value:        'Maintenance Cost (% of Value)',
                maintenance_capex_pct:                'Maintenance % of CapEx',
                insurance_pct_of_value:               'Insurance (% of Value)',
                land_cost_pct_of_tdc:                 'Land Cost (% of TDC)',
                // CapEx
                hard_cost_pct_of_tdc:                 'Hard Cost (% of TDC)',
                soft_cost_pct_of_tdc:                 'Soft Cost (% of TDC)',
                infrastructure_cost_pct:              'Infrastructure Cost %',
                construction_period_months:           'Construction Period',
                pre_sales_pct_required:               'Pre-Sales Required',
                // Financing — strict bank-ready set
                equity_pct:                           'Equity %',
                senior_debt_pct:                      'Senior Debt %',
                shareholder_loan_pct:                 'Shareholder Loan %',
                senior_debt_interest_rate:            'Senior Debt Rate',
                loan_tenor_years:                     'Loan Tenor (Years)',
                grace_period_years:                   'Grace Period (Years)',
                dsra_months:                          'DSRA (Months)',
                debt_arrangement_fee_pct:             'Debt Arrangement Fee %',
                // Taxes
                corporate_tax_rate:                   'Corporate Tax Rate',
                corporate_income_tax_rate:            'Corporate Tax Rate',
                vat_rate:                             'VAT Rate',
                withholding_tax_pct:                  'Withholding Tax',
                land_registration_fee_pct:            'Land Registration Fee',
                transfer_tax_pct:                     'Transfer Tax',
                // Working Capital
                receivables_days:                     'Receivables Days',
                receivable_days:                      'Receivables Days',
                payables_days:                        'Payables Days',
                payable_days:                         'Payables Days',
                inventory_months:                     'Inventory (Months)',
                inventory_days:                       'Inventory Days',
                retention_pct:                        'Retention %',
                retention_receivable_pct:             'Retention Receivable %',
                mobilisation_advance_pct:             'Mobilisation Advance %',
                // Exit & Valuation
                discount_rate_wacc:                   'WACC',
                risk_free_rate:                       'Risk-Free Rate',
                irr_hurdle_equity_min:                'Min. Equity IRR Hurdle',
                irr_hurdle_equity_max:                'Max. Equity IRR Hurdle',
                exit_cap_rate:                        'Exit Cap Rate',
                terminal_cap_rate:                    'Terminal Cap Rate',
                terminal_growth_rate:                 'Terminal Growth Rate',
                exit_year:                            'Exit Year',
                exit_costs_pct:                       'Exit Costs %',
                // Depreciation
                depreciation_rate_buildings:          'Depreciation — Buildings',
                depreciation_rate_fitout:             'Depreciation — Fit-out',
                useful_life_years:                    'Useful Life',
                useful_life_civil_works:              'Useful Life — Civil Works',
                useful_life_equipment:                'Useful Life — Equipment',
                useful_life_intangibles:              'Useful Life — Intangibles',
                salvage_value_pct:                    'Salvage Value %',
                // Risk
                dscr_floor:                           'DSCR Floor',
                loan_to_cost_max:                     'Max. Loan-to-Cost',
                loan_to_value_max:                    'Max. Loan-to-Value',
                stress_vacancy_pct:                   'Stress Vacancy Rate',
                sensitivity_range_pct:                'Sensitivity Range',
                variance_threshold_amber:             'Variance Threshold — Watch',
                variance_threshold_red:               'Variance Threshold — Material',
              }

              // B15: per-row helper text shown beneath cleanLabel in the Jordan RE Benchmarks accordion
              const HINT_MAP = {
                sale_price_per_sqm_residential:
                  'Per net saleable area, after Efficiency %. Do not enter a per-gross-sqm price.',
              }

              function cleanLabel(key) {
                return LABEL_MAP[key] || key.replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase())
              }

              function fmtDefault(d) {
                const raw = Number(d.value), unit = String(d.unit || '')
                if (unit === 'decimal' || unit === 'percent') return (raw * 100).toFixed(2) + '%'
                if (unit === 'ratio')   return raw.toFixed(2) + 'x'
                if (unit === 'years')   return raw + ' Yrs'
                if (unit === 'months')  return raw + ' Mo'
                if (unit === 'days')    return raw + ' Days'
                if (unit === 'JOD/sqm') return raw.toLocaleString('en-US') + ' JOD/sqm'
                return String(d.value) + (unit && unit !== 'number' ? ' ' + unit : '')
              }

              function fmtOverride(val, d) {
                const unit = String(d.unit || '')
                if (unit === 'decimal' || unit === 'percent') return (Number(val) * 100).toFixed(2) + '%'
                if (unit === 'ratio')  return Number(val).toFixed(2) + 'x'
                if (unit === 'years')  return val + ' Yrs'
                if (unit === 'months') return val + ' Mo'
                if (unit === 'days')   return val + ' Days'
                if (unit === 'JOD/sqm') return Number(val).toLocaleString('en-US') + ' JOD/sqm'
                return String(val) + (unit && unit !== 'number' ? ' ' + unit : '')
              }

              // Bucket defaults into groups using deduplicated map
              const keyToGroup = {}
              DEDUPED_GROUPS.forEach(g => g.keys.forEach(k => { keyToGroup[k] = g.name }))
              const catchAll = 'Other Assumptions'
              const groupMap = {}
              DEDUPED_GROUPS.forEach(g => { groupMap[g.name] = [] })
              groupMap[catchAll] = []
              defaults.forEach(d => {
                const gName = keyToGroup[d.key] || catchAll
                if (!groupMap[gName]) groupMap[gName] = []
                groupMap[gName].push(d)
              })

              const toggleGroup = (name) =>
                setOpenGroups(prev => ({ ...prev, [name]: !prev[name] }))

              // Render: named groups first, Other Assumptions only if non-empty
              const groupsToRender = [
                ...DEDUPED_GROUPS.map(g => g.name).filter(n => (groupMap[n] || []).length > 0),
                ...((groupMap[catchAll] || []).length > 0 ? [catchAll] : []),
              ]

              return groupsToRender.map(groupName => {
                  const rows = groupMap[groupName]
                  const overrideCount = rows.filter(d => overrides[d.key] !== undefined).length
                  const isOpen = !!openGroups[groupName]

                  return (
                    <div key={groupName} style={{marginBottom:'0.5rem',border:`1px solid ${colors.border}`,borderRadius:'8px',overflow:'hidden'}}>

                      {/* Group header */}
                      <button
                        onClick={() => toggleGroup(groupName)}
                        style={{width:'100%',display:'flex',justifyContent:'space-between',alignItems:'center',
                          padding:'0.65rem 1rem',background:colors.surfaceElevated,border:'none',cursor:'pointer',textAlign:'left'}}>
                        <div style={{display:'flex',alignItems:'center',gap:'0.6rem'}}>
                          <span style={{color:colors.textSecondary,fontSize:'0.7rem',transition:'transform 0.15s',
                            display:'inline-block',transform:isOpen?'rotate(90deg)':'rotate(0deg)'}}>▶</span>
                          <span style={{fontSize:'0.8rem',color:colors.textPrimary,fontWeight:'500'}}>{groupName}</span>
                          <span style={{fontSize:'0.7rem',color:colors.textMuted}}>
                            {rows.length} item{rows.length !== 1 ? 's' : ''}
                            {overrideCount > 0 && (
                              <span style={{marginLeft:'0.4rem',color:colors.warning}}>· {overrideCount} override{overrideCount > 1 ? 's' : ''}</span>
                            )}
                          </span>
                        </div>
                      </button>

                      {/* Expanded rows */}
                      {isOpen && (
                        <div style={{background:colors.surfaceMuted}}>
                          <table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.82rem',tableLayout:'fixed'}}>
                            <thead>
                              <tr style={{borderBottom:`1px solid ${colors.border}`}}>
                                {[
                                  {label:'Assumption',    width:'30%'},
                                  {label:'System Default',width:'20%'},
                                  {label:'Active Value',  width:'35%'},
                                  {label:'',              width:'15%'},
                                ].map((h,i) => (
                                  <th key={i} style={{padding:'0.5rem 1rem',textAlign:i===3?'right':'left',
                                    color:colors.textMuted,fontWeight:'500',fontSize:'0.7rem',whiteSpace:'nowrap',width:h.width}}>{h.label}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map(d => {
                                const isOverridden = overrides[d.key] !== undefined
                                const isEditingThis = editingOverrideKey === d.key
                                return (
                                  <tr key={d.default_id || d.key}
                                    style={{borderBottom:`1px solid ${colors.surfaceElevated}`,
                                      background: isEditingThis ? colors.surfaceMuted
                                        : isOverridden ? colors.warningSoft
                                        : 'transparent'}}>

                                    {/* Label */}
                                    <td style={{padding:'0.65rem 1rem',color:colors.textPrimary,fontWeight:'400',minWidth:'180px'}}>
                                      <div>{cleanLabel(d.key)}</div>
                                      {HINT_MAP[d.key] && (
                                        <p style={{fontSize:'0.7rem',color:colors.textSecondary,marginTop:'0.2rem',lineHeight:1.4}}>
                                          {HINT_MAP[d.key]}
                                        </p>
                                      )}
                                    </td>

                                    {/* System Default */}
                                    <td style={{padding:'0.65rem 1rem',color:colors.textSecondary,fontSize:'0.8rem',whiteSpace:'nowrap'}}>
                                      {fmtDefault(d)}
                                    </td>

                                    {/* Active Value */}
                                    <td style={{padding:'0.65rem 1rem',minWidth:'180px'}}>
                                      {isEditingThis ? (
                                        <input type="number" value={editingOverrideValue}
                                          onChange={e => setEditingOverrideValue(e.target.value)} autoFocus
                                          onKeyDown={e => {
                                            if(e.key==='Enter') handleSaveOverride(d.key)
                                            if(e.key==='Escape'){setEditingOverrideKey(null);setEditingOverrideValue('')}
                                          }}
                                          style={{background:colors.surfaceMuted,border:`1px solid ${colors.warning}`,borderRadius:'4px',
                                            color:colors.textPrimary,padding:'0.2rem 0.5rem',fontSize:'0.82rem',width:'110px'}} />
                                      ) : isOverridden ? (
                                        <span style={{display:'flex',alignItems:'center',gap:'0.5rem'}}>
                                          <span style={{color:colors.textPrimary,fontWeight:'500'}}>
                                            {fmtOverride(overrides[d.key], d)}
                                          </span>
                                          <span style={{fontSize:'0.63rem',padding:'1px 6px',borderRadius:'20px',
                                            background:colors.warningSoft,color:colors.warning,
                                            border:`1px solid ${colors.warning}`,whiteSpace:'nowrap'}}>
                                            Overridden
                                          </span>
                                        </span>
                                      ) : (
                                        <span style={{display:'flex',alignItems:'center',gap:'0.5rem'}}>
                                          <span style={{color:colors.textSecondary,fontSize:'0.8rem'}}>
                                            {fmtDefault(d)}
                                          </span>
                                          <span style={{fontSize:'0.63rem',padding:'1px 6px',borderRadius:'20px',
                                            background:colors.accentBgSubtle,color:colors.accent,
                                            border:`1px solid ${colors.accent}`,whiteSpace:'nowrap'}}>
                                            Default
                                          </span>
                                        </span>
                                      )}
                                    </td>

                                    {/* Actions */}
                                    <td style={{padding:'0.65rem 0.75rem',textAlign:'right',whiteSpace:'nowrap'}}>
                                      {isEditingThis ? (
                                        <div style={{display:'flex',gap:'0.4rem',justifyContent:'flex-end'}}>
                                          <button onClick={() => handleSaveOverride(d.key)} disabled={savingOverride}
                                            style={{padding:'0.25rem 0.7rem',background:colors.warning,color:colors.surfaceMuted,
                                              border:'none',borderRadius:'4px',cursor:'pointer',fontSize:'0.72rem',fontWeight:'600'}}>
                                            {savingOverride ? '...' : 'Save'}
                                          </button>
                                          <button onClick={() => {setEditingOverrideKey(null);setEditingOverrideValue('')}}
                                            style={{padding:'0.25rem 0.7rem',background:'none',color:colors.textSecondary,
                                              border:`1px solid ${colors.border}`,borderRadius:'4px',cursor:'pointer',fontSize:'0.72rem'}}>
                                            Cancel
                                          </button>
                                        </div>
                                      ) : (
                                        <div style={{display:'flex',gap:'0.4rem',justifyContent:'flex-end'}}>
                                          <button
                                            onClick={() => {setEditingOverrideKey(d.key);setEditingOverrideValue(isOverridden?String(overrides[d.key]):String(d.value))}}
                                            style={{padding:'0.25rem 0.75rem',background:colors.surfaceElevated,color:colors.textSecondary,
                                              border:`1px solid ${colors.border}`,borderRadius:'4px',cursor:'pointer',fontSize:'0.72rem'}}>
                                            Override
                                          </button>
                                          {isOverridden && (
                                            <button onClick={() => handleRemoveOverride(d.key)}
                                              style={{padding:'0.25rem 0.6rem',background:'none',color:colors.textMuted,
                                                border:`1px solid ${colors.border}`,borderRadius:'4px',cursor:'pointer',fontSize:'0.7rem'}}>
                                              Reset
                                            </button>
                                          )}
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )
                })
            })()}
          </div>
          )} {/* end !pppAP benchmarks */}
        </div>
      )}

      {/* ══════════════════ RESULTS TAB ══════════════════ */}
      {tab === 'Results' && (
        <div>
          {!isApproved ? (
            <div style={{background:colors.surfaceElevated,border:`1px solid ${colors.border}`,borderRadius:'8px',padding:'2rem',
              display:'flex',flexDirection:'column',alignItems:'flex-start',gap:'1rem',maxWidth:'480px'}}>
              <div>
                <p style={{fontSize:'0.95rem',color:colors.textPrimary,fontWeight:'500',marginBottom:'0.4rem'}}>Approve Year 0 Baseline</p>
                <p style={{fontSize:'0.82rem',color:colors.textSecondary,lineHeight:'1.5'}}>
                  Approving this version locks it as the baseline for FP&A variance tracking and generates the basic feasibility results.
                </p>
              </div>
              <button onClick={handleApprove} disabled={approving}
                style={{padding:'0.55rem 1.4rem',background:colors.success,color:'white',border:`1px solid ${colors.success}`,
                  borderRadius:'6px',cursor:approving?'not-allowed':'pointer',fontSize:'0.875rem',fontWeight:'500',opacity:approving?0.6:1}}>
                {approving ? 'Approving & running model...' : 'Approve Version'}
              </button>
            </div>
          ) : (
            <div>
              {/* Approved banner + FP&A link */}
              <div style={{background:colors.surfaceElevated,border:`1px solid ${colors.success}`,borderRadius:'8px',padding:'1rem 1.5rem',
                display:'flex',alignItems:'center',justifyContent:'space-between',gap:'0.75rem',marginBottom:'2rem',flexWrap:'wrap'}}>
                <div style={{display:'flex',alignItems:'center',gap:'0.75rem'}}>
                  <span style={{color:colors.success}}>✓</span>
                  <p style={{fontSize:'0.85rem',color:colors.success,fontWeight:'500'}}>
                    Version approved — baseline locked · {version.label} · Approved {new Date(version.approved_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}
                  </p>
                </div>
                <button onClick={() => navigate('/fpa/' + projectId)}
                  style={{padding:'0.4rem 1rem',background:'none',border:`1px solid ${colors.accent}`,
                    color:colors.accent,borderRadius:'6px',cursor:'pointer',fontSize:'0.8rem',whiteSpace:'nowrap'}}>
                  View in FP&A →
                </button>
              </div>

              {modelOutput ? (
                <div>
                  {/* ── Stale output warning — old engine run detected ── */}
                  {hasStalePPPOutput && (
                    <div style={{
                      background: colors.dangerSoft, border: `1px solid ${colors.danger}`,
                      borderRadius: '8px', padding: '0.85rem 1.25rem',
                      marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between',
                      alignItems: 'center', gap: '1rem', flexWrap: 'wrap',
                    }}>
                      <div>
                        <p style={{fontSize:'0.82rem',color:colors.danger,fontWeight:'600',marginBottom:'0.2rem'}}>
                          ⚠ Model output is outdated
                        </p>
                        <p style={{fontSize:'0.75rem',color:colors.textSecondary,lineHeight:1.5}}>
                          This output was generated by an earlier engine version and contains invalid DSCR values.
                          Create a new draft and re-approve to regenerate clean results.
                        </p>
                      </div>
                      <button
                        onClick={handleCreateDraft}
                        disabled={creatingDraft}
                        style={{
                          padding: '0.4rem 1rem', background: colors.danger, color: 'white',
                          border: 'none', borderRadius: '6px', cursor: 'pointer',
                          fontSize: '0.78rem', fontWeight: '600', whiteSpace: 'nowrap',
                          opacity: creatingDraft ? 0.6 : 1,
                        }}>
                        {creatingDraft ? 'Creating...' : '+ New Draft'}
                      </button>
                    </div>
                  )}
                  {pppAP && pppBankability && (
                    <div style={{marginBottom:'2rem'}}>
                      {/* Recommendation banner */}
                      <div style={{
                        background: pppBankability.verdictBg,
                        border: '1px solid ' + pppBankability.verdictColor,
                        borderRadius: '8px', padding: '1rem 1.5rem',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem',
                      }}>
                        <div>
                          <p style={{fontSize:'0.7rem',color:colors.textSecondary,marginBottom:'0.3rem',textTransform:'uppercase',letterSpacing:'0.05em'}}>
                            Investment Case
                          </p>
                          <p style={{fontSize:'1rem',fontWeight:'700',color: pppBankability.verdictColor}}>
                            {pppBankability.investmentCase}
                          </p>
                        </div>
                        <div style={{textAlign:'right'}}>
                          <p style={{fontSize:'0.7rem',color:colors.textSecondary,marginBottom:'0.3rem',textTransform:'uppercase',letterSpacing:'0.05em'}}>
                            Recommendation
                          </p>
                          <p style={{fontSize:'1rem',fontWeight:'700',color: pppBankability.verdictColor}}>
                            {pppBankability.recommendation}
                          </p>
                        </div>
                      </div>

                      {/* Gate checks */}
                      <div style={{display:'flex',gap:'0.75rem',marginBottom:'1rem',flexWrap:'wrap'}}>
                        {[
                          {
                            label: 'IRR ≥ ' + pppBankability.PPP_IRR_HURDLE + '% Hurdle',
                            pass: pppBankability.irrOk,
                            value: pppBankability.irrOk ? 'PASS' : 'FAIL',
                          },
                          {
                            label: 'NPV ≥ 0',
                            pass: pppBankability.npvOk,
                            value: pppBankability.npvOk ? 'PASS' : 'FAIL',
                          },
                          {
                            label: 'Min DSCR ≥ ' + pppBankability.PPP_DSCR_FLOOR + 'x',
                            pass: pppBankability.dscrOk,
                            value: pppBankability.dscrOk
                              ? 'PASS'
                              : (pppBankability.minDSCR !== null ? pppBankability.minDSCR.toFixed(2) + 'x (breach)' : 'FAIL'),
                          },
                        ].map(gate => (
                          <div key={gate.label} style={{
                            flex: 1, minWidth: '140px', padding: '0.75rem 1rem',
                            background: colors.surfaceMuted, borderRadius: '6px',
                            border: `1px solid ${gate.pass ? colors.success : colors.danger}`,
                          }}>
                            <p style={{fontSize:'0.7rem',color:colors.textMuted,marginBottom:'0.3rem'}}>{gate.label}</p>
                            <span style={{
                              fontSize: '0.75rem', fontWeight: '700',
                              padding: '2px 8px', borderRadius: '20px',
                              background: gate.pass ? colors.successSoft : colors.dangerSoft,
                              color: gate.pass ? colors.success : colors.danger,
                              border: `1px solid ${gate.pass ? colors.success : colors.danger}`,
                            }}>
                              {gate.value}
                            </span>
                          </div>
                        ))}
                      </div>

                      {/* Cash Trap notice */}
                      {pppBankability.cashTrapYears.length > 0 && (
                        <div style={{
                          background: colors.warningSoft, border: `1px solid ${colors.warning}`,
                          borderRadius: '6px', padding: '0.75rem 1rem', marginBottom: '0.75rem',
                        }}>
                          <p style={{fontSize:'0.8rem',color:colors.warning,fontWeight:'600',marginBottom:'0.2rem'}}>
                            Cash Trap / Dividend Lock — {pppBankability.cashTrapYears.length} year{pppBankability.cashTrapYears.length > 1 ? 's' : ''}
                          </p>
                          <p style={{fontSize:'0.75rem',color:colors.textSecondary,lineHeight:1.5}}>
                            DSCR falls below {pppBankability.PPP_DSCR_FLOOR}x floor in Op. Year{pppBankability.cashTrapYears.length > 1 ? 's' : ''}{' '}
                            {pppBankability.cashTrapYears.join(', ')}. Equity distributions locked to zero; cash retained inside the project.
                          </p>
                        </div>
                      )}

                      {/* Liquidity Warnings — split by grace period */}
                      {(() => {
                        const gracePeriod = pppVal(assumptions, 'Grace Period') || 0
                        const earlyYears = pppBankability.liquidityWarnings
                          .filter(w => w.ops_year <= gracePeriod)
                          .map(w => w.ops_year)
                        const riskYears = pppBankability.liquidityWarnings
                          .filter(w => w.ops_year > gracePeriod)
                          .map(w => w.ops_year)
                        return (
                          <>
                            {earlyYears.length > 0 && (
                              <div style={{
                                background: colors.warningSoft, border: `1px solid ${colors.warning}`,
                                borderRadius: '6px', padding: '0.75rem 1rem',
                              }}>
                                <p style={{fontSize:'0.8rem',color:colors.warning,fontWeight:'600',marginBottom:'0.2rem'}}>
                                  Liquidity Pressure (Ramp-Up Phase)
                                </p>
                                <p style={{fontSize:'0.75rem',color:colors.textSecondary,lineHeight:1.5}}>
                                  SPV cash reserve below 3-month OPEX in early operating year{earlyYears.length > 1 ? 's' : ''}{' '}
                                  {earlyYears.join(', ')}.
                                </p>
                              </div>
                            )}
                            {riskYears.length > 0 && (
                              <div style={{
                                background: colors.dangerSoft, border: `1px solid ${colors.danger}`,
                                borderRadius: '6px', padding: '0.75rem 1rem',
                              }}>
                                <p style={{fontSize:'0.8rem',color:colors.danger,fontWeight:'600',marginBottom:'0.2rem'}}>
                                  ⚠ Liquidity Risk
                                </p>
                                <p style={{fontSize:'0.75rem',color:colors.textSecondary,lineHeight:1.5}}>
                                  SPV cash reserve below 3-month OPEX in Op. Year{riskYears.length > 1 ? 's' : ''}{' '}
                                  {riskYears.join(', ')} — potential DSRA drawdown or equity injection required.
                                </p>
                              </div>
                            )}
                          </>
                        )
                      })()}

                      {/* Required Availability Payment / DSCR Remediation */}
                      {requiredPaymentResult && (
                        <div style={{
                          background: colors.surfaceElevated, border: `1px solid ${colors.border}`,
                          borderRadius: '6px', padding: '0.85rem 1rem', marginTop: '0.75rem',
                        }}>
                          <p style={{fontSize:'0.7rem',color:colors.textSecondary,marginBottom:'0.6rem',textTransform:'uppercase',letterSpacing:'0.05em'}}>
                            DSCR Remediation — Target {targetDSCR.toFixed(2)}x
                          </p>
                          <div style={{display:'flex',flexDirection:'column',gap:'0.35rem'}}>
                            <div style={{display:'flex',justifyContent:'space-between',fontSize:'0.8rem'}}>
                              <span style={{color:colors.textSecondary}}>Required Availability Payment (Target DSCR {targetDSCR.toFixed(2)}x)</span>
                              <span style={{color:colors.textPrimary,fontWeight:'600'}}>
                                {Math.round(requiredPaymentResult.required_payment).toLocaleString('en-US')} JOD/yr
                              </span>
                            </div>
                            <div style={{display:'flex',justifyContent:'space-between',fontSize:'0.8rem'}}>
                              <span style={{color:colors.textSecondary}}>Current Availability Payment</span>
                              <span style={{color:colors.textPrimary}}>
                                {Math.round(pppVal(assumptions, 'Annual Availability Payment') || 0).toLocaleString('en-US')} JOD/yr
                              </span>
                            </div>
                            <div style={{borderTop:`1px solid ${colors.border}`,marginTop:'0.25rem',paddingTop:'0.35rem',display:'flex',justifyContent:'space-between',fontSize:'0.8rem'}}>
                              <span style={{color:colors.textSecondary}}>Gap</span>
                              <span style={{
                                color: requiredPaymentResult.payment_gap <= 0 ? colors.success : colors.warning,
                                fontWeight:'600',
                              }}>
                                {requiredPaymentResult.payment_gap <= 0
                                  ? '✓ Current payment sufficient'
                                  : '+' + Math.round(requiredPaymentResult.payment_gap).toLocaleString('en-US') + ' JOD/yr'}
                              </span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Investment Recommendation */}
                  {(() => {
                    const rec = getRecommendation({
                      irr:            Number(modelOutput.irr),
                      npv:            Number(modelOutput.npv),
                      minDSCR:        extraKPIs ? extraKPIs.minDSCR : null,
                      equityMultiple: Number(modelOutput.equity_multiple),
                      paybackYear:    extraKPIs ? extraKPIs.paybackYear : null,
                      dscrBreachYear: extraKPIs ? extraKPIs.dscrBreachYear : null,
                      isPPP:          pppAP,
                      irrHurdle:      pppAP ? PPP_IRR_HURDLE : IRR_HURDLE,
                      pppDscrFloor:   PPP_DSCR_FLOOR,
                    })

                    const verdictColor =
                      rec.verdict === 'Proceed'
                        ? colors.success
                        : rec.verdict === 'Do Not Proceed' ||
                          rec.verdict === 'High Risk'
                          ? colors.danger
                          : colors.warning

                    const verdictBg =
                      rec.verdict === 'Proceed'
                        ? colors.successSoft
                        : rec.verdict === 'Do Not Proceed' ||
                          rec.verdict === 'High Risk'
                          ? colors.dangerSoft
                          : colors.warningSoft

                    return (
                      <div style={{
                        background: verdictBg,
                        border: `1px solid ${verdictColor}`,
                        borderRadius: '8px',
                        padding: '1.25rem 1.5rem',
                        marginBottom: '2rem',
                      }}>

                        {/* Verdict header */}
                        <p style={{
                          fontSize: '0.7rem',
                          color: colors.textMuted,
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          marginBottom: '0.3rem',
                        }}>
                          Investment Recommendation
                        </p>
                        <p style={{
                          fontSize: '1rem',
                          fontWeight: '700',
                          color: verdictColor,
                          marginBottom: '0.5rem',
                        }}>
                          {rec.verdict}
                        </p>
                        <p style={{
                          fontSize: '0.8rem',
                          color: colors.textSecondary,
                          marginBottom: rec.riskFlags.length > 0 ||
                            rec.signals.length > 0 ? '1rem' : '0',
                          lineHeight: '1.5',
                        }}>
                          {rec.rationale}
                        </p>

                        {/* Risk flags */}
                        {rec.riskFlags.length > 0 && (
                          <div style={{ marginBottom: rec.signals.length > 0
                            ? '1rem' : '0' }}>
                            <p style={{
                              fontSize: '0.7rem',
                              color: colors.textMuted,
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                              marginBottom: '0.5rem',
                            }}>
                              Risk Flags
                            </p>
                            <div style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '0.35rem',
                            }}>
                              {rec.riskFlags.map((flag, i) => (
                                <div key={i} style={{
                                  display: 'flex',
                                  alignItems: 'flex-start',
                                  gap: '0.5rem',
                                }}>
                                  <div style={{
                                    width: '6px',
                                    height: '6px',
                                    borderRadius: '50%',
                                    marginTop: '0.35rem',
                                    flexShrink: 0,
                                    background: flag.severity === 'danger'
                                      ? colors.danger
                                      : colors.warning,
                                  }} />
                                  <p style={{
                                    fontSize: '0.8rem',
                                    color: colors.textSecondary,
                                    lineHeight: '1.4',
                                  }}>
                                    {flag.message}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Positive signals */}
                        {rec.signals.length > 0 && (
                          <div>
                            <p style={{
                              fontSize: '0.7rem',
                              color: colors.textMuted,
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                              marginBottom: '0.5rem',
                            }}>
                              Strengths
                            </p>
                            <div style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '0.35rem',
                            }}>
                              {rec.signals.map((signal, i) => (
                                <div key={i} style={{
                                  display: 'flex',
                                  alignItems: 'flex-start',
                                  gap: '0.5rem',
                                }}>
                                  <div style={{
                                    width: '6px',
                                    height: '6px',
                                    borderRadius: '50%',
                                    marginTop: '0.35rem',
                                    flexShrink: 0,
                                    background: colors.success,
                                  }} />
                                  <p style={{
                                    fontSize: '0.8rem',
                                    color: colors.textSecondary,
                                    lineHeight: '1.4',
                                  }}>
                                    {signal.message}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                      </div>
                    )
                  })()}

                  {/* Investment Summary */}
                  <div style={{background:colors.surfaceElevated,border:`1px solid ${colors.border}`,borderRadius:'8px',padding:'1.25rem 1.5rem',marginBottom:'2rem'}}>
                    <h3 style={{fontSize:'0.8rem',color:colors.textSecondary,marginBottom:'1rem',textTransform:'uppercase',letterSpacing:'0.05em'}}>Investment Summary</h3>
                    <div style={{display:'flex',gap:'1rem',flexWrap:'wrap'}}>
                      {[
                        {
                          label: pppAP ? 'IRR vs PPP Hurdle' : 'IRR vs Hurdle',
                          value: fmtIRR(modelOutput.irr),
                          sub: 'Hurdle: ' + (pppAP ? PPP_IRR_HURDLE : IRR_HURDLE) + '%',
                          pass: pppAP
                            ? (modelOutput.irr !== null && Number(modelOutput.irr) >= PPP_IRR_HURDLE)
                            : irrPass,
                          verdict: (pppAP
                            ? (modelOutput.irr !== null && Number(modelOutput.irr) >= PPP_IRR_HURDLE)
                            : irrPass) ? 'PASS' : 'BELOW HURDLE',
                        },
                        {
                          label: 'NPV', value: fmtCurrency(modelOutput.npv),
                          sub: Number(modelOutput.npv) >= 0 ? 'Value created' : 'Value destroyed',
                          pass: npvPass, verdict: npvPass ? 'POSITIVE' : 'NEGATIVE',
                        },
                      ].map(item => (
                        <div key={item.label} style={{flex:1,minWidth:'160px',padding:'1rem',
                          background:colors.surfaceMuted,borderRadius:'6px',
                          border:item.pass===true?`1px solid ${colors.success}`:item.pass===false?`1px solid ${colors.danger}`:`1px solid ${colors.border}`}}>
                          <p style={{fontSize:'0.72rem',color:colors.textMuted,marginBottom:'0.4rem',textTransform:'uppercase',letterSpacing:'0.04em'}}>{item.label}</p>
                          <p style={{fontSize:'1.1rem',fontWeight:'600',color:colors.textPrimary,marginBottom:'0.3rem'}}>{item.value}</p>
                          <p style={{fontSize:'0.72rem',color:colors.textSecondary,marginBottom:'0.5rem'}}>{item.sub}</p>
                          <span style={{fontSize:'0.68rem',padding:'2px 7px',borderRadius:'20px',fontWeight:'600',
                            background:item.pass===true?colors.successSoft:item.pass===false?colors.dangerSoft:colors.surfaceElevated,
                            color:item.pass===true?colors.success:item.pass===false?colors.danger:colors.textMuted,
                            border:item.pass===true?`1px solid ${colors.success}`:item.pass===false?`1px solid ${colors.danger}`:`1px solid ${colors.border}`}}>
                            {item.verdict}
                          </span>
                        </div>
                      ))}
                      {(() => {
                        const dscrPassFinal = pppAP
                          ? (extraKPIs && extraKPIs.minDSCR !== null && extraKPIs.minDSCR >= PPP_DSCR_FLOOR)
                          : dscrPass
                        const dscrVerdict = dscrPassFinal
                          ? 'SERVICEABLE'
                          : (extraKPIs && extraKPIs.minDSCR !== null ? 'BREACH DETECTED' : '---')
                        return (
                          <div style={{flex:1,minWidth:'160px',padding:'1rem',
                            background:colors.surfaceMuted,borderRadius:'6px',
                            border:dscrPassFinal===true?`1px solid ${colors.success}`:dscrPassFinal===false?`1px solid ${colors.danger}`:`1px solid ${colors.border}`}}>
                            <p style={{fontSize:'0.72rem',color:colors.textMuted,marginBottom:'0.4rem',textTransform:'uppercase',letterSpacing:'0.04em'}}>Debt Coverage</p>
                            <p style={{fontSize:'1.1rem',fontWeight:'600',color:colors.textPrimary,marginBottom:'0.3rem'}}>
                              {extraKPIs && extraKPIs.minDSCR !== null
                                ? fmtDSCR(extraKPIs.minDSCR) + ' min DSCR' : '---'}
                            </p>
                            {extraKPIs && extraKPIs.minDSCR !== null && (
                              extraKPIs.minDSCR < 1.00
                                ? <p style={{
                                    fontSize: '0.7rem',
                                    color: colors.danger,
                                    marginTop: '0.4rem',
                                  }}>
                                    Bankability risk: cash flow does not fully cover debt service.
                                  </p>
                                : extraKPIs.minDSCR < 1.20
                                  ? <p style={{
                                      fontSize: '0.7rem',
                                      color: colors.warning,
                                      marginTop: '0.4rem',
                                    }}>
                                      Watch: thin debt-service coverage.
                                    </p>
                                  : null
                            )}
                            <p style={{fontSize:'0.72rem',color:colors.textSecondary,marginBottom:'0.5rem'}}>
                              {extraKPIs && extraKPIs.dscrBreachYear
                                ? 'Breach in Op. Year ' + extraKPIs.dscrBreachYear
                                : 'No breach detected'}
                            </p>
                            <span style={{fontSize:'0.68rem',padding:'2px 7px',borderRadius:'20px',fontWeight:'600',
                              background:dscrPassFinal===true?colors.successSoft:dscrPassFinal===false?colors.dangerSoft:colors.surfaceElevated,
                              color:dscrPassFinal===true?colors.success:dscrPassFinal===false?colors.danger:colors.textMuted,
                              border:dscrPassFinal===true?`1px solid ${colors.success}`:dscrPassFinal===false?`1px solid ${colors.danger}`:`1px solid ${colors.border}`}}>
                              {dscrVerdict}
                            </span>
                          </div>
                        )
                      })()}
                    </div>
                  </div>

                  {/* Primary KPIs */}
                  <div style={{display:'flex',gap:'1rem',marginBottom:'1rem',flexWrap:'wrap'}}>
                    <div style={{background:colors.surfaceElevated,border:`1px solid ${colors.border}`,borderRadius:'8px',padding:'1.25rem 1.5rem',minWidth:'150px',flex:1}}>
                      <p style={{fontSize:'0.75rem',color:colors.textSecondary,marginBottom:'0.5rem'}}>IRR (Equity)</p>
                      <p style={{fontSize:'1.5rem',fontWeight:'600',color:Number(modelOutput.irr)>=(pppAP?PPP_IRR_HURDLE:15)?colors.success:Number(modelOutput.irr)>=8?colors.warning:colors.danger}}>{fmtIRR(modelOutput.irr)}</p>
                      {Number(modelOutput.irr) > 100 && (
                        <p style={{
                          fontSize: '0.7rem',
                          color: colors.warning,
                          marginTop: '0.4rem',
                        }}>
                          Outlier: validate equity timing and cash flow phasing
                        </p>
                      )}
                    </div>
                    {[
                      {label:'NPV',value:fmtCurrency(modelOutput.npv),color:Number(modelOutput.npv)>=0?colors.success:colors.danger},
                      {label:'Equity Multiple',value:modelOutput.equity_multiple?modelOutput.equity_multiple+'x':'---',color:Number(modelOutput.equity_multiple)>=1.5?colors.success:colors.warning},
                    ].map(kpi => (
                      <div key={kpi.label} style={{background:colors.surfaceElevated,border:`1px solid ${colors.border}`,borderRadius:'8px',padding:'1.25rem 1.5rem',minWidth:'150px',flex:1}}>
                        <p style={{fontSize:'0.75rem',color:colors.textSecondary,marginBottom:'0.5rem'}}>{kpi.label}</p>
                        <p style={{fontSize:'1.5rem',fontWeight:'600',color:kpi.color}}>{kpi.value}</p>
                      </div>
                    ))}
                  </div>

                  {/* Extra KPIs */}
                  {extraKPIs && (
                    <div style={{display:'flex',gap:'1rem',marginBottom:'2rem',flexWrap:'wrap'}}>
                      {[
                        {label:'Payback Period', value:extraKPIs.paybackYear!==null?'Year '+extraKPIs.paybackYear:'Not Recovered'},
                        {label:'Total Revenue',  value:fmtCurrency(extraKPIs.totalRevenue)},
                        {label:'Total Cost',     value:fmtCurrency(extraKPIs.totalCost)},
                        {label:'Equity Invested',value:extraKPIs.equityInvested?fmtCurrency(extraKPIs.equityInvested):'---'},
                      ].map(kpi => (
                        <div key={kpi.label} style={{background:colors.surfaceElevated,border:`1px solid ${colors.border}`,borderRadius:'8px',padding:'1rem 1.25rem',minWidth:'140px',flex:1}}>
                          <p style={{fontSize:'0.72rem',color:colors.textSecondary,marginBottom:'0.4rem'}}>{kpi.label}</p>
                          <p style={{fontSize:'1.1rem',fontWeight:'500',color:colors.textPrimary}}>{kpi.value}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* DSCR Series */}
                  {modelOutput.dscr_series && modelOutput.dscr_series.length > 0 && (
                    <div style={{marginBottom:'2rem'}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'1rem',flexWrap:'wrap',gap:'0.5rem'}}>
                        <h3 style={{fontSize:'0.8rem',color:colors.textSecondary,textTransform:'uppercase',letterSpacing:'0.05em'}}>DSCR — Annual Series</h3>
                        {extraKPIs && extraKPIs.dscrBreachYear && (
                          <span style={{fontSize:'0.75rem',padding:'3px 10px',borderRadius:'20px',
                            background:colors.dangerSoft,color:colors.danger,border:`1px solid ${colors.danger}`}}>
                            ⚠ Breach in Op. Year {extraKPIs.dscrBreachYear}
                          </span>
                        )}
                        {extraKPIs && !extraKPIs.dscrBreachYear && extraKPIs.minDSCR !== null && (
                          <span style={{fontSize:'0.75rem',color:colors.textMuted}}>
                            Min DSCR: <span style={{color:dscrColor(extraKPIs.minDSCR),fontWeight:'500'}}>{extraKPIs.minDSCR.toFixed(2)}x</span>
                          </span>
                        )}
                      </div>
                      <div style={{background:colors.surfaceElevated,border:`1px solid ${colors.border}`,borderRadius:'8px',overflow:'hidden'}}>
                        <table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.875rem'}}>
                          <thead><tr style={{borderBottom:`1px solid ${colors.border}`}}>
                            {['Op. Year','DSCR','Status'].map(h => (
                              <th key={h} style={{padding:'0.75rem 1rem',textAlign:'left',color:colors.textSecondary,fontWeight:'500',fontSize:'0.75rem'}}>{h}</th>
                            ))}
                          </tr></thead>
                          <tbody>
                            {modelOutput.dscr_series.map((d, index) => {
                              const st = d.dscr===null?'---':d.dscr>=1.25?'OK':d.dscr>=1.0?'Watch':'Breach'
                              const isMin = extraKPIs && extraKPIs.minDSCR !== null && d.dscr === extraKPIs.minDSCR
                              return (
                                <tr key={d.year} style={{borderBottom:`1px solid ${colors.border}`,
                                  background:st==='Breach'?colors.dangerSoft:isMin?colors.warningSoft:index%2===0?colors.accentBgSubtle:'transparent'}}>
                                  <td style={{padding:'0.75rem 1rem',color:colors.textPrimary}}>
                                    Year {d.year}
                                    {isMin && <span style={{marginLeft:'0.5rem',fontSize:'0.65rem',color:colors.warning}}>min</span>}
                                  </td>
                                  <td style={{padding:'0.75rem 1rem',color:dscrColor(d.dscr),fontWeight:'500'}}>{d.dscr!==null?d.dscr:'---'}</td>
                                  <td style={{padding:'0.75rem 1rem'}}>
                                    <span style={{fontSize:'0.7rem',padding:'2px 8px',borderRadius:'20px',
                                      background:st==='OK'?colors.successSoft:st==='Watch'?colors.warningSoft:colors.dangerSoft,
                                      color:st==='OK'?colors.success:st==='Watch'?colors.warning:colors.danger,
                                      border:st==='OK'?`1px solid ${colors.success}`:st==='Watch'?`1px solid ${colors.warning}`:`1px solid ${colors.danger}`}}>
                                      {st}
                                    </span>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Annual Cash Flows */}
                  <div>
                    <h3 style={{fontSize:'0.8rem',color:colors.textSecondary,marginBottom:'1rem',textTransform:'uppercase',letterSpacing:'0.05em'}}>Annual Cash Flows (JOD)</h3>
                    <div style={{background:colors.surfaceElevated,border:`1px solid ${colors.border}`,borderRadius:'8px',overflow:'auto'}}>
                      <table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.8rem',minWidth:'900px'}}>
                        <thead><tr style={{borderBottom:`1px solid ${colors.border}`}}>
                          {['Year','Phase','Revenue','Opex','EBITDA','Interest','PBT','Tax','Net Income','Principal','Equity CF'].map(h => (
                            <th key={h} style={{padding:'0.6rem 0.75rem',textAlign:'right',color:colors.textSecondary,fontWeight:'500',fontSize:'0.7rem',whiteSpace:'nowrap'}}>{h}</th>
                          ))}
                        </tr></thead>
                        <tbody>
                          {cfRows.map((row, index) => (
                            <tr key={row.year} style={{borderBottom:`1px solid ${colors.border}`,background:index%2===0?colors.accentBgSubtle:'transparent'}}>
                              <td style={{padding:'0.6rem 0.75rem',color:colors.textSecondary,textAlign:'right'}}>{row.year}</td>
                              <td style={{padding:'0.6rem 0.75rem',color:colors.textMuted,textAlign:'right',fontSize:'0.7rem'}}>{row.phase}</td>
                              <td style={{padding:'0.6rem 0.75rem',color:colors.textPrimary,textAlign:'right'}}>{fmtNumber(row.revenue)}</td>
                              <td style={{padding:'0.6rem 0.75rem',color:colors.textSecondary,textAlign:'right'}}>{fmtNumber(row.opex)}</td>
                              <td style={{padding:'0.6rem 0.75rem',color:Number(row.ebitda)>=0?colors.textPrimary:colors.danger,textAlign:'right'}}>{fmtNumber(row.ebitda)}</td>
                              <td style={{padding:'0.6rem 0.75rem',color:colors.textSecondary,textAlign:'right'}}>{fmtNumber(row.interest)}</td>
                              <td style={{padding:'0.6rem 0.75rem',color:Number(row.pbt)>=0?colors.textPrimary:colors.danger,textAlign:'right'}}>{fmtNumber(row.pbt)}</td>
                              <td style={{padding:'0.6rem 0.75rem',color:colors.textSecondary,textAlign:'right'}}>{fmtNumber(row.tax)}</td>
                              <td style={{padding:'0.6rem 0.75rem',color:Number(row.net_income)>=0?colors.textPrimary:colors.danger,textAlign:'right'}}>{fmtNumber(row.net_income)}</td>
                              <td style={{padding:'0.6rem 0.75rem',color:colors.textSecondary,textAlign:'right'}}>{fmtNumber(row.principal)}</td>
                              <td style={{padding:'0.6rem 0.75rem',color:Number(row.equity_cf)>=0?colors.success:colors.danger,fontWeight:'500',textAlign:'right'}}>{fmtNumber(row.equity_cf)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {modelOutput.cash_flows && modelOutput.cash_flows.length > 6 && (
                      <button onClick={() => setShowFullCF(!showFullCF)}
                        style={{marginTop:'0.75rem',background:'none',border:'none',color:colors.accent,cursor:'pointer',fontSize:'0.8rem'}}>
                        {showFullCF ? 'Show less' : 'Show all ' + modelOutput.cash_flows.length + ' years'}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <p style={{color:colors.textMuted,fontSize:'0.85rem'}}>Model output not found.</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ══════════════════ SCENARIOS TAB ══════════════════ */}
      {tab === 'Scenarios' && (
        <div>
          {scenariosLoading ? (
            <p style={{color:colors.textSecondary,fontSize:'0.875rem'}}>Loading scenarios...</p>
          ) : (
            <div>
              {/* ── Comparison Table (2+ approved scenarios) ── */}
              {(() => {
                const approved = scenariosData.filter(s => s.modelOutput)
                if (approved.length < 2) return null
                const metrics = [
                  { key: 'irr',             label: 'IRR (Equity)',    fmt: v => v !== null ? v.toFixed(1) + '%' : '—' },
                  { key: 'npv',             label: 'NPV (' + project.currency + ')', fmt: v => v !== null ? Number(v).toLocaleString('en-US') : '—' },
                  { key: 'equity_multiple', label: 'Equity Multiple', fmt: v => v !== null ? v + 'x' : '—' },
                ]
                function getMinDSCR(mo) {
                  if (!mo || !mo.dscr_series) return null
                  const vals = mo.dscr_series.filter(d => d.dscr !== null)
                  return vals.length ? Math.min(...vals.map(d => d.dscr)) : null
                }
                return (
                  <div style={{marginBottom:'2.5rem'}}>
                    <h3 style={{fontSize:'0.8rem',color:colors.textSecondary,textTransform:'uppercase',letterSpacing:'0.05em',marginBottom:'1rem'}}>
                      Scenario Comparison
                    </h3>
                    <div style={{background:colors.surfaceElevated,border:`1px solid ${colors.border}`,borderRadius:'8px',overflow:'auto'}}>
                      <table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.875rem'}}>
                        <thead>
                          <tr style={{borderBottom:`1px solid ${colors.border}`}}>
                            <th style={{padding:'0.75rem 1rem',textAlign:'left',color:colors.textSecondary,fontWeight:'500',fontSize:'0.75rem',minWidth:'140px'}}>Metric</th>
                            {approved.map(s => (
                              <th key={s.scenario_id} style={{padding:'0.75rem 1rem',textAlign:'right',color:colors.textSecondary,fontWeight:'500',fontSize:'0.75rem',minWidth:'120px'}}>
                                {s.label || 'Base'}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {metrics.map(m => (
                            <tr key={m.key} style={{borderBottom:`1px solid ${colors.border}`}}>
                              <td style={{padding:'0.75rem 1rem',color:colors.textSecondary,fontSize:'0.8rem'}}>{m.label}</td>
                              {approved.map(s => (
                                <td key={s.scenario_id} style={{padding:'0.75rem 1rem',textAlign:'right',color:colors.textPrimary,fontWeight:'500'}}>
                                  {m.fmt(s.modelOutput ? s.modelOutput[m.key] : null)}
                                </td>
                              ))}
                            </tr>
                          ))}
                          <tr style={{borderBottom:`1px solid ${colors.border}`}}>
                            <td style={{padding:'0.75rem 1rem',color:colors.textSecondary,fontSize:'0.8rem'}}>Min DSCR</td>
                            {approved.map(s => {
                              const md = getMinDSCR(s.modelOutput)
                              return (
                                <td key={s.scenario_id} style={{padding:'0.75rem 1rem',textAlign:'right',fontWeight:'500',
                                  color:md===null?colors.textMuted:md>=1.25?colors.success:md>=1.0?colors.warning:colors.danger}}>
                                  {md !== null ? md.toFixed(2) + 'x' : '—'}
                                </td>
                              )
                            })}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              })()}

              {/* ── Scenario Cards ── */}
              <div style={{display:'flex',flexDirection:'column',gap:'1rem',marginBottom:'1.5rem'}}>
                {scenariosData.map(sc => {
                  const isExpanded = expandedScenario === sc.scenario_id
                  const isApprovedSc = sc.latestVersion && sc.latestVersion.status === 'approved'
                  const isDraft = sc.latestVersion && sc.latestVersion.status === 'draft'
                  const typeColor = sc.scenario_type === 'bull' ? colors.success : sc.scenario_type === 'bear' ? colors.danger : colors.accent
                  const typeBg = sc.scenario_type === 'bull' ? colors.successSoft : sc.scenario_type === 'bear' ? colors.dangerSoft : colors.accentBgSubtle
                  return (
                    <div key={sc.scenario_id} style={{background:colors.surfaceElevated,border:`1px solid ${colors.border}`,borderRadius:'8px',overflow:'hidden'}}>
                      {/* Card header */}
                      <div style={{padding:'1rem 1.25rem',display:'flex',justifyContent:'space-between',alignItems:'center',gap:'1rem',flexWrap:'wrap'}}>
                        <div style={{display:'flex',alignItems:'center',gap:'0.75rem'}}>
                          <span style={{fontSize:'0.7rem',padding:'2px 8px',borderRadius:'20px',
                            background:typeBg,color:typeColor,border:`1px solid ${typeColor}`,fontWeight:'600'}}>
                            {(sc.scenario_type || 'base').toUpperCase()}
                          </span>
                          <span style={{fontWeight:'600',fontSize:'0.95rem',color:colors.textPrimary}}>{sc.label || 'Base'}</span>
                          {sc.latestVersion && (
                            <span style={{fontSize:'0.72rem',color:colors.textMuted}}>{sc.latestVersion.label}</span>
                          )}
                        </div>
                        <div style={{display:'flex',alignItems:'center',gap:'0.6rem'}}>
                          {sc.modelOutput && (
                            <span style={{fontSize:'0.75rem',color:colors.success}}>
                              IRR {sc.modelOutput.irr !== null ? sc.modelOutput.irr.toFixed(1) + '%' : '—'}
                              &nbsp;·&nbsp;
                              NPV {sc.modelOutput.npv !== null ? Number(sc.modelOutput.npv).toLocaleString('en-US') : '—'}
                            </span>
                          )}
                          <span style={{fontSize:'0.7rem',padding:'2px 8px',borderRadius:'20px',
                            background:isApprovedSc?colors.successSoft:isDraft?colors.accentBgSubtle:colors.surfaceElevated,
                            color:isApprovedSc?colors.success:isDraft?colors.accent:colors.textMuted,
                            border:isApprovedSc?`1px solid ${colors.success}`:isDraft?`1px solid ${colors.accent}`:`1px solid ${colors.border}`}}>
                            {isApprovedSc ? 'approved' : isDraft ? 'draft' : 'no version'}
                          </span>
                          {isDraft && (
                            <button onClick={() => handleApproveScenario(sc)}
                              disabled={scApproving === sc.scenario_id}
                              style={{padding:'0.3rem 0.8rem',background:colors.success,color:'white',border:'none',
                                borderRadius:'5px',cursor:'pointer',fontSize:'0.75rem',
                                opacity:scApproving===sc.scenario_id?0.6:1}}>
                              {scApproving===sc.scenario_id ? 'Running...' : 'Approve & Run'}
                            </button>
                          )}
                          <button onClick={() => setExpandedScenario(isExpanded ? null : sc.scenario_id)}
                            style={{padding:'0.3rem 0.8rem',background:'none',border:`1px solid ${colors.border}`,
                              color:colors.textSecondary,borderRadius:'5px',cursor:'pointer',fontSize:'0.75rem'}}>
                            {isExpanded ? 'Close' : 'Edit Assumptions'}
                          </button>
                          <button onClick={() => handleDeleteScenario(sc)}
                            disabled={scDeletingId === sc.scenario_id}
                            style={{padding:'0.3rem 0.8rem',background:'none',border:`1px solid ${colors.danger}`,
                              color:colors.danger,borderRadius:'5px',cursor:'pointer',fontSize:'0.75rem',
                              opacity:scDeletingId===sc.scenario_id?0.5:1}}>
                            {scDeletingId===sc.scenario_id ? '...' : 'Delete'}
                          </button>
                        </div>
                      </div>

                      {/* Expanded assumptions editor */}
                      {isExpanded && (
                        <div style={{borderTop:`1px solid ${colors.border}`,padding:'1rem 1.25rem'}}>
                          <p style={{fontSize:'0.75rem',color:colors.textMuted,marginBottom:'1.25rem'}}>
                            Edit assumptions for this scenario, then click Approve &amp; Run to compute results.
                          </p>

                          {/* ── Key Drivers ── */}
                          {!pppAP && (() => {
                            const KEY_DRIVERS = [
                              {key:'sale_price_per_sqm_residential', label:'Sale Price per saleable sqm', unit:'JOD/sqm',  hint:'Base: ~2,200'},
                              {key:'sales_absorption_rate_pct_per_year', label:'Absorption Rate',  unit:'% p.a.',   hint:'Base: ~30%', isPct:true},
                              {key:'construction_cost_per_sqm_residential', label:'Construction Cost', unit:'JOD/sqm', hint:'Base: ~850'},
                              {key:'land_cost_pct_of_tdc', label:'Land Cost % of TDC', unit:'%', hint:'Base: ~20%', isPct:true},
                              {key:'rental_yield_residential', label:'Rental Yield', unit:'%', hint:'Base: ~6%', isPct:true},
                            ]
                            return (
                              <div style={{marginBottom:'1.75rem'}}>
                                <p style={{fontSize:'0.72rem',color:colors.accent,textTransform:'uppercase',letterSpacing:'0.05em',marginBottom:'0.75rem',fontWeight:'600'}}>
                                  Key Market Drivers
                                </p>
                                <p style={{fontSize:'0.72rem',color:colors.textMuted,marginBottom:'0.75rem'}}>
                                  These are the inputs that most impact scenario outcomes. Override them to flex the model. Leave blank to use project defaults.
                                </p>
                                <div style={{background:colors.surfaceMuted,border:`1px solid ${colors.border}`,borderRadius:'6px',overflow:'hidden'}}>
                                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.82rem'}}>
                                    <thead>
                                      <tr style={{borderBottom:`1px solid ${colors.border}`}}>
                                        {['Driver','Default','This Scenario',''].map((h,i) => (
                                          <th key={i} style={{padding:'0.5rem 0.75rem',textAlign:'left',color:colors.textMuted,fontWeight:'500',fontSize:'0.7rem'}}>{h}</th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {KEY_DRIVERS.map(driver => {
                                        const defRow = defaults.find(d => d.key === driver.key)
                                        const defVal = defRow ? Number(defRow.value) : null
                                        const defDisplay = defVal !== null
                                          ? (driver.isPct ? (defVal * 100).toFixed(1) + '%' : defVal.toLocaleString('en-US') + ' ' + driver.unit)
                                          : '—'
                                        const override = sc.drivers && sc.drivers[driver.key]
                                        const overrideDisplay = override !== undefined
                                          ? (driver.isPct ? (override.value * 100).toFixed(1) + '%' : Number(override.value).toLocaleString('en-US') + ' ' + driver.unit)
                                          : '—'
                                        const editKey = sc.scenario_id + ':' + driver.key
                                        const isEditingThis = scDriverEditKey === editKey
                                        return (
                                          <tr key={driver.key} style={{borderBottom:`1px solid ${colors.border}`,background:override?colors.surfaceMuted:isEditingThis?colors.surfaceElevated:'transparent'}}>
                                            <td style={{padding:'0.6rem 0.75rem',color:colors.textPrimary}}>
                                              {driver.label}
                                              <span style={{fontSize:'0.65rem',color:colors.textMuted,marginLeft:'0.4rem'}}>{driver.hint}</span>
                                            </td>
                                            <td style={{padding:'0.6rem 0.75rem',color:colors.textMuted,fontSize:'0.78rem'}}>{defDisplay}</td>
                                            <td style={{padding:'0.6rem 0.75rem'}}>
                                              {isEditingThis ? (
                                                <input type="number" value={scDriverEditValue}
                                                  onChange={e => setScDriverEditValue(e.target.value)} autoFocus
                                                  onKeyDown={e => { if(e.key==='Enter') handleSaveScenarioDriver(sc,driver.key,scDriverEditValue); if(e.key==='Escape'){setScDriverEditKey(null);setScDriverEditValue('')} }}
                                                  placeholder={driver.isPct ? 'e.g. 0.35 for 35%' : 'e.g. 2500'}
                                                  style={{background:colors.surfaceMuted,border:`1px solid ${colors.accent}`,borderRadius:'4px',color:colors.textPrimary,padding:'0.2rem 0.5rem',fontSize:'0.82rem',width:'130px'}} />
                                              ) : (
                                                <span style={{color:override?colors.textPrimary:colors.textMuted,fontWeight:override?'500':'400'}}>
                                                  {overrideDisplay}
                                                  {override && <span style={{marginLeft:'0.4rem',fontSize:'0.65rem',padding:'1px 5px',borderRadius:'10px',background:colors.accentBgSubtle,color:colors.accent,border:`1px solid ${colors.accent}`}}>override</span>}
                                                </span>
                                              )}
                                            </td>
                                            <td style={{padding:'0.6rem 0.5rem',textAlign:'right',whiteSpace:'nowrap'}}>
                                              {isEditingThis ? (
                                                <div style={{display:'flex',gap:'0.3rem',justifyContent:'flex-end'}}>
                                                  <button onClick={() => handleSaveScenarioDriver(sc,driver.key,scDriverEditValue)} disabled={scDriverSaving}
                                                    style={{padding:'0.2rem 0.5rem',background:colors.success,color:'white',border:'none',borderRadius:'4px',cursor:'pointer',fontSize:'0.72rem'}}>
                                                    {scDriverSaving?'...':'Save'}
                                                  </button>
                                                  <button onClick={() => {setScDriverEditKey(null);setScDriverEditValue('')}}
                                                    style={{padding:'0.2rem 0.5rem',background:'none',color:colors.textMuted,border:`1px solid ${colors.border}`,borderRadius:'4px',cursor:'pointer',fontSize:'0.72rem'}}>
                                                    Cancel
                                                  </button>
                                                </div>
                                              ) : (
                                                <div style={{display:'flex',gap:'0.3rem',justifyContent:'flex-end'}}>
                                                  <button onClick={() => {
                                                    setScDriverEditKey(editKey)
                                                    setScDriverEditValue(override ? String(override.value) : (defVal !== null ? String(defVal) : ''))
                                                  }} style={{padding:'0.2rem 0.5rem',background:colors.surfaceElevated,color:colors.textSecondary,border:`1px solid ${colors.border}`,borderRadius:'4px',cursor:'pointer',fontSize:'0.72rem'}}>
                                                    Override
                                                  </button>
                                                  {override && (
                                                    <button onClick={() => handleResetScenarioDriver(sc,driver.key)}
                                                      style={{padding:'0.2rem 0.5rem',background:'none',color:colors.textMuted,border:`1px solid ${colors.border}`,borderRadius:'4px',cursor:'pointer',fontSize:'0.72rem'}}>
                                                      Reset
                                                    </button>
                                                  )}
                                                </div>
                                              )}
                                            </td>
                                          </tr>
                                        )
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )
                          })()}

                          {/* ── PPP: no benchmark drivers, just edit assumptions directly ── */}
                          {pppAP && (
                            <div style={{marginBottom:'1.75rem',background:colors.surfaceMuted,border:`1px solid ${colors.border}`,borderRadius:'6px',padding:'0.85rem 1rem'}}>
                              <p style={{fontSize:'0.78rem',color:colors.textSecondary,lineHeight:1.6}}>
                                Edit the assumptions below to flex this scenario. Key PPP drivers — Annual Payment, OPEX %, Interest Rate, WACC — are all editable in the All Assumptions table.
                              </p>
                            </div>
                          )}

                          {/* ── Standard assumptions ── */}
                          <p style={{fontSize:'0.72rem',color:colors.textSecondary,textTransform:'uppercase',letterSpacing:'0.05em',marginBottom:'0.75rem',fontWeight:'600'}}>
                            All Assumptions
                          </p>
                          {(pppAP
                            ? ['ppp_structure','ppp_revenue','ppp_financing','sizing','revenue']
                            : ['sizing','timeline','revenue','capital_structure']
                          ).map(group => {
                            const groupRows = (sc.assumptions || []).filter(a => a.category === group)
                            if (!groupRows.length) return null
                            return (
                              <div key={group} style={{marginBottom:'1.5rem'}}>
                                <p style={{fontSize:'0.72rem',color:colors.textSecondary,textTransform:'uppercase',letterSpacing:'0.05em',marginBottom:'0.5rem'}}>
                                  {group.replace(/_/g,' ')}
                                </p>
                                <div style={{background:colors.surfaceMuted,border:`1px solid ${colors.border}`,borderRadius:'6px',overflow:'hidden'}}>
                                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.82rem'}}>
                                    <tbody>
                                      {groupRows.map(a => {
                                        const type = editType(a.name)
                                        const isEditingThis = scEditingId === a.assumption_id
                                        return (
                                          <tr key={a.assumption_id} style={{borderBottom:`1px solid ${colors.border}`,
                                            background:isEditingThis?colors.surfaceElevated:'transparent'}}>
                                            <td style={{padding:'0.6rem 0.75rem',color:colors.textPrimary,width:'55%'}}>{a.name}</td>
                                            <td style={{padding:'0.6rem 0.75rem',color:colors.textPrimary,textAlign:'right'}}>
                                              {isEditingThis ? (
                                                type === 'dropdown' ? (
                                                  <select value={scEditingValue} onChange={e => setScEditingValue(e.target.value)} autoFocus
                                                    style={{background:colors.surfaceMuted,border:`1px solid ${colors.accent}`,borderRadius:'4px',color:colors.textPrimary,padding:'0.15rem 0.4rem',fontSize:'0.82rem'}}>
                                                    {DROPDOWN_OPTIONS[a.name].map(opt => <option key={opt} value={opt}>{opt}</option>)}
                                                  </select>
                                                ) : type === 'date' ? (
                                                  <input type="date" value={scEditingValue} onChange={e => setScEditingValue(e.target.value)} autoFocus
                                                    style={{background:colors.surfaceMuted,border:`1px solid ${colors.accent}`,borderRadius:'4px',color:colors.textPrimary,padding:'0.15rem 0.4rem',fontSize:'0.82rem'}} />
                                                ) : (
                                                  <input type="number" value={scEditingValue} onChange={e => setScEditingValue(e.target.value)} autoFocus
                                                    onKeyDown={e => { if(e.key==='Enter') handleSaveScenarioAssumption(a.assumption_id, a.name); if(e.key==='Escape'){setScEditingId(null);setScEditingValue('')} }}
                                                    style={{background:colors.surfaceMuted,border:`1px solid ${colors.accent}`,borderRadius:'4px',color:colors.textPrimary,padding:'0.15rem 0.4rem',fontSize:'0.82rem',width:'90px',textAlign:'right'}} />
                                                )
                                              ) : (
                                                <span>{a.value !== null ? a.value : (a.unit || '—')}</span>
                                              )}
                                            </td>
                                            <td style={{padding:'0.6rem 0.5rem',textAlign:'right',whiteSpace:'nowrap'}}>
                                              {isEditingThis ? (
                                                <div style={{display:'flex',gap:'0.3rem',justifyContent:'flex-end'}}>
                                                  <button onClick={() => handleSaveScenarioAssumption(a.assumption_id, a.name)} disabled={scSaving}
                                                    style={{padding:'0.2rem 0.5rem',background:colors.success,color:'white',border:'none',borderRadius:'4px',cursor:'pointer',fontSize:'0.72rem'}}>
                                                    {scSaving ? '...' : 'Save'}
                                                  </button>
                                                  <button onClick={() => {setScEditingId(null);setScEditingValue('')}}
                                                    style={{padding:'0.2rem 0.5rem',background:'none',color:colors.textMuted,border:`1px solid ${colors.border}`,borderRadius:'4px',cursor:'pointer',fontSize:'0.72rem'}}>
                                                    ✕
                                                  </button>
                                                </div>
                                              ) : (a.value !== null || DROPDOWN_OPTIONS[a.name] || DATE_FIELDS.includes(a.name)) && (
                                                <button onClick={() => { setScEditingId(a.assumption_id); setScEditingValue(editType(a.name)==='number'?String(a.value??''):(a.unit||'')) }}
                                                  style={{padding:'0.2rem 0.5rem',background:colors.surfaceElevated,color:colors.textMuted,border:`1px solid ${colors.border}`,borderRadius:'4px',cursor:'pointer',fontSize:'0.72rem'}}>
                                                  Edit
                                                </button>
                                              )}
                                            </td>
                                          </tr>
                                        )
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* ── Create Scenario ── */}
              {!showCreateScenario ? (
                <button onClick={() => setShowCreateScenario(true)}
                  style={{padding:'0.5rem 1.25rem',background:'none',border:`1px dashed ${colors.border}`,
                    color:colors.textSecondary,borderRadius:'6px',cursor:'pointer',fontSize:'0.875rem'}}>
                  + Create Scenario
                </button>
              ) : (
                <div style={{background:colors.surfaceElevated,border:`1px solid ${colors.border}`,borderRadius:'8px',padding:'1.25rem 1.5rem',maxWidth:'480px'}}>
                  <p style={{fontWeight:'600',fontSize:'0.9rem',marginBottom:'1.25rem',color:colors.textPrimary}}>New Scenario</p>
                  <div style={{display:'flex',flexDirection:'column',gap:'1rem'}}>
                    <div>
                      <label style={{display:'block',fontSize:'0.75rem',color:colors.textSecondary,marginBottom:'0.4rem'}}>Scenario Type</label>
                      <div style={{display:'flex',gap:'0.5rem',flexWrap:'wrap'}}>
                        {[
                          {type:'bull',label:'Bull / Best Case'},
                          {type:'bear',label:'Bear / Worst Case'},
                          {type:'base',label:'Base (Alternate)'},
                        ].map(opt => (
                          <button key={opt.type} onClick={() => { setNewScenarioType(opt.type); setNewScenarioLabel(opt.label) }}
                            style={{padding:'0.4rem 0.9rem',background:newScenarioType===opt.type?colors.accent:'none',
                              border:`1px solid ${newScenarioType===opt.type?colors.accent:colors.border}`,
                              color:newScenarioType===opt.type?'white':colors.textSecondary,
                              borderRadius:'6px',cursor:'pointer',fontSize:'0.8rem'}}>
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label style={{display:'block',fontSize:'0.75rem',color:colors.textSecondary,marginBottom:'0.4rem'}}>Label</label>
                      <input type="text" value={newScenarioLabel} onChange={e => setNewScenarioLabel(e.target.value)}
                        style={{width:'100%',padding:'0.45rem 0.75rem',background:colors.surfaceMuted,border:`1px solid ${colors.border}`,
                          borderRadius:'6px',color:colors.textPrimary,fontSize:'0.875rem'}} />
                    </div>
                    <p style={{fontSize:'0.78rem',color:colors.textMuted}}>
                      Assumptions will be cloned from the Base scenario. You can edit them before running.
                    </p>
                    <div style={{display:'flex',gap:'0.75rem'}}>
                      <button onClick={handleCreateScenario} disabled={creatingScenario}
                        style={{padding:'0.5rem 1.25rem',background:colors.accent,color:'white',border:'none',
                          borderRadius:'6px',cursor:creatingScenario?'not-allowed':'pointer',
                          fontSize:'0.875rem',opacity:creatingScenario?0.6:1}}>
                        {creatingScenario ? 'Creating...' : 'Create Scenario'}
                      </button>
                      <button onClick={() => setShowCreateScenario(false)}
                        style={{padding:'0.5rem 1rem',background:'none',color:colors.textSecondary,
                          border:`1px solid ${colors.border}`,borderRadius:'6px',cursor:'pointer',fontSize:'0.875rem'}}>
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ══════════════════ SENSITIVITY TAB ══════════════════ */}
 {/* ══════════════════ DEVELOPMENT CASH FLOW TAB ══════════════════ */}
      {tab === 'Development Cash Flow' && (
        <DevEngineTab assumptions={assumptions} defaults={mergedDefaults} onEngineResult={handleEngineResult} />
      )}

      {/* ══════════════════ EXPORT TAB ══════════════════ */}
      {tab === 'Export' && (() => {
        const hasResults = !!(version && version.dev_engine_results && version.dev_engine_results.summary)
        return (
          <div style={{maxWidth:'560px'}}>
            <div style={{background:colors.surfaceElevated,border:`1px solid ${colors.border}`,borderRadius:'8px',padding:'2rem',display:'flex',flexDirection:'column',gap:'1.25rem'}}>
              <div>
                <p style={{fontSize:'0.95rem',color:colors.textPrimary,fontWeight:'500',marginBottom:'0.4rem'}}>Export Development Cash Flow Pack</p>
                <p style={{fontSize:'0.82rem',color:colors.textSecondary,lineHeight:'1.5'}}>
                  Generates an investment-grade PDF with cover page, executive summary, scenario comparison, sensitivity analysis, and full appendix.
                </p>
              </div>

              {/* Results status indicator */}
              <div style={{
                display:'flex',alignItems:'center',gap:'0.6rem',
                background: hasResults ? colors.successSoft : colors.dangerSoft,
                border: `1px solid ${hasResults ? colors.success : colors.danger}`,
                borderRadius:'6px', padding:'0.65rem 0.9rem',
              }}>
                <div style={{
                  width:'8px',height:'8px',borderRadius:'50%',flexShrink:0,
                  background: hasResults ? colors.success : colors.danger,
                }} />
                <span style={{fontSize:'0.82rem',color: hasResults ? colors.success : colors.danger}}>
                  {hasResults
                    ? 'Engine results ready — export available'
                    : 'This export draws from the Development Cash Flow engine. Open the Development Cash Flow tab and click Run Engine to enable export.'}
                </span>
              </div>

              <div style={{fontSize:'0.8rem',color:colors.textMuted,display:'flex',flexDirection:'column',gap:'0.3rem'}}>
                <p>· {assumptions.length} assumption rows</p>
                <p>· {defaults.length} benchmark rows{Object.keys(overrides).length > 0 ? ' (' + Object.keys(overrides).length + ' overridden)' : ''}</p>
                <p>· {variances.length} variance {variances.length === 1 ? 'row' : 'rows'}{variances.length === 0 ? ' (none yet)' : ''}</p>
              </div>

              <button onClick={generatePDF} disabled={exporting || !hasResults}
                style={{
                  padding:'0.65rem 1.6rem',
                  background: hasResults ? colors.accent : colors.surfaceElevated,
                  color: hasResults ? 'white' : colors.textMuted,
                  border:'none',borderRadius:'6px',
                  cursor: (exporting || !hasResults) ? 'not-allowed' : 'pointer',
                  fontSize:'0.875rem',fontWeight:'500',
                  opacity: exporting ? 0.6 : 1,
                  alignSelf:'flex-start',
                }}>
                {exporting ? 'Generating…' : 'Download PDF'}
              </button>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
