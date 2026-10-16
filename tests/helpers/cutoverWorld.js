// Shared fixture for the SEC-04 cutover rehearsals: the post-SEC-03 staging schema with two
// tenants and every role, projects created the way the app creates them, a per-project row
// fingerprint, and the deployed app (2e4994c) request sequences — copied from the deployed
// code, intermediate errors ignored exactly as there.
import { createSecurityDb, asClient } from './pgliteSecurity.js'
import { runPPPEngine, PPP_ENGINE_VERSION } from '../../src/modules/feasibility/annualEngine.js'
import { savePPPApproval } from '../../src/modules/feasibility/pppResultStore.js'

export const rows = o => Object.entries(o).map(([name, v]) => (typeof v === 'string'
  ? { name, value: null, unit: v, category: 'ppp_structure' } : { name, value: v, unit: null, category: 'ppp_structure' }))
export const BASE = { 'Total Project Cost': 100e6, 'Debt %': 80, 'Equity %': 20, 'Annual Availability Payment': 12e6,
  'Concession Period': 25, 'Construction Period': 24, 'OPEX % of Revenue': 5, 'Interest Rate': 7, 'Loan Tenor': 10,
  'Grace Period': 2, 'Tax Rate': 21, 'WACC': 10, 'Target DSCR': 1.2, 'Construction Start Date': '2026-07-01' }
const ok = r => { if (r && r.error) throw new Error(r.error.message); return r && r.data }

// roles: adm (admin), adm2 (second admin, deactivated), mgr, an, vw (tenant A); badm (admin, tenant B)
export async function createCutoverWorld({ upTo = 4 } = {}) {
  const pg = await createSecurityDb({ upTo })
  const one = async (q, v) => (await pg.query(q, v)).rows[0]
  const U = await one(`select gen_random_uuid() t, gen_random_uuid() tb, gen_random_uuid() adm, gen_random_uuid() adm2, gen_random_uuid() mgr,
    gen_random_uuid() an, gen_random_uuid() vw, gen_random_uuid() badm`)
  await pg.exec(`begin; select set_config('xcepta.ctx', 'admin', true);
    insert into tenants (tenant_id, name) values ('${U.t}', 'Staging A'), ('${U.tb}', 'Staging B');
    insert into auth.users (id, email) select x, x::text || '@xcepta.test'
      from unnest(array['${U.adm}', '${U.adm2}', '${U.mgr}', '${U.an}', '${U.vw}', '${U.badm}']::uuid[]) x;
    insert into users (user_id, tenant_id, email, name, role, active) values
      ('${U.adm}', '${U.t}', 'adm@xcepta.test', 'Admin', 'admin', true), ('${U.adm2}', '${U.t}', 'adm2@xcepta.test', 'Former admin', 'admin', true),
      ('${U.mgr}', '${U.t}', 'mgr@xcepta.test', 'Manager', 'manager', true), ('${U.an}', '${U.t}', 'an@xcepta.test', 'Analyst', 'analyst', true),
      ('${U.vw}', '${U.t}', 'vw@xcepta.test', 'Viewer', 'viewer', true), ('${U.badm}', '${U.tb}', 'badm@xcepta.test', 'B Admin', 'admin', true);
    update users set active = false where user_id = '${U.adm2}';
    commit;`)
  const C = Object.fromEntries(['adm', 'adm2', 'mgr', 'an', 'vw', 'badm'].map(k => [k, asClient(pg, { role: 'authenticated', sub: U[k] })]))
  C.op = asClient(pg, { role: 'service_role' })
  C.anon = asClient(pg, { role: 'anon' })

  // base scenario + draft + intake + project assumptions; a named scenario with a draft and a
  // scenario-level driver; FP&A actuals and variances for two periods
  async function project(owner, name, { approve = false } = {}) {
    const c = C[owner], uid = U[owner]
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
    if (approve) await approvePPP(C.mgr, v.version_id)
    return { p, s, v, bull, bv, override: a.find(x => x.name === 'Debt %'), driver }
  }
  const approvePPP = (client, versionId) => savePPPApproval(client, { output: runPPPEngine(rows(BASE)), assumptions: rows(BASE),
    engineVersion: PPP_ENGINE_VERSION, versionId, projectId: null, tenantId: null, userId: null, approvedLabel: 'v1.0 Approved' })

  // every row belonging to a project, as the owner (bypasses RLS)
  const projectRows = async pid => one(`select
    (select count(*)::int || ':' || md5(coalesce(string_agg(x::text, '|' order by x.assumption_id), '')) from assumptions x where project_id = $1) assumptions,
    (select count(*)::int || ':' || md5(coalesce(string_agg(x::text, '|' order by x.actual_id), '')) from actuals x where project_id = $1) actuals,
    (select count(*)::int || ':' || md5(coalesce(string_agg(x::text, '|' order by x.variance_id), '')) from variances x where project_id = $1) variances,
    (select count(*)::int || ':' || md5(coalesce(string_agg(x::text, '|' order by x.output_id), '')) from model_outputs x where project_id = $1) model_outputs,
    (select count(*)::int || ':' || md5(coalesce(string_agg(x::text, '|' order by x.version_id), '')) from versions x join scenarios s using (scenario_id) where s.project_id = $1) versions,
    (select count(*)::int || ':' || md5(coalesce(string_agg(i::text, '|' order by i.intake_id), '')) from intake_state i join versions x using (version_id) join scenarios s using (scenario_id) where s.project_id = $1) intake,
    (select count(*)::int || ':' || md5(coalesce(string_agg(x::text, '|' order by x.scenario_id), '')) from scenarios x where project_id = $1) scenarios,
    (select count(*)::int from projects where project_id = $1) project`, [pid])
  // a project is either untouched or entirely gone — never partial
  const isGone = r => r.project === 0 && ['assumptions', 'actuals', 'variances', 'model_outputs', 'versions', 'intake', 'scenarios'].every(k => r[k].startsWith('0:'))

  return { pg, one, U, C, project, approvePPP, projectRows, isGone }
}

export async function oldDeleteProject(c, pid) {                  // 2e4994c src/pages/Feasibility.jsx handleDelete
  await c.from('model_outputs').delete().eq('project_id', pid)
  await c.from('variances').delete().eq('project_id', pid)
  await c.from('actuals').delete().eq('project_id', pid)
  await c.from('assumptions').delete().eq('project_id', pid)
  const sc = (await c.from('scenarios').select('scenario_id').eq('project_id', pid)).data || []
  for (const s of sc) await c.from('versions').delete().eq('scenario_id', s.scenario_id)   // .in('scenario_id', ids) in the app
  await c.from('scenarios').delete().eq('project_id', pid)
  return c.from('projects').delete().eq('project_id', pid)
}
export async function oldDeleteScenario(c, pid, sc, latestVersionId) {   // 2e4994c src/pages/FeasibilityProject.jsx handleDeleteScenario
  await c.from('model_outputs').delete().eq('version_id', latestVersionId)
  await c.from('versions').delete().eq('scenario_id', sc)
  await c.from('assumptions').delete().eq('project_id', pid).eq('scenario_id', sc)
  await c.from('scenarios').delete().eq('scenario_id', sc)
}
// FP&A replacement — identical in 2e4994c and the new app (src/pages/FPAProject.jsx)
export async function fpaSubmit(c, tenant, uid, x, period, amount) {
  await c.from('actuals').delete().eq('project_id', x.p.project_id).eq('period', period)
  const a = await c.from('actuals').insert(['REV_AP', 'OPEX'].map(n => ({ tenant_id: tenant, project_id: x.p.project_id, period, coa_node: n, amount, created_by: uid })))
  if (a.error) return 'stopped at actuals insert: ' + a.error.message
  await c.from('variances').delete().eq('project_id', x.p.project_id).eq('period', period)
  const v = await c.from('variances').insert(['REV_AP', 'OPEX'].map(n => ({ tenant_id: tenant, project_id: x.p.project_id, version_id: x.v.version_id, period,
    coa_node: n, budget_amount: 100, actual_amount: amount, severity_flag: 'green', created_by: uid })))
  if (v.error) return 'stopped at variances insert: ' + v.error.message
  return 'saved'
}
