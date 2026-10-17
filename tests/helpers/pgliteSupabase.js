/**
 * pgliteSupabase.js — test-only Supabase-style client over PGlite (embedded
 * Postgres compiled to WebAssembly; in-memory, no network, no external DB).
 *
 * Implements exactly the query-builder subset used by the PPP result store:
 *   from(t).insert(rows).select()      from(t).update(v).eq(c, x)
 *   from(t).delete().eq(c, x)          from(t).select('*').eq().order().limit()
 *   from(t).delete().eq(c, x).select() (returns the deleted rows, like Prefer: return=representation)
 *   from(t).select().eq().maybeSingle() (one row or null; more than one → error, like PostgREST)
 * Results are { data, error } like supabase-js; errors carry the Postgres
 * SQLSTATE `code` and `message`. numeric columns are returned as JS numbers
 * and json/jsonb as parsed values, matching PostgREST's JSON responses.
 */
import { PGlite, types } from '@electric-sql/pglite'
import { readFileSync } from 'fs'

export async function createTestDb() {
  const pg = new PGlite({
    parsers: { [types.NUMERIC]: v => (v === null ? null : Number(v)) },
  })
  await pg.exec(readFileSync(new URL('./ppp_base_schema.sql', import.meta.url), 'utf8'))
  return pg
}

export async function applyP022Migration(pg) {
  await pg.exec(readFileSync(new URL('../../db/migrations/2026-10-10_p022_versioned_model_outputs.sql', import.meta.url), 'utf8')
    .replace(/public\./g, ''))
}

const ident = s => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error('unsafe identifier ' + s)
  return '"' + s + '"'
}
const toParam = v => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v)

class Query {
  constructor(pg, table) { this.pg = pg; this.table = table; this.op = 'select'; this.filters = []; this.returning = false }
  select() { if (this.op === 'insert' || this.op === 'update' || this.op === 'delete') this.returning = true; return this }
  maybeSingle() { this.maybe = true; return this }
  insert(v) { this.op = 'insert'; this.rows = Array.isArray(v) ? v : [v]; return this }
  update(v) { this.op = 'update'; this.values = v; return this }
  delete() { this.op = 'delete'; return this }
  eq(col, val) { this.filters.push([col, val]); return this }
  order(col, opts) { this.orderBy = [col, !opts || opts.ascending !== false]; return this }
  limit(n) { this.lim = n; return this }
  then(resolve, reject) { return this.run().then(resolve, reject) }

  async run() {
    const params = []
    const p = v => { params.push(toParam(v)); return '$' + params.length }
    const where = this.filters.length ? ' where ' + this.filters.map(([c, v]) => ident(c) + ' = ' + p(v)).join(' and ') : ''
    let sql
    if (this.op === 'insert') {
      const cols = Object.keys(this.rows[0])
      sql = 'insert into ' + ident(this.table) + ' (' + cols.map(ident).join(', ') + ') values ' +
        this.rows.map(r => '(' + cols.map(c => p(r[c])).join(', ') + ')').join(', ') + (this.returning ? ' returning *' : '')
    } else if (this.op === 'update') {
      sql = 'update ' + ident(this.table) + ' set ' + Object.keys(this.values).map(c => ident(c) + ' = ' + p(this.values[c])).join(', ') +
        where + (this.returning ? ' returning *' : '')
    } else if (this.op === 'delete') {
      sql = 'delete from ' + ident(this.table) + where + (this.returning ? ' returning *' : '')
    } else {
      sql = 'select * from ' + ident(this.table) + where +
        (this.orderBy ? ' order by ' + ident(this.orderBy[0]) + (this.orderBy[1] ? ' asc' : ' desc') : '') +
        (this.lim ? ' limit ' + Number(this.lim) : '')
    }
    try {
      const res = await this.pg.query(sql, params)
      if (this.maybe) {
        if (res.rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: null, hint: null } }
        return { data: res.rows[0] || null, error: null }
      }
      return { data: this.op === 'delete' && !this.returning ? null : res.rows, error: null }
    } catch (e) {
      return { data: null, error: { code: e.code, message: e.message, details: e.detail || null, hint: e.hint || null } }
    }
  }
}

// rpc(fn, { arg: value }) → select public.fn(arg => $1 …) — like supabase-js
// rpc over PostgREST: { data: <function result>, error }.
async function rpc(pg, fn, args) {
  const names = Object.keys(args || {})
  const params = names.map(k => toParam(args[k]))
  const sql = 'select public.' + ident(fn) + '(' + names.map((k, i) => ident(k) + ' => $' + (i + 1)).join(', ') + ') as result'
  try {
    const res = await pg.query(sql, params)
    return { data: res.rows[0] ? res.rows[0].result : null, error: null }
  } catch (e) {
    return { data: null, error: { code: e.code, message: e.message, details: e.detail || null, hint: e.hint || null } }
  }
}

export function supabaseLike(pg) {
  return {
    from: table => new Query(pg, table),
    rpc: (fn, args) => rpc(pg, fn, args),
    raw: (sql, params) => pg.query(sql, params),
  }
}
