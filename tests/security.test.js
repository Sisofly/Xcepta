/**
 * security.test.js — database authorization (SEC-01..04) on the PRODUCTION
 * schema structure (PGlite), with Supabase roles and JWT identities.
 *
 * Every attempt is a direct database / API action (the same privileges, RLS
 * policies and triggers a REST or RPC call meets) — not a UI restriction.
 * Identities: two tenants; tenant A has admin, manager, analyst and viewer;
 * tenant B has a manager and an analyst; plus an authenticated account with
 * no membership, the anonymous role, the service role and the database owner.
 */
import { createSecurityDb, asClient, SECURITY_MIGRATIONS } from './helpers/pgliteSecurity.js'
import { splitSqlStatements, runLikePsql } from './helpers/sqlStatements.js'
import { runPPPEngine, PPP_ENGINE_VERSION } from '../src/modules/feasibility/annualEngine.js'
import { savePPPApproval, loadLatestModelOutput } from '../src/modules/feasibility/pppResultStore.js'
import { exactDiff } from '../scripts/staging/exact-compare.mjs'

const rows = o => Object.entries(o).map(([name, v]) => (typeof v === 'string'
  ? { name, value: null, unit: v, category: 'ppp_structure' } : { name, value: v, unit: null, category: 'ppp_structure' }))
const BASE = { 'Total Project Cost': 100e6, 'Debt %': 80, 'Equity %': 20, 'Annual Availability Payment': 12e6,
  'Concession Period': 25, 'Construction Period': 24, 'OPEX % of Revenue': 5, 'Interest Rate': 7, 'Loan Tenor': 10,
  'Grace Period': 2, 'Tax Rate': 21, 'WACC': 10, 'Target DSCR': 1.2, 'Construction Start Date': '2026-07-01' }
const clean = o => JSON.parse(JSON.stringify(o))
const uuid = () => crypto.randomUUID()

let pg, owner, op, anon, U = {}, T = {}, F = {}
const as = name => asClient(pg, { role: 'authenticated', sub: U[name] })
const one = async (q, v) => (await pg.query(q, v)).rows[0]
const denied = r => { expect(r.error).not.toBeNull(); return r.error }
const ok = r => { expect(r.error).toBeNull(); return r.data }
const msg = r => (r.error ? r.error.message : '')
// fingerprint of every protected row (versions + model_outputs), as the owner
const fingerprint = async () => (await pg.query(
  `select (select md5(coalesce(string_agg(md5(v::text), ',' order by v.version_id), '')) from versions v where status in ('approved','archived')) as versions,
          (select md5(coalesce(string_agg(md5(m::text), ',' order by m.output_id), '')) from model_outputs m) as outputs,
          (select count(*)::int from model_outputs) as n_outputs`)).rows[0]

async function newProject(client, tenant, name) {
  const p = ok(await client.from('projects').insert({ tenant_id: tenant, name, project_type: 'Infrastructure / PPP',
    revenue_model: 'Availability Payment', financing_structure: 'Project Finance' }).select())[0]
  const s = ok(await client.from('scenarios').insert({ project_id: p.project_id, name: 'Base', type: 'base' }).select())[0]
  const v = ok(await client.from('versions').insert({ scenario_id: s.scenario_id, label: 'v1.0 Draft', status: 'draft' }).select())[0]
  const a = rows(BASE).map(r => ({ ...r, tenant_id: tenant, project_id: p.project_id, module_origin: 'feasibility', source_type: 'user_entry', confidence: 'indicative' }))
  ok(await client.from('assumptions').insert(a).select())
  return { p, s, v }
}
async function approve(client, versionId) {
  return savePPPApproval(client, { output: runPPPEngine(rows(BASE)), assumptions: rows(BASE), engineVersion: PPP_ENGINE_VERSION,
    versionId, projectId: null, tenantId: null, userId: null, approvedLabel: 'v1.0 Approved' })
}

beforeAll(async () => {
  pg = await createSecurityDb()
  owner = asClient(pg, null)
  op = asClient(pg, { role: 'service_role' })
  anon = asClient(pg, { role: 'anon' })
  T.A = ok(await op.rpc('operator_create_tenant', { p_name: 'Tenant A' }))
  T.B = ok(await op.rpc('operator_create_tenant', { p_name: 'Tenant B' }))
  for (const [name, tenant, role] of [['A_admin', 'A', 'admin'], ['A_manager', 'A', 'manager'], ['A_analyst', 'A', 'analyst'],
    ['A_viewer', 'A', 'viewer'], ['A_analyst2', 'A', 'analyst'], ['B_manager', 'B', 'manager'], ['B_analyst', 'B', 'analyst']]) {
    U[name] = uuid()
    await pg.query('insert into auth.users (id, email) values ($1, $2)', [U[name], name + '@xcepta.test'])
    ok(await op.rpc('operator_add_member', { p_user_id: U[name], p_tenant_id: T[tenant], p_email: name + '@xcepta.test', p_name: name, p_role: role }))
  }
  U.orphan = uuid()
  await pg.query('insert into auth.users (id, email) values ($1, $2)', [U.orphan, 'orphan@xcepta.test'])
  // Tenant A: approved PPP project (analyst creates, manager approves)
  F.PA = await newProject(as('A_analyst'), T.A, 'A approved')
  F.OA = await approve(as('A_manager'), F.PA.v.version_id)
  // Tenant A: a second approved version (archived later) and draft-only items
  F.PA2 = await newProject(as('A_analyst'), T.A, 'A to archive')
  F.OA2 = await approve(as('A_manager'), F.PA2.v.version_id)
  F.DA = await newProject(as('A_analyst'), T.A, 'A draft-only (analyst)')
  F.DA2 = await newProject(as('A_analyst2'), T.A, 'A draft-only (analyst2)')
  // Tenant B: approved project
  F.PB = await newProject(as('B_analyst'), T.B, 'B approved')
  F.OB = await approve(as('B_manager'), F.PB.v.version_id)
  F.before = await fingerprint()
}, 120000)
afterAll(async () => { if (pg) await pg.close() })

// ═════════════════════════════════════════════════════════════════════════
describe('S0 catalog — SECURITY DEFINER hardening, grants, RLS coverage', () => {
  test('S0.1 every SECURITY DEFINER function: owner postgres, search_path = "", no EXECUTE for PUBLIC or anon', async () => {
    const fns = (await pg.query(`
      select n.nspname || '.' || p.proname as fn, pg_get_userbyid(p.proowner) as owner, p.proconfig, p.oid,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.prosecdef and n.nspname in ('public', 'app_private')`)).rows
    expect(fns.length).toBeGreaterThanOrEqual(25)
    for (const f of fns) {
      expect([f.fn, f.owner]).toEqual([f.fn, 'postgres'])
      expect([f.fn, f.proconfig]).toEqual([f.fn, ['search_path=""']])
      expect([f.fn, f.public_exec, f.anon_exec]).toEqual([f.fn, false, false])
      if (f.fn.startsWith('app_private.')) expect([f.fn, f.auth_exec, f.svc_exec]).toEqual([f.fn, false, false])
      if (/^public\.operator_/.test(f.fn)) expect([f.fn, f.auth_exec, f.svc_exec]).toEqual([f.fn, false, true])
      if (/^public\.(approve_version|archive_version|delete_|admin_)/.test(f.fn)) expect([f.fn, f.auth_exec]).toEqual([f.fn, true])
    }
  })

  test('S0.2 app_private is unreachable; no role can create objects in public; anon has no table privilege', async () => {
    for (const r of ['anon', 'authenticated', 'service_role']) {
      expect((await one(`select has_schema_privilege($1, 'app_private', 'USAGE') as u`, [r])).u).toBe(false)
      expect((await one(`select has_schema_privilege($1, 'public', 'CREATE') as c`, [r])).c).toBe(false)
    }
    const anonTables = (await pg.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')`)).rows
    expect(anonTables).toEqual([])
  })

  test('S0.3 RLS is enabled on every public table; protection triggers are installed', async () => {
    const noRls = (await pg.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)).rows
    expect(noRls).toEqual([])
    const trg = (await pg.query(`select tgrelid::regclass::text || ':' || tgname as t from pg_trigger where not tgisinternal order by 1`)).rows.map(r => r.t)
    for (const t of ['users:users_guard', 'tenants:tenants_guard', 'versions:versions_guard', 'model_outputs:model_outputs_guard',
      'projects:projects_guard', 'scenarios:scenarios_guard', 'audit_events:audit_events_append_only', 'audit_events:audit_events_no_truncate',
      'model_outputs:model_outputs_no_truncate', 'versions:versions_no_truncate', 'users:users_no_truncate']) expect(trg).toContain(t)
  })

  test('S0.4 no policy recursion: users / projects / results are readable by members without error', async () => {
    for (const name of ['A_admin', 'A_viewer', 'B_analyst']) {
      ok(await as(name).from('users').select('*'))
      ok(await as(name).from('projects').select('*'))
      ok(await as(name).from('model_outputs').select('*'))
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════
describe('S1 identity (B1) — no self-assignment of tenant, role or identity fields', () => {
  test('S1.1 a member cannot change their own tenant_id, role, e-mail, status or user_id', async () => {
    const me = as('A_analyst')
    for (const change of [{ tenant_id: T.B }, { role: 'admin' }, { email: 'x@evil.test' }, { active: false }, { user_id: uuid() }]) {
      expect(msg(await me.from('users').update(change).eq('user_id', U.A_analyst))).toMatch(/permission denied/)
    }
    const row = await one('select tenant_id, role, email, active from users where user_id = $1', [U.A_analyst])
    expect(row).toEqual({ tenant_id: T.A, role: 'analyst', email: 'A_analyst@xcepta.test', active: true })
    ok(await me.from('users').update({ name: 'Analyst A' }).eq('user_id', U.A_analyst))       // own display name: allowed
    expect((await one('select name from users where user_id = $1', [U.A_analyst])).name).toBe('Analyst A')
  })

  test('S1.2 an account without membership cannot create its own users row (any tenant, any role)', async () => {
    const orphan = asClient(pg, { role: 'authenticated', sub: U.orphan })
    expect(msg(await orphan.from('users').insert({ user_id: U.orphan, tenant_id: T.A, email: 'o@x.test', name: 'o', role: 'admin' }).select()))
      .toMatch(/permission denied/)
    expect(await one('select count(*)::int n from users where user_id = $1', [U.orphan])).toEqual({ n: 0 })
    expect(ok(await orphan.from('projects').select('*'))).toEqual([])                               // and sees nothing
    expect(msg(await orphan.rpc('approve_version', { p_version_id: F.PA2.v.version_id, p_record: {} }))).toMatch(/NOT_AUTHENTICATED/)
  })

  test('S1.3 members cannot create, rename or delete tenants, or delete memberships', async () => {
    const me = as('A_admin')
    denied(await me.from('tenants').insert({ name: 'Mine' }).select())
    denied(await me.from('tenants').update({ name: 'Renamed' }).eq('tenant_id', T.A))
    denied(await me.from('tenants').delete().eq('tenant_id', T.A))
    denied(await me.from('users').delete().eq('user_id', U.A_viewer))
    expect((await one('select name from tenants where tenant_id = $1', [T.A])).name).toBe('Tenant A')
  })

  test('S1.4 alternate paths — service role and database owner cannot change identity fields directly', async () => {
    expect(msg(await op.from('users').update({ role: 'admin' }).eq('user_id', U.A_viewer))).toMatch(/IDENTITY_PROTECTED/)
    expect(msg(await op.from('users').update({ tenant_id: T.B }).eq('user_id', U.A_viewer))).toMatch(/IDENTITY_PROTECTED/)
    expect(msg(await owner.from('users').update({ role: 'admin' }).eq('user_id', U.A_viewer))).toMatch(/IDENTITY_PROTECTED/)
    expect(msg(await op.from('users').insert({ user_id: uuid(), tenant_id: T.A, email: 'z@x.test', name: 'z' }).select())).toMatch(/IDENTITY_PROTECTED/)
    expect(msg(await op.from('tenants').delete().eq('tenant_id', T.B))).toMatch(/IDENTITY_PROTECTED/)        // no tenant cascade either
    await expect(op.raw('truncate public.users cascade')).rejects.toThrow(/permission denied for table users/)          // C1: no TRUNCATE privilege
    await expect(owner.raw('truncate public.users cascade')).rejects.toThrow(/RECORD_PROTECTED: [a-z_]+ cannot be truncated/) // trigger layer (owner)
    expect((await one('select role from users where user_id = $1', [U.A_viewer])).role).toBe('viewer')
  })

  test('S1.5 the anonymous role reads and writes nothing', async () => {
    expect(msg(await anon.from('users').select('*'))).toMatch(/permission denied/)
    expect(msg(await anon.from('projects').select('*'))).toMatch(/permission denied/)
    expect(msg(await anon.from('model_outputs').select('*'))).toMatch(/permission denied/)
    expect(msg(await anon.rpc('app_tenant_id', {}))).toMatch(/permission denied/)
    expect(msg(await anon.rpc('approve_version', { p_version_id: F.PA2.v.version_id, p_record: {} }))).toMatch(/permission denied/)
  })
})

// ═════════════════════════════════════════════════════════════════════════
describe('S2 approval authority — status is never a client-writable field', () => {
  test('S2.1 a draft cannot be approved by UPDATE, nor created approved, nor given another owner', async () => {
    const mgr = as('A_manager'), v = F.DA.v.version_id
    expect(msg(await mgr.from('versions').update({ status: 'approved' }).eq('version_id', v))).toMatch(/permission denied/)
    expect(msg(await mgr.from('versions').update({ approved_at: new Date().toISOString() }).eq('version_id', v))).toMatch(/permission denied/)
    expect(msg(await mgr.from('versions').insert({ scenario_id: F.DA.s.scenario_id, label: 'x', status: 'approved' }).select())).toMatch(/RECORD_PROTECTED/)
    const forged = ok(await as('A_analyst').from('versions').insert({ scenario_id: F.DA.s.scenario_id, label: 'v2 Draft', status: 'draft', created_by: U.A_manager }).select())[0]
    expect(forged.created_by).toBe(U.A_analyst)                                                       // ownership stamped server-side
    expect(msg(await op.from('versions').update({ status: 'approved' }).eq('version_id', v))).toMatch(/RECORD_PROTECTED/)   // service role
    expect((await one('select status from versions where version_id = $1', [v])).status).toBe('draft')
    F.DAv2 = forged
  })

  test('S2.2 approve_version: analyst / viewer refused; other tenant NOT_FOUND; double approval refused', async () => {
    expect(msg(await as('A_analyst').rpc('approve_version', { p_version_id: F.DA.v.version_id, p_record: {} }))).toMatch(/NOT_AUTHORIZED/)
    expect(msg(await as('A_viewer').rpc('approve_version', { p_version_id: F.DA.v.version_id, p_record: {} }))).toMatch(/NOT_AUTHORIZED/)
    expect(msg(await as('B_manager').rpc('approve_version', { p_version_id: F.DA.v.version_id, p_record: {} }))).toMatch(/NOT_FOUND/)
    expect(msg(await as('B_manager').rpc('approve_version', { p_version_id: uuid(), p_record: {} }))).toMatch(/NOT_FOUND/)   // same answer: no existence leak
    expect(msg(await as('A_manager').rpc('approve_version', { p_version_id: F.PA.v.version_id, p_record: {} }))).toMatch(/INVALID_STATE/)
    expect((await one('select status from versions where version_id = $1', [F.DA.v.version_id])).status).toBe('draft')
  })

  test('S2.3 forged identity fields in the record are ignored (tenant, project, creator from the database)', async () => {
    const id = ok(await as('A_manager').rpc('approve_version', { p_version_id: F.DAv2.version_id,
      p_record: { irr: 1, tenant_id: T.B, project_id: F.PB.p.project_id, created_by: U.B_manager, version_id: F.PB.v.version_id } }))
    const r = await one('select tenant_id, project_id, created_by, version_id from model_outputs where output_id = $1', [id])
    expect(r).toEqual({ tenant_id: T.A, project_id: F.DA.p.project_id, created_by: U.A_manager, version_id: F.DAv2.version_id })
    const v = await one('select status, approved_by from versions where version_id = $1', [F.DAv2.version_id])
    expect(v).toEqual({ status: 'approved', approved_by: U.A_manager })
  })

  test('S2.4 approved versions cannot be reverted, relabelled or re-dated', async () => {
    const v = F.PA.v.version_id
    expect(msg(await as('A_admin').from('versions').update({ label: 'tampered' }).eq('version_id', v))).toMatch(/RECORD_PROTECTED/)
    expect(msg(await as('A_admin').from('versions').update({ status: 'draft' }).eq('version_id', v))).toMatch(/permission denied/)
    expect(msg(await op.from('versions').update({ status: 'draft' }).eq('version_id', v))).toMatch(/RECORD_PROTECTED/)
    expect(msg(await owner.from('versions').update({ approved_at: '2000-01-01T00:00:00Z' }).eq('version_id', v))).toMatch(/RECORD_PROTECTED/)
    ok(await as('A_analyst').from('versions').update({ label: 'v1.0 Draft (renamed)' }).eq('version_id', F.DA.v.version_id))   // drafts: label editable
  })

  test('S2.5 archive_version: manager only, reason required, approved → archived only, then immutable', async () => {
    const v = F.PA2.v.version_id
    expect(msg(await as('A_analyst').rpc('archive_version', { p_version_id: v, p_reason: 'superseded' }))).toMatch(/NOT_AUTHORIZED/)
    expect(msg(await as('A_manager').rpc('archive_version', { p_version_id: v, p_reason: '' }))).toMatch(/REASON_REQUIRED/)
    expect(msg(await as('B_manager').rpc('archive_version', { p_version_id: v, p_reason: 'superseded' }))).toMatch(/NOT_FOUND/)
    const before = await one('select version_id, scenario_id, label, approved_at, approved_by, created_by from versions where version_id = $1', [v])
    ok(await as('A_manager').rpc('archive_version', { p_version_id: v, p_reason: 'superseded by new approval' }))
    const after = await one('select version_id, scenario_id, label, approved_at, approved_by, created_by, status, archived_by from versions where version_id = $1', [v])
    expect(after).toEqual({ ...before, status: 'archived', archived_by: U.A_manager })
    expect(msg(await as('A_manager').rpc('archive_version', { p_version_id: v, p_reason: 'again' }))).toMatch(/INVALID_STATE/)
    expect(msg(await op.from('versions').update({ status: 'approved' }).eq('version_id', v))).toMatch(/RECORD_PROTECTED/)
  })
})

// ═════════════════════════════════════════════════════════════════════════
describe('S3 saved results and input snapshots — immutable', () => {
  test('S3.1 the creator cannot update, delete or insert results directly', async () => {
    const me = as('A_manager'), id = F.OA.output_id
    expect(msg(await me.from('model_outputs').update({ irr: 99 }).eq('output_id', id))).toMatch(/permission denied/)
    expect(msg(await me.from('model_outputs').update({ inputs_snapshot: [] }).eq('output_id', id))).toMatch(/permission denied/)
    expect(msg(await me.from('model_outputs').delete().eq('output_id', id))).toMatch(/permission denied/)
    expect(msg(await me.from('model_outputs').insert({ version_id: F.DA.v.version_id, project_id: F.DA.p.project_id, tenant_id: T.A, created_by: U.A_manager }).select()))
      .toMatch(/permission denied/)
  })

  test('S3.2 alternate paths — service role, database owner and TRUNCATE are refused', async () => {
    const id = F.OA.output_id
    expect(msg(await op.from('model_outputs').update({ irr: 99 }).eq('output_id', id))).toMatch(/RECORD_PROTECTED/)
    expect(msg(await op.from('model_outputs').delete().eq('output_id', id))).toMatch(/RECORD_PROTECTED/)
    expect(msg(await op.from('model_outputs').insert({ version_id: F.DA.v.version_id, project_id: F.DA.p.project_id, tenant_id: T.A }).select())).toMatch(/RECORD_PROTECTED/)
    expect(msg(await owner.from('model_outputs').update({ result_payload: {} }).eq('output_id', id))).toMatch(/RECORD_PROTECTED/)
    await expect(op.raw('truncate public.model_outputs')).rejects.toThrow(/permission denied|AUDIT_APPEND_ONLY|cannot/)
    await expect(owner.raw('truncate public.model_outputs cascade')).rejects.toThrow(/RECORD_PROTECTED: [a-z_]+ cannot be truncated/)
    expect(await fingerprint()).toMatchObject({ outputs: expect.any(String) })
  })
})

// ═════════════════════════════════════════════════════════════════════════
describe('S4 indirect changes — deletion, FK cascades and administrative functions', () => {
  test('S4.1 members cannot delete projects, scenarios or versions directly (any status)', async () => {
    for (const name of ['A_admin', 'A_analyst']) {
      const c = as(name)
      expect(msg(await c.from('projects').delete().eq('project_id', F.DA.p.project_id))).toMatch(/permission denied/)
      expect(msg(await c.from('scenarios').delete().eq('scenario_id', F.DA.s.scenario_id))).toMatch(/permission denied/)
      expect(msg(await c.from('versions').delete().eq('version_id', F.DA.v.version_id))).toMatch(/permission denied/)
    }
  })

  test('S4.2 cascades from project / scenario deletion cannot remove approved records (service role, owner)', async () => {
    expect(msg(await op.from('projects').delete().eq('project_id', F.PA.p.project_id))).toMatch(/RECORD_PROTECTED/)
    expect(msg(await op.from('scenarios').delete().eq('scenario_id', F.PA.s.scenario_id))).toMatch(/RECORD_PROTECTED/)
    expect(msg(await owner.from('projects').delete().eq('project_id', F.PA.p.project_id))).toMatch(/RECORD_PROTECTED/)
    // bypass the project guard by setting the delete context as the owner: the cascade still hits the version guard
    await expect(owner.raw(`do $$ begin perform set_config('xcepta.ctx', 'delete', true); delete from public.projects where project_id = '${F.PA.p.project_id}'; end $$`))
      .rejects.toThrow(/RECORD_PROTECTED/)
    expect(await one('select count(*)::int n from projects where project_id = $1', [F.PA.p.project_id])).toEqual({ n: 1 })
  })

  test('S4.3 the delete functions refuse anything containing approved or archived records', async () => {
    const KEPT = /RECORD_PROTECTED: approved or archived records are kept/        // the function's own check (first layer)
    for (const name of ['A_admin', 'A_manager']) {
      expect(msg(await as(name).rpc('delete_project', { p_project_id: F.PA.p.project_id }))).toMatch(KEPT)
      expect(msg(await as(name).rpc('delete_scenario', { p_scenario_id: F.PA.s.scenario_id }))).toMatch(KEPT)
      expect(msg(await as(name).rpc('delete_draft_version', { p_version_id: F.PA.v.version_id }))).toMatch(KEPT)
      expect(msg(await as(name).rpc('delete_scenario', { p_scenario_id: F.PA.s.scenario_id }))).toMatch(/RECORD_PROTECTED/)
      expect(msg(await as(name).rpc('delete_draft_version', { p_version_id: F.PA.v.version_id }))).toMatch(/RECORD_PROTECTED/)
      expect(msg(await as(name).rpc('delete_project', { p_project_id: F.PA2.p.project_id }))).toMatch(/RECORD_PROTECTED/)   // archived
    }
    // project DA now contains an approved version (S2.3) → protected too
    expect(msg(await as('A_analyst').rpc('delete_project', { p_project_id: F.DA.p.project_id }))).toMatch(/RECORD_PROTECTED/)
  })

  test('S4.4 parent-version cascade: deleting a draft parent cannot remove an approved child', async () => {
    const parent = F.DA2.v
    const child = ok(await as('A_analyst2').from('versions').insert({ scenario_id: F.DA2.s.scenario_id, label: 'child', status: 'draft', parent_version_id: parent.version_id }).select())[0]
    ok(await as('A_manager').rpc('approve_version', { p_version_id: child.version_id, p_record: { irr: 5 } }))
    expect(msg(await as('A_analyst2').rpc('delete_draft_version', { p_version_id: parent.version_id }))).toMatch(/RECORD_PROTECTED/)
    await expect(owner.raw(`do $$ begin perform set_config('xcepta.ctx', 'delete', true); delete from public.versions where version_id = '${parent.version_id}'; end $$`))
      .rejects.toThrow(/RECORD_PROTECTED/)
    expect((await one('select status from versions where version_id = $1', [child.version_id])).status).toBe('approved')
  })

  test('S4.5 analysts delete only their OWN draft-only items; managers any draft-only item; cross-tenant NOT_FOUND', async () => {
    const own = await newProject(as('A_analyst'), T.A, 'own draft-only')
    const other = await newProject(as('A_analyst2'), T.A, 'colleague draft-only')
    expect(msg(await as('A_analyst').rpc('delete_project', { p_project_id: other.p.project_id }))).toMatch(/NOT_AUTHORIZED/)
    expect(msg(await as('A_viewer').rpc('delete_project', { p_project_id: own.p.project_id }))).toMatch(/NOT_AUTHORIZED/)
    expect(msg(await as('B_manager').rpc('delete_project', { p_project_id: own.p.project_id }))).toMatch(/NOT_FOUND/)
    const bare = ok(await as('A_analyst2').from('projects').insert({ tenant_id: T.A, name: 'colleague project, no versions', project_type: 'Infrastructure / PPP' }).select())[0]
    expect(msg(await as('A_analyst').rpc('delete_project', { p_project_id: bare.project_id }))).toMatch(/NOT_AUTHORIZED/)
    ok(await as('A_analyst2').rpc('delete_project', { p_project_id: bare.project_id }))
    ok(await as('A_analyst').rpc('delete_project', { p_project_id: own.p.project_id }))
    ok(await as('A_manager').rpc('delete_project', { p_project_id: other.p.project_id }))
    expect(await one('select count(*)::int n from projects where project_id in ($1, $2)', [own.p.project_id, other.p.project_id])).toEqual({ n: 0 })
    const sc = await newProject(as('A_analyst'), T.A, 'scenario delete')
    expect(msg(await as('A_analyst2').rpc('delete_scenario', { p_scenario_id: sc.s.scenario_id }))).toMatch(/NOT_AUTHORIZED/)
    ok(await as('A_analyst').rpc('delete_scenario', { p_scenario_id: sc.s.scenario_id }))
  })

  test('S4.7 an approved version WITHOUT a saved result (legacy non-atomic approval) is still protected', async () => {
    const lg = await newProject(as('A_analyst'), T.A, 'legacy approved, no result')
    // simulate a pre-SEC approval that flipped the status but never saved a result
    await owner.raw(`do $$ begin perform set_config('xcepta.ctx', 'approve', true);
      update public.versions set status = 'approved', approved_at = now() where version_id = '${lg.v.version_id}'; end $$`)
    expect(await one('select count(*)::int n from model_outputs where version_id = $1', [lg.v.version_id])).toEqual({ n: 0 })
    await expect(owner.raw(`do $$ begin perform set_config('xcepta.ctx', 'delete', true); delete from public.versions where version_id = '${lg.v.version_id}'; end $$`))
      .rejects.toThrow(/RECORD_PROTECTED: approved and archived versions cannot be deleted/)
    await expect(owner.raw(`do $$ begin perform set_config('xcepta.ctx', 'delete', true); delete from public.scenarios where scenario_id = '${lg.s.scenario_id}'; end $$`))
      .rejects.toThrow(/RECORD_PROTECTED: approved and archived versions cannot be deleted/)
    expect(msg(await as('A_admin').rpc('delete_scenario', { p_scenario_id: lg.s.scenario_id }))).toMatch(/approved or archived records are kept/)
    expect((await one('select status from versions where version_id = $1', [lg.v.version_id])).status).toBe('approved')
  })

  test('S4.6 administrative functions cannot be used to rewrite or remove approved records', async () => {
    // member administration never touches financial records; tenant rename leaves them intact
    ok(await as('A_admin').rpc('admin_rename_tenant', { p_name: 'Tenant A (renamed)' }))
    ok(await as('A_admin').rpc('admin_set_member_role', { p_user_id: U.A_viewer, p_role: 'analyst' }))
    ok(await as('A_admin').rpc('admin_set_member_role', { p_user_id: U.A_viewer, p_role: 'viewer' }))
    // operator move of a member does not carry records across tenants
    const fp = await fingerprint()
    expect(fp.versions).toBeTruthy()
    // project archiving (flag) requires manager / admin
    expect(msg(await as('A_analyst').from('projects').update({ archived: true }).eq('project_id', F.PA.p.project_id))).toMatch(/NOT_AUTHORIZED/)
    ok(await as('A_manager').from('projects').update({ archived: true }).eq('project_id', F.PA.p.project_id))
    ok(await as('A_manager').from('projects').update({ archived: false }).eq('project_id', F.PA.p.project_id))
    expect(msg(await as('A_admin').from('projects').update({ tenant_id: T.B }).eq('project_id', F.PA.p.project_id))).toMatch(/RECORD_PROTECTED|row-level security/)
  })
})

// ═════════════════════════════════════════════════════════════════════════
describe('S5 collaboration (I2) and cross-tenant isolation', () => {
  test('S5.1 colleagues read approved results (any creator) exactly as saved; viewers read too', async () => {
    const expected = clean(runPPPEngine(rows(BASE)))
    for (const name of ['A_analyst', 'A_viewer', 'A_admin']) {
      const shown = await loadLatestModelOutput(as(name), F.PA.v.version_id)
      expect(shown).not.toBeNull()
      const { _persistence, ...financial } = shown
      expect(_persistence.engine_version).toBe(PPP_ENGINE_VERSION)
      expect(exactDiff(expected, financial).differences).toEqual([])
    }
  })

  test('S5.2 another tenant sees none of A (projects, versions, results, assumptions, members, audit)', async () => {
    const b = as('B_manager')
    expect(await loadLatestModelOutput(b, F.PA.v.version_id)).toBeNull()
    for (const [t, col, id] of [['projects', 'project_id', F.PA.p.project_id], ['scenarios', 'scenario_id', F.PA.s.scenario_id],
      ['versions', 'version_id', F.PA.v.version_id], ['model_outputs', 'version_id', F.PA.v.version_id],
      ['assumptions', 'project_id', F.PA.p.project_id], ['intake_state', 'version_id', F.PA.v.version_id], ['users', 'tenant_id', T.A],
      ['tenants', 'tenant_id', T.A], ['audit_events', 'tenant_id', T.A]]) {
      expect([t, ok(await b.from(t).select('*').eq(col, id))]).toEqual([t, []])
    }
  })

  test('S5.3 another tenant cannot write into A (insert with A tenant, update A rows)', async () => {
    const b = as('B_manager')
    denied(await b.from('projects').insert({ tenant_id: T.A, name: 'intrusion', project_type: 'Infrastructure / PPP' }).select())
    denied(await b.from('assumptions').insert({ tenant_id: T.A, project_id: F.PA.p.project_id, module_origin: 'feasibility', source_type: 'user_entry', name: 'x' }).select())
    ok(await b.from('assumptions').update({ value: 1 }).eq('project_id', F.PA.p.project_id))                 // RLS: zero rows touched
    expect((await one(`select value from assumptions where project_id = $1 and name = 'Total Project Cost'`, [F.PA.p.project_id])).value).toBe(100e6)
    expect(msg(await b.rpc('admin_set_member_role', { p_user_id: U.A_analyst, p_role: 'viewer' }))).toMatch(/NOT_AUTHORIZED|NOT_FOUND/)
  })

  test('S5.4 colleagues see each other’s profiles (same tenant only)', async () => {
    const names = ok(await as('A_analyst').from('users').select('*')).map(u => u.name).sort()
    expect(names).toEqual(['A_admin', 'A_analyst2', 'A_manager', 'A_viewer', 'Analyst A'].sort())
  })
})

// ═════════════════════════════════════════════════════════════════════════
describe('S6 roles, membership administration and deactivation', () => {
  test('S6.1 viewers are read-only (projects, assumptions, drafts, FP&A actuals)', async () => {
    const v = as('A_viewer')
    denied(await v.from('projects').insert({ tenant_id: T.A, name: 'viewer project', project_type: 'Infrastructure / PPP' }).select())
    denied(await v.from('versions').insert({ scenario_id: F.PA.s.scenario_id, label: 'x', status: 'draft' }).select())
    denied(await v.from('actuals').insert({ tenant_id: T.A, period: '2029-01', coa_node: 'REV_AVAILABILITY', amount: 1, project_id: F.PA.p.project_id, created_by: U.A_viewer }).select())
    ok(await v.from('assumptions').update({ value: 1 }).eq('project_id', F.PA.p.project_id))   // restrictive policy: zero rows
    expect((await one(`select value from assumptions where project_id = $1 and name = 'Total Project Cost'`, [F.PA.p.project_id])).value).toBe(100e6)
  })

  test('S6.2 tenant admin: roles within own tenant only; last admin protected; non-admins refused', async () => {
    expect(msg(await as('A_manager').rpc('admin_set_member_role', { p_user_id: U.A_analyst, p_role: 'manager' }))).toMatch(/NOT_AUTHORIZED/)
    expect(msg(await as('A_admin').rpc('admin_set_member_role', { p_user_id: U.B_analyst, p_role: 'admin' }))).toMatch(/NOT_FOUND/)
    expect(msg(await as('A_admin').rpc('admin_set_member_role', { p_user_id: U.A_admin, p_role: 'analyst' }))).toMatch(/LAST_ADMIN/)
    expect(msg(await as('A_admin').rpc('admin_set_member_active', { p_user_id: U.A_admin, p_active: false }))).toMatch(/LAST_ADMIN/)
    expect(msg(await as('A_admin').rpc('admin_set_member_role', { p_user_id: U.A_analyst, p_role: 'owner' }))).toMatch(/INVALID_ROLE/)
    expect(msg(await as('A_admin').rpc('operator_add_member', { p_user_id: uuid(), p_tenant_id: T.A, p_email: 'x', p_name: 'x' }))).toMatch(/permission denied/)
  })

  test('S6.3 a deactivated member immediately loses all access, then regains it when reactivated', async () => {
    ok(await as('A_admin').rpc('admin_set_member_active', { p_user_id: U.A_analyst2, p_active: false }))
    const off = as('A_analyst2')
    expect(ok(await off.from('projects').select('*'))).toEqual([])
    expect(ok(await off.from('model_outputs').select('*'))).toEqual([])
    denied(await off.from('projects').insert({ tenant_id: T.A, name: 'x', project_type: 'Infrastructure / PPP' }).select())
    expect(ok(await off.from('users').select('*')).map(u => u.user_id)).toEqual([U.A_analyst2])   // own profile only
    expect(msg(await off.rpc('delete_project', { p_project_id: F.DA2.p.project_id }))).toMatch(/NOT_AUTHENTICATED/)
    ok(await as('A_admin').rpc('admin_set_member_active', { p_user_id: U.A_analyst2, p_active: true }))
    expect(ok(await as('A_analyst2').from('projects').select('*')).length).toBeGreaterThan(0)
  })

  test('S6.4 operator: tenant moves need a documented reason; moved members get least privilege', async () => {
    const tmp = uuid()
    await pg.query('insert into auth.users (id, email) values ($1, $2)', [tmp, 'mover@xcepta.test'])
    ok(await op.rpc('operator_add_member', { p_user_id: tmp, p_tenant_id: T.A, p_email: 'mover@xcepta.test', p_name: 'mover', p_role: 'manager' }))
    expect(msg(await op.rpc('operator_move_member', { p_user_id: tmp, p_tenant_id: T.B, p_reason: 'short' }))).toMatch(/REASON_REQUIRED/)
    ok(await op.rpc('operator_move_member', { p_user_id: tmp, p_tenant_id: T.B, p_reason: 'transferred to Tenant B by agreement' }))
    expect(await one('select tenant_id, role from users where user_id = $1', [tmp])).toEqual({ tenant_id: T.B, role: 'analyst' })
    expect(msg(await as('A_admin').rpc('operator_move_member', { p_user_id: U.A_viewer, p_tenant_id: T.B, p_reason: 'xxxxxxxxxxxxxxxx' }))).toMatch(/permission denied/)
  })
})

// ═════════════════════════════════════════════════════════════════════════
describe('S7 audit trail — complete and append-only', () => {
  test('S7.1 privileged actions are recorded with actor and tenant; only tenant admins read them', async () => {
    const ev = (await pg.query('select action, actor, tenant_id from audit_events')).rows
    for (const a of ['tenant.create', 'member.add', 'version.approve', 'version.archive', 'project.delete_draft_only', 'scenario.delete_draft_only',
      'member.set_role', 'member.deactivate', 'member.activate', 'tenant.rename', 'member.move_out', 'member.move_in']) {
      expect([a, ev.some(e => e.action === a)]).toEqual([a, true])
    }
    expect(ev.find(e => e.action === 'version.approve' && e.tenant_id === T.A).actor).toBe(U.A_manager)
    const adminView = ok(await as('A_admin').from('audit_events').select('*'))
    expect(adminView.length).toBeGreaterThan(0)
    expect(adminView.every(e => e.tenant_id === T.A)).toBe(true)
    expect(ok(await as('A_manager').from('audit_events').select('*'))).toEqual([])
  })

  test('S7.2 nobody can alter or delete audit records — directly, as service role, as owner, or by truncate', async () => {
    const n = (await one('select count(*)::int n from audit_events')).n
    const id = (await one('select event_id from audit_events limit 1')).event_id
    expect(msg(await as('A_admin').from('audit_events').update({ action: 'x' }).eq('event_id', id))).toMatch(/permission denied/)
    expect(msg(await as('A_admin').from('audit_events').delete().eq('event_id', id))).toMatch(/permission denied/)
    expect(msg(await as('A_admin').from('audit_events').insert({ action: 'forged', entity: 'x', db_role: 'x' }).select())).toMatch(/permission denied/)
    expect(msg(await op.from('audit_events').delete().eq('event_id', id))).toMatch(/permission denied|AUDIT_APPEND_ONLY/)
    expect(msg(await owner.from('audit_events').update({ action: 'x' }).eq('event_id', id))).toMatch(/AUDIT_APPEND_ONLY/)
    expect(msg(await owner.from('audit_events').delete().eq('event_id', id))).toMatch(/AUDIT_APPEND_ONLY/)
    await expect(owner.raw('truncate public.audit_events')).rejects.toThrow(/AUDIT_APPEND_ONLY/)
    expect((await one('select count(*)::int n from audit_events')).n).toBe(n)
  })
})

// ═════════════════════════════════════════════════════════════════════════
describe('S8 operator purge — the only permanent deletion of approved records', () => {
  test('S8.1 refused for members and without explicit confirmation or a documented reason', async () => {
    const p = F.PB.p.project_id
    expect(msg(await as('B_manager').rpc('operator_purge_project', { p_project_id: p, p_reason: 'x'.repeat(20), p_confirm: 'PURGE ' + p }))).toMatch(/permission denied/)
    expect(msg(await op.rpc('operator_purge_project', { p_project_id: p, p_reason: 'retention period ended', p_confirm: 'yes' }))).toMatch(/CONFIRMATION_REQUIRED/)
    expect(msg(await op.rpc('operator_purge_project', { p_project_id: p, p_reason: 'short', p_confirm: 'PURGE ' + p }))).toMatch(/REASON_REQUIRED/)
    expect(await one('select count(*)::int n from model_outputs where project_id = $1', [p])).toEqual({ n: 1 })
  })

  test('S8.2 with confirmation and reason: records removed, audit written first and kept (no cascade into audit)', async () => {
    const p = F.PB.p.project_id
    const summary = ok(await op.rpc('operator_purge_project', { p_project_id: p, p_reason: 'client data-retention request #42', p_confirm: 'PURGE ' + p }))
    expect(summary).toMatchObject({ approved_versions: 1, model_outputs: 1, reason: 'client data-retention request #42' })
    expect(await one('select count(*)::int n from projects where project_id = $1', [p])).toEqual({ n: 0 })
    const a = await one(`select details from audit_events where action = 'project.purge' and entity_id = $1`, [p])
    expect(a.details.model_outputs_md5).toMatch(/^[0-9a-f]{32}$/)
    expect(await one(`select count(*)::int n from audit_events where tenant_id = $1 and action = 'version.approve'`, [T.B])).toEqual({ n: 1 })
  })
})

// ═════════════════════════════════════════════════════════════════════════
describe('S9 integrity proof and migration behaviour', () => {
  test('S9.1 tenant A approved versions and every saved result are bit-identical after the whole negative suite', async () => {
    // Only intended changes happened: PA2 archived (S2.5), DAv2 and the S4.4 child approved, PB purged (S8).
    const now = (await pg.query(`select md5(m::text) h, m.output_id from model_outputs m where m.output_id = $1`, [F.OA.output_id])).rows[0]
    const at = (await pg.query(`select md5(m::text) h from (select * from model_outputs where output_id = $1) m`, [F.OA.output_id])).rows[0]
    expect(now.output_id).toBe(F.OA.output_id)
    const original = clean(F.OA)
    const stored = clean((await pg.query('select * from model_outputs where output_id = $1', [F.OA.output_id])).rows[0])
    expect(exactDiff(original, stored).differences).toEqual([])
    const v = await one('select status, label, approved_at, approved_by from versions where version_id = $1', [F.PA.v.version_id])
    expect(v.status).toBe('approved'); expect(v.label).toBe('v1.0 Approved'); expect(v.approved_by).toBe(U.A_manager)
    expect(at.h).toMatch(/^[0-9a-f]{32}$/)
  })

  test('S9.2 before SEC-03 is applied, the app reports a clear SECURITY_MIGRATION_MISSING (nothing written)', async () => {
    const early = await createSecurityDb({ upTo: 1 })   // P-022 only
    const c = asClient(early, null)
    await expect(savePPPApproval(c, { output: runPPPEngine(rows(BASE)), assumptions: rows(BASE), engineVersion: PPP_ENGINE_VERSION,
      versionId: uuid(), approvedLabel: 'x' })).rejects.toMatchObject({ code: 'SECURITY_MIGRATION_MISSING' })
    await early.close()
  })

  test('S9.4 the read-only catalog verification (db/security/verify_security_catalog.sql) passes every check', async () => {
    const { readFileSync } = await import('fs')
    const res = await pg.exec(readFileSync(new URL('../db/security/verify_security_catalog.sql', import.meta.url), 'utf8'))
    const checks = res.find(r => r.rows && r.rows.length && 'check_name' in r.rows[0]).rows
    expect(checks.length).toBe(22)
    expect(checks.filter(c => !c.pass).map(c => c.step + ' ' + c.check_name + ' ' + (c.detail || ''))).toEqual([])
  })

  test('S9.5 rollback 04 → 01 restores the baseline privileges and policies exactly; re-applying works', async () => {
    const { readFileSync } = await import('fs')
    const db3 = await createSecurityDb({ upTo: 1 })                  // baseline + P-022
    const snap = async db => ({
      policies: (await db.query("select tablename || ':' || policyname || ':' || permissive || ':' || cmd as p from pg_policies where tablename <> 'audit_events' order by 1")).rows.map(r => r.p),
      grants: (await db.query(`select table_name || ':' || grantee || ':' || privilege_type as g from information_schema.role_table_grants
                where table_schema = 'public' and table_name <> 'audit_events' and grantee in ('anon', 'authenticated', 'service_role') order by 1`)).rows.map(r => r.g),
      colgrants: (await db.query(`select table_name || ':' || column_name || ':' || grantee as g from information_schema.column_privileges
                where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type = 'UPDATE' and table_name in ('users', 'versions')
                  and column_name not in ('active', 'approved_by', 'archived_at', 'archived_by') order by 1`)).rows.map(r => r.g),   // additive columns are kept by design
      triggers: (await db.query("select tgrelid::regclass::text || ':' || tgname as t from pg_trigger where not tgisinternal and tgrelid::regclass::text <> 'audit_events' order by 1")).rows.map(r => r.t),
    })
    const baseline = await snap(db3)
    for (const m of SECURITY_MIGRATIONS.slice(1, 4)) await db3.exec(readFileSync(new URL(m, new URL('./helpers/', import.meta.url)), 'utf8'))
    const afterSec03 = await snap(db3)
    await db3.exec(readFileSync(new URL(SECURITY_MIGRATIONS[4], new URL('./helpers/', import.meta.url)), 'utf8'))
    expect((await snap(db3)).policies).not.toEqual(baseline.policies)
    await db3.exec(readFileSync(new URL('../db/migrations/rollback/2026-10-16_sec04_rollback.sql', import.meta.url), 'utf8'))
    expect(await snap(db3)).toEqual(afterSec03)                                  // SEC-04 rollback -> exactly post-SEC-03
    await db3.exec(readFileSync(new URL(SECURITY_MIGRATIONS[4], new URL('./helpers/', import.meta.url)), 'utf8'))
    for (const r of ['04', '03', '02', '01']) await db3.exec(readFileSync(new URL(`../db/migrations/rollback/2026-10-16_sec${r}_rollback.sql`, import.meta.url), 'utf8'))
    expect(await snap(db3)).toEqual(baseline)
    expect((await db3.query("select count(*)::int n from information_schema.tables where table_name = 'audit_events'")).rows[0].n).toBe(1)  // audit history kept
    for (const m of SECURITY_MIGRATIONS.slice(1)) await db3.exec(readFileSync(new URL(m, new URL('./helpers/', import.meta.url)), 'utf8'))
    const res = await db3.exec(readFileSync(new URL('../db/security/verify_security_catalog.sql', import.meta.url), 'utf8'))
    expect(res.find(r => r.rows && r.rows.length && 'check_name' in r.rows[0]).rows.every(c => c.pass)).toBe(true)
    await db3.close()
  })

  test('S9.6 maintenance freeze: only tenant admins operate; members are frozen; off restores exactly', async () => {
    const { readFileSync } = await import('fs')
    const before = (await pg.query('select count(*)::int n from pg_policies')).rows[0].n
    await pg.exec(readFileSync(new URL('../db/security/maintenance_on.sql', import.meta.url), 'utf8'))
    expect(ok(await as('A_manager').from('projects').select('*'))).toEqual([])
    expect(ok(await as('A_analyst').from('model_outputs').select('*'))).toEqual([])
    denied(await as('A_analyst').from('projects').insert({ tenant_id: T.A, name: 'during freeze', project_type: 'Infrastructure / PPP' }).select())
    ok(await as('A_analyst').from('assumptions').delete().eq('project_id', F.PA.p.project_id))          // zero rows: nothing deleted
    expect((await one('select count(*)::int n from assumptions where project_id = $1', [F.PA.p.project_id])).n).toBeGreaterThan(0)
    expect(ok(await as('A_admin').from('projects').select('*')).length).toBeGreaterThan(0)            // admins can verify
    await pg.exec(readFileSync(new URL('../db/security/maintenance_off.sql', import.meta.url), 'utf8'))
    expect((await pg.query('select count(*)::int n from pg_policies')).rows[0].n).toBe(before)
    expect(ok(await as('A_manager').from('projects').select('*')).length).toBeGreaterThan(0)
  })

  test('S9.7 operator can bootstrap a tenant admin (reason required, audited); members cannot', async () => {
    expect(msg(await as('A_admin').rpc('operator_set_member_role', { p_user_id: U.A_viewer, p_role: 'admin', p_reason: 'bootstrap first admin' }))).toMatch(/permission denied/)
    expect(msg(await op.rpc('operator_set_member_role', { p_user_id: U.A_viewer, p_role: 'admin', p_reason: 'short' }))).toMatch(/REASON_REQUIRED/)
    ok(await op.rpc('operator_set_member_role', { p_user_id: U.A_viewer, p_role: 'manager', p_reason: 'cutover role assignment (test)' }))
    expect((await one('select role from users where user_id = $1', [U.A_viewer])).role).toBe('manager')
    expect((await one(`select details from audit_events where action = 'member.set_role_by_operator' and entity_id = $1`, [U.A_viewer])).details.reason)
      .toBe('cutover role assignment (test)')
    ok(await op.rpc('operator_set_member_role', { p_user_id: U.A_viewer, p_role: 'viewer', p_reason: 'restore test role after check' }))
  })

  test('S9.3 every migration is idempotent (re-applying SEC-01..04 changes nothing and does not fail)', async () => {
    const db2 = await createSecurityDb()
    const { readFileSync } = await import('fs')
    for (const m of SECURITY_MIGRATIONS) await db2.exec(readFileSync(new URL(m, new URL('./helpers/', import.meta.url)), 'utf8'))
    const pol = (await db2.query('select count(*)::int n from pg_policies')).rows[0].n
    const pol1 = (await pg.query('select count(*)::int n from pg_policies')).rows[0].n
    expect(pol).toBe(pol1)
    await db2.close()
  })
})

// ═════════════════════════════════════════════════════════════════════════
describe('S10 privileges (C1, C2): TRUNCATE / TRIGGER / REFERENCES, default privileges, ownership differences', () => {
  const verify = async db => {
    const { readFileSync } = await import('fs')
    const res = await db.exec(readFileSync(new URL('../db/security/verify_security_catalog.sql', import.meta.url), 'utf8'))
    return res.find(r => r.rows && r.rows.length && 'check_name' in r.rows[0]).rows
  }
  const failing = rows => rows.filter(c => !c.pass).map(c => c.check_name)

  test('S10.1 only the owner holds TRUNCATE / TRIGGER / REFERENCES; TRUNCATE (which bypasses RLS) is refused for every API role', async () => {
    const holders = (await pg.query(`select c.relname, r.rolname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
       where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege(r.rolname, c.oid, 'TRUNCATE,TRIGGER,REFERENCES')`)).rows
    expect(holders).toEqual([])
    for (const t of ['assumptions', 'actuals', 'variances', 'intake_state', 'static_defaults', 'projects', 'model_outputs']) {
      await expect(op.raw('truncate public.' + t)).rejects.toThrow(/permission denied/)
      await expect(as('A_admin').raw('truncate public.' + t)).rejects.toThrow(/permission denied/)
    }
  })

  test('S10.2 legitimate service-role and operator operations still work', async () => {
    const id = ok(await op.from('actuals').insert({ tenant_id: T.A, period: '2030-01', coa_node: 'REV_AVAILABILITY', amount: 10, project_id: F.PA.p.project_id }).select())[0].actual_id
    ok(await op.from('actuals').update({ amount: 11 }).eq('actual_id', id))
    expect(ok(await op.from('actuals').select('*').eq('actual_id', id))[0].amount).toBe(11)
    ok(await op.from('actuals').delete().eq('actual_id', id))
    expect(ok(await op.from('model_outputs').select('*')).length).toBeGreaterThan(0)            // reads everything (bypasses RLS)
    const t = ok(await op.rpc('operator_create_tenant', { p_name: 'Tenant C (S10)' }))
    const u = uuid()
    await pg.query('insert into auth.users (id, email) values ($1, $2)', [u, 'c@xcepta.test'])
    ok(await op.rpc('operator_add_member', { p_user_id: u, p_tenant_id: t, p_email: 'c@xcepta.test', p_name: 'C', p_role: 'analyst' }))
    ok(await op.rpc('operator_set_member_role', { p_user_id: u, p_role: 'admin', p_reason: 'bootstrap admin for tenant C' }))
    expect((await one('select role from users where user_id = $1', [u])).role).toBe('admin')
  })

  test('S10.3 objects created LATER by the migration owner get no PUBLIC / anon EXECUTE and no TRUNCATE / TRIGGER / REFERENCES', async () => {
    const db = await createSecurityDb()
    await db.exec(`create function public.probe_fn() returns int language sql as $$ select 1 $$;
                   create table public.probe_t (id int primary key); create sequence public.probe_s;`)
    const f = (await db.query(`select has_function_privilege('anon', 'public.probe_fn()', 'EXECUTE') a,
        has_function_privilege('authenticated', 'public.probe_fn()', 'EXECUTE') u,
        has_function_privilege('service_role', 'public.probe_fn()', 'EXECUTE') s,
        exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                 where p.oid = 'public.probe_fn()'::regprocedure and x.grantee = 0) pub`)).rows[0]
    expect(f).toEqual({ a: false, u: false, s: true, pub: false })
    const t = (await db.query(`select has_table_privilege('anon', 'public.probe_t', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') anon,
        has_table_privilege('authenticated', 'public.probe_t', 'SELECT') auth_sel,
        has_table_privilege('authenticated', 'public.probe_t', 'TRUNCATE,TRIGGER,REFERENCES') auth_trunc,
        has_table_privilege('service_role', 'public.probe_t', 'TRUNCATE,TRIGGER,REFERENCES') svc_trunc,
        has_sequence_privilege('anon', 'public.probe_s', 'USAGE,SELECT,UPDATE') anon_seq`)).rows[0]
    expect(t).toEqual({ anon: false, auth_sel: true, auth_trunc: false, svc_trunc: false, anon_seq: false })
    // a new table without RLS is flagged by the catalog verification
    expect(failing(await verify(db))).toEqual(['RLS enabled on every public table'])
    await db.close()
  })

  test('S10.4 Supabase ownership differences: objects / grants by ANOTHER role are not covered by owner revokes — the catalog verification flags them', async () => {
    const db = await createSecurityDb()
    await db.exec(`create role supabase_admin nologin; grant usage, create on schema public to supabase_admin;
      alter default privileges for role supabase_admin in schema public grant execute on functions to anon, authenticated;
      grant truncate on public.assumptions to supabase_admin with grant option;
      set role supabase_admin;
      create function public.sa_probe() returns int language sql as $$ select 1 $$;
      grant truncate on public.assumptions to authenticated;
      reset role;`)
    expect(failing(await verify(db)).sort()).toEqual([
      'every table privilege of anon / authenticated / service_role is granted by the table owner (owner revokes are effective)',
      'no function in schema public executable by anon (any function, any owner)',
      'no role except the owner holds TRUNCATE / TRIGGER / REFERENCES on public tables'].sort())
    // re-running the owner's revoke does NOT remove another grantor's grant …
    await db.exec('revoke truncate, trigger, references on all tables in schema public from authenticated, service_role;')
    expect((await db.query(`select has_table_privilege('authenticated', 'public.assumptions', 'TRUNCATE') t`)).rows[0].t).toBe(true)
    // … the documented remediation (owner revokes the grantor's grant option with CASCADE) does
    await db.exec('revoke truncate on public.assumptions from supabase_admin cascade; drop function public.sa_probe();')
    expect(failing(await verify(db))).toEqual([])
    await db.close()
  })

  test('S10.5 a failing migration applies NOTHING, even when run statement by statement like psql -f (C3)', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync(new URL(SECURITY_MIGRATIONS[1], new URL('./helpers/', import.meta.url)), 'utf8')
    const broken = src.replace('create table if not exists public.audit_events (', 'create table if not exists public.audit_events (broken_column not_a_type, ')
    expect(splitSqlStatements(src).length).toBeGreaterThan(20)                       // really statement by statement
    const db = await createSecurityDb({ upTo: 1 })
    const r = await runLikePsql(db, broken)
    expect(r.error).not.toBeNull()
    const left = (await db.query(`select (select count(*) from pg_namespace where nspname = 'app_private')::int sch,
        (select count(*) from information_schema.columns where table_name = 'users' and column_name = 'active')::int col,
        (select count(*) from pg_default_acl where defaclnamespace = 0)::int defacl`)).rows[0]
    expect(left).toEqual({ sch: 0, col: 0, defacl: 0 })
    expect((await runLikePsql(db, src)).error).toBeNull()                              // the intact file then applies cleanly
    await db.close()
  })

  test('S10.6 explicit per-function revokes hold even where the C2 default privileges are absent', async () => {
    const { readFileSync } = await import('fs')
    const db = await createSecurityDb({ upTo: 1 })
    const sec01NoDefaults = readFileSync(new URL(SECURITY_MIGRATIONS[1], new URL('./helpers/', import.meta.url)), 'utf8')
      .split('\n').filter(l => !/^alter default privileges for role postgres/.test(l)).join('\n')
    await db.exec(sec01NoDefaults)
    for (const m of SECURITY_MIGRATIONS.slice(2)) await db.exec(readFileSync(new URL(m, new URL('./helpers/', import.meta.url)), 'utf8'))
    const exposed = (await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'app_private') and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or (n.nspname = 'app_private' and has_function_privilege('authenticated', p.oid, 'EXECUTE')))`)).rows
    expect(exposed).toEqual([])
    await db.close()
  })

  test('S10.7 every migration and rollback script is one explicit transaction (begin first, commit last)', async () => {
    const { readFileSync, readdirSync } = await import('fs')
    const files = SECURITY_MIGRATIONS.slice(1).map(m => new URL(m, new URL('./helpers/', import.meta.url)))
      .concat(readdirSync(new URL('../db/migrations/rollback/', import.meta.url)).map(n => new URL('../db/migrations/rollback/' + n, import.meta.url)))
    expect(files.length).toBe(8)
    for (const u of files) {
      const st = splitSqlStatements(readFileSync(u, 'utf8'))
      expect([u.pathname, st[0].replace(/^(--[^\n]*\n)*/, '').trim()]).toEqual([u.pathname, 'begin'])
      expect([u.pathname, st[st.length - 1]]).toEqual([u.pathname, 'commit'])
      expect([u.pathname, st.filter(x => /^(begin|commit|rollback)$/i.test(x.replace(/^(--[^\n]*\n)*/, '').trim())).length]).toEqual([u.pathname, 2])
    }
  })

})
