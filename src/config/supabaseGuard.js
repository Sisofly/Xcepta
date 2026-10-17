/**
 * supabaseGuard.js — fail-closed database-target check (staging / production)
 * ---------------------------------------------------------------------------
 * One rule set, enforced twice:
 *   • at BUILD time (vite.config.js) — a misconfigured preview never builds;
 *   • at RUNTIME (src/lib/supabase.js) — the browser refuses to create a
 *     client for a forbidden target.
 *
 * Deployment environment = Vercel's VERCEL_ENV at build time
 * ('production' | 'preview' | 'development'), or 'local' off Vercel.
 *
 *   production  → MUST use the production project (also catches a production
 *                 deployment accidentally pointed at staging)
 *   preview     → MUST NOT use the production project. No override exists.
 *   development → (vercel dev) treated like preview
 *   local       → MUST NOT use the production project unless the developer
 *                 sets XCEPTA_ALLOW_PRODUCTION_DB=1 in their own shell
 *                 (deliberate, local-only, never read on Vercel)
 *   anything else / missing URL → blocked
 *
 * The production project reference is not a secret (it is part of the public
 * Supabase URL shipped in the client bundle).
 * ---------------------------------------------------------------------------
 */
export const PRODUCTION_SUPABASE_REF = 'acaqynigacgpswobiasb'

export function projectRefFromUrl(url) {
  const m = /^https:\/\/([a-z0-9]{10,40})\.supabase\.(co|in)\/?$/i.exec(String(url || '').trim())
  return m ? m[1].toLowerCase() : null
}

export function checkSupabaseTarget({ deployEnv, url, allowLocalProduction = false }) {
  const ref = projectRefFromUrl(url)
  const isProd = ref === PRODUCTION_SUPABASE_REF
  if (!ref) {
    return { ok: false, reason: 'VITE_SUPABASE_URL is missing or not a Supabase project URL (https://<ref>.supabase.co).' }
  }
  switch (deployEnv) {
    case 'production':
      return isProd
        ? { ok: true, target: 'production' }
        : { ok: false, reason: 'Production deployment must use the production Supabase project (' + PRODUCTION_SUPABASE_REF + '); got ' + ref + '.' }
    case 'preview':
    case 'development':
      return isProd
        ? { ok: false, reason: 'BLOCKED: ' + deployEnv + ' deployments must not connect to the production Supabase project. ' +
            'Set the Vercel Preview/Development VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to the staging project.' }
        : { ok: true, target: 'staging' }
    case 'local':
      if (!isProd) return { ok: true, target: 'staging' }
      return allowLocalProduction
        ? { ok: true, target: 'production', warning: 'LOCAL BUILD CONNECTED TO PRODUCTION (XCEPTA_ALLOW_PRODUCTION_DB=1)' }
        : { ok: false, reason: 'BLOCKED: local development is configured for the production Supabase project. ' +
            'Put the staging URL/anon key in .env.local (see .env.example), or — only if you must — set ' +
            'XCEPTA_ALLOW_PRODUCTION_DB=1 in your shell for this session.' }
    default:
      return { ok: false, reason: 'Unknown deployment environment "' + deployEnv + '".' }
  }
}
