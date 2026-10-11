#!/usr/bin/env node
/**
 * staging-verify.mjs — end-to-end PPP verification against the STAGING database
 * ---------------------------------------------------------------------------
 *   npm run verify:staging            (add -- --cleanup to delete what it created)
 *   (file: scripts/staging/verify-lifecycle.mjs)
 *
 * Reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY and STAGING_TEST_EMAIL /
 * STAGING_TEST_PASSWORD from the shell or .env.local (never commit them).
 *
 * SAFETY: refuses to run against the production Supabase project — there is
 * no override. Everything it creates is synthetic and named "SYNTHETIC —".
 *
 * For each case it runs the real application code path:
 *   create project (same rows as the New Project wizard) → read assumptions
 *   back → runPPPEngine → savePPPApproval → loadLatestModelOutput → display
 *   (debt schedule, funding summary, currency) → PDF values
 * and checks the reloaded result equals the engine output exactly.
 * ---------------------------------------------------------------------------
 */
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { PRODUCTION_SUPABASE_REF } from '../../src/config/supabaseGuard.js'
import { runPPPEngine, PPP_ENGINE_VERSION, PPP_ENGINE_COMPATIBLE_VERSIONS } from '../../src/modules/feasibility/annualEngine.js'
import { savePPPApproval, loadLatestModelOutput } from '../../src/modules/feasibility/pppResultStore.js'
import { assessResultCurrency } from '../../src/modules/feasibility/resultPersistence.js'
import { buildDebtScheduleRows } from '../../src/modules/feasibility/debtSchedule.js'
import { pppFundingSummaryRows, pppPdfMetricValues } from '../../src/modules/feasibility/pppReporting.js'
import { resolvePPPFpaBasis, pppMonthlyBudget } from '../../src/modules/feasibility/pppTimeline.js'
import { loadStagingEnv, fail } from './env.mjs'
import { exactDiff, describeDiff } from './exact-compare.mjs'

const { env, ref } = loadStagingEnv(['STAGING_TEST_EMAIL', 'STAGING_TEST_PASSWORD'])
const url = env.VITE_SUPABASE_URL, key = env.VITE_SUPABASE_ANON_KEY
const cleanup = process.argv.includes('--cleanup')

const db = createClient(url, key, { auth: { persistSession: false } })
const results = []
const check = (name, ok, detail) => { results.push({ check: name, result: ok ? 'PASS' : 'FAIL', detail: detail || '' }); return ok }
const created = { projects: [], scenarios: [], versions: [] }
const strip = o => JSON.parse(JSON.stringify(o))

const BASE = {
  'Total Project Cost': 100_000_000, 'Debt %': 80, 'Equity %': 20, 'Annual Availability Payment': 12_000_000,
  'Concession Period': 25, 'Construction Period': 24, 'OPEX % of Revenue': 5, 'Interest Rate': 7,
  'Loan Tenor': 10, 'Grace Period': 2, 'Tax Rate': 20, 'WACC': 10, 'Target DSCR': 1.2,
  'Construction Start Date': '2026-07-01',
}
const CASES = {
  'Annual — IDC, DSCR-bound': { ...BASE },
  'Quarterly — Madaba benchmark timing': {
    'Total Project Cost': 50_788_939, 'Debt %': 84.899, 'Equity %': 15.101, 'Annual Availability Payment': 8_800_000,
    'Concession Period': 10, 'Construction Period': 36, 'OPEX Amount (JOD)': 54_020, 'OPEX Escalation %': 2.015,
    'Interest Rate': 8.25, 'Loan Tenor': 9.5, 'Grace Period': 0, 'Tax Rate': 0, 'WACC': 10, 'Target DSCR': 1.0,
    'Model Periodicity': 'Quarterly',
    'Construction Start Date': '2026-01-01',
    'Construction Cost Profile': '6232.8,3008.4,6434.0,6443.8,3654.5,3554.5,3554.5,3554.5,3654.5,3554.5,3554.5,3588.4' },
  'Variable CFADS — escalation + demand profile + annuity': { ...BASE,
    'Availability Payment Escalation %': 2.5, 'OPEX Amount (JOD)': 800_000, 'OPEX Escalation %': 3.5,
    'Revenue Profile': Array.from({ length: 25 }, (_, i) => 9e6 + 250_000 * i).join(','), 'Revenue Basis': 'Demand Estimate',
    'Repayment Profile': 'Annuity' },
}
const CATEGORY = name => (/Rate|Tenor|Grace|Tax|WACC|DSCR|Repayment|Interest/.test(name) ? 'ppp_financing'
  : /Payment|OPEX|Revenue/.test(name) ? 'ppp_revenue' : 'ppp_structure')

async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data }

async function createSyntheticProject(label, inputs, user, tenantId) {
  const project = await q(db.from('projects').insert({
    tenant_id: tenantId, name: 'SYNTHETIC — ' + label + ' — ' + new Date().toISOString().slice(0, 16),
    country: 'Jordan', currency: 'JOD', accounting_standard: 'IFRS', unit_system: 'Metric', sector: 'Healthcare',
    revenue_model: 'Availability Payment', financing_structure: 'Project Finance', project_type: 'Infrastructure / PPP',
    delivery_model: 'PPP', forecast_horizon: Math.ceil(inputs['Concession Period']), created_by: user.id,
  }).select().single())
  created.projects.push(project.project_id)
  const scenario = await q(db.from('scenarios').insert({ project_id: project.project_id, name: 'Base', label: 'Base',
    scenario_type: 'base', type: 'base' }).select().single())
  created.scenarios.push(scenario.scenario_id)
  const version = await q(db.from('versions').insert({ scenario_id: scenario.scenario_id, label: 'v1.0 Draft',
    status: 'draft', created_by: user.id }).select().single())
  created.versions.push(version.version_id)
  await q(db.from('intake_state').insert({ version_id: version.version_id,
    section_completion_status: { identity: true, capital: true, revenue: true }, validation_flags: {} }))
  const base = { tenant_id: tenantId, project_id: project.project_id, module_origin: 'feasibility',
    source_type: 'user_entry', confidence: 'indicative', author_user_id: user.id }
  const rows = [
    { name: 'Project Type', category: 'sizing', value: null, unit: 'Infrastructure / PPP' },
    { name: 'Project Sector', category: 'sizing', value: null, unit: 'Healthcare' },
    { name: 'Contract Model', category: 'revenue', value: null, unit: 'Availability Payment' },
    ...Object.entries(inputs).map(([name, v]) => (typeof v === 'string'
      ? { name, category: CATEGORY(name), value: null, unit: v }
      : { name, category: CATEGORY(name), value: v, unit: null })),
  ]
  await q(db.from('assumptions').insert(rows.map(r => ({ ...base, ...r }))))
  return { project, scenario, version }
}

async function main() {
  console.log('Staging verification against project ' + ref + ' (production is ' + PRODUCTION_SUPABASE_REF + ')\n')
  const { data: auth, error: authErr } = await db.auth.signInWithPassword({ email: env.STAGING_TEST_EMAIL, password: env.STAGING_TEST_PASSWORD })
  if (authErr) fail('Sign-in failed for the staging test user: ' + authErr.message)
  const user = auth.user
  const urow = await q(db.from('users').select('tenant_id').eq('user_id', user.id).single())
  const tenantId = urow.tenant_id

  for (const [label, inputs] of Object.entries(CASES)) {
    try {
      const { version, project } = await createSyntheticProject(label, inputs, user, tenantId)
      const assumptions = await q(db.from('assumptions').select('*').eq('project_id', project.project_id).is('scenario_id', null))
      const out = runPPPEngine(assumptions)                                                         // Calculation on DB-read inputs
      check(label + ' · inputs round trip', assumptions.length === Object.keys(inputs).length + 3)
      await savePPPApproval(db, { output: out, assumptions, engineVersion: PPP_ENGINE_VERSION, versionId: version.version_id,
        projectId: project.project_id, tenantId, userId: user.id, approvedLabel: 'v1.0 Approved' })  // Save + Approve
      const ver = await q(db.from('versions').select('*').eq('version_id', version.version_id).single())
      check(label + ' · version approved with timestamp', ver.status === 'approved' && !!ver.approved_at)
      const shown = await loadLatestModelOutput(db, version.version_id)                              // Reload
      const { _persistence, ...financial } = shown || {}
      // Exact, key-order-insensitive comparison: jsonb reorders object keys,
      // so JSON-text equality is not a valid test (see exact-compare.mjs).
      const resultDiff = exactDiff(strip(out), financial)
      check(label + ' · reloaded result = engine output (exact)', resultDiff.equal, describeDiff(resultDiff))
      check(label + ' · engine version + periodicity stored', _persistence && _persistence.engine_version === PPP_ENGINE_VERSION && shown.periodicity === out.periodicity)
      check(label + ' · currency = current', assessResultCurrency(shown, { engineVersion: PPP_ENGINE_VERSION,
        compatibleVersions: PPP_ENGINE_COMPATIBLE_VERSIONS, assumptions }).status === 'current')
      const sched = buildDebtScheduleRows(shown)
      const schedDiff = exactDiff(strip(out.debt_schedule), sched)
      check(label + ' · debt schedule (saved) reconciles', schedDiff.equal && Math.abs(sched[sched.length - 1].closing) <= 2,
        describeDiff(schedDiff) + '; COD ' + Math.round(out.debt_amount) + ', IDC ' + Math.round(out.idc_capitalized))
      check(label + ' · funding summary rendered', (pppFundingSummaryRows(shown) || []).length >= 10)
      const pdf = pppPdfMetricValues(shown, { engineVersion: PPP_ENGINE_VERSION, compatibleVersions: PPP_ENGINE_COMPATIBLE_VERSIONS })
      check(label + ' · PDF values from saved record', pdf.basis.startsWith('Saved result') && pdf.debt_amount === out.debt_amount, pdf.basis)
      // FP&A (same query as the FP&A page): date from the APPROVED inputs record,
      // first operating month = first operating period ÷ its months; month after
      // the concession is outside the timeline.
      const fpaRows = await q(db.from('model_outputs').select('*').eq('version_id', version.version_id)
        .order('computed_at', { ascending: false }).limit(1))
      const basis = resolvePPPFpaBasis(fpaRows[0], assumptions)
      const P = out.periods_per_year > 1 ? out.cash_flows_periodic : out.cash_flows
      const firstOps = P.find(r => r.phase === 'Operations'), mpp = 12 / (out.periods_per_year || 1)
      const est = basis.status === 'ok' ? pppMonthlyBudget(basis.result, basis.startDate, basis.bounds.operationsStart) : null
      const [ey, em] = basis.status === 'ok' ? basis.bounds.concessionEnd.split('-').map(Number) : [0, 0]
      const afterEnd = em === 12 ? (ey + 1) + '-01' : ey + '-' + String(em + 1).padStart(2, '0')
      check(label + ' · FP&A monthly estimate from approved date',
        basis.status === 'ok' && basis.startDate === inputs['Construction Start Date'] && est && est.status === 'ok' &&
        est.phase === 'Operations' && est.budget.REV_AVAILABILITY === Math.round(firstOps.revenue / mpp) &&
        !('REV_SALE' in est.budget) && pppMonthlyBudget(basis.result, basis.startDate, afterEnd).status === 'after_concession',
        basis.status === 'ok'
          ? 'start ' + basis.startDate + ' · operations from ' + basis.bounds.operationsStart + ' · concession ends ' + basis.bounds.concessionEnd
          : basis.status)
    } catch (e) {
      check(label + ' · lifecycle', false, e.message)
    }
  }

  // Legacy-style row (pre-P-022 shape) on a synthetic version must still display, flagged historical
  try {
    const { version } = await createSyntheticProject('Legacy row display', BASE, user, tenantId)
    const out = runPPPEngine(Object.entries(BASE).map(([name, value]) => ({ name, value })))
    await q(db.from('model_outputs').insert({ version_id: version.version_id, project_id: created.projects.at(-1), tenant_id: tenantId,
      created_by: user.id, irr: out.irr, npv: out.npv, equity_multiple: out.equity_multiple, dscr_series: out.dscr_series,
      cash_flows: out.cash_flows }))
    const shown = await loadLatestModelOutput(db, version.version_id)
    check('Legacy row · displayed and flagged historical', shown && shown._persistence.legacy === true && shown.irr === out.irr)
  } catch (e) { check('Legacy row · display', false, e.message) }

  console.table(results)
  if (cleanup) {
    for (const v of created.versions) { await db.from('model_outputs').delete().eq('version_id', v); await db.from('intake_state').delete().eq('version_id', v) }
    for (const p of created.projects) await db.from('assumptions').delete().eq('project_id', p)
    for (const v of created.versions) await db.from('versions').delete().eq('version_id', v)
    for (const s of created.scenarios) await db.from('scenarios').delete().eq('scenario_id', s)
    for (const p of created.projects) await db.from('projects').delete().eq('project_id', p)
    console.log('Cleanup attempted for ' + created.projects.length + ' synthetic project(s).')
  } else {
    console.log('Synthetic projects kept (names start with "SYNTHETIC —"). Re-run with -- --cleanup to delete them.')
  }
  const failed = results.filter(r => r.result === 'FAIL').length
  console.log(failed ? '\n✖ ' + failed + ' check(s) failed' : '\n✔ All staging checks passed')
  process.exit(failed ? 1 : 0)
}
main().catch(e => fail(e.message))


