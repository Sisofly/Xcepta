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
export const SEC03_MIGRATION_FILE = 'db/migrations/2026-10-16_sec03_lifecycle_functions.sql'

// Approve a version and save its complete, versioned PPP result — atomically,
// on the server (SEC-03 approve_version): role (manager / admin), tenant and
// draft status are checked by the database, and identity, tenant and project
// are taken from the database and auth.uid(), not from this record. The
// version is approved only if the result is saved, in one transaction.
//   P022_MIGRATION_MISSING    — the P-022 result columns are missing
//   SECURITY_MIGRATION_MISSING — the SEC-03 approval function is missing
// Returns the stored model_outputs row.
export async function savePPPApproval(db, {
  output, assumptions, engineVersion, versionId, projectId, tenantId, userId, approvedLabel,
}) {
  const record = buildPPPOutputRecord(output, {
    assumptions, engineVersion, versionId, projectId, tenantId, userId,
  })
  const { data: outputId, error } = await db.rpc('approve_version', {
    p_version_id: versionId, p_record: record, p_label: approvedLabel || null,
  })
  if (error) {
    if (isMissingP022Columns(error)) {
      const e = new Error('The database has not been upgraded for versioned results (P-022 migration). ' +
        'Approval cancelled — nothing was saved. Please ask an administrator to apply ' + P022_MIGRATION_FILE + '.')
      e.code = 'P022_MIGRATION_MISSING'
      throw e
    }
    if (isMissingApprovalFunction(error)) {
      const e = new Error('The database has not been upgraded for secured approvals (SEC-03 migration). ' +
        'Approval cancelled — nothing was saved. Please ask an administrator to apply ' + SEC03_MIGRATION_FILE + '.')
      e.code = 'SECURITY_MIGRATION_MISSING'
      throw e
    }
    throw error
  }
  const { data: rows, error: readError } = await db.from('model_outputs').select('*').eq('output_id', outputId)
  if (readError) throw readError
  return rows && rows[0] ? rows[0] : { output_id: outputId }
}

// PostgREST (PGRST202) or Postgres (42883) error for a missing function.
export function isMissingApprovalFunction(error) {
  if (!error) return false
  const text = [error.code, error.message, error.details, error.hint].filter(Boolean).join(' ')
  return /approve_version/.test(text) && /(PGRST202|42883|does not exist|Could not find the function)/i.test(text)
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
