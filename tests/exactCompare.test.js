/**
 * exactCompare.test.js — the staging lifecycle comparator must ignore ONLY
 * object key order (jsonb reorders keys) and catch every other difference,
 * however small, including tampering with the stored jsonb in the database.
 */
import { exactDiff, describeDiff } from '../scripts/staging/exact-compare.mjs'
import { createTestDb, applyP022Migration, supabaseLike } from './helpers/pgliteSupabase.js'
import { runPPPEngine, PPP_ENGINE_VERSION } from '../src/modules/feasibility/annualEngine.js'
import { savePPPApproval, loadLatestModelOutput } from '../src/modules/feasibility/pppResultStore.js'
import { buildDebtScheduleRows } from '../src/modules/feasibility/debtSchedule.js'

const paths = d => d.differences.map(x => x.path)

describe('exactDiff — unit', () => {
  test('X1: key order is the ONLY thing ignored (counted, not a difference)', () => {
    const d = exactDiff({ a: 1, b: { c: 2, d: [1, 2] } }, { b: { d: [1, 2], c: 2 }, a: 1 })
    expect(d.equal).toBe(true)
    expect(d.reorderedObjects).toBe(2)
    expect(describeDiff(d)).toBe('0 value differences (2 objects key-reordered by jsonb)')
  })

  test('X2: the smallest numerical differences are detected — no tolerance', () => {
    const x = 47_507_319.59
    const next = x + x * Number.EPSILON                       // next representable double above x
    expect(next).not.toBe(x)
    expect(exactDiff({ v: x }, { v: next }).equal).toBe(false)
    expect(exactDiff({ v: 0.1 + 0.2 }, { v: 0.3 }).equal).toBe(false)
    expect(paths(exactDiff({ debt: 47_507_319.59 }, { debt: 47_507_319.6 }))).toEqual(['$.debt'])
    expect(exactDiff({ v: 0 }, { v: -0 }).equal).toBe(false)
    expect(exactDiff({ v: NaN }, { v: NaN }).equal).toBe(true)
  })

  test('X3: types, keys and arrays are strict', () => {
    expect(paths(exactDiff({ v: 1 }, { v: '1' }))).toEqual(['$.v'])
    expect(paths(exactDiff({ v: 0 }, { v: null }))).toEqual(['$.v'])
    expect(paths(exactDiff({ v: true }, { v: 1 }))).toEqual(['$.v'])
    expect(paths(exactDiff({ v: [] }, { v: {} }))).toEqual(['$.v'])
    expect(exactDiff({ a: 1, b: 2 }, { a: 1 }).differences[0]).toMatchObject({ path: '$.b', reason: 'missing key' })
    expect(exactDiff({ a: 1 }, { a: 1, b: 2 }).differences[0]).toMatchObject({ path: '$.b', reason: 'unexpected key' })
    expect(paths(exactDiff([1, 2], [2, 1]))).toEqual(['$[0]', '$[1]'])              // array order enforced
    expect(paths(exactDiff([1, 2], [1, 2, 3]))).toEqual(['$.length'])
    expect(paths(exactDiff({ s: [{ r: { p: 5 } }] }, { s: [{ r: { p: 6 } }] }))).toEqual(['$.s[0].r.p'])
  })
})

// Real Postgres jsonb round trip (PGlite) with the app's save/reload code.
const rows = o => Object.entries(o).map(([name, v]) => (typeof v === 'string'
  ? { name, value: null, unit: v, category: 'x' } : { name, value: v, unit: null, category: 'x' }))
const BASE = { 'Total Project Cost': 100e6, 'Debt %': 80, 'Equity %': 20, 'Annual Availability Payment': 12e6,
  'Concession Period': 25, 'Construction Period': 24, 'OPEX % of Revenue': 5, 'Interest Rate': 7, 'Loan Tenor': 10,
  'Grace Period': 2, 'Tax Rate': 20, 'WACC': 10, 'Target DSCR': 1.2 }
const CASES = {
  annual: BASE,
  quarterly: { ...BASE, 'Model Periodicity': 'Quarterly' },
  'variable CFADS': { ...BASE, 'Availability Payment Escalation %': 2.5, 'Repayment Profile': 'Annuity' },
}

async function savedAndReloaded(inputs) {
  const pg = await createTestDb(), db = supabaseLike(pg)
  await applyP022Migration(pg)
  const v = (await pg.query("insert into versions (label, status) values ('v1.0 Draft', 'draft') returning *")).rows[0]
  const out = runPPPEngine(rows(inputs))
  await savePPPApproval(db, { output: out, assumptions: rows(inputs), engineVersion: PPP_ENGINE_VERSION,
    versionId: v.version_id, projectId: null, tenantId: null, userId: null, approvedLabel: 'v1.0 Approved' })
  const reload = async () => { const financial = await loadLatestModelOutput(db, v.version_id); delete financial._persistence; return financial }
  return { pg, out: JSON.parse(JSON.stringify(out)), reload }
}

describe.each(Object.entries(CASES))('exactDiff — jsonb round trip (%s)', (_label, inputs) => {
  test('R1: jsonb reorders keys, so JSON text differs — yet every value is identical', async () => {
    const { out, reload } = await savedAndReloaded(inputs)
    const shown = await reload()
    expect(JSON.stringify(shown)).not.toBe(JSON.stringify(out))       // documents the jsonb behaviour
    const d = exactDiff(out, shown)
    expect(d.differences).toEqual([])
    expect(d.reorderedObjects).toBeGreaterThan(0)
    expect(exactDiff(out.debt_schedule, buildDebtScheduleRows({ ...shown, cash_flows: shown.cash_flows })).equal).toBe(true)
  })

  test('R2: tampering with the stored jsonb is caught — 0.01 on COD debt, 1e-6 deep in the debt schedule, a removed key, a type change', async () => {
    const { pg, out, reload } = await savedAndReloaded(inputs)
    await pg.exec(`update model_outputs set result_payload = jsonb_set(result_payload, '{debt_amount}',
      to_jsonb((result_payload->>'debt_amount')::numeric + 0.01))`)
    let d = exactDiff(out, await reload())
    expect(paths(d)).toEqual(['$.debt_amount'])
    // Postgres numeric added exactly 0.01; assert the exact tampered value (cent
    // arithmetic is exact for these 2-dp amounts) rather than a float subtraction.
    expect(d.differences[0].actual).toBe((Math.round(d.differences[0].expected * 100) + 1) / 100)

    await pg.exec(`update model_outputs set result_payload = jsonb_set(result_payload, '{debt_amount}', to_jsonb(${out.debt_amount}::numeric))`)
    expect(exactDiff(out, await reload()).equal).toBe(true)          // restored exactly

    await pg.exec(`update model_outputs set result_payload = jsonb_set(result_payload, '{debt_schedule,3,principal}',
      to_jsonb((result_payload#>>'{debt_schedule,3,principal}')::numeric + 0.000001))`)
    d = exactDiff(out, await reload())
    expect(paths(d)).toEqual(['$.debt_schedule[3].principal'])

    await pg.exec(`update model_outputs set result_payload = (result_payload - 'idc_capitalized') || jsonb_build_object('irr', (result_payload->>'irr'))`)
    d = exactDiff(out, await reload())
    expect(paths(d)).toEqual(expect.arrayContaining(['$.idc_capitalized', '$.irr', '$.debt_schedule[3].principal']))
    expect(d.differences.find(x => x.path === '$.idc_capitalized').reason).toBe('missing key')
    expect(d.differences.find(x => x.path === '$.irr').reason).toBe('type number ≠ string')
  })
})
