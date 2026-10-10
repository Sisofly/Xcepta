/**
 * resultPersistence.test.js — P-022 versioned result persistence
 * Engine → persisted record → database JSON round trip → reload → display.
 */
import {
  runPPPEngine, PPP_ENGINE_VERSION, PPP_ENGINE_COMPATIBLE_VERSIONS,
} from '../src/modules/feasibility/annualEngine.js'
import {
  buildPPPOutputRecord, hydrateModelOutput, assessResultCurrency, diffInputs,
  snapshotInputs, inferLegacyGeneration, isMissingP022Columns, RESULT_SCHEMA_VERSION,
} from '../src/modules/feasibility/resultPersistence.js'
import { buildDebtScheduleRows } from '../src/modules/feasibility/debtSchedule.js'

const rows = obj => Object.entries(obj).map(([name, value]) => ({
  name, value, unit: null, category: 'ppp_structure', assumption_id: name,
}))
const BASE = {
  'Total Project Cost': 100_000_000, 'Debt %': 80, 'Equity %': 20,
  'Annual Availability Payment': 12_000_000, 'Concession Period': 25,
  'Construction Period': 24, 'OPEX % of Revenue': 5, 'Interest Rate': 7,
  'Loan Tenor': 10, 'Grace Period': 2, 'Tax Rate': 20, 'WACC': 10,
}
const META = { engineVersion: PPP_ENGINE_VERSION, versionId: 'v1', projectId: 'p1', tenantId: 't1', userId: 'u1' }
// Simulates a Supabase insert + select: jsonb columns go through JSON.
const dbRoundTrip = rec => ({ ...JSON.parse(JSON.stringify(rec)), output_id: 'o1', computed_at: '2026-10-10T12:00:00Z' })

describe('P-022 — persisted record', () => {
  const assumptions = rows(BASE)
  const out = runPPPEngine(assumptions)
  const rec = buildPPPOutputRecord(out, { ...META, assumptions })

  test('P1: legacy columns equal engine output (FP&A / PDF / older readers unaffected)', () => {
    ;['irr', 'npv', 'equity_multiple', 'dscr_series', 'cash_flows'].forEach(k => expect(rec[k]).toEqual(out[k]))
  })

  test('P2: record carries engine version, schema version, periodicity, full payload and inputs', () => {
    expect(rec.engine_version).toBe(PPP_ENGINE_VERSION)
    expect(rec.result_schema_version).toBe(RESULT_SCHEMA_VERSION)
    expect(rec.periodicity).toBe('annual')
    ;['debt_schedule', 'debt_sizing', 'idc_capitalized', 'total_funding_requirement', 'integrity', 'warnings', 'engine_version']
      .forEach(k => expect(rec.result_payload[k]).toEqual(out[k]))
    expect(rec.inputs_snapshot.map(r => r.name)).toEqual(Object.keys(BASE).sort())
  })

  test('P3: the payload is a frozen copy — later mutation of the engine object does not alter it', () => {
    const before = rec.result_payload.debt_schedule[0].closing
    out.debt_schedule[0].closing = -999
    expect(rec.result_payload.debt_schedule[0].closing).toBe(before)
  })

  test('P4: reload renders the SAVED result verbatim — all financial fields identical after the DB round trip', () => {
    const fresh = runPPPEngine(assumptions)
    const shown = hydrateModelOutput(dbRoundTrip(buildPPPOutputRecord(fresh, { ...META, assumptions })))
    const { _persistence, ...financial } = shown
    expect(financial).toEqual(JSON.parse(JSON.stringify(fresh)))
    expect(_persistence.legacy).toBe(false)
    expect(_persistence.engine_version).toBe(PPP_ENGINE_VERSION)
    // the displayed debt schedule is the saved engine schedule, not a re-derivation
    expect(buildDebtScheduleRows(shown)).toEqual(shown.debt_schedule)
  })

  test('P5: display does not depend on current inputs — changing assumptions after approval leaves figures unchanged', () => {
    const saved = hydrateModelOutput(dbRoundTrip(buildPPPOutputRecord(runPPPEngine(assumptions), { ...META, assumptions })))
    const edited = rows({ ...BASE, 'Annual Availability Payment': 15_000_000 })
    const cur = assessResultCurrency(saved, { engineVersion: PPP_ENGINE_VERSION, compatibleVersions: PPP_ENGINE_COMPATIBLE_VERSIONS, assumptions: edited })
    expect(cur.status).toBe('current')
    expect(cur.inputs_changed).toEqual([{ name: 'Annual Availability Payment', from: 12_000_000, to: 15_000_000 }])
    expect(saved.irr).toBe(runPPPEngine(assumptions).irr)          // still the approved figure
  })
})

describe('P-022 — currency and legacy disclosure', () => {
  const assumptions = rows(BASE)
  const out = runPPPEngine(assumptions)
  const opts = { engineVersion: PPP_ENGINE_VERSION, compatibleVersions: PPP_ENGINE_COMPATIBLE_VERSIONS, assumptions }

  test('C1: a result from an incompatible engine version is flagged stale, not recalculated', () => {
    const rec = dbRoundTrip(buildPPPOutputRecord(out, { ...META, assumptions, engineVersion: '1.9.0' }))
    const shown = hydrateModelOutput(rec)
    expect(assessResultCurrency(shown, opts).status).toBe('stale_engine')
    expect(shown.irr).toBe(out.irr)
  })

  test('C2: legacy rows (pre-P-022) stay displayable, are flagged legacy, and their generation is inferred', () => {
    const strip = (o, drop) => ({ irr: o.irr, npv: o.npv, equity_multiple: o.equity_multiple, dscr_series: o.dscr_series,
      cash_flows: o.cash_flows.map(r => { const c = { ...r }; drop.forEach(k => delete c[k]); return c }), computed_at: '2026-06-08' })
    const idcRow  = strip(out, [])
    const r015a   = strip(runPPPEngine(rows({ ...BASE, 'Construction Interest Rate': 0 })), ['idc'])
    const pre015a = strip(out, ['idc', 'debt_draw', 'equity_draw'])
    expect(inferLegacyGeneration(idcRow)).toMatch(/ppp-idc/)
    expect(inferLegacyGeneration(r015a)).toMatch(/ppp-015a/)
    expect(inferLegacyGeneration(pre015a)).toMatch(/pre-015a/)
    ;[idcRow, r015a, pre015a].forEach(row => {
      const shown = hydrateModelOutput(row)
      expect(shown._persistence.legacy).toBe(true)
      expect(shown._persistence.missing.length).toBeGreaterThan(0)
      expect(assessResultCurrency(shown, opts).status).toBe('legacy')
      expect(shown.irr).toBe(row.irr)
      expect(buildDebtScheduleRows(shown)).not.toBeNull()
    })
  })

  test('C3: input diff detects changed, added and removed rows; ignores benchmark overrides', () => {
    const snap = snapshotInputs([...rows({ A: 1, B: 2 }), { name: 'X', value: 9, category: 'benchmark_override' }])
    expect(snap.map(r => r.name)).toEqual(['A', 'B'])
    const now = rows({ A: 1, B: 3, C: 4 })
    expect(diffInputs(snap, now)).toEqual([{ name: 'B', from: 2, to: 3 }, { name: 'C', from: null, to: 4 }])
    expect(diffInputs(snap, rows({ A: 1 }))).toEqual([{ name: 'B', from: 2, to: null }])
    expect(diffInputs(snap, rows({ A: 1, B: 2 }))).toEqual([])
  })

  test('C4: missing-migration errors are recognised so approval is cancelled with a clear message', () => {
    expect(isMissingP022Columns({ code: 'PGRST204', message: "Could not find the 'result_payload' column of 'model_outputs' in the schema cache" })).toBe(true)
    expect(isMissingP022Columns({ code: '42703', message: 'column "engine_version" of relation "model_outputs" does not exist' })).toBe(true)
    expect(isMissingP022Columns({ code: '23505', message: 'duplicate key value' })).toBe(false)
    expect(isMissingP022Columns(null)).toBe(false)
  })
})
