// Splits a SQL script into top-level statements the way psql sends them
// (one at a time): ';' ends a statement except inside single quotes,
// dollar-quoted bodies ($$ … $$ or $tag$ … $tag$) and comments.
export function splitSqlStatements(sql) {
  const out = []
  let cur = '', i = 0, quote = null, dollar = null
  while (i < sql.length) {
    const c = sql[i], rest = sql.slice(i)
    if (dollar) {
      if (rest.startsWith(dollar)) { cur += dollar; i += dollar.length; dollar = null; continue }
      cur += c; i++; continue
    }
    if (quote) { cur += c; i++; if (c === "'") quote = null; continue }
    if (rest.startsWith('--')) { const e = sql.indexOf('\n', i); const end = e < 0 ? sql.length : e; cur += sql.slice(i, end); i = end; continue }
    const d = /^\$[A-Za-z_]*\$/.exec(rest)
    if (d) { dollar = d[0]; cur += dollar; i += dollar.length; continue }
    if (c === "'") { quote = "'"; cur += c; i++; continue }
    if (c === ';') { if (cur.replace(/--[^\n]*/g, '').trim()) out.push(cur.trim()); cur = ''; i++; continue }
    cur += c; i++
  }
  if (cur.replace(/--[^\n]*/g, '').trim()) out.push(cur.trim())
  return out
}

// Executes statement by statement like `psql -v ON_ERROR_STOP=1 -f`: stops at
// the first error; the session then ends (an open transaction is rolled back).
export async function runLikePsql(pg, sql) {
  for (const st of splitSqlStatements(sql)) {
    try { await pg.query(st) } catch (e) {
      try { await pg.query('rollback') } catch { /* no transaction open */ }
      return { error: e }
    }
  }
  return { error: null }
}
