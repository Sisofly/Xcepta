/**
 * assumptionWrites.test.js — confirmed assumption deletes (src/modules/feasibility/assumptionWrites.js),
 * used by FeasibilityProject.jsx handleRemoveOverride / handleResetScenarioDriver.
 * Runs the real request sequence against the post-SEC-03 staging schema (PGlite) with the exact
 * cutover-lock and SEC-04 files: success, already absent, permission refusal under the lock,
 * zero-row deletion, failed lookup, ambiguous lookup. A failure must never be reported as success.
 */
import { readFileSync } from 'node:fs'
import { createCutoverWorld } from './helpers/cutoverWorld.js'
import { saveBenchmarkOverride, removeBenchmarkOverride, deleteAssumption } from '../src/modules/feasibility/assumptionWrites.js'

const file = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
const LOCK_ON = file('db/security/cutover_lock_on.sql')
const LOCK_OFF = file('db/security/cutover_lock_off.sql')
const SEC04 = file('db/migrations/2026-10-16_sec04_record_protection.sql')
const M_ON = file('db/security/maintenance_on.sql')
const KEY = 'construction_cost_per_sqm'

let W, pg, X
const exists = async id => (await pg.query('select count(*)::int n from assumptions where assumption_id = $1', [id])).rows[0].n === 1
async function override(owner, key = KEY) {
  const r = await W.C[owner].from('assumptions').insert({ tenant_id: W.U.t, project_id: X.p.project_id, category: 'benchmark_override',
    name: key, value: 1500, module_origin: 'feasibility', source_type: 'user_entry', author_user_id: W.U[owner] }).select()
  if (r.error) throw new Error(r.error.message)
  return r.data[0].assumption_id
}
async function setup(stage) {
  W = await createCutoverWorld(); pg = W.pg
  X = await W.project('an', 'override project')
  const ids = { override: await override('an'), driver: X.driver.assumption_id }
  if (stage !== 'A') await pg.exec(LOCK_ON)
  if (stage === 'C' || stage === 'D') await pg.exec(SEC04)
  if (stage === 'D') await pg.exec(LOCK_OFF)
  return ids
}
afterEach(async () => { if (pg) { await pg.close(); pg = null } })

describe('W1 successful deletion', () => {
  test.each(['A', 'D'])('W1.1 stage %s: override removed — ok, row gone', async stage => {
    const ids = await setup(stage)
    expect(await removeBenchmarkOverride(W.C.an, X.p.project_id, KEY)).toEqual({ ok: true })
    expect(await exists(ids.override)).toBe(false)
  })
  test.each(['A', 'D'])('W1.2 stage %s: scenario driver reset — ok, row gone', async stage => {
    const ids = await setup(stage)
    expect(await deleteAssumption(W.C.an, ids.driver)).toEqual({ ok: true })
    expect(await exists(ids.driver)).toBe(false)
  })
  test('W1.3 an override that is already absent counts as removed (nothing else touched)', async () => {
    const ids = await setup('A')
    expect(await removeBenchmarkOverride(W.C.an, X.p.project_id, 'not_overridden')).toEqual({ ok: true, alreadyAbsent: true })
    expect(await exists(ids.override)).toBe(true)
  })
})

describe('W2 permission refusal under the temporary cutover lock', () => {
  test.each(['B', 'C'])('W2.1 stage %s: override removal refused with the database message; row kept', async stage => {
    const ids = await setup(stage)
    for (const who of ['adm', 'mgr', 'an']) {
      expect(await removeBenchmarkOverride(W.C[who], X.p.project_id, KEY)).toEqual({ ok: false, message: 'permission denied for table assumptions' })
    }
    expect(await exists(ids.override)).toBe(true)
  })
  test.each(['B', 'C'])('W2.2 stage %s: scenario driver reset refused; row kept', async stage => {
    const ids = await setup(stage)
    expect(await deleteAssumption(W.C.an, ids.driver)).toEqual({ ok: false, message: 'permission denied for table assumptions' })
    expect(await exists(ids.driver)).toBe(true)
  })
})

describe('W3 zero-row deletion is a failure, not a success', () => {
  test('W3.1 stage D: a viewer sees the override but its DELETE removes no row (role policy) → failure; row kept', async () => {
    const ids = await setup('D')
    const r = await removeBenchmarkOverride(W.C.vw, X.p.project_id, KEY)
    expect(r.ok).toBe(false); expect(r.message).toMatch(/not deleted/)
    expect(await exists(ids.override)).toBe(true)
  })
  test('W3.2 stage D: a viewer resetting a scenario driver → failure; row kept', async () => {
    const ids = await setup('D')
    const r = await deleteAssumption(W.C.vw, ids.driver)
    expect(r.ok).toBe(false); expect(r.message).toMatch(/not deleted/)
    expect(await exists(ids.driver)).toBe(true)
  })
  test('W3.3 a driver id that no longer exists (deleted elsewhere) → failure reported; the page reloads from the database', async () => {
    await setup('D')
    const r = await deleteAssumption(W.C.an, crypto.randomUUID())
    expect(r.ok).toBe(false); expect(r.message).toMatch(/not deleted/)
  })
  test('W3.4 another tenant cannot see or delete the override: treated as absent there, row kept', async () => {
    const ids = await setup('D')
    expect(await deleteAssumption(W.C.badm, ids.override)).toMatchObject({ ok: false })
    expect(await exists(ids.override)).toBe(true)
  })
})

describe('W4 lookup failures never look like success', () => {
  test('W4.1 a failed lookup (anon: no privilege) → failure; row kept', async () => {
    const ids = await setup('A')
    const r = await removeBenchmarkOverride(W.C.anon, X.p.project_id, KEY)
    expect(r.ok).toBe(false); expect(r.message).toMatch(/permission denied/)
    expect(await exists(ids.override)).toBe(true)
  })
  test('W4.2 two overrides with the same name (ambiguous) → failure; neither deleted', async () => {
    const ids = await setup('A')
    const second = await override('an')
    const r = await removeBenchmarkOverride(W.C.an, X.p.project_id, KEY)
    expect(r.ok).toBe(false)
    expect(await exists(ids.override)).toBe(true); expect(await exists(second)).toBe(true)
  })
  test('W4.3 during the maintenance freeze an analyst cannot see the row: reported as absent, the row is untouched', async () => {
    const ids = await setup('C')
    await pg.exec(M_ON)
    expect(await removeBenchmarkOverride(W.C.an, X.p.project_id, KEY)).toEqual({ ok: true, alreadyAbsent: true })
    expect(await exists(ids.override)).toBe(true)
  })
})

// a scenario-level driver with the same key as a project-level override (same category)
async function driver(owner, scenarioId, key = KEY, value = 900) {
  const r = await W.C[owner].from('assumptions').insert({ tenant_id: W.U.t, project_id: X.p.project_id, scenario_id: scenarioId,
    category: 'benchmark_override', name: key, value, module_origin: 'feasibility', source_type: 'user_entry', author_user_id: W.U[owner] }).select()
  if (r.error) throw new Error(r.error.message)
  return r.data[0].assumption_id
}
const row = async id => (await pg.query('select assumption_id, scenario_id, value from assumptions where assumption_id = $1', [id])).rows[0] || null
const projectLevel = async key => (await pg.query(`select assumption_id, value, unit, confidence, category, module_origin, source_type, tenant_id, scenario_id
  from assumptions where project_id = $1 and scenario_id is null and category = 'benchmark_override' and name = $2 order by created_at`, [X.p.project_id, key])).rows

describe('W6 a project-level override never touches a scenario driver with the same name', () => {
  test.each(['A', 'D'])('W6.1 stage %s: remove deletes the project-level row only; the driver is unchanged', async stage => {
    const ids = await setup(stage)
    const d = await driver('an', X.bull.scenario_id)
    const before = await row(d)
    expect(await removeBenchmarkOverride(W.C.an, X.p.project_id, KEY)).toEqual({ ok: true })
    expect(await exists(ids.override)).toBe(false)
    expect(await row(d)).toEqual(before)
  })
  test('W6.2 only a scenario driver has the name: remove reports "already absent" and deletes nothing', async () => {
    await setup('A')
    const d = await driver('an', X.bull.scenario_id, 'land_cost_pct_of_tdc')
    const before = await row(d)
    expect(await removeBenchmarkOverride(W.C.an, X.p.project_id, 'land_cost_pct_of_tdc')).toEqual({ ok: true, alreadyAbsent: true })
    expect(await row(d)).toEqual(before)
  })
  test('W6.3 only a scenario driver has the name: save creates a project-level override; the driver keeps its value', async () => {
    await setup('A')
    const d = await driver('an', X.bull.scenario_id, 'land_cost_pct_of_tdc', 0.25)
    const before = await row(d)
    expect(await saveBenchmarkOverride(W.C.an, { projectId: X.p.project_id, tenantId: W.U.t, key: 'land_cost_pct_of_tdc', value: 0.3 })).toEqual({ ok: true })
    expect(await row(d)).toEqual(before)
    const p = await projectLevel('land_cost_pct_of_tdc')
    expect(p.map(r => [r.value, r.scenario_id])).toEqual([[0.3, null]])
  })
  test.each(['A', 'D'])('W6.4 stage %s: both exist — save updates the project-level row only', async stage => {
    const ids = await setup(stage)
    const d = await driver('an', X.bull.scenario_id)
    const before = await row(d)
    expect(await saveBenchmarkOverride(W.C.an, { projectId: X.p.project_id, tenantId: W.U.t, key: KEY, value: 3333 })).toEqual({ ok: true })
    expect((await row(ids.override)).value).toBe(3333)
    expect(await row(d)).toEqual(before)
    expect(await projectLevel(KEY)).toHaveLength(1)
  })
  test('W6.5 drivers with the name in two scenarios: remove and save still address only the project-level row', async () => {
    const ids = await setup('A')
    const d1 = await driver('an', X.bull.scenario_id), d2 = await driver('an', X.s.scenario_id, KEY, 800)
    const b1 = await row(d1), b2 = await row(d2)
    expect(await saveBenchmarkOverride(W.C.an, { projectId: X.p.project_id, tenantId: W.U.t, key: KEY, value: 1234 })).toEqual({ ok: true })
    expect(await removeBenchmarkOverride(W.C.an, X.p.project_id, KEY)).toEqual({ ok: true })
    expect(await exists(ids.override)).toBe(false)
    expect([await row(d1), await row(d2)]).toEqual([b1, b2])
  })
})

describe('W7 saving an override is confirmed by the database', () => {
  test('W7.1 absent → one project-level row with exactly the fields the page wrote before', async () => {
    await setup('A')
    expect(await saveBenchmarkOverride(W.C.an, { projectId: X.p.project_id, tenantId: W.U.t, key: 'rental_yield_residential', value: 0.07 })).toEqual({ ok: true })
    expect((await projectLevel('rental_yield_residential')).map(({ assumption_id, ...r }) => r)).toEqual([{ value: 0.07, unit: null,
      confidence: 'indicative', category: 'benchmark_override', module_origin: 'feasibility', source_type: 'user_entry', tenant_id: W.U.t, scenario_id: null }])
  })
  test('W7.2 under the cutover lock (stage C) saving still works — the lock removes deletes, not inserts or updates on assumptions', async () => {
    const ids = await setup('C')
    expect(await saveBenchmarkOverride(W.C.an, { projectId: X.p.project_id, tenantId: W.U.t, key: KEY, value: 1600 })).toEqual({ ok: true })
    expect((await row(ids.override)).value).toBe(1600)
    expect(await saveBenchmarkOverride(W.C.an, { projectId: X.p.project_id, tenantId: W.U.t, key: 'rental_yield_residential', value: 0.06 })).toEqual({ ok: true })
  })
  test('W7.3 a failed lookup (anon) → failure; nothing written', async () => {
    const ids = await setup('A')
    const before = await row(ids.override)
    expect((await saveBenchmarkOverride(W.C.anon, { projectId: X.p.project_id, tenantId: W.U.t, key: KEY, value: 1 })).ok).toBe(false)
    expect(await row(ids.override)).toEqual(before)
    expect(await projectLevel(KEY)).toHaveLength(1)
  })
  test('W7.4 stage D: a viewer cannot save — update changes no row, insert refused; both reported; nothing written', async () => {
    const ids = await setup('D')
    const before = await row(ids.override)
    const u = await saveBenchmarkOverride(W.C.vw, { projectId: X.p.project_id, tenantId: W.U.t, key: KEY, value: 1 })
    expect(u.ok).toBe(false); expect(u.message).toMatch(/not updated/)
    const i = await saveBenchmarkOverride(W.C.vw, { projectId: X.p.project_id, tenantId: W.U.t, key: 'rental_yield_residential', value: 1 })
    expect(i.ok).toBe(false); expect(i.message).toMatch(/row-level security/)
    expect(await row(ids.override)).toEqual(before)
    expect(await projectLevel('rental_yield_residential')).toHaveLength(0)
  })
  test('W7.5 two project-level overrides with the same name (ambiguous) → save fails; neither changed', async () => {
    const ids = await setup('A')
    const second = await override('an')
    const b1 = await row(ids.override), b2 = await row(second)
    expect((await saveBenchmarkOverride(W.C.an, { projectId: X.p.project_id, tenantId: W.U.t, key: KEY, value: 1 })).ok).toBe(false)
    expect([await row(ids.override), await row(second)]).toEqual([b1, b2])
  })
})

describe('W5 the page uses the confirmed deletes', () => {
  const src = file('src/pages/FeasibilityProject.jsx').replace(/\r\n/g, '\n')      // working copy may be CRLF (core.autocrlf)
  const body = name => {
    const i = src.indexOf('async function ' + name + '('), end = src.indexOf('\n  }\n', i)
    expect(i).toBeGreaterThan(-1); expect(end).toBeGreaterThan(i)
    return src.slice(i, end)
  }
  test('W5.1 handleRemoveOverride updates local state only after a confirmed result', () => {
    const b = body('handleRemoveOverride')
    expect(b).toMatch(/removeBenchmarkOverride\(supabase, projectId, key\)/)
    expect(b.indexOf("if (!result.ok) { alert('Remove override failed: ' + result.message); return }")).toBeGreaterThan(-1)
    expect(b.indexOf('if (!result.ok)')).toBeLessThan(b.indexOf('setOverrides('))
    expect(b).not.toMatch(/from\('assumptions'\)\.delete\(\)/)
  })
  test('W5.3 handleSaveOverride saves through saveBenchmarkOverride and updates local state only on success', () => {
    const b = body('handleSaveOverride')
    expect(b).toMatch(/saveBenchmarkOverride\(supabase, \{ projectId, tenantId: project\.tenant_id, key, value: val \}\)/)
    expect(b.indexOf('if (result.ok) {')).toBeGreaterThan(-1)
    expect(b.indexOf('if (result.ok) {')).toBeLessThan(b.indexOf('setOverrides('))
    expect(b).not.toMatch(/from\('assumptions'\)/)
  })
  test('W5.4 every project-override lookup in the app is restricted to project-level rows', () => {
    const lookups = [src, file('src/modules/feasibility/assumptionWrites.js')].join('\n').replace(/\r\n/g, '\n')
      .split(/from\('assumptions'\)\.select/).slice(1).map(s => s.slice(0, 260))
      .filter(s => /eq\('category', 'benchmark_override'\)/.test(s))
    expect(lookups.length).toBeGreaterThanOrEqual(3)                                    // page load, scenario-driver load, module lookup
    for (const l of lookups) expect(l).toMatch(/\.is\('scenario_id', null\)|\.eq\('scenario_id', /)
  })
  test('W5.2 handleResetScenarioDriver reports a rejected DELETE', () => {
    const b = body('handleResetScenarioDriver')
    expect(b).toMatch(/deleteAssumption\(supabase, existing\.assumption_id\)/)
    expect(b).toMatch(/if \(!result\.ok\) alert\('Reset failed: ' \+ result\.message\)/)
    expect(b).not.toMatch(/from\('assumptions'\)\.delete\(\)/)
  })
})
