/**
 * stagingGate.test.js — temporary SEC-04 cutover request gate
 * (db/security/staging_gate_{on,off,remove}.sql), run as the exact files on the
 * post-SEC-03 staging schema (PGlite). PostgREST is simulated the way it calls
 * a pre-request function: one transaction per request, `set local role`, the
 * request headers in `request.headers` (JSON, lower-case names), then the
 * pre-request function, then the request's statement.
 */
import { readFileSync } from 'node:fs'
import { createSecurityDb } from './helpers/pgliteSecurity.js'

const file = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
const ON = file('db/security/staging_gate_on.sql')
const OFF = file('db/security/staging_gate_off.sql')
const REMOVE = file('db/security/staging_gate_remove.sql')
const PRECHECK = file('db/security/staging_gate_precheck.sql')
const VERIFY = file('db/security/verify_security_catalog.sql')
const ROLES = ['anon', 'authenticated', 'service_role']
const GATE = 'pgrst.db_pre_request=staging_gate.check_request'

const ALLOWED = [
  ['local app (localhost:5173)', { origin: 'http://localhost:5173' }],
  ['local app (127.0.0.1:5173)', { origin: 'http://127.0.0.1:5173' }],
  ['referer on the local app, no Origin', { referer: 'http://localhost:5173/feasibility/123' }],
  ['referer equal to the local origin', { referer: 'http://127.0.0.1:5173' }],
  ['origin-less non-browser client (Node, curl)', { 'user-agent': 'node', accept: 'application/json' }],
  ['empty header object', {}],
]
const REJECTED = [
  ['old Preview — branch alias', { origin: 'https://xcepta-git-rc-ppp-v1-sisofly.vercel.app' }],
  ['old Preview — deployment URL', { origin: 'https://xcepta-8f3k2l1qz-sisofly.vercel.app' }],
  ['production app domain', { origin: 'https://xcepta.vercel.app' }],
  ['vercel, upper case', { origin: 'HTTPS://XCEPTA-GIT-X.VERCEL.APP' }],
  ['vercel over http', { origin: 'http://xcepta.vercel.app' }],
  ['vercel, referer only', { referer: 'https://xcepta-git-rc-ppp-v1-sisofly.vercel.app/feasibility' }],
  ['vercel origin + local referer', { origin: 'https://xcepta.vercel.app', referer: 'http://localhost:5173/' }],
  ['Supabase dashboard', { origin: 'https://supabase.com' }],
  ['other port 5174', { origin: 'http://localhost:5174' }],
  ['https localhost', { origin: 'https://localhost:5173' }],
  ['localhost without port', { origin: 'http://localhost' }],
  ['look-alike host suffix', { origin: 'http://localhost:5173.evil.test' }],
  ['look-alike userinfo', { origin: 'http://localhost:5173@evil.test' }],
  ['look-alike IP suffix', { origin: 'http://127.0.0.1:5173.evil.test' }],
  ['trailing slash', { origin: 'http://localhost:5173/' }],
  ['leading space', { origin: ' http://localhost:5173' }],
  ["opaque origin 'null'", { origin: 'null' }],
  ['empty origin', { origin: '' }],
  ['capitalised header name', { Origin: 'https://xcepta.vercel.app' }],
  ['allowed + vercel under two header names', { origin: 'http://localhost:5173', Origin: 'https://xcepta.vercel.app' }],
  ['referer look-alike', { referer: 'http://localhost:5173evil.test/' }],
]
const MALFORMED = [
  ['not JSON', 'origin: https://x.vercel.app'],
  ['truncated JSON', '{"origin": "http://localhost:5173"'],
  ['JSON array', '["http://localhost:5173"]'],
  ['JSON string', '"http://localhost:5173"'],
  ['JSON null', 'null'],
  ['origin is a number', '{"origin": 5173}'],
  ['origin is null', '{"origin": null}'],
  ['origin is an array', '{"origin": ["http://localhost:5173"]}'],
  ['origin is an object', '{"origin": {"href": "http://localhost:5173"}}'],
  ['referer is a number', '{"referer": 1}'],
]

let pg
const setting = async () => (await pg.query(`select coalesce(string_agg(c, ',' order by c), '') s
  from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c where r.rolname = 'authenticator'`)).rows[0].s
const schemaCount = async () => (await pg.query(`select count(*)::int n from pg_namespace where nspname = 'staging_gate'`)).rows[0].n
// one PostgREST-style request; raw = exact request.headers text (null → setting absent)
async function request(role, raw, statement = 'select 1') {
  try {
    await pg.transaction(async tx => {
      await tx.exec('set local role ' + role)
      if (raw !== null) await tx.query("select set_config('request.headers', $1, true)", [raw])
      await tx.query('select staging_gate.check_request()')
      await tx.exec(statement)
    })
    return 'allowed'
  } catch (e) {
    if (/^STAGING_GATE: /.test(e.message)) return e.code === '42501' ? 'blocked' : 'blocked, wrong SQLSTATE ' + e.code
    return 'error: ' + e.message
  }
}
const snapshot = async () => (await pg.query(`select
  (select md5(string_agg(tablename || policyname || coalesce(qual, '') || coalesce(with_check, ''), '|' order by tablename, policyname)) from pg_policies) p,
  (select md5(string_agg(table_name || grantee || privilege_type, '|' order by table_name, grantee, privilege_type)) from information_schema.role_table_grants) g,
  (select md5(string_agg(n.nspname || '.' || p.proname || coalesce(array_to_string(p.proacl, ','), ''), '|' order by n.nspname, p.proname))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog', 'information_schema')) f,
  (select string_agg(nspname, ',' order by nspname) from pg_namespace) s`)).rows[0]
// a failing file leaves the session's explicit transaction aborted (the SQL Editor / psql end it the same way)
async function fails(sql, re) {
  await expect(pg.exec(sql)).rejects.toThrow(re)
  await pg.exec('rollback')
}
async function stagingDb(upTo = 4, emails = ['staging.a@xcepta.test', 'staging.b@xcepta.test']) {
  const db = await createSecurityDb({ upTo })
  await db.exec(`create role authenticator noinherit login`)
  for (const e of emails) await db.query('insert into auth.users (id, email) values (gen_random_uuid(), $1)', [e])
  return db
}

describe('G0 pre-check (read-only)', () => {
  test('G0.1 reports the expected staging values before installation', async () => {
    pg = await stagingDb()
    const r = (await pg.query(PRECHECK)).rows[0]
    expect(r).toMatchObject({ existing_pre_request: 0, can_alter_authenticator: true, sec03_present: 1, auth_users: 2, non_test_auth_users: 0, staging_gate_schema: 0 })
    await pg.close()
  })
})

describe('G1 installation guards — nothing is installed', () => {
  test('G1.1 refuses without SEC-03 (Production today)', async () => {
    pg = await stagingDb(3)
    await fails(ON, /SEC-03 is not present/)
    expect(await schemaCount()).toBe(0); expect(await setting()).toBe('')
    await pg.close()
  })
  test('G1.2 refuses when a non-synthetic Auth account exists', async () => {
    pg = await stagingDb(4, ['staging.a@xcepta.test', 'person@gmail.com'])
    await fails(ON, /non-synthetic Auth accounts/)
    expect(await schemaCount()).toBe(0); expect(await setting()).toBe('')
    await pg.close()
  })
  test('G1.3 refuses with no Auth accounts at all', async () => {
    pg = await stagingDb(4, [])
    await fails(ON, /non-synthetic Auth accounts/)
    expect(await schemaCount()).toBe(0)
    await pg.close()
  })
  test('G1.4 never replaces another pre-request function', async () => {
    pg = await stagingDb()
    await pg.exec(`alter role authenticator set pgrst.db_pre_request = 'public.other_check'`)
    await fails(ON, /another pre-request function/)
    expect(await setting()).toBe('pgrst.db_pre_request=public.other_check'); expect(await schemaCount()).toBe(0)
    await pg.close()
  })
  test('G1.5 atomic: a failure at the last step (e.g. no privilege to alter authenticator) leaves nothing', async () => {
    pg = await stagingDb()
    const failing = ON.replace("alter role authenticator set pgrst.db_pre_request = 'staging_gate.check_request';",
      "alter role authenticator_missing set pgrst.db_pre_request = 'staging_gate.check_request';")
    expect(failing).not.toBe(ON)
    await fails(failing, /authenticator_missing/)
    expect(await schemaCount()).toBe(0); expect(await setting()).toBe('')
    await pg.close()
  })
})

describe('G2–G6 installed gate', () => {
  let before
  beforeAll(async () => {
    pg = await stagingDb()
    before = await snapshot()
    const res = await pg.exec(ON)
    expect(res[res.length - 1].rows[0]).toEqual({ gate_configured: 1, gate_function: 1 })
  })
  afterAll(async () => { await pg.close() })

  test('G2.1 PostgREST setting points at the gate; re-running the install is idempotent', async () => {
    expect(await setting()).toBe(GATE)
    await pg.exec(ON)
    expect(await setting()).toBe(GATE)
  })
  test('G2.2 the function is SECURITY INVOKER, search_path empty, owned by postgres, executable only by the API roles', async () => {
    const f = (await pg.query(`select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) owner, p.provolatile,
        has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') au,
        has_function_privilege('service_role', p.oid, 'execute') s
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'staging_gate'`)).rows
    expect(f).toEqual([{ prosecdef: false, proconfig: ['search_path=""'], owner: 'postgres', provolatile: 's', a: true, au: true, s: true }])
    expect((await pg.query(`select has_schema_privilege('public', 'staging_gate', 'usage') u, has_schema_privilege('anon', 'staging_gate', 'create') c`)).rows[0]).toEqual({ u: false, c: false })
  })
  test('G2.3 no table, policy or grant changed; only the staging_gate schema and function were added', async () => {
    const after = await snapshot()
    expect(after.p).toBe(before.p); expect(after.g).toBe(before.g)
    expect(after.s.split(',').filter(x => !before.s.split(',').includes(x))).toEqual(['staging_gate'])
  })
  test('G2.4 catalog verification is unaffected (19 pass / 4 SEC-04 pending)', async () => {
    const v = (await pg.exec(VERIFY)).find(x => x.rows && x.rows.length && 'check_name' in x.rows[0]).rows
    expect([v.filter(x => x.pass).length, v.filter(x => !x.pass).length]).toEqual([19, 4])
  })

  test.each(ROLES)('G3.1 exact permitted origins are allowed (%s)', async role => {
    for (const [name, h] of ALLOWED) expect([name, await request(role, JSON.stringify(h))]).toEqual([name, 'allowed'])
  })
  test.each(ROLES)('G3.2 the request.headers setting absent → allowed (%s)', async role => {
    expect(await request(role, null)).toBe('allowed')
    expect(await request(role, '')).toBe('allowed')
  })
  test.each(ROLES)('G4 Vercel and every other origin are rejected with 42501 (%s)', async role => {
    for (const [name, h] of REJECTED) expect([name, await request(role, JSON.stringify(h))]).toEqual([name, 'blocked'])
  })
  test.each(ROLES)('G5 malformed request headers fail closed (%s)', async role => {
    for (const [name, raw] of MALFORMED) expect([name, await request(role, raw)]).toEqual([name, 'blocked'])
  })
  test('G6 a refused request never runs its statement (the deployed app delete sequence changes nothing)', async () => {
    await pg.exec(`create table public.gate_probe (n int); insert into public.gate_probe values (1), (2); grant select, delete on public.gate_probe to authenticated`)
    const vercel = JSON.stringify({ origin: 'https://xcepta-git-rc-ppp-v1-sisofly.vercel.app' })
    for (let i = 0; i < 8; i++) expect(await request('authenticated', vercel, 'delete from public.gate_probe')).toBe('blocked')
    expect((await pg.query('select count(*)::int n from public.gate_probe')).rows[0].n).toBe(2)
    expect(await request('authenticated', JSON.stringify({ origin: 'http://localhost:5173' }), 'delete from public.gate_probe where n = 1')).toBe('allowed')
    expect((await pg.query('select count(*)::int n from public.gate_probe')).rows[0].n).toBe(1)
    await pg.exec('drop table public.gate_probe')
  })
})

describe('G7 removal and reversibility', () => {
  test('G7.1 remove refuses while the gate is configured; off → remove restores the exact prior state; both idempotent', async () => {
    pg = await stagingDb()
    const before = await snapshot()
    await pg.exec(ON)
    await fails(REMOVE, /still configured/)
    expect(await schemaCount()).toBe(1); expect(await setting()).toBe(GATE)
    let r = await pg.exec(OFF)
    expect(r[r.length - 1].rows[0]).toEqual({ gate_configured: 0, any_pre_request: 0 })
    expect(await setting()).toBe('')
    expect(await schemaCount()).toBe(1)                                   // function kept until step 2
    expect(await request('authenticated', JSON.stringify({ origin: 'https://xcepta.vercel.app' }))).toBe('blocked')   // only PostgREST stops calling it
    await pg.exec(OFF)                                                    // idempotent
    r = await pg.exec(REMOVE)
    expect(r[r.length - 1].rows[0]).toEqual({ staging_gate_schema: 0 })
    await pg.exec(REMOVE)                                                 // idempotent
    expect(await snapshot()).toEqual(before)
    expect(await setting()).toBe('')
    await pg.close()
  })
  test('G7.2 off leaves any other pre-request setting untouched', async () => {
    pg = await stagingDb()
    await pg.exec(`alter role authenticator set pgrst.db_pre_request = 'public.other_check'`)
    const r = await pg.exec(OFF)
    expect(r[r.length - 1].rows[0]).toEqual({ gate_configured: 0, any_pre_request: 1 })
    expect(await setting()).toBe('pgrst.db_pre_request=public.other_check')
    await pg.close()
  })
  test('G7.3 off refuses (changes nothing) if the gate was configured per database instead', async () => {
    pg = await stagingDb()
    await pg.exec(ON)
    await pg.exec(`alter role authenticator reset pgrst.db_pre_request; alter role authenticator in database postgres set pgrst.db_pre_request = 'staging_gate.check_request'`)
    await fails(OFF, /unexpected scope/)
    expect(await setting()).toBe(GATE)
    await pg.close()
  })
  test('G7.4 remove never drops other objects: a non-empty schema aborts the whole removal', async () => {
    pg = await stagingDb()
    await pg.exec(ON); await pg.exec(OFF)
    await pg.exec('create table staging_gate.keep_me (n int)')
    await fails(REMOVE, /depend|other objects|cannot drop/)
    expect(await schemaCount()).toBe(1)
    expect((await pg.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'staging_gate'`)).rows[0].n).toBe(1)
    await pg.close()
  })
  test('G7.5 with SEC-04 applied the gate is equally inert to the catalog (23/23)', async () => {
    pg = await stagingDb(5)
    await pg.exec(ON)
    const v = (await pg.exec(VERIFY)).find(x => x.rows && x.rows.length && 'check_name' in x.rows[0]).rows
    expect(v.every(x => x.pass)).toBe(true); expect(v).toHaveLength(23)
    await pg.close()
  })
})
