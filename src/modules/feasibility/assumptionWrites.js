// Direct assumption deletes (benchmark overrides, scenario drivers), confirmed
// by the database. A refused DELETE (missing privilege, row-level security,
// the SEC-04 cutover lock) or one that removes no row is reported as a
// failure — the caller must not update its local state in that case.
// Results: { ok: true } | { ok: true, alreadyAbsent: true } | { ok: false, message }.

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

// Remove a project's benchmark override. An override that is already absent
// counts as removed; a failed lookup does not.
export async function removeBenchmarkOverride(db, projectId, key) {
  const { data: existing, error } = await db.from('assumptions').select('assumption_id')
    .eq('project_id', projectId).eq('category', 'benchmark_override').eq('name', key).maybeSingle()
  if (error) return { ok: false, message: error.message }
  if (!existing) return { ok: true, alreadyAbsent: true }
  return deleteAssumption(db, existing.assumption_id)
}
