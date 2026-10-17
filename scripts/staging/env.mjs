// Shared environment loading for the staging scripts. Shell variables win over
// .env.local. Refuses the production Supabase project — no override.
import { readFileSync, existsSync } from 'node:fs'
import process from 'node:process'
import { PRODUCTION_SUPABASE_REF, projectRefFromUrl } from '../../src/config/supabaseGuard.js'

export function fail(msg) { console.error('✖ ' + msg); process.exit(2) }

export function loadStagingEnv(required = []) {
  const env = { ...process.env }
  if (existsSync('.env.local')) {
    for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  }
  const ref = projectRefFromUrl(env.VITE_SUPABASE_URL)
  if (!ref) fail('VITE_SUPABASE_URL is missing or invalid.')
  if (ref === PRODUCTION_SUPABASE_REF) fail('REFUSED: this is the PRODUCTION Supabase project. Staging scripts only run against staging.')
  const missing = ['VITE_SUPABASE_ANON_KEY', ...required].filter(k => !env[k])
  if (missing.length) fail('Set ' + missing.join(', ') + ' (in your shell or .env.local — never in chat).')
  return { env, ref, PRODUCTION_SUPABASE_REF }
}

// Legacy anon keys are JWTs carrying the project ref; returns null for other key formats.
export function anonKeyRef(key) {
  try {
    const payload = JSON.parse(Buffer.from(String(key).split('.')[1], 'base64url').toString('utf8'))
    return payload.ref || null
  } catch { return null }
}
