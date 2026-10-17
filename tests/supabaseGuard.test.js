/**
 * supabaseGuard.test.js — fail-closed database-target rules (staging setup)
 */
import { checkSupabaseTarget, projectRefFromUrl, PRODUCTION_SUPABASE_REF } from '../src/config/supabaseGuard.js'

const PROD = 'https://' + PRODUCTION_SUPABASE_REF + '.supabase.co'
const STAGING = 'https://abcdefghijklmnopqrst.supabase.co'

describe('environment guard', () => {
  test('G1: preview and vercel-development can never use production — no override', () => {
    ;['preview', 'development'].forEach(deployEnv => {
      expect(checkSupabaseTarget({ deployEnv, url: PROD }).ok).toBe(false)
      expect(checkSupabaseTarget({ deployEnv, url: PROD, allowLocalProduction: true }).ok).toBe(false)
      expect(checkSupabaseTarget({ deployEnv, url: STAGING })).toEqual({ ok: true, target: 'staging' })
    })
  })
  test('G2: production must use production (a production build pointed at staging fails)', () => {
    expect(checkSupabaseTarget({ deployEnv: 'production', url: PROD })).toEqual({ ok: true, target: 'production' })
    expect(checkSupabaseTarget({ deployEnv: 'production', url: STAGING }).ok).toBe(false)
  })
  test('G3: local defaults to blocked on production; explicit opt-in is allowed and flagged', () => {
    expect(checkSupabaseTarget({ deployEnv: 'local', url: PROD }).ok).toBe(false)
    const o = checkSupabaseTarget({ deployEnv: 'local', url: PROD, allowLocalProduction: true })
    expect(o.ok).toBe(true); expect(o.warning).toMatch(/PRODUCTION/)
    expect(checkSupabaseTarget({ deployEnv: 'local', url: STAGING }).target).toBe('staging')
  })
  test('G4: missing / malformed URLs and unknown environments fail closed', () => {
    ;[undefined, '', 'http://' + PRODUCTION_SUPABASE_REF + '.supabase.co', 'https://evil.example.com', PROD + '/rest/v1']
      .forEach(url => expect(checkSupabaseTarget({ deployEnv: 'preview', url }).ok).toBe(false))
    expect(checkSupabaseTarget({ deployEnv: 'unknown', url: STAGING }).ok).toBe(false)
    expect(checkSupabaseTarget({ deployEnv: undefined, url: STAGING }).ok).toBe(false)
  })
  test('G5: project reference parsing is case-insensitive and exact', () => {
    expect(projectRefFromUrl(PROD.toUpperCase().replace('HTTPS', 'https'))).toBe(PRODUCTION_SUPABASE_REF)
    expect(projectRefFromUrl(PROD + '/')).toBe(PRODUCTION_SUPABASE_REF)
    expect(projectRefFromUrl('https://' + PRODUCTION_SUPABASE_REF + 'x.supabase.co')).not.toBe(PRODUCTION_SUPABASE_REF)
  })
})
