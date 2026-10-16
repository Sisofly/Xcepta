#!/usr/bin/env node
/**
 * probe-gate.mjs — HTTP probe of the temporary SEC-04 staging request gate
 * (db/security/staging_gate_on.sql) against the real hosted staging API.
 *
 *   node scripts/staging/probe-gate.mjs --expect=open    before install / after staging_gate_off.sql
 *   node scripts/staging/probe-gate.mjs --expect=gated   after staging_gate_on.sql
 *
 * Runs ONLY against the staging project (ldhsckzvfuwpxywqloag); refuses any
 * other project, production included. Reads VITE_SUPABASE_URL /
 * VITE_SUPABASE_ANON_KEY and STAGING_TEST_EMAIL / STAGING_TEST_PASSWORD from
 * the shell or .env.local; never prints keys, tokens or passwords.
 * Harmless requests only: reads (limit 1), delete_project and an assumptions
 * DELETE on random, non-existent ids (they match nothing either way).
 * Node's fetch can set the Origin header, so each request reproduces exactly
 * the header a browser on that origin sends. Exit 0 only if every result
 * matches the expected mode.
 */
import process from 'node:process'
import { randomUUID } from 'node:crypto'
import { loadStagingEnv, fail } from './env.mjs'

const STAGING_REF = 'ldhsckzvfuwpxywqloag'
const mode = (process.argv.find(a => a.startsWith('--expect=')) || '').split('=')[1]
if (!['open', 'gated'].includes(mode)) fail('Usage: node scripts/staging/probe-gate.mjs --expect=open|gated')
const { env, ref } = loadStagingEnv(['STAGING_TEST_EMAIL', 'STAGING_TEST_PASSWORD'])
if (ref !== STAGING_REF) fail('REFUSED: VITE_SUPABASE_URL is project ' + ref + ', not the staging project ' + STAGING_REF + '.')
const base = env.VITE_SUPABASE_URL.replace(/\/$/, ''), key = env.VITE_SUPABASE_ANON_KEY

const VERCEL = 'https://xcepta-git-rc-ppp-v1-sisofly.vercel.app'
const ORIGINS = {
  'old Preview (vercel.app)': VERCEL,
  'production domain (vercel.app)': 'https://xcepta.vercel.app',
  'local app localhost:5173': 'http://localhost:5173',
  'local app 127.0.0.1:5173': 'http://127.0.0.1:5173',
  'other local port 5174': 'http://localhost:5174',
  'no Origin (Node script)': null,
}
const allowedWhenGated = o => o === null || o === 'http://localhost:5173' || o === 'http://127.0.0.1:5173'

async function call(method, path, { origin = null, token = null, body } = {}) {
  const headers = { apikey: key, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
  if (token) headers.Authorization = 'Bearer ' + token
  if (origin) headers.Origin = origin
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let message = ''
  try { const j = JSON.parse(text); message = j.message || j.msg || j.error_description || '' } catch { message = '' }
  return { status: res.status, gated: /^STAGING_GATE/.test(message), message: message.slice(0, 70) }
}

async function main() {
  console.log('Request-gate probe on staging ' + ref + ' — expecting: ' + mode.toUpperCase() + '\n')
  const auth = await fetch(base + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.STAGING_TEST_EMAIL, password: env.STAGING_TEST_PASSWORD }),
  })
  if (!auth.ok) fail('Sign-in failed (HTTP ' + auth.status + ').')
  const token = (await auth.json()).access_token
  if (!token) fail('Sign-in returned no session.')

  const checks = []
  const add = (name, r, expectGated) => checks.push({ name, ...r, expectGated, pass: r.gated === expectGated })
  for (const [label, origin] of Object.entries(ORIGINS)) {
    add('read projects  · ' + label, await call('GET', '/rest/v1/projects?select=project_id&limit=1', { origin, token }),
      mode === 'gated' && !allowedWhenGated(origin))
  }
  for (const [label, origin] of [['old Preview (vercel.app)', VERCEL], ['no Origin (Node script)', null]]) {
    add('rpc delete_project(random id) · ' + label, await call('POST', '/rest/v1/rpc/delete_project', { origin, token, body: { p_project_id: randomUUID() } }),
      mode === 'gated' && origin !== null)
  }
  add('DELETE assumptions(random id) · old Preview (vercel.app)',
    await call('DELETE', '/rest/v1/assumptions?assumption_id=eq.' + randomUUID(), { origin: VERCEL, token }), mode === 'gated')
  add('read projects, signed out · old Preview (vercel.app)', await call('GET', '/rest/v1/projects?select=project_id&limit=1', { origin: VERCEL }), mode === 'gated')
  // Auth is a separate service and is NOT gated — informational: it cannot read or change application tables.
  const authInfo = await call('GET', '/auth/v1/user', { origin: VERCEL, token })

  for (const c of checks) {
    console.log((c.pass ? 'PASS ' : 'FAIL ') + c.name.padEnd(62) + ' HTTP ' + c.status + ' ' +
      (c.gated ? 'STAGING_GATE' : 'passed the gate' + (c.message ? ' (' + c.message + ')' : '')) +
      ' — expected ' + (c.expectGated ? 'STAGING_GATE' : 'passed the gate'))
  }
  console.log('INFO Auth API /auth/v1/user · old Preview origin'.padEnd(67) + ' HTTP ' + authInfo.status + ' (Auth is not gated by design; it has no access to application tables)')
  const failed = checks.filter(c => !c.pass).length
  if (mode === 'gated' && checks[0] && !checks[0].gated) console.log('\n✖ The gate is NOT active on the hosted API. Do not proceed with SEC-04; run staging_gate_off.sql.')
  console.log('\n' + (failed ? '✖ ' + failed + ' check(s) did not match ' + mode.toUpperCase() : '✔ all ' + checks.length + ' checks match ' + mode.toUpperCase()))
  process.exit(failed ? 1 : 0)
}
main().catch(e => fail(e.message))
