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
  sql(db, SUPABASE_STUBS.replace('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;',
    `do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; end if; end $$;`))
  sqlFile(db, 'tests/fixtures/xcepta_production_schema.sql')
  for (const m of SECURITY_MIGRATIONS) sqlFile(db, new URL(m, new URL('../../tests/helpers/', import.meta.url)).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const t = sql(db, `${asOperator} select public.operator_create_tenant('Race tenant');`).split('\n').pop()
  const a1 = randomUUID(), a2 = randomUUID()
  sql(db, `insert into auth.users (id, email) values ('${a1}', 'a1@x.test'), ('${a2}', 'a2@x.test');`)
  sql(db, `${asOperator} select public.operator_add_member('${a1}', '${t}', 'a1@x.test', 'A1', 'admin'); select public.operator_add_member('${a2}', '${t}', 'a2@x.test', 'A2', 'admin');`)
  return { t, a1, a2 }
}
const admins = (db, t) => Number(sql(db, `select count(*) from public.users where tenant_id = '${t}' and role = 'admin' and active;`))

// Session 1 holds its transaction open for HOLD ms after its change; session 2 starts meanwhile.
async function race(db, s1, s2, { iso = '' } = {}) {
  const p1 = session(db, `begin; ${s1} select pg_sleep(2.5); commit;`)
  await sleep(700)
  const t0 = Date.now()
  const p2 = session(db, `begin ${iso}; ${s2} commit;`)
  const [r1, r2] = await Promise.all([p1, p2])
  return { r1, r2, waitedMs: Date.now() - t0 }
}

const report = []
try {
  run('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'])
  run('pg_ctl', ['-D', data, '-l', join(dir, 'pg.log'), '-o', `-p ${PORT} -c listen_addresses=localhost`, '-w', 'start'])
  console.log('PostgreSQL ' + sql('postgres', 'show server_version;') + ' (local, localhost:' + PORT + ', throwaway)')

  // 1. operator demotes both admins in parallel
  {
    const { t, a1, a2 } = await setupDb('race1')
    const r = await race('race1', `${asOperator} select public.operator_set_member_role('${a1}', 'analyst', 'parallel demotion test one');`,
                                  `${asOperator} select public.operator_set_member_role('${a2}', 'analyst', 'parallel demotion test two');`)
    report.push(['operator demotes both admins in parallel', r, admins('race1', t)])
  }
  // 2. tenant admins act against each other in parallel (A1 demotes A2 while A2 deactivates A1)
  {
    const { t, a1, a2 } = await setupDb('race2')
    const r = await race('race2', `${asMember(a1)} select public.admin_set_member_role('${a2}', 'manager');`,
                                  `${asMember(a2)} select public.admin_set_member_active('${a1}', false);`)
    report.push(['admins demote / deactivate each other in parallel', r, admins('race2', t)])
  }
  // 3. same as 1 under REPEATABLE READ for the second session
  {
    const { t, a1, a2 } = await setupDb('race3')
    const r = await race('race3', `${asOperator} select public.operator_set_member_role('${a1}', 'analyst', 'parallel demotion test one');`,
                                  `${asOperator} select public.operator_set_member_role('${a2}', 'analyst', 'parallel demotion test two');`, { iso: 'isolation level repeatable read' })
    report.push(['parallel demotion, second session REPEATABLE READ', r, admins('race3', t)])
  }
  // 4. operator moves both admins out in parallel
  {
    const { t, a1, a2 } = await setupDb('race4')
    const other = sql('race4', `${asOperator} select public.operator_create_tenant('Other tenant');`).split('\n').pop()
    const r = await race('race4', `${asOperator} select public.operator_move_member('${a1}', '${other}', 'parallel move test one');`,
                                  `${asOperator} select public.operator_move_member('${a2}', '${other}', 'parallel move test two');`)
    report.push(['operator moves both admins out in parallel', r, admins('race4', t)])
  }
  // 5. CONTROL — protection removed (trigger dropped, tenant lock a no-op): the race must reproduce
  {
    const { t, a1, a2 } = await setupDb('race5')
    sql('race5', `drop trigger users_last_admin_guard on public.users;
      create or replace function app_private.lock_tenant(p_tenant uuid) returns void language sql volatile security definer set search_path = '' as $$ select $$;`)
    const r = await race('race5', `${asOperator} select public.operator_set_member_role('${a1}', 'analyst', 'parallel demotion test one');`,
                                  `${asOperator} select public.operator_set_member_role('${a2}', 'analyst', 'parallel demotion test two');`)
    report.push(['CONTROL: same race with the protection removed', r, admins('race5', t)])
  }
  let ok = true
  for (const [name, r, n] of report) {
    const control = name.startsWith('CONTROL')
    const pass = control ? n === 0 : n >= 1
    ok = ok && pass
    const second = r.r2.code === 0 ? 'committed' : 'refused: ' + (r.r2.out.match(/(LAST_ADMIN[^\n]*|NOT_AUTHORIZED[^\n]*|could not serialize[^\n]*)/) || [r.r2.out.split('\n').pop()])[0]
    console.log((pass ? 'PASS ' : 'FAIL ') + name.padEnd(52) + ' | session 1 ' + (r.r1.code === 0 ? 'committed' : 'failed') +
      ' | session 2 waited ' + (r.waitedMs / 1000).toFixed(1) + 's, ' + second + ' | active admins left: ' + n + (control ? ' (expected 0 — race reproduced)' : ''))
  }
  console.log(ok ? '\nALL CONCURRENCY CHECKS PASSED' : '\nCONCURRENCY CHECK FAILED')
  process.exitCode = ok ? 0 : 1
} finally {
  run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { allowFail: true })
  rmSync(dir, { recursive: true, force: true })
  console.log('local cluster stopped and deleted')
}
void readFileSync
