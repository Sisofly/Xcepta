#!/usr/bin/env node
/**
 * check-env.mjs — validate .env.local for STAGING without printing any value.
 *   npm run staging:check-env
 * Reports only yes/no, project references and key formats.
 */
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import process from 'node:process'
import { PRODUCTION_SUPABASE_REF, projectRefFromUrl } from '../../src/config/supabaseGuard.js'
import { anonKeyRef } from './env.mjs'

const parse = f => Object.fromEntries((existsSync(f) ? readFileSync(f, 'utf8') : '').split(/\r?\n/)
  .map(l => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map(m => [m[1], m[2].replace(/^['"]|['"]$/g, '')]))
const env = parse('.env.local'), prodBackup = parse('.env.prod-backup')
const h = v => (v ? createHash('sha256').update(v).digest('hex') : null)
const rows = []
const check = (name, ok, detail = '') => rows.push({ check: name, result: ok === null ? 'INFO' : ok ? 'PASS' : 'FAIL', detail })

const ref = projectRefFromUrl(env.VITE_SUPABASE_URL)
check('VITE_SUPABASE_URL is the staging project', ref !== null && ref !== PRODUCTION_SUPABASE_REF, 'project ' + ref)
const key = env.VITE_SUPABASE_ANON_KEY || ''
const fmt = key.startsWith('sb_publishable_') ? 'publishable key' : key.split('.').length === 3 ? 'legacy anon JWT' : key ? 'unknown format' : 'EMPTY'
check('Anon/publishable key is set', key.length > 20, fmt)
if (key.startsWith('sb_secret_') || /service_role/.test(Buffer.from((key.split('.')[1] || ''), 'base64url').toString('utf8'))) {
  check('Key is a PUBLIC key (not secret/service_role)', false, 'a secret or service-role key must never be in .env.local')
} else check('Key is a PUBLIC key (not secret/service_role)', key.length > 20)
const kref = anonKeyRef(key)
if (kref) check('Key belongs to the staging project', kref === ref && kref !== PRODUCTION_SUPABASE_REF, 'key project ' + kref)
check('Key is NOT the production key', !prodBackup.VITE_SUPABASE_ANON_KEY || h(key) !== h(prodBackup.VITE_SUPABASE_ANON_KEY),
  prodBackup.VITE_SUPABASE_ANON_KEY ? 'compared with .env.prod-backup (hashes only)' : 'no backup to compare')
check('No production reference anywhere in .env.local', !readFileSync('.env.local', 'utf8').includes(PRODUCTION_SUPABASE_REF))
for (const [e, p] of [['STAGING_TEST_EMAIL', 'STAGING_TEST_PASSWORD'], ['STAGING_TEST_EMAIL_2', 'STAGING_TEST_PASSWORD_2']]) {
  check(e + ' is a synthetic .test address', /@[^@]+\.test$/i.test(env[e] || ''), env[e] || 'EMPTY')
  check(p + ' is set', (env[p] || '').length >= 8, (env[p] || '').length ? 'length ' + env[p].length : 'EMPTY')
}
check('Test-user passwords differ', !!env.STAGING_TEST_PASSWORD && env.STAGING_TEST_PASSWORD !== env.STAGING_TEST_PASSWORD_2)
console.table(rows)
const failed = rows.filter(r => r.result === 'FAIL').length
console.log(failed ? '✖ ' + failed + ' problem(s) — fix .env.local and re-run' : '✔ .env.local is configured for staging')
process.exit(failed ? 1 : 0)
