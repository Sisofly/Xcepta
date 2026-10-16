#!/usr/bin/env node
// LOCAL concurrency test of the last-admin invariant on a REAL PostgreSQL
// server (PGlite cannot run concurrent sessions). Creates a throwaway cluster
// in the OS temp folder, listening on localhost only, loads the production
// schema structure + P-022 + SEC-01..04 statement by statement with psql (as
// `psql -f` would), races parallel sessions, then deletes the cluster.
// Never connects to staging or production.
//   node scripts/security/pg17-concurrency.mjs ["C:\Program Files\PostgreSQL\17\bin"]
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SUPABASE_STUBS, SECURITY_MIGRATIONS } from '../../tests/helpers/pgliteSecurity.js'

const BIN = process.argv[2] || 'C:\\Program Files\\PostgreSQL\\17\\bin'
const PORT = '55432'
const exe = n => join(BIN, n + (process.platform === 'win32' ? '.exe' : ''))
const dir = mkdtempSync(join(tmpdir(), 'xcepta-pg17-'))
const data = join(dir, 'data')
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(exe(cmd), args, { encoding: 'utf8', ...opts })
  if (r.status !== 0 && !opts.allowFail) throw new Error(cmd + ' failed: ' + (r.stderr || r.stdout))
  return r
}
const psqlArgs = db => ['-h', 'localhost', '-p', PORT, '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At']
const sqlFile = (db, path) => run('psql', [...psqlArgs(db), '-f', path])
const sql = (db, text) => { const f = join(dir, 'q' + randomUUID() + '.sql'); writeFileSync(f, text); return run('psql', [...psqlArgs(db), '-f', f]).stdout.trim() }
const session = (db, text) => new Promise(resolve => {
  const f = join(dir, 's' + randomUUID() + '.sql'); writeFileSync(f, text)
  const p = spawn(exe('psql'), ['-h', 'localhost', '-p', PORT, '-U', 'postgres', '-d', db, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-f', f])
  let out = ''; p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (out += d))
  p.on('close', code => resolve({ code, out: out.trim() }))
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
const asOperator = `set role service_role; select set_config('request.jwt.claims', '{"role":"service_role"}', false);`
const asMember = uid => `select set_config('request.jwt.claims', '{"role":"authenticated","sub":"${uid}"}', false); set role authenticated;`

async function setupDb(db) {
  run('createdb', ['-h', 'localhost', '-p', PORT, '-U', 'postgres', db])
  // replacer function: a replacement *string* would turn $$ into $
  sql(db, SUPABASE_STUBS.replace('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;',
    () => `do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; end if; end $$;`))
  sqlFile(db, 'tests/fixtures/xcepta_production_schema.sql')
  for (const m of SECURITY_MIGRATIONS) sqlFile(db, new URL(m, new URL('../../tests/helpers/', import.meta.url)).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const t = sql(db, `${asOperator} select public.operator_create_tenant('Race tenant');`).split('\n').pop()
  const a1 = randomUUID(), a2 = randomUUID()
  sql(db, `insert into auth.users (id, email) values ('${a1}', 'a1@x.test'), ('${a2}', 'a2@x.test');`)
  sql(db, `${asOperator} select public.operator_add_member('${a1}', '${t}', 'a1@x.test', 'A1', 'admin'); select public.operator_add_member('${a2}', '${t}', 'a2@x.test', 'A2', 'admin');`)
  return { t, a1, a2 }
}
const admins = (db, t) => Number(sql(db, `select count(*) from public.users where tenant_id = '${t}' and role = 'admin' and active;`))

// Session 1 holds its transaction open for 2.5 s after its change; session 2 starts meanwhile.
// Both sessions run at the given isolation level.
const HOLD_MS = 2500, START_GAP_MS = 700
async function race(db, s1, s2, iso) {
  const p1 = session(db, `begin isolation level ${iso}; ${s1} select pg_sleep(${HOLD_MS / 1000}); commit;`)
  await sleep(START_GAP_MS)
  const t0 = Date.now()
  let t2 = 0
  const p2 = session(db, `begin isolation level ${iso}; ${s2} commit;`).then(r => { t2 = Date.now(); return r })
  const [r1, r2] = await Promise.all([p1, p2])
  return { r1, r2, waitedMs: t2 - t0 }                   // session 2's own duration
}

const ISOLATION = ['read committed', 'repeatable read', 'serializable']
const SCENARIOS = [
  { key: 'demote', name: 'operator demotes both admins',
    s1: x => `${asOperator} select public.operator_set_member_role('${x.a1}', 'analyst', 'parallel demotion test one');`,
    s2: x => `${asOperator} select public.operator_set_member_role('${x.a2}', 'analyst', 'parallel demotion test two');` },
  { key: 'cross', name: 'admins demote / deactivate each other',
    s1: x => `${asMember(x.a1)} select public.admin_set_member_role('${x.a2}', 'manager');`,
    s2: x => `${asMember(x.a2)} select public.admin_set_member_active('${x.a1}', false);` },
  { key: 'selfdown', name: 'both admins deactivate themselves',
    s1: x => `${asMember(x.a1)} select public.admin_set_member_active('${x.a1}', false);`,
    s2: x => `${asMember(x.a2)} select public.admin_set_member_active('${x.a2}', false);` },
  { key: 'move', name: 'operator moves both admins out',
    s1: x => `${asOperator} select public.operator_move_member('${x.a1}', '${x.other}', 'parallel move test one');`,
    s2: x => `${asOperator} select public.operator_move_member('${x.a2}', '${x.other}', 'parallel move test two');` },
  { key: 'control', control: true, name: 'CONTROL: operator demotion, protection removed',
    s1: x => `${asOperator} select public.operator_set_member_role('${x.a1}', 'analyst', 'parallel demotion test one');`,
    s2: x => `${asOperator} select public.operator_set_member_role('${x.a2}', 'analyst', 'parallel demotion test two');` },
]
const REMOVE_PROTECTION = `drop trigger users_last_admin_guard on public.users;
  create or replace function app_private.lock_tenant(p_tenant uuid) returns void language sql volatile security definer set search_path = '' as $$ select $$;`

const report = []
try {
  run('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'])
  // stdio 'ignore': the server inherits pg_ctl's handles; a captured pipe would never close (Windows)
  run('pg_ctl', ['-D', data, '-l', join(dir, 'pg.log'), '-o', `-p ${PORT} -c listen_addresses=localhost`, '-w', 'start'], { stdio: 'ignore' })
  console.log('PostgreSQL ' + sql('postgres', 'show server_version;') + ' (local, ' + sql('postgres', 'show listen_addresses;') + ':' + PORT + ', throwaway)')

  let i = 0
  for (const sc of SCENARIOS) for (const iso of ISOLATION) {
    const db = 'race' + (++i)
    const x = await setupDb(db)
    if (sc.key === 'move') x.other = sql(db, `${asOperator} select public.operator_create_tenant('Other tenant');`).split('\n').pop()
    if (sc.control) sql(db, REMOVE_PROTECTION)
    if (admins(db, x.t) !== 2) throw new Error(db + ': setup did not create 2 active admins')
    const r = await race(db, sc.s1(x), sc.s2(x), iso)
    report.push({ sc, iso, r, n: admins(db, x.t) })
  }
  let ok = true
  for (const { sc, iso, r, n } of report) {
    const c1 = r.r1.code === 0, c2 = r.r2.code === 0
    const waited = r.waitedMs >= HOLD_MS - START_GAP_MS - 300
    // Protected: exactly one change commits, one admin is left, and session 2 waited for session 1 (tenant lock).
    // Control: both changes commit and the tenant is left without an active admin (the race is real).
    const pass = sc.control ? (c1 && c2 && n === 0) : (c1 && !c2 && n === 1 && waited)
    ok = ok && pass
    const second = c2 ? 'committed' : 'refused: ' + (r.r2.out.match(/(LAST_ADMIN[^\n]*|NOT_AUTHORIZED[^\n]*|could not serialize[^\n]*|deadlock[^\n]*)/) || [r.r2.out.split('\n').pop()])[0]
    console.log((pass ? 'PASS ' : 'FAIL ') + (sc.name + ' [' + iso + ']').padEnd(66) + ' | s1 ' + (c1 ? 'committed' : 'FAILED: ' + r.r1.out.split('\n').pop()) +
      ' | s2 waited ' + (r.waitedMs / 1000).toFixed(1) + 's, ' + second + ' | active admins left: ' + n + (sc.control ? ' (control expects 0)' : ''))
  }
  console.log(ok ? '\nALL CONCURRENCY CHECKS PASSED' : '\nCONCURRENCY CHECK FAILED')
  process.exitCode = ok ? 0 : 1
} finally {
  run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { allowFail: true })
  rmSync(dir, { recursive: true, force: true })
  console.log('local cluster stopped and deleted')
}
void readFileSync
