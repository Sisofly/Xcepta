/**
 * pppResultStore.js — database operations for versioned PPP results (P-022)
 * ---------------------------------------------------------------------------
 * Takes a Supabase-style client (`db.from(table)…` returning {data, error}),
 * so the page uses the live Supabase client and the integration tests use
 * an embedded Postgres (PGlite) through the same calls.
 * ---------------------------------------------------------------------------
 */
import { buildPPPOutputRecord, hydrateModelOutput, isMissingP022Columns } from './resultPersistence.js'

export const P022_MIGRATION_FILE = 'db/migrations/2026-10-10_p022_versioned_model_outputs.sql'

// Write one immutable, versioned PPP result, then approve the version.
//   1. insert the complete record (engine output, engine version, inputs)
//   2. flip the version to approved
// If step 2 fails, the just-inserted row is removed so no orphan result is
// left on a draft version. If the P-022 columns are missing (migration not
// applied) nothing is written and the version stays a draft.
export async function savePPPApproval(db, {
  output, assumptions, engineVersion, versionId, projectId, tenantId, userId, approvedLabel, approvedAt,
}) {
  const record = buildPPPOutputRecord(output, {
    assumptions, engineVersion, versionId, projectId, tenantId, userId,
  })
  const { data: inserted, error: insertError } = await db.from('model_outputs').insert(record).select()
  if (insertError) {
    if (isMissingP022Columns(insertError)) {
      const e = new Error('The database has not been upgraded for versioned results (P-022 migration). ' +
        'Approval cancelled — nothing was saved. Please ask an administrator to apply ' + P022_MIGRATION_FILE + '.')
      e.code = 'P022_MIGRATION_MISSING'
      throw e
    }
    throw insertError
  }
  const { error: approveError } = await db.from('versions').update({
    status: 'approved', approved_at: approvedAt || new Date().toISOString(), label: approvedLabel,
  }).eq('version_id', versionId)
  if (approveError) {
    const row = Array.isArray(inserted) ? inserted[0] : inserted
    const pk = row && ['output_id', 'model_output_id', 'id'].find(k => row[k] != null)
    if (pk) await db.from('model_outputs').delete().eq(pk, row[pk])
    throw approveError
  }
  return Array.isArray(inserted) ? inserted[0] : inserted
}

// Latest stored result for a version, hydrated for display (any engine).
// A failed read returns null (the page's long-standing behaviour: no result
// shown) and is reported to the console; it never throws during page load.
export async function loadLatestModelOutput(db, versionId) {
  const { data, error } = await db.from('model_outputs').select('*')
    .eq('version_id', versionId).order('computed_at', { ascending: false }).limit(1)
  if (error) { console.warn('model_outputs load failed:', error.message || error); return null }
  return data && data.length ? hydrateModelOutput(data[0]) : null
}
