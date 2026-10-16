/**
 * pgliteSecurity.js — test-only Supabase-like database for the security suite.
 *
 * Loads the PRODUCTION schema structure (tests/fixtures/xcepta_production_schema.sql:
 * tables, constraints, RLS policies, grants and Supabase default privileges),
 * then P-022 and the SEC-01..04 migrations exactly as they will be applied.
 * Supabase pieces are simulated: the anon / authenticated / service_role roles
 * (service_role bypasses RLS, as on Supabase), the auth schema, and auth.uid() /
 * auth.role() reading the request JWT claims like PostgREST sets them.
 *
 * asClient(pg, identity) runs every statement in its own transaction as the
 * given role with the given JWT claims — the same privileges, RLS policies and
 * triggers a direct REST / RPC call meets (not a UI restriction).
 */
import { PGlite, types } from '@electric-sql/pglite'
import { readFileSync } from 'fs'
import { supabaseLike } from './pgliteSupabase.js'

const file = rel => readFileSync(new URL(rel, import.meta.url), 'utf8')
export const SECURITY_MIGRATIONS = [
  '../../db/migrations/2026-10-10_p022_versioned_model_outputs.sql',
  '../../db/migrations/2026-10-16_sec01_helpers_audit.sql',
  '../../db/migrations/2026-10-16_sec02_identity_lockdown.sql',
  '../../db/migrations/2026-10-16_sec03_lifecycle_functions.sql',
  '../../db/migrations/2026-10-16_sec04_record_protection.sql',
]

export const SUPABASE_STUBS = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema extensions;
  create function extensions.uuid_generate_v4() returns uuid language sql as $$ select gen_random_uuid() $$;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  create function auth.role() returns text language sql stable as $$ select nullif(auth.jwt() ->> 'role', '') $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
`

export async function createSecurityDb({ upTo = SECURITY_MIGRATIONS.length } = {}) {
  const pg = new PGlite({ parsers: { [types.NUMERIC]: v => (v === null ? null : Number(v)) } })
  await pg.exec(SUPABASE_STUBS)
  await pg.exec(file('../fixtures/xcepta_production_schema.sql'))
  await pg.exec('reset all')                       // the dump turns row_security off for the session
  for (const m of SECURITY_MIGRATIONS.slice(0, upTo)) await pg.exec(file(m))
  return pg
}

// identity: null → database owner (setup only); { role: 'anon' };
// { role: 'service_role' }; { role: 'authenticated', sub: '<uuid>' }
export function asClient(pg, identity) {
  const runner = {
    async query(sql, params) {
      if (!identity) return pg.query(sql, params)
      return pg.transaction(async tx => {
        await tx.exec('set local role ' + identity.role)
        await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(identity)])
        return tx.query(sql, params)
      })
    },
  }
  return supabaseLike(runner)
}

// Raw SQL as an identity (for statements the query builder cannot express).
export async function sqlAs(pg, identity, sql, params) {
  try {
    const res = await asClient(pg, identity).raw(sql, params)
    return { data: res.rows, error: null }
  } catch (e) {
    return { data: null, error: { code: e.code, message: e.message } }
  }
}
