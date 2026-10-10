#!/usr/bin/env node
/**
 * prepare-dump.mjs — make a production pg_dump schema file importable into a
 * Supabase staging project WITHOUT weakening application grants or RLS.
 *
 *   node scripts/staging/prepare-dump.mjs <dump.sql> <out.sql> <defaults.sql>
 *
 * Removed (Supabase platform-managed, already present in every project, and
 * not changeable by the `postgres` login):
 *   - CREATE SCHEMA public / ALTER SCHEMA public OWNER / COMMENT ON SCHEMA public
 *   - ALTER DEFAULT PRIVILEGES FOR ROLE supabase_*   ← cause of the 2026-10-10
 *     "permission denied to change default privileges" failure (line 1213)
 *   - SET transaction_timeout (pg_dump 17 setting unknown to older servers)
 * Kept unchanged: every table, constraint, index, function, RLS enablement,
 * policy and GRANT (application-level permissions).
 * Split out to <defaults.sql> (idempotent, re-applied on resume):
 *   - ALTER DEFAULT PRIVILEGES FOR ROLE postgres …
 * Output is UTF-8 without BOM.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

export function prepareDump(text) {
  const removed = [], defaults = []
  const out = text.replace(/^﻿/, '').split(/\r?\n/).map(line => {
    const drop = reason => { removed.push(reason + ': ' + line); return '-- [staging import] removed (' + reason + '): ' + line }
    if (/^SET transaction_timeout = /.test(line)) return drop('pg17 setting')
    if (/^CREATE SCHEMA public;$/.test(line)) return drop('schema exists in Supabase')
    if (/^ALTER SCHEMA public OWNER TO /.test(line)) return drop('owner')
    if (/^COMMENT ON SCHEMA public IS /.test(line)) return drop('schema comment')
    if (/^ALTER DEFAULT PRIVILEGES FOR ROLE supabase_\w+ /.test(line)) return drop('Supabase platform default privileges')
    if (/^ALTER DEFAULT PRIVILEGES FOR ROLE postgres /.test(line)) { defaults.push(line); return line }
    return line
  })
  return { sql: out.join('\n'), defaults: defaults.join('\n') + '\n', removed }
}

if (process.argv[1] && process.argv[1].endsWith('prepare-dump.mjs')) {
  const [inPath, outPath, defaultsPath] = process.argv.slice(2)
  if (!inPath || !outPath || !defaultsPath) { console.error('usage: prepare-dump.mjs <dump.sql> <out.sql> <defaults.sql>'); process.exit(2) }
  const r = prepareDump(readFileSync(inPath, 'utf8'))
  if (/^(COPY |INSERT INTO )/m.test(r.sql)) { console.error('✖ The schema dump contains data rows. Stopping.'); process.exit(3) }
  writeFileSync(outPath, r.sql)
  writeFileSync(defaultsPath, r.defaults)
  console.log('prepared: ' + r.removed.length + ' platform-managed line(s) removed; ' +
    r.defaults.trim().split('\n').filter(Boolean).length + ' postgres default-privilege line(s) kept (also in ' + defaultsPath + ')')
}
