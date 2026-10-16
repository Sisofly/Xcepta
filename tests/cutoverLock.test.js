/**
 * cutoverLock.test.js — temporary SEC-04 cutover lock (db/security/cutover_lock_{on,off,preflight}.sql),
 * run as the exact files on the post-SEC-03 staging schema (PGlite, Supabase roles simulated).
 *
 *  L0 guards and the read-only state check
 *  L1 stages A → B → C → D and every rollback path: exact grants fingerprints
 *  L2 the old Preview (2e4994c request sequences, intermediate errors ignored as in the
 *     deployed code) cannot leave partial data — at stage B and at stage C, freeze on and off
 *  L3 the SEC-03 lifecycle functions keep working while locked
 *  L4 FP&A replacement submissions: no duplicate or partial rows
 *  L5 the HTTP probe's request semantics (what probe-lock.mjs relies on); never writes
 */
import { readFileSync } from 'node:fs'
import { createSecurityDb, asClient } from './helpers/pgliteSecurity.js'
import { runPPPEngine, PPP_ENGINE_VERSION } from '../src/modules/feasibility/annualEngine.js'
import { savePPPApproval } from '../src/modules/feasibility/pppResultStore.js'

const file = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
const ON = file('db/security/cutover_lock_on.sql')
const OFF = file('db/security/cutover_lock_off.sql')
const STATE = file('db/security/cutover_lock_preflight.sql')
const SEC04 = file('db/migrations/2026-10-16_sec04_record_protection.sql')
const SEC04_RB = file('db/migrations/rollback/2026-10-16_sec04_rollback.sql')
const M_ON = file('db/security/maintenance_on.sql')
const M_OFF = file('db/security/maintenance_off.sql')
const FP = { A: '264e089a3a351afa75905fcd1f4b193c', B: 'fabdac15a44f3ca18df6fcb894f86101', C: '24b12f0ed2ae58fa8ae7030c61b94989',
  D: '8420a1981965e2e68785c10e12694499', R1: 'd9706beb7c5baf5ef1109202a8e0ffd6' }
const LOCKED_PRIVILEGES = ['actuals:DELETE', 'actuals:INSERT', 'assumptions:DELETE', 'model_outputs:DELETE', 'projects:DELETE',
  'scenarios:DELETE', 'variances:DELETE', 'variances:INSERT', 'versions:DELETE']

const rows = o => Object.entries(o).map(([name, v]) => (typeof v === 'string'
  ? { name, value: null, unit: v, category: 'ppp_structure' } : { name, value: v, unit: null, category: 'ppp_structure' }))
const BASE = { 'Total Project Cost': 100e6, 'Debt %': 80, 'Equity %': 20, 'Annual Availability Payment': 12e6,
  'Concession Period': 25, 'Construction Period': 24, 'OPEX % of Revenue': 5, 'Interest Rate': 7, 'Loan Tenor': 10,
  'Grace Period': 2, 'Tax Rate': 21, 'WACC': 10, 'Target DSCR': 1.2, 'Construction Start Date': '2026-07-01' }

let pg, U, C
const one = async (q, v) => (await pg.query(q, v)).rows[0]
const fingerprint = async () => (await one(`select md5(string_agg(table_name || ':' || grantee || ':' || privilege_type, '|' order by table_name, grantee, privilege_type)) m
  from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')`)).m
const authPrivileges = async () => (await pg.query(`select table_name || ':' || privilege_type p from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'authenticated' order by 1`)).rows.map(r => r.p)
const state = async () => (await pg.query(STATE)).rows[0]
async function fails(sql, re) { await expect(pg.exec(sql)).rejects.toThrow(re); await pg.exec('rollback') }

async function world(upTo = 4, extraEmails = []) {
  pg = await createSecurityDb({ upTo })
  const ids = await one(`select gen_random_uuid() t, gen_random_uuid() tb, gen_random_uuid() adm, gen_random_uuid() mgr,
    gen_random_uuid() an, gen_random_uuid() vw, gen_random_uuid() badm`)
  U = ids
  await pg.exec(`begin; select set_config('xcepta.ctx', 'admin', true);
    insert into tenants (tenant_id, name) values ('${ids.t}', 'Staging A'), ('${ids.tb}', 'Staging B');
    insert into auth.users (id, email) values ('${ids.adm}', 'adm@xcepta.test'), ('${ids.mgr}', 'mgr@xcepta.test'),
      ('${ids.an}', 'an@xcepta.test'), ('${ids.vw}', 'vw@xcepta.test'), ('${ids.badm}', 'badm@xcepta.test');
    insert into users (user_id, tenant_id, email, name, role) values ('${ids.adm}', '${ids.t}', 'adm@xcepta.test', 'Admin', 'admin'),
      ('${ids.mgr}', '${ids.t}', 'mgr@xcepta.test', 'Manager', 'manager'), ('${ids.an}', '${ids.t}', 'an@xcepta.test', 'Analyst', 'analyst'),
      ('${ids.vw}', '${ids.t}', 'vw@xcepta.test', 'Viewer', 'viewer'), ('${ids.badm}', '${ids.tb}', 'badm@xcepta.test', 'B Admin', 'admin');
    commit;`)
  for (const e of extraEmails) await pg.query('insert into auth.users (id, email) values (gen_random_uuid(), $1)', [e])
  C = Object.fromEntries(['adm', 'mgr', 'an', 'vw', 'badm'].map(k => [k, asClient(pg, { role: 'authenticated', sub: ids[k] })]))
  C.op = asClient(pg, { role: 'service_role' })
}
const ok = r => { if (r && r.error) throw new Error(r.error.message); return r && r.data }

// A project as the app creates it: base scenario + draft + intake + project assumptions, a named scenario
// with a draft and a scenario-level driver, FP&A actuals and variances for two periods.
async function project(owner, uid, name, { approve = false } = {}) {
  const c = C[owner]
  const p = ok(await c.from('projects').insert({ tenant_id: U.t, name, project_type: 'Infrastructure / PPP', revenue_model: 'Availability Payment', created_by: uid }).select())[0]
  const s = ok(await c.from('scenarios').insert({ project_id: p.project_id, name: 'Base', type: 'base' }).select())[0]
  const v = ok(await c.from('versions').insert({ scenario_id: s.scenario_id, label: 'v1.0 Draft', status: 'draft', created_by: uid }).select())[0]
  ok(await c.from('intake_state').insert({ version_id: v.version_id, section_completion_status: {}, validation_flags: {} }))
  const a = ok(await c.from('assumptions').insert(rows(BASE).map(r => ({ ...r, tenant_id: U.t, project_id: p.project_id,
    module_origin: 'feasibility', source_type: 'user_entry', author_user_id: uid }))).select())
  const bull = ok(await c.from('scenarios').insert({ project_id: p.project_id, name: 'Bull', type: 'named', scenario_type: 'bull' }).select())[0]
  const bv = ok(await c.from('versions').insert({ scenario_id: bull.scenario_id, label: 'v1.0 Draft', status: 'draft', created_by: uid }).select())[0]
  const driver = ok(await c.from('assumptions').insert({ tenant_id: U.t, project_id: p.project_id, scenario_id: bull.scenario_id, name: 'Debt %',
    value: 75, module_origin: 'feasibility', source_type: 'user_entry', author_user_id: uid }).select())[0]
  for (const period of ['2027-01', '2027-02']) {
    ok(await c.from('actuals').insert(['REV_AP', 'OPEX'].map(n => ({ tenant_id: U.t, project_id: p.project_id, period, coa_node: n, amount: 100, created_by: uid }))))
    ok(await c.from('variances').insert(['REV_AP', 'OPEX'].map(n => ({ tenant_id: U.t, project_id: p.project_id, version_id: v.version_id, period,
      coa_node: n, budget_amount: 100, actual_amount: 100, severity_flag: 'green', created_by: uid }))))
  }
  if (approve) await savePPPApproval(C.mgr, { output: runPPPEngine(rows(BASE)), assumptions: rows(BASE), engineVersion: PPP_ENGINE_VERSION,
    versionId: v.version_id, projectId: null, tenantId: null, userId: null, approvedLabel: 'v1.0 Approved' })
  return { p, s, v, bull, bv, override: a.find(x => x.name === 'Debt %'), driver }
}
// Every row belonging to a project, as the owner (bypasses RLS): one fingerprint per table.
const projectRows = async pid => one(`select
  (select count(*)::int || ':' || md5(coalesce(string_agg(x::text, '|' order by x.assumption_id), '')) from assumptions x where project_id = $1) assumptions,
  (select count(*)::int || ':' || md5(coalesce(string_agg(x::text, '|' order by x.actual_id), '')) from actuals x where project_id = $1) actuals,
  (select count(*)::int || ':' || md5(coalesce(string_agg(x::text, '|' order by x.variance_id), '')) from variances x where project_id = $1) variances,
  (select count(*)::int || ':' || md5(coalesce(string_agg(x::text, '|' order by x.output_id), '')) from model_outputs x where project_id = $1) model_outputs,
  (select count(*)::int || ':' || md5(coalesce(string_agg(x::text, '|' order by x.version_id), '')) from versions x join scenarios s using (scenario_id) where s.project_id = $1) versions,
  (select count(*)::int || ':' || md5(coalesce(string_agg(i::text, '|' order by i.intake_id), '')) from intake_state i join versions x using (version_id) join scenarios s using (scenario_id) where s.project_id = $1) intake,
  (select count(*)::int || ':' || md5(coalesce(string_agg(x::text, '|' order by x.scenario_id), '')) from scenarios x where project_id = $1) scenarios,
  (select count(*)::int from projects where project_id = $1) project`, [pid])

// ── deployed app 2e4994c request sequences (copied from the deployed code; intermediate errors ignored) ──
async function oldDeleteProject(c, pid) {                      // src/pages/Feasibility.jsx handleDelete
  await c.from('model_outputs').delete().eq('project_id', pid)
  await c.from('variances').delete().eq('project_id', pid)
  await c.from('actuals').delete().eq('project_id', pid)
  await c.from('assumptions').delete().eq('project_id', pid)
  const sc = (await c.from('scenarios').select('scenario_id').eq('project_id', pid)).data || []
  for (const s of sc) await c.from('versions').delete().eq('scenario_id', s.scenario_id)   // .in('scenario_id', ids) in the app
  await c.from('scenarios').delete().eq('project_id', pid)
  return c.from('projects').delete().eq('project_id', pid)
}
async function oldDeleteScenario(c, pid, sc, latestVersionId) {   // src/pages/FeasibilityProject.jsx handleDeleteScenario
  await c.from('model_outputs').delete().eq('version_id', latestVersionId)
  await c.from('versions').delete().eq('scenario_id', sc)
  await c.from('assumptions').delete().eq('project_id', pid).eq('scenario_id', sc)
  await c.from('scenarios').delete().eq('scenario_id', sc)
}
// FP&A replacement — identical sequence in 2e4994c and in the new app (src/pages/FPAProject.jsx):
// delete the period's actuals (error ignored), insert (error thrown), same for variances.
async function fpaSubmit(c, uid, x, period, amount) {
  await c.from('actuals').delete().eq('project_id', x.p.project_id).eq('period', period)
  const a = await c.from('actuals').insert(['REV_AP', 'OPEX'].map(n => ({ tenant_id: U.t, project_id: x.p.project_id, period, coa_node: n, amount, created_by: uid })))
  if (a.error) return 'stopped at actuals insert: ' + a.error.message
  await c.from('variances').delete().eq('project_id', x.p.project_id).eq('period', period)
  const v = await c.from('variances').insert(['REV_AP', 'OPEX'].map(n => ({ tenant_id: U.t, project_id: x.p.project_id, version_id: x.v.version_id, period,
    coa_node: n, budget_amount: 100, actual_amount: amount, severity_flag: 'green', created_by: uid })))
  if (v.error) return 'stopped at variances insert: ' + v.error.message
  return 'saved'
}
const toStage = async stage => {                                 // from a fresh post-SEC-03 world
  if (stage === 'A') return
  await pg.exec(ON)
  if (stage === 'C') await pg.exec(SEC04)
}

describe('L0 guards and state check', () => {
  afterEach(async () => { await pg.close() })
  test('L0.1 stage A (staging now): unlocked, fingerprint as staging reported, no foreign grantors, anon without privileges', async () => {
    await world()
    expect(await state()).toMatchObject({ lock_state: 'unlocked', sec04_triggers: 0, grants_md5_now: FP.A, anon_privileges: false,
      other_grantor_privileges: 0, sec03_present: 1, non_test_auth_users: 0 })
  })
  test('L0.2 lock and unlock refuse without SEC-03 (Production) — nothing changed', async () => {
    await world(3)
    const before = await fingerprint()
    await fails(ON, /SEC-03 is not present/)
    await fails(OFF, /SEC-03 is not present/)
    expect(await fingerprint()).toBe(before)
  })
  test('L0.3 lock refuses when a non-synthetic Auth account exists — nothing changed', async () => {
    await world(4, ['person@gmail.com'])
    await fails(ON, /non-synthetic Auth accounts/)
    await fails(OFF, /non-synthetic Auth accounts/)
    expect(await fingerprint()).toBe(FP.A)
  })
  test('L0.4 a privilege granted by another role survives REVOKE: the lock detects it and changes nothing', async () => {
    await world()
    await pg.exec(`create role other_grantor; grant delete on public.assumptions to other_grantor with grant option;
      set role other_grantor; grant delete on public.assumptions to authenticated; reset role;`)
    expect((await state()).other_grantor_privileges).toBe(1)
    const before = await fingerprint()
    await fails(ON, /DELETE on assumptions still effective/)
    expect(await fingerprint()).toBe(before)
    expect((await state()).lock_state).toBe('unlocked')
  })
})

describe('L1 stages, fingerprints and rollback paths (exact files)', () => {
  beforeEach(async () => { await world() })
  afterEach(async () => { await pg.close() })
  test('L1.1 A → freeze → B → C → freeze off → D, idempotent at every step', async () => {
    const a = await authPrivileges()
    await pg.exec(M_ON); expect(await fingerprint()).toBe(FP.A)
    await pg.exec(ON); await pg.exec(ON)
    expect(await state()).toMatchObject({ lock_state: 'locked', sec04_triggers: 0, grants_md5_now: FP.B })
    expect(a.filter(p => !LOCKED_PRIVILEGES.includes(p))).toEqual(await authPrivileges())       // exactly the 9 privileges removed
    await pg.exec(SEC04)
    expect(await state()).toMatchObject({ lock_state: 'locked', sec04_triggers: 8, grants_md5_now: FP.C, maintenance_policies: 13 })
    await pg.exec(M_OFF); expect(await fingerprint()).toBe(FP.C)
    await pg.exec(OFF); await pg.exec(OFF)
    expect(await state()).toMatchObject({ lock_state: 'unlocked', sec04_triggers: 8, grants_md5_now: FP.D })
    await pg.exec(ON); expect(await fingerprint()).toBe(FP.C)                                    // re-lock after SEC-04
  })
  test('L1.2 a failed SEC-04 changes nothing: the lock stays (B); unlock returns exactly to A; a retry reaches C', async () => {
    await pg.exec(ON)
    const failing = SEC04.replace(/commit;\s*$/, 'select 1 / 0;\ncommit;\n')
    expect(failing).not.toBe(SEC04)
    await fails(failing, /division by zero/)
    expect(await state()).toMatchObject({ lock_state: 'locked', sec04_triggers: 0, grants_md5_now: FP.B })
    await pg.exec(SEC04); expect(await fingerprint()).toBe(FP.C)
    await pg.exec(SEC04_RB); await pg.exec(ON); await pg.exec(OFF)
    expect(await state()).toMatchObject({ lock_state: 'unlocked', sec04_triggers: 0, grants_md5_now: FP.A })
  })
  test('L1.3 SEC-04 rolled back while locked → PARTIAL (R1); re-running the lock → B; abandoning → A', async () => {
    await pg.exec(ON); await pg.exec(SEC04)
    await pg.exec(SEC04_RB)
    expect(await state()).toMatchObject({ lock_state: 'PARTIAL', sec04_triggers: 0, grants_md5_now: FP.R1 })
    await pg.exec(ON)
    expect(await state()).toMatchObject({ lock_state: 'locked', grants_md5_now: FP.B })
    await pg.exec(OFF)
    expect(await state()).toMatchObject({ lock_state: 'unlocked', grants_md5_now: FP.A })
  })
  test('L1.5 state check: lock privileges present but a SEC-04-owned delete in the wrong state → PARTIAL, never "unlocked"', async () => {
    await pg.exec('revoke delete on public.versions from authenticated')                        // no SEC-04: versions delete should exist
    expect(await state()).toMatchObject({ lock_state: 'PARTIAL', sec04_triggers: 0 })
    await pg.exec('grant delete on public.versions to authenticated')
    await pg.exec(ON); await pg.exec(SEC04); await pg.exec(OFF)
    await pg.exec('grant delete on public.projects to authenticated')                           // SEC-04: projects delete must stay closed
    expect(await state()).toMatchObject({ lock_state: 'PARTIAL', sec04_triggers: 8 })
  })
  test('L1.4 unlock never re-opens what SEC-04 closed', async () => {
    await pg.exec(ON); await pg.exec(SEC04); await pg.exec(OFF)
    const s = await state()
    expect([s.versions_delete, s.model_outputs_delete, s.scenarios_delete, s.projects_delete]).toEqual([false, false, false, false])
    expect([s.assumptions_delete, s.actuals_delete, s.variances_delete, s.actuals_insert, s.variances_insert]).toEqual([true, true, true, true, true])
  })
})

describe.each([['B', 'lock, before SEC-04', false], ['C', 'lock + SEC-04, freeze on', true], ['C', 'lock + SEC-04, freeze off', false]])(
  'L2 old Preview cannot leave partial data — stage %s (%s)', (stage, _label, freeze) => {
    let APPROVED, DRAFT
    beforeAll(async () => {
      await world()
      APPROVED = await project('mgr', U.mgr, 'approved', { approve: true })
      DRAFT = await project('an', U.an, 'draft-only')
      await toStage(stage)
      if (freeze) await pg.exec(M_ON)
    })
    afterAll(async () => { await pg.close() })
    test.each(['adm', 'mgr', 'an'])('L2.1 delete project (approved and draft-only) as %s — every row unchanged', async who => {
      for (const x of [APPROVED, DRAFT]) {
        const before = await projectRows(x.p.project_id)
        const r = await oldDeleteProject(C[who], x.p.project_id)
        expect(r.error).not.toBeNull()
        expect(await projectRows(x.p.project_id)).toEqual(before)
      }
    })
    test.each(['adm', 'mgr', 'an'])('L2.2 delete scenario, reset override, delete scenario driver as %s — unchanged', async who => {
      for (const x of [APPROVED, DRAFT]) {
        const before = await projectRows(x.p.project_id)
        await oldDeleteScenario(C[who], x.p.project_id, x.bull.scenario_id, x.bv.version_id)
        await oldDeleteScenario(C[who], x.p.project_id, x.s.scenario_id, x.v.version_id)
        await C[who].from('assumptions').delete().eq('assumption_id', x.override.assumption_id)
        await C[who].from('assumptions').delete().eq('assumption_id', x.driver.assumption_id)
        expect(await projectRows(x.p.project_id)).toEqual(before)
      }
    })
    test.each(['adm', 'mgr', 'an'])('L2.3 FP&A replacement as %s — refused at the first insert, nothing removed or duplicated', async who => {
      for (const x of [APPROVED, DRAFT]) {
        const before = await projectRows(x.p.project_id)
        expect(await fpaSubmit(C[who], U[who], x, '2027-01', 999)).toMatch(/^stopped at actuals insert: permission denied for table actuals$/)
        expect(await fpaSubmit(C[who], U[who], x, '2027-03', 999)).toMatch(/^stopped at actuals insert/)          // a new period too
        expect(await projectRows(x.p.project_id)).toEqual(before)
      }
    })
  })

describe.each(['B', 'C'])('L3 SEC-03 lifecycle functions while locked — stage %s', stage => {
  beforeEach(async () => { await world() })
  afterEach(async () => { await pg.close() })
  test('L3.1 approve_version (PPP and RE) by a manager; an analyst is refused', async () => {
    const x = await project('mgr', U.mgr, 'p'), y = await project('mgr', U.mgr, 'q')
    await toStage(stage)
    const row = await savePPPApproval(C.mgr, { output: runPPPEngine(rows(BASE)), assumptions: rows(BASE), engineVersion: PPP_ENGINE_VERSION,
      versionId: x.v.version_id, projectId: null, tenantId: null, userId: null, approvedLabel: 'v1.0 Approved' })
    expect(row.output_id).toBeTruthy()
    expect((await C.mgr.rpc('approve_version', { p_version_id: y.v.version_id, p_label: 'v1.0 Approved',
      p_record: { irr: 0.1, npv: 1, equity_multiple: 1.5, dscr_series: [], cash_flows: [] } })).error).toBeNull()
    expect((await C.an.rpc('approve_version', { p_version_id: y.bv.version_id, p_record: { irr: 0.1 } })).error.message).toMatch(/NOT_AUTHORIZED/)
    expect((await one(`select count(*)::int n from versions where status = 'approved'`)).n).toBe(2)
  })
  test('L3.2 delete_project removes a draft-only project completely (assumptions, actuals, variances, intake, versions, scenarios)', async () => {
    const x = await project('an', U.an, 'draft-only')
    await toStage(stage)
    expect((await C.an.rpc('delete_project', { p_project_id: x.p.project_id })).error).toBeNull()
    expect(await projectRows(x.p.project_id)).toMatchObject({ assumptions: expect.stringMatching(/^0:/), actuals: expect.stringMatching(/^0:/),
      variances: expect.stringMatching(/^0:/), versions: expect.stringMatching(/^0:/), intake: expect.stringMatching(/^0:/), scenarios: expect.stringMatching(/^0:/), project: 0 })
  })
  test('L3.3 delete_scenario and delete_draft_version remove only their own rows', async () => {
    const x = await project('an', U.an, 'draft-only')
    const extra = ok(await C.an.from('versions').insert({ scenario_id: x.s.scenario_id, label: 'v2.0 Draft', status: 'draft', created_by: U.an }).select())[0]
    await toStage(stage)
    expect((await C.an.rpc('delete_scenario', { p_scenario_id: x.bull.scenario_id })).error).toBeNull()
    expect((await C.an.rpc('delete_draft_version', { p_version_id: extra.version_id })).error).toBeNull()
    const r = await projectRows(x.p.project_id)
    expect([r.scenarios, r.versions, r.assumptions].map(s => Number(s.split(':')[0]))).toEqual([1, 1, Object.keys(BASE).length])
    expect(r.actuals.startsWith('4:') && r.variances.startsWith('4:')).toBe(true)
  })
  test('L3.4 a project with an approved version: delete_project refused, nothing changed; operator purge removes everything', async () => {
    const x = await project('mgr', U.mgr, 'approved', { approve: true })
    await toStage(stage)
    const before = await projectRows(x.p.project_id)
    expect((await C.mgr.rpc('delete_project', { p_project_id: x.p.project_id })).error.message).toMatch(/RECORD_PROTECTED/)
    expect(await projectRows(x.p.project_id)).toEqual(before)
    expect((await C.op.rpc('operator_purge_project', { p_project_id: x.p.project_id, p_confirm: 'PURGE ' + x.p.project_id,
      p_reason: 'cutover lock test purge' })).error).toBeNull()
    expect((await projectRows(x.p.project_id)).project).toBe(0)
    expect((await one(`select count(*)::int n from actuals where project_id = $1`, [x.p.project_id])).n).toBe(0)
  })
  test('L3.5 archive_version, new project / scenario / draft creation and assumption edits still work', async () => {
    const x = await project('mgr', U.mgr, 'approved', { approve: true })
    await toStage(stage)
    expect((await C.mgr.rpc('archive_version', { p_version_id: x.v.version_id, p_reason: 'superseded in test' })).error).toBeNull()
    const y = await project('an', U.an, 'created while locked').catch(e => e)
    expect(y instanceof Error ? y.message : 'ok').toMatch(/^(ok|permission denied for table actuals)$/)      // project creation itself works;
    expect((await C.an.from('assumptions').update({ value: 70 }).eq('assumption_id', x.override.assumption_id)).error).toBeNull()  // FP&A seeding is paused
  })
})

describe('L4 FP&A replacement submissions', () => {
  afterEach(async () => { await pg.close() })
  test('L4.1 while locked (B, C): refused before any change — no partial period, no duplicates', async () => {
    for (const stage of ['B', 'C']) {
      await world()
      const x = await project('an', U.an, 'fpa')
      await toStage(stage)
      const before = await projectRows(x.p.project_id)
      expect(await fpaSubmit(C.an, U.an, x, '2027-02', 500)).toBe('stopped at actuals insert: permission denied for table actuals')
      expect(await projectRows(x.p.project_id)).toEqual(before)
      if (stage === 'B') await pg.close()
    }
  })
  test('L4.2 after unlock (D): a replacement replaces exactly one period — one row per period and account, other periods untouched', async () => {
    await world()
    const x = await project('an', U.an, 'fpa')
    await pg.exec(ON); await pg.exec(SEC04); await pg.exec(OFF)
    const jan = (await pg.query(`select * from actuals where project_id = $1 and period = '2027-01' order by coa_node`, [x.p.project_id])).rows
    expect(await fpaSubmit(C.an, U.an, x, '2027-02', 500)).toBe('saved')
    expect(await fpaSubmit(C.an, U.an, x, '2027-02', 600)).toBe('saved')                          // resubmitted
    const counts = (await pg.query(`select period, coa_node, count(*)::int n, max(amount) amount from actuals where project_id = $1
      group by 1, 2 order by 1, 2`, [x.p.project_id])).rows
    expect(counts).toEqual([{ period: '2027-01', coa_node: 'OPEX', n: 1, amount: 100 }, { period: '2027-01', coa_node: 'REV_AP', n: 1, amount: 100 },
      { period: '2027-02', coa_node: 'OPEX', n: 1, amount: 600 }, { period: '2027-02', coa_node: 'REV_AP', n: 1, amount: 600 }])
    expect((await pg.query(`select period, count(*)::int n from variances where project_id = $1 group by 1 order by 1`, [x.p.project_id])).rows)
      .toEqual([{ period: '2027-01', n: 2 }, { period: '2027-02', n: 2 }])
    expect((await pg.query(`select * from actuals where project_id = $1 and period = '2027-01' order by coa_node`, [x.p.project_id])).rows).toEqual(jan)
  })
  test('L4.3 after unlock (D): a viewer is refused at every step — no partial period', async () => {
    await world()
    const x = await project('an', U.an, 'fpa')
    await pg.exec(ON); await pg.exec(SEC04); await pg.exec(OFF)
    const before = await projectRows(x.p.project_id)
    expect(await fpaSubmit(C.vw, U.vw, x, '2027-01', 1)).toMatch(/^stopped at actuals insert: new row violates row-level security policy/)
    expect(await projectRows(x.p.project_id)).toEqual(before)
  })
})

describe('L5 probe request semantics (probe-lock.mjs) — never writes', () => {
  afterEach(async () => { await pg.close() })
  const probe = async c => {
    const del = {}
    for (const [t, k] of [['assumptions', 'assumption_id'], ['actuals', 'actual_id'], ['variances', 'variance_id']]) {
      const r = await c.from(t).delete().eq(k, crypto.randomUUID()); del[t] = r.error ? r.error.code + ' ' + r.error.message : 'ok'
    }
    const ia = await c.from('actuals').insert({ tenant_id: U.t, period: '2099-01', amount: 0, created_by: U.adm })
    const iv = await c.from('variances').insert({ tenant_id: U.t, period: '2099-01', budget_amount: 0, actual_amount: 0, created_by: U.adm })
    return { del, insActuals: ia.error.code + ' ' + ia.error.message.split(' "')[0], insVariances: iv.error.code + ' ' + iv.error.message.split(' "')[0] }
  }
  test.each([['A', false], ['C', true], ['C', false], ['D', false]])('L5.1 stage %s (freeze %s)', async (stage, freeze) => {
    await world()
    if (stage === 'D') { await pg.exec(ON); await pg.exec(SEC04); await pg.exec(OFF) } else await toStage(stage)
    if (freeze) await pg.exec(M_ON)
    const counts = async () => one(`select (select count(*)::int from actuals) a, (select count(*)::int from variances) v, (select count(*)::int from assumptions) s`)
    const before = await counts()
    const r = await probe(C.adm)
    const locked = stage === 'C'
    expect(r.del).toEqual(locked
      ? { assumptions: '42501 permission denied for table assumptions', actuals: '42501 permission denied for table actuals', variances: '42501 permission denied for table variances' }
      : { assumptions: 'ok', actuals: 'ok', variances: 'ok' })
    expect([r.insActuals, r.insVariances]).toEqual(locked
      ? ['42501 permission denied for table actuals', '42501 permission denied for table variances']
      : ['23502 null value in column', '23502 null value in column'])
    expect(await counts()).toEqual(before)
  })
})
