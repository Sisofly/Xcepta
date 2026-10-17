/**
 * resultPersistence.js — versioned PPP result persistence (P-022)
 * ---------------------------------------------------------------------------
 * An approved PPP result is stored as ONE immutable model_outputs row that
 * carries everything needed to display and audit it without recalculating:
 *
 *   legacy columns     irr, npv, equity_multiple, dscr_series, cash_flows
 *                      (kept so FP&A, PDF and older readers keep working)
 *   engine_version     PPP engine version that produced the result
 *   result_schema_version  layout version of result_payload (this file)
 *   result_payload     the complete engine output: debt_schedule, IDC,
 *                      debt_sizing, integrity, warnings, periodic detail …
 *   inputs_snapshot    the assumption rows the result was calculated from
 *   periodicity        'annual' | 'quarterly'
 *
 * Rows are only ever INSERTED on approval; nothing here updates or deletes.
 * Rows written before P-022 have none of the new columns ("legacy") and are
 * displayed from their legacy columns with an explicit disclosure.
 * Requires migration db/migrations/2026-10-10_p022_versioned_model_outputs.sql.
 * ---------------------------------------------------------------------------
 */

export const RESULT_SCHEMA_VERSION = 1

// Assumption fields that define a calculation input (identity rows included,
// since Contract Model drives engine routing).
function snapshotRow(a) {
  return {
    name: a.name,
    value: a.value === undefined ? null : a.value,
    unit: a.unit === undefined ? null : a.unit,
    category: a.category === undefined ? null : a.category,
  }
}

export function snapshotInputs(assumptions) {
  return (assumptions || [])
    .filter(a => a && a.name && a.category !== 'benchmark_override')
    .map(snapshotRow)
    .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
}

// Builds the model_outputs insert row for a PPP result.
export function buildPPPOutputRecord(output, { assumptions, engineVersion, versionId, projectId, tenantId, userId }) {
  return {
    version_id: versionId, project_id: projectId, tenant_id: tenantId, created_by: userId,
    irr: output.irr, npv: output.npv, equity_multiple: output.equity_multiple,
    dscr_series: output.dscr_series, cash_flows: output.cash_flows,
    engine_version: engineVersion,
    result_schema_version: RESULT_SCHEMA_VERSION,
    periodicity: output.periodicity || 'annual',
    result_payload: JSON.parse(JSON.stringify(output)),
    inputs_snapshot: snapshotInputs(assumptions),
  }
}

// Infers which engine generation produced a legacy (pre-P-022) PPP row
// from the fields present on its stored cash_flows rows.
export function inferLegacyGeneration(row) {
  const cfs = (row && row.cash_flows) || []
  if (cfs.some(r => r && r.idc !== undefined)) return 'ppp-idc (deployed 7a59b14, pre-P-022)'
  if (cfs.some(r => r && r.debt_draw !== undefined)) return 'ppp-015a (equity-first, no IDC)'
  return 'ppp-pre-015a (no construction debt draws)'
}

// Turns a stored row into the object the Results tab renders. A versioned
// row renders its saved payload verbatim; a legacy row renders its legacy
// columns. `_persistence` describes provenance for the disclosure banners.
export function hydrateModelOutput(row) {
  if (!row) return null
  if (row.result_payload && typeof row.result_payload === 'object') {
    return {
      ...row.result_payload,
      _persistence: {
        legacy: false,
        engine_version: row.engine_version || row.result_payload.engine_version || null,
        result_schema_version: row.result_schema_version || null,
        computed_at: row.computed_at || null,
        inputs_snapshot: row.inputs_snapshot || null,
        output_id: row.output_id || row.id || null,
      },
    }
  }
  return {
    ...row,
    _persistence: {
      legacy: true,
      engine_version: null,
      inferred_generation: inferLegacyGeneration(row),
      computed_at: row.computed_at || null,
      inputs_snapshot: null,
      missing: ['inputs snapshot', 'engine version', 'debt sizing', 'debt schedule', 'IDC totals', 'model checks'],
    },
  }
}

// Compares a saved inputs snapshot with the current assumption rows.
export function diffInputs(snapshot, assumptions) {
  if (!snapshot) return null
  const now = new Map(snapshotInputs(assumptions).map(r => [r.name, r]))
  const then = new Map(snapshot.map(r => [r.name, r]))
  const changed = []
  then.forEach((r, name) => {
    const c = now.get(name)
    if (!c) changed.push({ name, from: r.value ?? r.unit, to: null })
    else if (String(c.value) !== String(r.value) || String(c.unit) !== String(r.unit)) {
      changed.push({ name, from: r.value ?? r.unit, to: c.value ?? c.unit })
    }
  })
  now.forEach((c, name) => { if (!then.has(name)) changed.push({ name, from: null, to: c.value ?? c.unit }) })
  return changed
}

// ── Demonstrated compatibility (P-028) ──
// A result from an engine version not listed as compatible is still current
// when re-running the CURRENT engine on its own saved inputs reproduces every
// value it stored, exactly (numbers bit-for-bit, same types, same array
// lengths). Only `warnings` and `engine_version` are ignored, and keys the old
// result never had (new reporting fields) are not compared. Nothing stored is
// changed. Eligible ONLY for tax-exempt results (saved inputs record Tax Rate
// = 0), per the P-028 approval rule; taxable results from another engine
// version are always outdated.
const COMPAT_IGNORED = ['warnings', 'engine_version']
export function storedValuesReproduced(stored, fresh) {
  const same = (a, b) => {
    if (a === null || typeof a !== 'object') return Object.is(a, b)
    if (b === null || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
    if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => same(x, b[i]))
    return Object.keys(a).every(k => Object.prototype.hasOwnProperty.call(b, k) && same(a[k], b[k]))
  }
  if (!stored || typeof stored !== 'object' || !fresh || typeof fresh !== 'object') return false
  return Object.keys(stored).filter(k => !COMPAT_IGNORED.includes(k))
    .every(k => Object.prototype.hasOwnProperty.call(fresh, k) && same(stored[k], fresh[k]))
}
const compatCache = new WeakMap()
function demonstrateCompatibility(modelOutput, rerun) {
  const snap = modelOutput._persistence.inputs_snapshot
  if (!rerun || !snap) return false
  const taxRow = snap.find(r => r && r.name === 'Tax Rate')
  if (!taxRow || taxRow.value === null || Number(taxRow.value) !== 0) return false
  if (compatCache.has(modelOutput)) return compatCache.get(modelOutput)
  let ok
  try {
    const stored = { ...modelOutput }
    delete stored._persistence
    ok = storedValuesReproduced(stored, JSON.parse(JSON.stringify(rerun(modelOutput._persistence.inputs_snapshot))))
  } catch {
    ok = false
  }
  compatCache.set(modelOutput, ok)
  return ok
}

// Classifies a hydrated PPP result against the running engine.
//   status 'current'      — produced by an engine whose outputs are identical
//                           (listed compatible, or demonstrated: `rerun` given)
//   status 'stale_engine' — produced by an engine with different outputs
//   status 'legacy'       — stored before P-022 (engine/inputs unknown)
// `rerun(inputRows)` (optional) runs the current engine; without it, only the
// listed compatible versions are current.
export function assessResultCurrency(modelOutput, { engineVersion, compatibleVersions, assumptions, rerun }) {
  if (!modelOutput || !modelOutput._persistence) return null
  const p = modelOutput._persistence
  if (p.legacy) {
    return { status: 'legacy', engine_version: null, inferred_generation: p.inferred_generation,
             current_engine: engineVersion, inputs_changed: null }
  }
  const listed = (compatibleVersions || [engineVersion]).includes(p.engine_version)
  const demonstrated = !listed && demonstrateCompatibility(modelOutput, rerun)
  return {
    status: listed || demonstrated ? 'current' : 'stale_engine',
    compatibility: listed ? 'listed' : demonstrated ? 'demonstrated' : 'none',
    engine_version: p.engine_version,
    current_engine: engineVersion,
    inputs_changed: diffInputs(p.inputs_snapshot, assumptions),
  }
}

// Recognises the database error raised when the P-022 columns are missing.
export function isMissingP022Columns(error) {
  if (!error) return false
  const text = [error.code, error.message, error.details, error.hint].filter(Boolean).join(' ')
  return /result_payload|inputs_snapshot|engine_version|result_schema_version|periodicity/.test(text) &&
         /(column|schema cache|PGRST204|42703)/i.test(text)
}
