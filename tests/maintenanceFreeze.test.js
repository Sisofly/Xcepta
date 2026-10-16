/**
 * maintenanceFreeze.test.js — maintenance freeze (db/security/maintenance_{on,off}.sql) and the full
 * SEC-04 cutover rehearsal, run as the exact files on the post-SEC-03 staging schema (PGlite).
 *
 *  F1 file structure: maintenance_on is one explicit transaction; maintenance_off one statement
 *  F2 exactly 13 restrictive admin-only policies; nothing else changes; off removes exactly those
 *  F3 repeat execution and rollback (failure before commit / inside the loop → no policy)
 *  F4 access during the freeze, by role, before and after SEC-04
 *  F5 SECURITY DEFINER lifecycle functions during the freeze
 *  F6 full sequence: freeze → lock → SEC-04 → verification → freeze off (both orders; also as psql -f)
 *  F7 the old Preview can never leave partial data at any point of the transition
 */
import { readFileSync } from 'node:fs'
import { createCutoverWorld, oldDeleteProject, oldDeleteScenario, fpaSubmit } from './helpers/cutoverWorld.js'
import { splitSqlStatements, runLikePsql } from './helpers/sqlStatements.js'

const file = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
const M_ON = file('db/security/maintenance_on.sql')
const M_OFF = file('db/security/maintenance_off.sql')
const LOCK_ON = file('db/security/cutover_lock_on.sql')
const LOCK_OFF = file('db/security/cutover_lock_off.sql')
const LOCK_STATE = file('db/security/cutover_lock_preflight.sql')
const SEC04 = file('db/migrations/2026-10-16_sec04_record_protection.sql')
const SEC04_PF = file('db/security/sec04_preflight.sql')
const VERIFY = file('db/security/verify_security_catalog.sql')
const DATA_FP = file('db/security/data_fingerprint.sql')
const FREEZE_TABLES = ['actuals', 'assumptions', 'coa_mappings', 'intake_state', 'model_outputs', 'projects', 'results',
  'scenarios', 'static_defaults', 'tenants', 'users', 'variances', 'versions']
const GRANTS = { A: '264e089a3a351afa75905fcd1f4b193c', B: 'fabdac15a44f3ca18df6fcb894f86101', C: '24b12f0ed2ae58fa8ae7030c61b94989' }

let W, pg
const policies = async () => (await pg.query(`select tablename || '.' || policyname || ' ' || permissive || ' ' || roles::text || ' ' || cmd
  || ' using(' || coalesce(qual, '') || ') check(' || coalesce(with_check, '') || ')' p from pg_policies where schemaname = 'public' order by 1`)).rows.map(r => r.p)
const maintenance = async () => (await pg.query(`select tablename, policyname, permissive, roles::text roles, cmd, qual, with_check
  from pg_policies where schemaname = 'public' and policyname like '%\\_maintenance' order by tablename`)).rows
const dataFingerprint = async () => (await pg.query(DATA_FP)).rows.filter(r => !r.table_name.startsWith('audit_events'))
const catalog = async () => { const v = (await pg.exec(VERIFY)).find(x => x.rows && x.rows.length && 'check_name' in x.rows[0]).rows; return [v.filter(x => x.pass).length, v.filter(x => !x.pass).length] }
const sec04pf = async () => (await pg.query(SEC04_PF)).rows[0]
const lockState = async () => (await pg.query(LOCK_STATE)).rows[0]
async function fresh() { W = await createCutoverWorld(); pg = W.pg }

describe('F1 file structure', () => {
  test('F1.1 maintenance_on.sql is exactly begin; one DO block; commit (one transaction under psql -f and the SQL Editor)', () => {
    const st = splitSqlStatements(M_ON)
    expect(st.length).toBe(3)
    expect(st[0].replace(/--[^\n]*\n/g, '').trim().toLowerCase()).toBe('begin')
    expect(st[1]).toMatch(/^do \$\$[\s\S]*end \$\$$/)
    expect(st[2].toLowerCase()).toBe('commit')
  })
  test('F1.2 maintenance_off.sql is one DO statement (atomic on its own) dropping only <table>_maintenance', () => {
    const st = splitSqlStatements(M_OFF)
    expect(st.length).toBe(1)
    expect(st[0]).toMatch(/drop policy if exists %I on public\.%I', t \|\| '_maintenance', t\)/)
    expect(st[0].replace(/--[^\n]*/g, '')).not.toMatch(/\b(create|alter|grant|revoke)\b/i)
  })
  test('F1.3 both scripts list the same 13 tables', () => {
    const list = s => JSON.stringify(/array\[([^\]]*)\] loop/.exec(s)[1].match(/'([a-z_]+)'/g).map(x => x.slice(1, -1)).sort())
    expect(list(M_ON)).toBe(JSON.stringify(FREEZE_TABLES)); expect(list(M_OFF)).toBe(JSON.stringify(FREEZE_TABLES))
  })
})

describe.each([['A (post-SEC-03)', false], ['C (lock + SEC-04)', true]])('F2–F3 policies at stage %s', (_s, sec04) => {
  beforeEach(async () => { await fresh(); if (sec04) { await pg.exec(LOCK_ON); await pg.exec(SEC04) } })
  afterEach(async () => { await pg.close() })
  test('F2.1 on creates exactly 13 RESTRICTIVE admin-only policies (ALL, authenticated); every other policy unchanged', async () => {
    const before = await policies()
    expect(before.length).toBe(sec04 ? 66 : 28)
    await pg.exec(M_ON)
    const m = await maintenance()
    expect(m.map(x => x.tablename)).toEqual(FREEZE_TABLES)
    for (const x of m) {
      expect(x).toMatchObject({ policyname: x.tablename + '_maintenance', permissive: 'RESTRICTIVE', roles: '{authenticated}', cmd: 'ALL' })
      expect(x.qual).toMatch(/^app_has_role\(ARRAY\['admin'::text\]\)$/); expect(x.with_check).toBe(x.qual)
    }
    const after = await policies()
    expect(after.length).toBe(before.length + 13)
    expect(after.filter(p => !/^\w+\.\w+_maintenance /.test(p))).toEqual(before)
  })
  test('F2.2 off removes exactly the 13 freeze policies — SEC-01..04 policies and look-alikes untouched; both idempotent', async () => {
    await pg.exec(`create policy projects_maintenance_review on public.projects for select to authenticated using (false);
                   create policy audit_events_maintenance on public.audit_events for select to authenticated using (false);`)
    const before = await policies()
    await pg.exec(M_ON); await pg.exec(M_ON)
    expect((await maintenance()).length).toBe(13 + 1)              // + the audit_events look-alike (not a freeze table)
    const twice = await policies()
    await pg.exec(M_OFF)
    expect(await policies()).toEqual(before)
    await pg.exec(M_OFF)
    expect(await policies()).toEqual(before)
    expect(twice.length).toBe(before.length + 13)
  })
  test('F3.1 rollback: a failure before COMMIT (statement by statement, as psql -f) leaves no policy', async () => {
    const before = await policies()
    const failing = M_ON.replace(/commit;\s*$/, 'select 1 / 0;\ncommit;\n')
    expect(failing).not.toBe(M_ON)
    expect((await runLikePsql(pg, failing)).error.message).toMatch(/division by zero/)
    expect(await policies()).toEqual(before)
  })
  test('F3.2 rollback: a failure inside the loop (13th table) leaves no policy — as one script and as psql -f', async () => {
    const before = await policies()
    const failing = M_ON.replace("'tenants', 'users'] loop", "'tenants', 'users_missing'] loop")
    expect(failing).not.toBe(M_ON)
    await expect(pg.exec(failing)).rejects.toThrow(/users_missing/); await pg.exec('rollback')
    expect(await policies()).toEqual(before)
    expect((await runLikePsql(pg, failing)).error.message).toMatch(/users_missing/)
    expect(await policies()).toEqual(before)
  })
  test('F3.3 the normal files also work statement by statement (psql -f): on → 13, off → exact prior state', async () => {
    const before = await policies()
    expect((await runLikePsql(pg, M_ON)).error).toBeNull(); expect((await maintenance()).length).toBe(13)
    expect((await runLikePsql(pg, M_OFF)).error).toBeNull(); expect(await policies()).toEqual(before)
  })
})

describe.each([['A (post-SEC-03)', false], ['C (lock + SEC-04)', true]])('F4 access during the freeze — stage %s', (_s, sec04) => {
  let X
  beforeAll(async () => {
    await fresh()
    X = await W.project('an', 'analyst project')
    if (sec04) { await pg.exec(LOCK_ON); await pg.exec(SEC04) }
    await pg.exec(M_ON)
  })
  afterAll(async () => { await pg.close() })
  const visible = async who => Object.fromEntries(await Promise.all(FREEZE_TABLES.map(async t => {
    const r = await W.C[who].from(t).select('*'); return [t, r.error ? 'error: ' + r.error.code : r.data.length]
  })))
  test('F4.1 the active admin of tenant A reads its own tenant', async () => {
    const v = await visible('adm')
    expect(v.projects).toBe(1); expect(v.tenants).toBe(1); expect(v.users).toBeGreaterThanOrEqual(5); expect(v.assumptions).toBeGreaterThan(0)
  })
  test.each(['mgr', 'an', 'vw', 'adm2'])('F4.2 %s (manager, analyst, viewer, INACTIVE admin) sees nothing in any of the 13 tables', async who => {
    expect(Object.values(await visible(who)).every(n => n === 0)).toBe(true)
  })
  test('F4.3 the admin of tenant B sees only tenant B (isolation unchanged by the freeze)', async () => {
    const r = await W.C.badm.from('projects').select('*'), t = await W.C.badm.from('tenants').select('*')
    expect(r.data.length).toBe(0); expect(t.data.map(x => x.tenant_id)).toEqual([W.U.tb])
  })
  test('F4.4 anon has no table access; the service role is not subject to RLS (operator path)', async () => {
    expect((await W.C.anon.from('projects').select('*')).error.message).toMatch(/permission denied/)
    expect((await W.C.op.from('projects').select('*')).data.length).toBe(1)
  })
  test('F4.5 writes: members are refused or affect nothing; the active admin can create a project', async () => {
    const before = await W.projectRows(X.p.project_id)
    expect((await W.C.mgr.from('projects').insert({ tenant_id: W.U.t, name: 'x', created_by: W.U.mgr }).select()).error.message).toMatch(/row-level security/)
    expect((await W.C.an.from('assumptions').update({ value: 1 }).eq('assumption_id', X.override.assumption_id)).error).toBeNull()   // 0 rows visible → 0 updated
    expect(await W.projectRows(X.p.project_id)).toEqual(before)
    const p = await W.C.adm.from('projects').insert({ tenant_id: W.U.t, name: 'admin during freeze', created_by: W.U.adm }).select()
    expect(p.error).toBeNull()
  })
})

describe('F5 SECURITY DEFINER lifecycle functions during the freeze (stage C, lock on)', () => {
  let X, Y, Z
  beforeAll(async () => {
    await fresh()
    X = await W.project('mgr', 'to approve'); Y = await W.project('an', 'analyst draft-only'); Z = await W.project('an', 'viewer target')
    await pg.exec(LOCK_ON); await pg.exec(SEC04); await pg.exec(M_ON)
  })
  afterAll(async () => { await pg.close() })
  test('F5.1 they run (they are owned by postgres, so RLS — including the freeze — does not apply inside) and keep every role check', async () => {
    expect((await W.approvePPP(W.C.mgr, X.v.version_id)).output_id).toBeTruthy()                                    // manager approves
    expect((await W.C.an.rpc('approve_version', { p_version_id: X.bv.version_id, p_record: { irr: 0.1 } })).error.message).toMatch(/NOT_AUTHORIZED/)
    expect((await W.C.an.rpc('delete_project', { p_project_id: Y.p.project_id })).error).toBeNull()                  // own draft-only, atomic
    expect(W.isGone(await W.projectRows(Y.p.project_id))).toBe(true)
    expect((await W.C.vw.rpc('delete_project', { p_project_id: Z.p.project_id })).error.message).toMatch(/NOT_AUTHORIZED/)
    expect((await W.C.adm2.rpc('delete_project', { p_project_id: Z.p.project_id })).error.message).toMatch(/NOT_AUTHENTICATED/)   // inactive
    expect((await W.C.badm.rpc('delete_project', { p_project_id: Z.p.project_id })).error.message).toMatch(/NOT_FOUND/)            // other tenant
    expect((await W.C.mgr.rpc('delete_project', { p_project_id: X.p.project_id })).error.message).toMatch(/RECORD_PROTECTED/)
  })
})

describe.each([['your order: freeze → lock → SEC-04', ['M_ON', 'LOCK_ON', 'SEC04']], ['lock first: lock → freeze → SEC-04', ['LOCK_ON', 'M_ON', 'SEC04']]])(
  'F6 full sequence — %s → verification → freeze off', (_n, order) => {
    const FILES = { M_ON, LOCK_ON, SEC04 }
    test.each([['one script per step (SQL Editor)', false], ['statement by statement (psql -f)', true]])('F6.1 %s', async (_m, psql) => {
      await fresh()
      await W.project('mgr', 'approved', { approve: true }); await W.project('an', 'draft-only')
      const data0 = await dataFingerprint()
      const run = async s => { if (psql) { const r = await runLikePsql(pg, s); expect(r.error).toBeNull() } else await pg.exec(s) }
      expect(await sec04pf()).toMatchObject({ sec03_functions: 20, last_admin_trigger: 1, sec04_triggers: 0, sec04_policies: 0, maintenance_policies: 0,
        policies_now: 28, grants_md5_now: GRANTS.A })
      for (const step of order) {
        await run(FILES[step])
        expect(await dataFingerprint()).toEqual(data0)                                           // no row changes at any step
      }
      expect(await catalog()).toEqual([23, 0])
      expect(await sec04pf()).toMatchObject({ sec04_triggers: 8, sec04_policies: 38, maintenance_policies: 13, policies_now: 79, grants_md5_now: GRANTS.C })
      expect(await lockState()).toMatchObject({ lock_state: 'locked', sec04_triggers: 8 })
      await run(M_OFF)
      expect(await sec04pf()).toMatchObject({ sec04_triggers: 8, sec04_policies: 38, maintenance_policies: 0, policies_now: 66, grants_md5_now: GRANTS.C })
      expect(await catalog()).toEqual([23, 0])
      expect(await dataFingerprint()).toEqual(data0)
      await pg.close()
    })
  })

describe('F7.0 freeze without the lock (your order, between maintenance_on and cutover_lock_on)', () => {
  afterAll(async () => { await pg.close() })
  test('F7.0 members are blocked entirely; an ADMIN using the old Preview can still delete a project — completely (the current behaviour, approved records included)', async () => {
    await fresh()
    const x = await W.project('mgr', 'approved', { approve: true })
    await pg.exec(M_ON)
    const before = await W.projectRows(x.p.project_id)
    for (const who of ['mgr', 'an']) { await oldDeleteProject(W.C[who], x.p.project_id); expect(await W.projectRows(x.p.project_id)).toEqual(before) }
    await oldDeleteProject(W.C.adm, x.p.project_id)
    expect(W.isGone(await W.projectRows(x.p.project_id))).toBe(true)
  })
})

// Every intermediate state of the transition (both orders), the old Preview as admin, manager and analyst.
const STATES = [
  ['freeze only (A + freeze) — your order, before the lock', ['M_ON']],
  ['lock only (B) — lock-first order, before the freeze', ['LOCK_ON']],
  ['freeze + lock (B)', ['M_ON', 'LOCK_ON']],
  ['freeze + lock + SEC-04 (C)', ['M_ON', 'LOCK_ON', 'SEC04']],
  ['lock + SEC-04, freeze off (C)', ['M_ON', 'LOCK_ON', 'SEC04', 'M_OFF']],
]
describe.each(STATES)('F7 old Preview at "%s"', (_label, steps) => {
  let R
  beforeAll(async () => {
    await fresh()
    const FILES = { M_ON, M_OFF, LOCK_ON, SEC04 }
    const P = { approved: await W.project('mgr', 'approved', { approve: true }), draft: await W.project('an', 'draft-only') }
    for (const s of steps) await pg.exec(FILES[s])
    const locked = steps.includes('LOCK_ON')
    R = { locked, P }
  })
  afterAll(async () => { await pg.close() })
  test.each(['adm', 'mgr', 'an'])('F7.1 delete project / delete scenario / reset override / FP&A as %s: each project untouched or entirely gone — never partial', async who => {
    for (const x of Object.values(R.P)) {
      const before = await W.projectRows(x.p.project_id)
      if (before.project === 0) continue                                                  // already deleted (completely) by an earlier role
      await oldDeleteScenario(W.C[who], x.p.project_id, x.bull.scenario_id, x.bv.version_id)
      await W.C[who].from('assumptions').delete().eq('assumption_id', x.override.assumption_id)
      await fpaSubmit(W.C[who], W.U.t, W.U[who], x, '2027-01', 777)
      await oldDeleteProject(W.C[who], x.p.project_id)
      const after = await W.projectRows(x.p.project_id)
      if (R.locked) expect(after).toEqual(before)                                         // the lock: nothing at all changes
      else if (JSON.stringify(after) !== JSON.stringify(before)) expect(W.isGone(after)).toBe(true)   // no lock: only a complete deletion is possible
    }
  })
})
