/**
 * pppTax.js — P-028 tax depreciation, loss carry-forward and cash-tax timing
 * ---------------------------------------------------------------------------
 * MODELLING ASSUMPTIONS, NOT CONFIRMED JORDANIAN TAX TREATMENT. The allowable
 * depreciation period depends on asset classification and the project's tax
 * position; loss expiry, payment dates and the tax rate must be confirmed by
 * a tax adviser. Results carry TAX_ASSUMPTIONS_UNCONFIRMED.
 *
 * Calendar: operating period k (0-based from COD) covers months
 * [k·M, (k+1)·M) after COD, M = 12 / periods-per-year. A period's EBITDA and
 * cash interest are spread evenly over its months (the model has no detail
 * within a period). Tax year y = the months up to and including the Tax Year
 * End Month (calendar mode, needs the Construction Start Date) or, without a
 * date, consecutive 12-month years from COD (fallback). First and final
 * tax years may be partial.
 *
 * Depreciation (non-cash, tax only): straight-line from the COD month,
 * cumulative allowance after j months = min(B, B·j / (Life·12)). No
 * depreciation during construction. Any balance left at the concession end
 * is NOT deducted unless a terminal write-off is expressly selected.
 *
 * Tax year y:  TI_y = ΣEBITDA_y − ΣInterest_y − Dep_y (− write-off, final year)
 *   losses: a loss is tagged with its tax year o and may be used in years
 *   o+1 … o+N (oldest first), then expires. No carry-back, no refunds.
 *   TaxExp_y = r2(rate × max(0, TI_y − LossUsed_y))
 * Cash tax: TaxExp_y is paid in the month (tax-year end + lag), in the
 * operating period containing that month; a payment falling after the
 * concession end is paid in the final operating period.
 *
 * No circularity: a tax year is settled at its last contributing period and
 * its payment period is never earlier, so tax paid in period k depends only
 * on EBITDA and interest of periods ≤ k (interest_k = opening balance × rate,
 * known before principal_k).
 *
 * Period tax expense (reporting) allocates each tax year's tax to its
 * periods in proportion to their positive taxable income — a modelling
 * estimate, not an accounting-standard tax provision.
 * ---------------------------------------------------------------------------
 */

function r2(n) { return Math.round(n * 100) / 100 }

// Strict 'YYYY-MM-DD' that is a real calendar date → { year, month, day } | null
export function parseStartDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s).trim())
  if (!m) return null
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3])
  const dt = new Date(Date.UTC(year, month - 1, day))
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null
  return { year, month, day }
}

const monthLabel = idx => Math.floor(idx / 12) + '-' + String((idx % 12) + 1).padStart(2, '0')

// Tax-year structure of the operating periods (independent of debt).
//   nO              operating periods
//   monthsPerPeriod 12 (annual) | 3 (quarterly)
//   codMonthIdx     absolute month index (year·12 + month − 1) of the first
//                   operating month, or null → COD-anniversary fallback
//   yearEndMonth    1–12 (calendar mode)
//   lagMonths       cash payment lag after the tax-year end
export function buildTaxCalendar({ nO, monthsPerPeriod, codMonthIdx, yearEndMonth, lagMonths }) {
  const M = monthsPerPeriod
  const calendar = codMonthIdx !== null && codMonthIdx !== undefined
  const base = calendar ? codMonthIdx : 0
  const keyOf = idx => (calendar
    ? Math.floor(idx / 12) + ((idx % 12) + 1 > yearEndMonth ? 1 : 0)
    : Math.floor((idx - base) / 12))
  const endOf = key => (calendar ? key * 12 + yearEndMonth - 1 : base + 12 * (key + 1) - 1)
  const years = [], byKey = new Map(), periods = []
  for (let k = 0; k < nO; k++) {
    const segs = []
    for (let j = k * M; j < (k + 1) * M; j++) {
      const key = keyOf(base + j)
      let y = byKey.get(key)
      if (!y) {
        y = { seq: years.length, key, firstMonth: j, months: 0, periods: [], lastPeriod: k }
        byKey.set(key, y); years.push(y)
      }
      y.months++; y.lastPeriod = k
      const last = segs[segs.length - 1]
      if (last && last.year === y.seq) last.j1 = j + 1
      else segs.push({ year: y.seq, j0: j, j1: j + 1 })
    }
    segs.forEach(s => { years[s.year].periods.push(k) })
    periods.push({ k, segments: segs })
  }
  const lastOpsPeriod = nO - 1
  years.forEach(y => {
    y.endMonthIdx = endOf(y.key)
    y.payMonthIdx = y.endMonthIdx + lagMonths
    const raw = Math.floor((y.payMonthIdx - base) / M)
    y.payPeriod = Math.min(lastOpsPeriod, raw)
    y.paymentAccelerated = raw > lastOpsPeriod
    y.partial = y.months < 12
    if (y.payPeriod < y.lastPeriod) throw new Error('TAX_TIMING_CIRCULAR: tax year paid before it ends')
  })
  return { calendar, base, monthsPerPeriod: M, nO, years, periods }
}

// Sequential tax state for one run (levered or unlevered). Call step(k, ebitda,
// interest) for k = 0, 1, … in order; it returns the cash tax paid in period k.
//   rate, basis, lifeYears, carryForwardYears (Infinity = unlimited), writeOff
export function createTaxState(cal, { rate, basis, lifeYears, carryForwardYears, writeOff }) {
  const M = cal.monthsPerPeriod
  const lifeMonths = lifeYears * 12
  const cum = j => Math.min(basis, basis * j / lifeMonths)
  const totalOpsMonths = cal.nO * M
  const Y = cal.years.map(() => ({ ebitda: 0, interest: 0, dep: 0, contrib: [] }))
  const vintages = []            // { seq, amount }
  const rows = []                // per-period { dep, taxable, taxPaid }
  const sched = new Array(cal.years.length)
  let next = 0

  function settle(s) {
    const y = cal.years[s], acc = Y[s]
    const final = s === cal.years.length - 1
    const writeOffAmt = final && writeOff ? Math.max(0, basis - cum(totalOpsMonths)) : 0
    const ti = acc.ebitda - acc.interest - acc.dep - writeOffAmt
    const opening = vintages.reduce((a, v) => a + v.amount, 0)
    let expired = 0
    vintages.forEach(v => { if (v.amount > 0 && v.seq + carryForwardYears < s) { expired += v.amount; v.amount = 0 } })
    let used = 0, arising = 0
    if (ti > 0) {
      for (const v of vintages) {
        if (used >= ti) break
        const take = Math.min(v.amount, ti - used)
        v.amount -= take; used += take
      }
    } else if (ti < 0) {
      arising = -ti
      vintages.push({ seq: s, amount: arising })
    }
    const taxable = Math.max(0, ti - used)
    const taxExp = r2(rate * taxable)
    const closing = vintages.reduce((a, v) => a + v.amount, 0)
    sched[s] = {
      tax_year: cal.calendar ? 'FY' + y.key : 'Tax year ' + (s + 1),
      first_month: cal.calendar ? monthLabel(cal.base + y.firstMonth) : null,
      months: y.months, partial: y.partial,
      ebitda: r2(acc.ebitda), interest: r2(acc.interest), depreciation: r2(acc.dep), write_off: r2(writeOffAmt),
      taxable_income: r2(ti),
      losses_opening: r2(opening), losses_expired: r2(expired), losses_arising: r2(arising),
      losses_used: r2(used), losses_closing: r2(closing),
      taxable_after_losses: r2(taxable), tax_expense: taxExp,
      payment_month: cal.calendar ? monthLabel(y.payMonthIdx) : null,
      payment_period: y.payPeriod, payment_accelerated: y.paymentAccelerated,
      // unrounded, for exact identities in tests
      _raw: { ti, opening, expired, arising, used, closing, taxable },
    }
  }

  function step(k, ebitda, interest) {
    if (k !== next) throw new Error('TAX_STATE_ORDER: period ' + k + ' stepped out of order')
    next++
    const per = cal.periods[k]
    let dep = 0, taxable = 0
    per.segments.forEach(sg => {
      const f = (sg.j1 - sg.j0) / M
      const d = cum(sg.j1) - cum(sg.j0)
      const acc = Y[sg.year]
      acc.ebitda += f * ebitda; acc.interest += f * interest; acc.dep += d
      const c = f * (ebitda - interest) - d
      acc.contrib.push({ k, ti: c })
      dep += d; taxable += c
    })
    cal.years.forEach((y, s) => { if (y.lastPeriod === k) settle(s) })
    let paid = 0
    cal.years.forEach((y, s) => { if (y.payPeriod === k) paid += sched[s].tax_expense })
    paid = r2(paid)
    rows.push({ dep, taxable, taxPaid: paid })
    return paid
  }

  // After all periods: per-period tax expense (estimate; see header).
  function finish() {
    if (next !== cal.nO) throw new Error('TAX_STATE_INCOMPLETE')
    const expense = new Array(cal.nO).fill(0)
    sched.forEach((s, i) => {
      const pos = Y[i].contrib.filter(c => c.ti > 0)
      const tot = pos.reduce((a, c) => a + c.ti, 0)
      if (!(s.tax_expense > 0) || !(tot > 0)) return
      let given = 0
      pos.forEach((c, n) => {
        const amt = n === pos.length - 1 ? r2(s.tax_expense - given) : r2(s.tax_expense * c.ti / tot)
        expense[c.k] = r2(expense[c.k] + amt); given = r2(given + amt)
      })
    })
    const unusedAtEnd = vintages.reduce((a, v) => a + v.amount, 0)
    return {
      schedule: sched,
      periods: rows.map((r, k) => ({ dep: r.dep, taxable: r.taxable, taxPaid: r.taxPaid, taxExpense: expense[k] })),
      basis, total_depreciation: cum(totalOpsMonths),
      undepreciated_at_end: Math.max(0, basis - cum(totalOpsMonths)),
      losses_unused_at_end: unusedAtEnd,
      losses_expired_total: sched.reduce((a, s) => a + s._raw.expired, 0),
      payment_accelerated: sched.some(s => s.payment_accelerated),
    }
  }

  return { step, finish }
}
