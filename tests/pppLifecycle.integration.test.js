/**
 * pppLifecycle.integration.test.js — database-backed end-to-end lifecycle
 *
 *   Inputs → Calculation → Save → Approve → Reload → Display → PDF values
 *
 * Runs against an embedded Postgres (PGlite, in-memory) with the REAL
 * migration file db/migrations/2026-10-10_p022_versioned_model_outputs.sql
 * and the same store functions the page uses (pppResultStore.js). No
 * network, no Supabase, no production data.
 */
import { createTestDb, applyP022Migration, supabaseLike } from './helpers/pgliteSupabase.js'
import { runPPPEngine, computePPPBankability, PPP_ENGINE_VERSION, PPP_ENGINE_COMPATIBLE_VERSIONS }
  from '../src/modules/feasibility/annualEngine.js'
import { savePPPApproval, loadLatestModelOutput } from '../src/modules/feasibility/pppResultStore.js'
import { assessResultCurrency } from '../src/modules/feasibility/resultPersistence.js'
import { buildDebtScheduleRows } from '../src/modules/feasibility/debtSchedule.js'
import { pppFundingSummaryRows, pppPdfMetricValues, pppResultBasis, isUnsupportedProjectFinance }
  from '../src/modules/feasibility/pppReporting.js'
import { fmtNumber, fmtIRR } from '../src/utils/format.js'
import { getRecommendation } from '../src/utils/recommend.js'

const VERS = { engineVersion: PPP_ENGINE_VERSION, compatibleVersions: PPP_ENGINE_COMPATIBLE_VERSIONS }
const PROJECT = '11111111-1111-1111-1111-111111111111'
const TENANT  = '22222222-2222-2222-2222-222222222222'
const USER    = '33333333-3333-3333-3333-333333333333'
const rows = obj => Object.entries(obj).map(([name, v]) => (typeof v === 'string'
  ? { name, value: null, unit: v, category: 'ppp_structure' } : { name, value: v, unit: null, category: 'ppp_structure' }))
const BASE = {
  'Total Project Cost': 100_000_000, 'Debt %': 80, 'Equity %': 20,
  'Annual Availability Payment': 12_000_000, 'Concession Period': 25,
  'Construction Period': 24, 'OPEX % of Revenue': 5, 'Interest Rate': 7,
  'Loan Tenor': 10, 'Grace Period': 2, 'Tax Rate': 20, 'WACC': 10,
}
const CASES = {
  'annual, IDC, DSCR-bound': BASE,
  'quarterly, IDC': { ...BASE, 'Model Periodicity': 'Quarterly' },
  'variable CFADS (escalation + demand profile, annuity)': { ...BASE,
    'Availability Payment Escalation %': 2.5, 'OPEX Amount (JOD)': 800_000, 'OPEX Escalation %': 3.5,
    'Revenue Profile': Array.from({ length: 25 }, (_, i) => 9e6 + 250_000 * i).join(','), 'Revenue Basis': 'Demand Estimate',
    'Repayment Profile': 'Annuity' },
  'quarterly Madaba (benchmark timing, sculpted at 1.00×)': {
    'Model Periodicity': 'Quarterly', 'Total Project Cost': 50_788_939, 'Debt %': 84.899, 'Equity %': 15.101,
    'Annual Availability Payment': 8_800_000, 'Concession Period': 10, 'Construction Period': 36,
    'Construction Cost Profile': '6232.8,3008.4,6434.0,6443.8,3654.5,3554.5,3554.5,3554.5,3654.5,3554.5,3554.5,3588.4',
    'OPEX Amount (JOD)': 54_020, 'OPEX Escalation %': 2.015, 'Interest Rate': 8.25, 'Loan Tenor': 9.5,
    'Grace Period': 0, 'Tax Rate': 0, 'WACC': 10, 'Target DSCR': 1.0 },
}

async function newDraft(pg, label = 'v1.0 Draft') {
  const r = await pg.query('insert into versions (label, status, created_by) values ($1, $2, $3) returning *', [label, 'draft', USER])
  return r.rows[0]
}
const strip = o => JSON.parse(JSON.stringify(o))

describe('P-022 migration on a real Postgres engine', () => {
  test('M1: additive — pre-existing (legacy) rows are byte-identical after migration; new columns NULL', async () => {
    const pg = await createTestDb(), db = supabaseLike(pg)
    const v = await newDraft(pg, 'v1.0 Approved')
    const legacy = runPPPEngine(rows(BASE))
    await db.from('model_outputs').insert({ version_id: v.version_id, project_id: PROJECT, tenant_id: TENANT, created_by: USER,
      irr: legacy.irr, npv: legacy.npv, equity_multiple: legacy.equity_multiple, dscr_series: legacy.dscr_series, cash_flows: legacy.cash_flows })
    const before = (await pg.query('select * from model_outputs')).rows
    await applyP022Migration(pg)
    const after = (await pg.query('select * from model_outputs')).rows
    expect(after).toHaveLength(1)
    Object.keys(before[0]).forEach(k => expect(after[0][k]).toEqual(before[0][k]))
    ;['engine_version', 'result_schema_version', 'periodicity', 'result_payload', 'inputs_snapshot']
      .forEach(k => expect(after[0][k]).toBeNull())
    const cols = (await pg.query(`select column_name, data_type, is_nullable from information_schema.columns
      where table_name = 'model_outputs' and column_name in ('engine_version','result_schema_version','periodicity','result_payload','inputs_snapshot')
      order by column_name`)).rows
    expect(cols).toEqual([
      { column_name: 'engine_version', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'inputs_snapshot', data_type: 'jsonb', is_nullable: 'YES' },
      { column_name: 'periodicity', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'result_payload', data_type: 'jsonb', is_nullable: 'YES' },
      { column_name: 'result_schema_version', data_type: 'integer', is_nullable: 'YES' },
    ])
  })

  test('M2: idempotent — applying the migration twice is harmless', async () => {
    const pg = await createTestDb()
    await applyP022Migration(pg)
    await expect(applyP022Migration(pg)).resolves.not.toThrow()
  })

  test('M3: before the migration, PPP approval is refused and NOTHING is written', async () => {
    const pg = await createTestDb(), db = supabaseLike(pg)
    const v = await newDraft(pg)
    const out = runPPPEngine(rows(BASE))
    await expect(savePPPApproval(db, { output: out, assumptions: rows(BASE), engineVersion: PPP_ENGINE_VERSION,
      versionId: v.version_id, projectId: PROJECT, tenantId: TENANT, userId: USER, approvedLabel: 'v1.0 Approved' }))
      .rejects.toMatchObject({ code: 'P022_MIGRATION_MISSING' })
    expect((await pg.query('select count(*)::int n from model_outputs')).rows[0].n).toBe(0)
    expect((await pg.query('select status from versions')).rows[0].status).toBe('draft')
  })
})

describe.each(Object.entries(CASES))('Lifecycle — %s', (_label, inputs) => {
  let pg, db, v, out, saved, shown
  const assumptions = rows(inputs)

  beforeAll(async () => {
    pg = await createTestDb(); db = supabaseLike(pg)
    await applyP022Migration(pg)
    v = await newDraft(pg)
    out = runPPPEngine(assumptions)                                                   // Calculation
    saved = await savePPPApproval(db, { output: out, assumptions, engineVersion: PPP_ENGINE_VERSION,   // Save + Approve
      versionId: v.version_id, projectId: PROJECT, tenantId: TENANT, userId: USER, approvedLabel: 'v1.0 Approved' })
    shown = await loadLatestModelOutput(db, v.version_id)                              // Reload
  })

  test('L1: approval metadata — version approved with timestamp and label; one immutable result row', async () => {
    const ver = (await pg.query('select * from versions where version_id = $1', [v.version_id])).rows[0]
    expect(ver.status).toBe('approved')
    expect(ver.label).toBe('v1.0 Approved')
    expect(ver.approved_at).toBeInstanceOf(Date)
    const r = (await pg.query('select * from model_outputs')).rows
    expect(r).toHaveLength(1)
    expect(r[0].created_by).toBe(USER)
    expect(r[0].computed_at).toBeInstanceOf(Date)
    expect(r[0].engine_version).toBe(PPP_ENGINE_VERSION)
    expect(r[0].periodicity).toBe(out.periodicity)
    expect(r[0].result_schema_version).toBe(1)
    expect(saved.output_id).toBe(r[0].output_id)
  })

  test('L2: complete outputs and inputs persist exactly (jsonb + numeric round trip)', async () => {
    const r = (await pg.query('select * from model_outputs')).rows[0]
    expect(r.result_payload).toEqual(strip(out))
    expect(r.irr).toBe(out.irr); expect(r.npv).toBe(out.npv); expect(r.equity_multiple).toBe(out.equity_multiple)
    expect(r.cash_flows).toEqual(strip(out.cash_flows))
    expect(r.dscr_series).toEqual(strip(out.dscr_series))
    expect(r.inputs_snapshot.map(x => x.name)).toEqual(Object.keys(inputs).sort())
    if (out.periodicity === 'quarterly') expect(r.result_payload.debt_schedule_periodic.length).toBe(out.debt_schedule_periodic.length)
  })

  test('L3: reload displays the SAVED result verbatim (no recalculation)', () => {
    const { _persistence, ...financial } = shown
    expect(financial).toEqual(strip(out))
    expect(_persistence.legacy).toBe(false)
    expect(assessResultCurrency(shown, { ...VERS, assumptions }).status).toBe('current')
    expect(assessResultCurrency(shown, { ...VERS, assumptions }).inputs_changed).toEqual([])
  })

  test('L4: Results display — debt schedule, IDC, funding summary and gates reconcile to the engine', () => {
    expect(buildDebtScheduleRows(shown)).toEqual(strip(out.debt_schedule))
    const sched = buildDebtScheduleRows(shown), nC = shown.construction_years
    expect(Math.abs(sched[nC - 1].closing - shown.debt_amount)).toBeLessThanOrEqual(1)               // COD = principal + IDC
    expect(Math.abs(sched[sched.length - 1].closing)).toBeLessThanOrEqual(2)                         // fully repaid
    const summary = Object.fromEntries(pppFundingSummaryRows(shown))
    expect(summary['Capitalised interest during construction (IDC)']).toBe(fmtNumber(out.idc_capitalized))
    expect(summary['Senior debt — balance at COD (principal + IDC)']).toBe(fmtNumber(out.debt_amount))
    expect(summary['Equity IRR (levered)']).toBe(fmtIRR(out.irr))
    expect(summary['Meets underwriting minimum']).toBe(out.debt_sizing.meets_underwriting ? 'Yes' : 'No')
    // P-018: the bankability gate and the recommendation use the saved underwriting threshold
    const uw = shown.debt_sizing.underwriting_dscr
    const bank = computePPPBankability(shown, uw)
    expect(bank.dscrOk).toBe(out.debt_sizing.meets_underwriting)
    const rec = getRecommendation({ irr: shown.irr, npv: shown.npv, minDSCR: bank.minDSCR, equityMultiple: shown.equity_multiple,
      paybackYear: null, dscrBreachYear: null, isPPP: true, pppDscrFloor: uw, irrHurdle: 10 })
    if (!out.debt_sizing.meets_underwriting) {
      expect(rec.verdict).not.toBe('Proceed')
      if (bank.minDSCR >= 1) expect(rec.riskFlags.map(r => r.message)).toContain('PPP DSCR below project finance floor')
    }
  })

  test('L5: PDF values — result basis, project IRR, IDC, COD debt, underwriting come from the saved record', () => {
    const pdf = pppPdfMetricValues(shown, VERS)
    expect(pdf.basis).toBe('Saved result, engine v' + PPP_ENGINE_VERSION + ' · ' + out.periodicity + ' model')
    expect(pdf.project_irr).toBe(out.project_irr)
    expect(pdf.idc_capitalized).toBe(out.idc_capitalized)
    expect(pdf.debt_amount).toBe(out.debt_amount)
    expect(pdf.underwriting_dscr).toBe(out.debt_sizing.underwriting_dscr)
  })

  test('L6: editing inputs after approval changes nothing saved; the drift is disclosed', async () => {
    const edited = assumptions.map(a => a.name === 'Interest Rate' ? { ...a, value: 9 } : a)
    const again = await loadLatestModelOutput(db, v.version_id)
    expect(again.irr).toBe(out.irr)
    expect(assessResultCurrency(again, { ...VERS, assumptions: edited }).inputs_changed)
      .toEqual([{ name: 'Interest Rate', from: inputs['Interest Rate'], to: 9 }])
  })
})

describe('Lifecycle — legacy approvals, outdated engines, history, failure', () => {
  test('H1: legacy approvals (pre-P-022) remain displayable after migration, flagged historical', async () => {
    const pg = await createTestDb(), db = supabaseLike(pg)
    const v = await newDraft(pg, 'v1.0 Approved')
    const old = runPPPEngine(rows({ ...BASE, 'Construction Interest Rate': 0 }))       // a pre-IDC era result
    const legacyCF = old.cash_flows.map(({ idc, ...r }) => r)                         // pre-IDC rows had no idc field
    await db.from('model_outputs').insert({ version_id: v.version_id, project_id: PROJECT, tenant_id: TENANT, created_by: USER,
      irr: old.irr, npv: old.npv, equity_multiple: old.equity_multiple, dscr_series: old.dscr_series, cash_flows: legacyCF })
    await applyP022Migration(pg)
    const shown = await loadLatestModelOutput(db, v.version_id)
    const cur = assessResultCurrency(shown, { ...VERS, assumptions: rows(BASE) })
    expect(cur.status).toBe('legacy')
    expect(cur.inferred_generation).toMatch(/015a/)
    expect(shown.irr).toBe(old.irr)                                                      // shown as approved, not recalculated
    expect(pppFundingSummaryRows(shown)).toBeNull()                                     // no stored debt sizing → no fabricated summary
    expect(buildDebtScheduleRows(shown)).not.toBeNull()
    expect(pppPdfMetricValues(shown, VERS).basis).toMatch(/^Historical/)
  })

  test('H2: a result from an outdated engine version is flagged, never recalculated', async () => {
    const pg = await createTestDb(), db = supabaseLike(pg)
    await applyP022Migration(pg)
    const v = await newDraft(pg)
    const out = runPPPEngine(rows(BASE))
    await savePPPApproval(db, { output: out, assumptions: rows(BASE), engineVersion: '1.9.0', versionId: v.version_id,
      projectId: PROJECT, tenantId: TENANT, userId: USER, approvedLabel: 'v1.0 Approved' })
    const shown = await loadLatestModelOutput(db, v.version_id)
    expect(assessResultCurrency(shown, { ...VERS, assumptions: rows(BASE) }).status).toBe('stale_engine')
    expect(pppResultBasis(shown, VERS)).toBe('Outdated engine v1.9.0 (current v' + PPP_ENGINE_VERSION + ') · annual model')
    expect(shown.irr).toBe(out.irr)
  })

  test('H3: history is preserved — re-approval creates a new version and row; the earlier approval is unchanged', async () => {
    const pg = await createTestDb(), db = supabaseLike(pg)
    await applyP022Migration(pg)
    const v1 = await newDraft(pg, 'v1.0 Draft')
    const o1 = runPPPEngine(rows(BASE))
    await savePPPApproval(db, { output: o1, assumptions: rows(BASE), engineVersion: PPP_ENGINE_VERSION, versionId: v1.version_id,
      projectId: PROJECT, tenantId: TENANT, userId: USER, approvedLabel: 'v1.0 Approved' })
    const snap1 = (await pg.query('select * from model_outputs where version_id = $1', [v1.version_id])).rows[0]
    const v2 = await newDraft(pg, 'v2.0 Draft')
    const in2 = rows({ ...BASE, 'Annual Availability Payment': 13_000_000 })
    const o2 = runPPPEngine(in2)
    await savePPPApproval(db, { output: o2, assumptions: in2, engineVersion: PPP_ENGINE_VERSION, versionId: v2.version_id,
      projectId: PROJECT, tenantId: TENANT, userId: USER, approvedLabel: 'v2.0 Approved' })
    expect((await pg.query('select count(*)::int n from model_outputs')).rows[0].n).toBe(2)
    expect((await pg.query('select * from model_outputs where version_id = $1', [v1.version_id])).rows[0]).toEqual(snap1)
    expect((await loadLatestModelOutput(db, v1.version_id)).irr).toBe(o1.irr)
    expect((await loadLatestModelOutput(db, v2.version_id)).irr).toBe(o2.irr)
  })

  test('H4: if approving the version fails, the inserted result is rolled back and the version stays a draft', async () => {
    const pg = await createTestDb(), db = supabaseLike(pg)
    await applyP022Migration(pg)
    await pg.exec(`create function block_approve() returns trigger language plpgsql as $$
      begin if new.label = 'FAIL' then raise exception 'simulated approval failure'; end if; return new; end $$;
      create trigger t_block before update on versions for each row execute function block_approve();`)
    const v = await newDraft(pg)
    const out = runPPPEngine(rows(BASE))
    await expect(savePPPApproval(db, { output: out, assumptions: rows(BASE), engineVersion: PPP_ENGINE_VERSION, versionId: v.version_id,
      projectId: PROJECT, tenantId: TENANT, userId: USER, approvedLabel: 'FAIL' })).rejects.toBeTruthy()
    expect((await pg.query('select count(*)::int n from model_outputs')).rows[0].n).toBe(0)
    expect((await pg.query('select status from versions')).rows[0].status).toBe('draft')
  })

  test('H5: unsupported project-finance contract models are identified (calculation and approval disabled)', () => {
    expect(isUnsupportedProjectFinance({ project_type: 'Infrastructure / PPP', revenue_model: 'Demand-based' }, [])).toBe(true)
    expect(isUnsupportedProjectFinance({ project_type: 'Infrastructure / PPP', revenue_model: 'PPA' }, [])).toBe(true)
    expect(isUnsupportedProjectFinance({ project_type: 'Infrastructure / PPP', revenue_model: 'Availability Payment' }, [])).toBe(false)
    expect(isUnsupportedProjectFinance({ project_type: 'Real Estate', delivery_model: 'PPP', revenue_model: 'Sales' }, [])).toBe(false)
    expect(isUnsupportedProjectFinance({ project_type: 'Infrastructure / PPP' },
      [{ name: 'Contract Model', value: null, unit: 'Availability Payment' }])).toBe(false)              // legacy AP project
  })
})
