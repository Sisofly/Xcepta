/**
 * assumptionWrites.test.js — confirmed assumption deletes (src/modules/feasibility/assumptionWrites.js),
 * used by FeasibilityProject.jsx handleRemoveOverride / handleResetScenarioDriver.
 * Runs the real request sequence against the post-SEC-03 staging schema (PGlite) with the exact
 * cutover-lock and SEC-04 files: success, already absent, permission refusal under the lock,
 * zero-row deletion, failed lookup, ambiguous lookup. A failure must never be reported as success.
 */
import { readFileSync } from 'node:fs'
import { createCutoverWorld } from './helpers/cutoverWorld.js'
import { removeBenchmarkOverride, deleteAssumption } from '../src/modules/feasibility/assumptionWrites.js'

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
  test('W5.2 handleResetScenarioDriver reports a rejected DELETE', () => {
    const b = body('handleResetScenarioDriver')
    expect(b).toMatch(/deleteAssumption\(supabase, existing\.assumption_id\)/)
    expect(b).toMatch(/if \(!result\.ok\) alert\('Reset failed: ' \+ result\.message\)/)
    expect(b).not.toMatch(/from\('assumptions'\)\.delete\(\)/)
  })
})
