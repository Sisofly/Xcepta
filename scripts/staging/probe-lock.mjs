#!/usr/bin/env node
/**
 * probe-lock.mjs — HTTP probe of the SEC-04 cutover lock (db/security/cutover_lock_on.sql)
 * against the real hosted staging Data API, as the staging test user.
 *
 *   node scripts/staging/probe-lock.mjs --expect=locked     after cutover_lock_on.sql
 *   node scripts/staging/probe-lock.mjs --expect=unlocked   before the lock / after cutover_lock_off.sql
 *
 * Staging project only (ldhsckzvfuwpxywqloag); refuses any other project.
 * Never prints keys, tokens or passwords. Sends no Origin header (it does not
 * depend on request headers reaching the database).
 * NEVER WRITES: deletes target random, non-existent ids (0 rows either way);
 * inserts deliberately omit the NOT NULL column coa_node, so they fail —
 * locked:   42501 "permission denied for table …" (privilege check, first)
 * unlocked: 23502 not-null violation (no row can be created).
 * Exit 0 only if every result matches the expected state.
 */
import process from 'node:process'
import { randomUUID } from 'node:crypto'
import { loadStagingEnv, fail } from './env.mjs'

const STAGING_REF = 'ldhsckzvfuwpxywqloag'
const mode = (process.argv.find(a => a.startsWith('--expect=')) || '').split('=')[1]
if (!['locked', 'unlocked'].includes(mode)) fail('Usage: node scripts/staging/probe-lock.mjs --expect=locked|unlocked')
const { env, ref } = loadStagingEnv(['STAGING_TEST_EMAIL', 'STAGING_TEST_PASSWORD'])
if (ref !== STAGING_REF) fail('REFUSED: VITE_SUPABASE_URL is project ' + ref + ', not the staging project ' + STAGING_REF + '.')
const base = env.VITE_SUPABASE_URL.replace(/\/$/, ''), key = env.VITE_SUPABASE_ANON_KEY

function classify(status, body) {
  const code = body && body.code, msg = (body && body.message) || ''
  if (code === '42501' && /^permission denied for table (assumptions|actuals|variances)$/.test(msg)) return 'privilege refused'
  if (code === '23502') return 'not-null violation'
  if (status === 204 || status === 200) return 'allowed (0 rows)'
  return 'other: HTTP ' + status + ' ' + (code || '') + ' ' + msg.slice(0, 60)
}

async function call(method, path, token, body) {
  const res = await fetch(base + path, {
    method, headers: { apikey: key, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let j = null; try { j = JSON.parse(text) } catch { j = null }
  return { status: res.status, body: j }
}

async function main() {
  console.log('Cutover-lock probe on staging ' + ref + ' — expecting: ' + mode.toUpperCase() + '\n')
  const auth = await fetch(base + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.STAGING_TEST_EMAIL, password: env.STAGING_TEST_PASSWORD }),
  })
  if (!auth.ok) fail('Sign-in failed (HTTP ' + auth.status + ').')
  const session = await auth.json(), token = session.access_token, uid = session.user && session.user.id
  if (!token || !uid) fail('Sign-in returned no session.')
  const me = await call('GET', '/rest/v1/users?select=tenant_id&user_id=eq.' + uid, token)
  const tenant = Array.isArray(me.body) && me.body[0] && me.body[0].tenant_id
  if (!tenant) fail('Could not read the test user\'s own membership (HTTP ' + me.status + ').')

  const L = mode === 'locked'
  const checks = [
    ['read projects (control: reads are never locked)', await call('GET', '/rest/v1/projects?select=project_id&limit=1', token), 'read'],
    ['DELETE assumptions (random id)', await call('DELETE', '/rest/v1/assumptions?assumption_id=eq.' + randomUUID(), token), L ? 'privilege refused' : 'allowed (0 rows)'],
    ['DELETE actuals (random id)', await call('DELETE', '/rest/v1/actuals?actual_id=eq.' + randomUUID(), token), L ? 'privilege refused' : 'allowed (0 rows)'],
    ['DELETE variances (random id)', await call('DELETE', '/rest/v1/variances?variance_id=eq.' + randomUUID(), token), L ? 'privilege refused' : 'allowed (0 rows)'],
    ['INSERT actuals (coa_node omitted — cannot be created)', await call('POST', '/rest/v1/actuals',
      token, { tenant_id: tenant, period: '2099-01', amount: 0, created_by: uid }), L ? 'privilege refused' : 'not-null violation'],
    ['INSERT variances (coa_node omitted — cannot be created)', await call('POST', '/rest/v1/variances',
      token, { tenant_id: tenant, period: '2099-01', budget_amount: 0, actual_amount: 0, created_by: uid }), L ? 'privilege refused' : 'not-null violation'],
  ]
  let failed = 0
  for (const [name, r, want] of checks) {
    const got = want === 'read' ? (r.status === 200 ? 'read' : 'other: HTTP ' + r.status) : classify(r.status, r.body)
    const pass = got === want
    if (!pass) failed++
    console.log((pass ? 'PASS ' : 'FAIL ') + name.padEnd(58) + ' HTTP ' + r.status + ' ' + got + (pass ? '' : ' — expected ' + want))
  }
  console.log('\n' + (failed ? '✖ ' + failed + ' check(s) did not match ' + mode.toUpperCase() : '✔ all ' + checks.length + ' checks match ' + mode.toUpperCase()))
  process.exit(failed ? 1 : 0)
}
main().catch(e => fail(e.message))
