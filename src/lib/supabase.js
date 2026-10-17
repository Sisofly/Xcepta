import { createClient } from '@supabase/supabase-js'
import { checkSupabaseTarget } from '../config/supabaseGuard.js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables')
}

// Environment guard (runtime, defence in depth): same rules as the build-time
// check in vite.config.js. A forbidden target stops the app before any
// database client exists. Values are injected at build time by Vite.
/* global __XCEPTA_DEPLOY_ENV__, __XCEPTA_ALLOW_LOCAL_PRODUCTION_DB__ */
export const DEPLOY_ENV = typeof __XCEPTA_DEPLOY_ENV__ === 'string' ? __XCEPTA_DEPLOY_ENV__ : 'unknown'
const target = checkSupabaseTarget({
  deployEnv: DEPLOY_ENV,
  url: supabaseUrl,
  allowLocalProduction: typeof __XCEPTA_ALLOW_LOCAL_PRODUCTION_DB__ === 'boolean' && __XCEPTA_ALLOW_LOCAL_PRODUCTION_DB__,
})
if (!target.ok) {
  throw new Error('[xcepta environment guard] ' + target.reason)
}
// 'production' | 'staging' — drives the environment banner
export const DATABASE_TARGET = target.target
export const DATABASE_WARNING = target.warning || null

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
