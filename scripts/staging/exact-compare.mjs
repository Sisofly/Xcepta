/**
 * exact-compare.mjs — exact structural comparison that ignores OBJECT KEY
 * ORDER only.
 *
 * Why: Postgres jsonb does not preserve object key order (keys are stored
 * sorted by length, then bytewise), so a result reloaded from jsonb has the
 * same values as the engine output but serialises to different JSON text.
 *
 * Everything else is strict — no tolerance of any kind:
 *   - numbers   Object.is (bit-exact; NaN === NaN, 0 !== -0)
 *   - strings, booleans, null — strict equality and same type
 *   - arrays    same length, element order enforced
 *   - objects   identical key SETS (missing / extra keys are differences);
 *               key ORDER is counted (reorderedObjects) but not a difference
 *
 * exactDiff(expected, actual) → { equal, differences: [{ path, expected, actual, reason }], reorderedObjects }
 */
export function exactDiff(expected, actual, path = '$', acc = { differences: [], reorderedObjects: 0 }) {
  const kind = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
  const ke = kind(expected), ka = kind(actual)
  if (ke !== ka) {
    acc.differences.push({ path, expected, actual, reason: 'type ' + ke + ' ≠ ' + ka })
  } else if (ke === 'array') {
    if (expected.length !== actual.length) {
      acc.differences.push({ path: path + '.length', expected: expected.length, actual: actual.length, reason: 'array length' })
    }
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) exactDiff(expected[i], actual[i], path + '[' + i + ']', acc)
  } else if (ke === 'object') {
    const keysE = Object.keys(expected), keysA = Object.keys(actual)
    const setA = new Set(keysA), setE = new Set(keysE)
    keysE.filter(k => !setA.has(k)).forEach(k => acc.differences.push({ path: path + '.' + k, expected: expected[k], actual: undefined, reason: 'missing key' }))
    keysA.filter(k => !setE.has(k)).forEach(k => acc.differences.push({ path: path + '.' + k, expected: undefined, actual: actual[k], reason: 'unexpected key' }))
    if (keysE.length === keysA.length && keysE.every(k => setA.has(k)) && keysE.some((k, i) => keysA[i] !== k)) acc.reorderedObjects++
    keysE.filter(k => setA.has(k)).forEach(k => exactDiff(expected[k], actual[k], path + '.' + k, acc))
  } else if (!Object.is(expected, actual)) {
    acc.differences.push({ path, expected, actual, reason: ke === 'number' ? 'Δ ' + (actual - expected) : 'value' })
  }
  return Object.assign(acc, { equal: acc.differences.length === 0 })
}

// One-line summary for reports: "0 value differences (69 objects key-reordered by jsonb)"
// or the first few differences with path, expected and actual.
export function describeDiff(d, max = 3) {
  if (d.equal) return '0 value differences (' + d.reorderedObjects + ' objects key-reordered by jsonb)'
  return d.differences.length + ' difference(s): ' + d.differences.slice(0, max)
    .map(x => x.path + ' expected ' + JSON.stringify(x.expected) + ' got ' + JSON.stringify(x.actual) + ' [' + x.reason + ']').join('; ') +
    (d.differences.length > max ? '; …' : '')
}
