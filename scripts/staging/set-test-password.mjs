#!/usr/bin/env node
/**
 * set-test-password.mjs — change a synthetic STAGING test user's password with
 * the supported Supabase Auth Admin API (auth.admin.updateUserById).
 *
 *   npm run staging:set-test-password
 *
 * - Target URL comes from .env.local via loadStagingEnv(): the production
 *   project is refused (no override).
 * - The staging SECRET (service_role) key is typed hidden at runtime, held in
 *   memory only for this run, never written to disk, logs, argv or history,
 *   and never given a VITE_ name (so it can never reach the frontend bundle).
 * - Only synthetic *.test users can be changed. The user id is unchanged, so
 *   the public.users tenant link is preserved; this is verified afterwards by
 *   signing in with the PUBLIC key and the new password.
 */
import process from 'node:process'
import readline from 'node:readline'
import { createClient } from '@supabase/supabase-js'
import { loadStagingEnv, anonKeyRef, fail } from './env.mjs'

const { env, ref, PRODUCTION_SUPABASE_REF } = loadStagingEnv()
const url = env.VITE_SUPABASE_URL

function ask(question, hidden = false) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = s => { if (!rl.muted) rl.output.write(s) }
    rl.question(question, answer => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()) })
    rl.muted = hidden
  })
}

async function main() {
  if (!process.stdin.isTTY) fail('Run this in an interactive terminal (hidden prompts need a TTY).')
  console.log('Staging project: ' + ref + '  (production ' + PRODUCTION_SUPABASE_REF + ' is refused)\n')

  let secret = await ask('Staging SECRET key (service_role / sb_secret_…), hidden: ', true)
  if (!secret || secret.startsWith('sb_publishable_')) fail('That is not a secret key. Use the staging service_role / secret key.')
  const kref = anonKeyRef(secret)
  if (kref === PRODUCTION_SUPABASE_REF) fail('REFUSED: that key belongs to the PRODUCTION project.')
  if (kref && kref !== ref) fail('That key belongs to project ' + kref + ', not staging ' + ref + '.')
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })

  const email = (await ask('Staging test user email to update (must end in .test): ')).toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.test$/.test(email)) fail('Only synthetic .test staging users can be changed.')

  // Find the user (paginated admin listing); a wrong/foreign key fails here.
  let user = null
  for (let page = 1; page <= 20 && !user; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 })
    if (error) fail('Admin API rejected the key for project ' + ref + ': ' + error.message)
    user = data.users.find(u => (u.email || '').toLowerCase() === email) || null
    if (data.users.length < 100) break
  }
  if (!user) fail('No staging auth user with email ' + email + '. Nothing was changed.')
  const link = await admin.from('users').select('tenant_id, tenants(name)').eq('user_id', user.id).single()
  const tenantBefore = link.data ? link.data.tenant_id : null
  console.log('Found ' + email + '  id ' + user.id + (link.data ? '  tenant: ' + (link.data.tenants && link.data.tenants.name) : '  (no tenant link)'))

  const p1 = await ask('New password (hidden, min 12 characters): ', true)
  const p2 = await ask('Repeat new password (hidden): ', true)
  if (p1 !== p2) fail('Passwords do not match. Nothing was changed.')
  if (p1.length < 12) fail('Password must be at least 12 characters. Nothing was changed.')

  const { data: upd, error: updErr } = await admin.auth.admin.updateUserById(user.id, { password: p1 })
  if (updErr) fail('Update failed: ' + updErr.message + '. Nothing was changed.')
  if (upd.user.id !== user.id) fail('Unexpected: user id changed.')

  // Verify with the PUBLIC key, exactly as the app signs in.
  const pub = createClient(url, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: si, error: siErr } = await pub.auth.signInWithPassword({ email, password: p1 })
  const linkAfter = await admin.from('users').select('tenant_id').eq('user_id', user.id).single()
  secret = null
  const rows = [
    { check: 'Password updated via Auth Admin API', result: 'PASS' },
    { check: 'Sign-in with new password (public key)', result: siErr ? 'FAIL' : 'PASS', detail: siErr ? siErr.message : '' },
    { check: 'User id unchanged', result: !siErr && si.user.id === user.id ? 'PASS' : 'FAIL' },
    { check: 'Tenant link unchanged', result: (linkAfter.data && linkAfter.data.tenant_id) === tenantBefore ? 'PASS' : 'FAIL' },
  ]
  if (!siErr) await pub.auth.signOut()
  console.table(rows)
  const failed = rows.filter(r => r.result === 'FAIL').length
  console.log(failed ? '✖ verification failed' : '✔ Done. Now put the new password in .env.local and run: npm run staging:check-env')
  process.exit(failed ? 1 : 0)
}
main().catch(e => fail(e.message))
