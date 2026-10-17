// Assumption writes confirmed by the database (benchmark overrides, scenario
// drivers). A refused write (missing privilege, row-level security, the SEC-04
// cutover lock) or one that changes no row is reported as a failure — the
// caller must not update its local state in that case.
// Results: { ok: true } | { ok: true, alreadyAbsent: true } | { ok: false, message }.
//
// Project-level benchmark overrides and scenario drivers share the category
// 'benchmark_override'; project-level rows are the ones with scenario_id NULL.
// Every project-override lookup is restricted to them, so a project override
// can never update or delete a scenario driver with the same name.

// Delete exactly one assumption row; the deleted row is returned to prove it.
export async function deleteAssumption(db, assumptionId) {
  const { data, error } = await db.from('assumptions').delete()
    .eq('assumption_id', assumptionId).select('assumption_id')
  if (error) return { ok: false, message: error.message }
  if (!Array.isArray(data) || data.length !== 1) {
    return { ok: false, message: 'the assumption was not deleted (no row could be removed)' }
  }
  return { ok: true }
}

// The project-level override row for a benchmark key: { ok, row } (row null if none).
async function findProjectOverride(db, projectId, key) {
  const { data, error } = await db.from('assumptions').select('assumption_id')
    .eq('project_id', projectId).is('scenario_id', null)
    .eq('category', 'benchmark_override').eq('name', key).maybeSingle()
  if (error) return { ok: false, message: error.message }
  return { ok: true, row: data || null }
}

// Create or update a project's benchmark override. A failed lookup, a refused
// write or an update that changes no row is a failure.
export async function saveBenchmarkOverride(db, { projectId, tenantId, key, value }) {
  const found = await findProjectOverride(db, projectId, key)
  if (!found.ok) return { ok: false, message: found.message }
  if (found.row) {
    const { data, error } = await db.from('assumptions').update({ value })
      .eq('assumption_id', found.row.assumption_id).select('assumption_id')
    if (error) return { ok: false, message: error.message }
    if (!Array.isArray(data) || data.length !== 1) {
      return { ok: false, message: 'the override was not updated (no row could be changed)' }
    }
    return { ok: true }
  }
  const { error } = await db.from('assumptions').insert({
    project_id: projectId, name: key, category: 'benchmark_override',
    value, unit: null, confidence: 'indicative',
    tenant_id: tenantId,
    module_origin: 'feasibility',
    source_type: 'user_entry',
  })
  if (error) return { ok: false, message: error.message }
  return { ok: true }
}

// Remove a project's benchmark override. An override that is already absent
// counts as removed; a failed lookup does not.
export async function removeBenchmarkOverride(db, projectId, key) {
  const found = await findProjectOverride(db, projectId, key)
  if (!found.ok) return { ok: false, message: found.message }
  if (!found.row) return { ok: true, alreadyAbsent: true }
  return deleteAssumption(db, found.row.assumption_id)
}
