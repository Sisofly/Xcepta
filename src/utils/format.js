/**
 * src/utils/format.js
 * ---------------------------------------------------------------------------
 * XCEPTA display-format helpers — locked institutional format standards.
 *
 * Locked format standards:
 *   Currency:     JOD 1,682,450  (prefix JOD, full commas, 0 decimals)
 *   Percentages:  32.8%          (1 decimal)
 *   DSCR:         1.38x          (2 decimals + x suffix)
 *   Multiples:    2.81x          (2 decimals + x suffix)
 *   Plain number: 30,956,565     (full commas, 0 decimals)
 *   IRR:          32.8%          (1 decimal + % suffix; accepts string input)
 *
 * All exported functions return '---' for null, undefined, NaN, or any
 * non-numeric string input. Comma formatting uses the en-US locale.
 *
 * No external dependencies — vanilla JS only.
 * ---------------------------------------------------------------------------
 */

// Internal helper — coerce input to a finite number, or null if not coercible.
function toFiniteNumber(n) {
  const value = typeof n === 'string' ? parseFloat(n) : n
  return Number.isFinite(value) ? value : null
}

/**
 * Currency — JOD prefix, full commas, 0 decimals
 * fmtCurrency(1682450)        → 'JOD 1,682,450'
 * fmtCurrency(null)           → '---'
 * fmtCurrency(0)              → 'JOD 0'
 * fmtCurrency(-45200)         → 'JOD -45,200'
 */
export function fmtCurrency(n, currency = 'JOD') {
  const v = toFiniteNumber(n)
  if (v === null) return '---'
  return currency + ' ' + v.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
}

/**
 * Percentage — 1 decimal, % suffix
 * fmtPct(32.8)    → '32.8%'
 * fmtPct(null)    → '---'
 * fmtPct(0)       → '0.0%'
 * Input is display value (32.8 not 0.328)
 */
export function fmtPct(n) {
  const v = toFiniteNumber(n)
  if (v === null) return '---'
  return v.toFixed(1) + '%'
}

/**
 * DSCR — 2 decimals + x suffix
 * fmtDSCR(1.38)   → '1.38x'
 * fmtDSCR(null)   → '---'
 * fmtDSCR(0)      → '0.00x'
 */
export function fmtDSCR(n) {
  const v = toFiniteNumber(n)
  if (v === null) return '---'
  return v.toFixed(2) + 'x'
}

/**
 * Multiple — 2 decimals + x suffix
 * fmtMultiple(2.81)  → '2.81x'
 * fmtMultiple(null)  → '---'
 * fmtMultiple(0)     → '0.00x'
 */
export function fmtMultiple(n) {
  const v = toFiniteNumber(n)
  if (v === null) return '---'
  return v.toFixed(2) + 'x'
}

/**
 * Plain number — full commas, 0 decimals
 * fmtNumber(30956565)  → '30,956,565'
 * fmtNumber(null)      → '---'
 * fmtNumber(0)         → '0'
 * fmtNumber(-1682450)  → '-1,682,450'
 */
export function fmtNumber(n) {
  const v = toFiniteNumber(n)
  if (v === null) return '---'
  return v.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
}

/**
 * IRR — 1 decimal + % suffix
 * Explicit alias for IRR contexts.
 * Accepts string input (engine returns IRR as string).
 * fmtIRR(32.8)    → '32.8%'
 * fmtIRR('32.8')  → '32.8%'
 * fmtIRR(null)    → '---'
 * fmtIRR('N/A')   → '---'
 */
export function fmtIRR(n) {
  const v = toFiniteNumber(n)
  if (v === null) return '---'
  return v.toFixed(1) + '%'
}

// Convenience default export bundling all named exports.
export default {
  fmtCurrency,
  fmtPct,
  fmtDSCR,
  fmtMultiple,
  fmtNumber,
  fmtIRR,
}
