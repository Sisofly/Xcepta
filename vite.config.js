import process from 'node:process'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { checkSupabaseTarget } from './src/config/supabaseGuard.js'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Vercel sets VERCEL_ENV at build time; off Vercel this is a local build/dev server.
  const deployEnv = process.env.VERCEL_ENV || 'local'
  const allowLocalProduction = deployEnv === 'local' && process.env.XCEPTA_ALLOW_PRODUCTION_DB === '1'
  const target = checkSupabaseTarget({
    deployEnv,
    url: process.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL,
    allowLocalProduction,
  })
  if (!target.ok) {
    // Fail closed: no bundle is produced for a forbidden database target.
    throw new Error('[xcepta environment guard] ' + target.reason)
  }
  if (target.warning) console.warn('\n[xcepta environment guard] ' + target.warning + '\n')

  return {
    plugins: [react()],
    define: {
      __XCEPTA_DEPLOY_ENV__: JSON.stringify(deployEnv),
      __XCEPTA_ALLOW_LOCAL_PRODUCTION_DB__: JSON.stringify(allowLocalProduction),
    },
  }
})
