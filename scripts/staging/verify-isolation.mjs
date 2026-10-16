#!/usr/bin/env node
/**
 * verify-isolation.mjs — authentication, permissions and Row Level Security
 * checks on the STAGING database (npm run verify:staging:isolation).
 *
 *  1. target is staging (never production) and the anon key belongs to it
 *  2. anonymous (signed-out) clients cannot read or write application tables
 *  3. the staging test user sees only its own tenant's rows
 *  4. optional second staging user on a different tenant (STAGING_TEST_EMAIL_2
 *     / STAGING_TEST_PASSWORD_2): cannot read or modify the first user's data
 *
 * Read-only except one synthetic probe project created and deleted by user A
 * for the cross-tenant check.
 */
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { loadStagingEnv, anonKeyRef, fail } from './env.mjs'

const { env, ref, PRODUCTION_SUPABASE_REF } = loadStagingEnv(['STAGING_TEST_EMAIL', 'STAGING_TEST_PASSWORD'])
const url = env.VITE_SUPABASE_URL, key = env.VITE_SUPABASE_ANON_KEY
const results = []
const check = (name, status, detail = '') => results.push({ check: name, result: status, detail })
const client = () => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
const TABLES = ['projects', 'scenarios', 'versions', 'assumptions', 'model_outputs', 'users', 'variances', 'actuals', 'intake_state']

async function main() {
  console.log('Isolation checks on staging project ' + ref + ' (production is ' + PRODUCTION_SUPABASE_REF + ')\n')
  // 1. key ↔ project
  const kref = anonKeyRef(key)
  if (kref === PRODUCTION_SUPABASE_REF) fail('REFUSED: the anon key belongs to the PRODUCTION project.')
  check('Anon key belongs to the staging project', kref === null ? 'INFO' : kref === ref ? 'PASS' : 'FAIL',
    kref === null ? 'non-JWT key format; project match not checkable' : 'key ref ' + kref)

  // 2. anonymous access
  const anon = client()
  for (const t of TABLES) {
    const { data, error } = await anon.from(t).select('*').limit(1)
    check('Anonymous cannot read ' + t, error || (data || []).length === 0 ? 'PASS' : 'FAIL', error ? 'blocked: ' + error.code : (data || []).length + ' row(s) visible')
  }
  const sd = await anon.from('static_defaults').select('*').limit(1)
  check('Anonymous read of static_defaults (reference benchmarks)', 'INFO', sd.error ? 'blocked' : (sd.data || []).length + ' row(s) visible')
  const ins = await anon.from('projects').insert({ name: 'SYNTHETIC — anonymous write probe' }).select()
  check('Anonymous cannot write projects', ins.error ? 'PASS' : 'FAIL', ins.error ? 'blocked: ' + ins.error.code : 'INSERT SUCCEEDED')
  if (!ins.error && ins.data && ins.data[0]) await anon.from('projects').delete().eq('project_id', ins.data[0].project_id)

  // 3. user A sees only its own tenant
  const a = client()
  const sa = await a.auth.signInWithPassword({ email: env.STAGING_TEST_EMAIL, password: env.STAGING_TEST_PASSWORD })
  if (sa.error) fail('Staging test user sign-in failed: ' + sa.error.message)
  const ua = await a.from('users').select('tenant_id').eq('user_id', sa.data.user.id).single()
  if (ua.error) fail('No users row for the staging test user — run db/staging/seed_staging_user.sql.')
  const tenantA = ua.data.tenant_id
  const projA = await a.from('projects').select('project_id, tenant_id')
  const foreign = (projA.data || []).filter(p => p.tenant_id !== tenantA)
  check('User A sees only its own tenant\'s projects', projA.error ? 'FAIL' : foreign.length === 0 ? 'PASS' : 'FAIL',
    projA.error ? projA.error.message : (projA.data || []).length + ' visible, ' + foreign.length + ' from other tenants')
  const usersA = await a.from('users').select('user_id, tenant_id')
  const otherUsers = (usersA.data || []).filter(u => u.tenant_id !== tenantA)
  check('User A cannot list other tenants\' users', otherUsers.length === 0 ? 'PASS' : 'FAIL', otherUsers.length + ' foreign user row(s)')

  // 4. optional cross-tenant check with user B
  if (!env.STAGING_TEST_EMAIL_2 || !env.STAGING_TEST_PASSWORD_2) {
    check('Cross-tenant isolation (second user)', 'SKIPPED', 'set STAGING_TEST_EMAIL_2 / STAGING_TEST_PASSWORD_2 (user on a different tenant)')
  } else {
    const probe = await a.from('projects').insert({ tenant_id: tenantA, name: 'SYNTHETIC — isolation probe', project_type: 'Infrastructure / PPP',
      revenue_model: 'Availability Payment', created_by: sa.data.user.id }).select().single()
    if (probe.error) {
      check('Create isolation probe as user A', 'FAIL', probe.error.message)
    } else {
      const b = client()
      const sb = await b.auth.signInWithPassword({ email: env.STAGING_TEST_EMAIL_2, password: env.STAGING_TEST_PASSWORD_2 })
      if (sb.error) check('Second user sign-in', 'FAIL', sb.error.message)
      else {
        const ub = await b.from('users').select('tenant_id').eq('user_id', sb.data.user.id).single()
        check('Second user is on a different tenant', ub.data && ub.data.tenant_id !== tenantA ? 'PASS' : 'FAIL')
        const readB = await b.from('projects').select('project_id').eq('project_id', probe.data.project_id)
        check('User B cannot read user A\'s project', (readB.data || []).length === 0 ? 'PASS' : 'FAIL')
        await b.from('projects').update({ name: 'SYNTHETIC — tampered' }).eq('project_id', probe.data.project_id)
        const after = await a.from('projects').select('name').eq('project_id', probe.data.project_id).single()
        check('User B cannot modify user A\'s project', after.data && after.data.name === 'SYNTHETIC — isolation probe' ? 'PASS' : 'FAIL')
        await b.from('projects').delete().eq('project_id', probe.data.project_id)
        const still = await a.from('projects').select('project_id').eq('project_id', probe.data.project_id)
        check('User B cannot delete user A\'s project', (still.data || []).length === 1 ? 'PASS' : 'FAIL')
      }
      // SEC-03/04: members delete only draft-only projects, through the server function
      const del = await a.rpc('delete_project', { p_project_id: probe.data.project_id })
      if (del.error && /Could not find the function|PGRST202/.test(del.error.message)) await a.from('projects').delete().eq('project_id', probe.data.project_id)   // before SEC-03
    }
  }

  console.table(results)
  const failed = results.filter(r => r.result === 'FAIL').length
  console.log(failed ? '\n✖ ' + failed + ' isolation check(s) failed' : '\n✔ No isolation failures')
  process.exit(failed ? 1 : 0)
}
main().catch(e => fail(e.message))
