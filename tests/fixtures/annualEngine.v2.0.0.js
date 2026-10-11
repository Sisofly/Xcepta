// FROZEN REGRESSION ORACLE — PPP engine v2.0.0 exactly as released (git 327d6f5,
// src/modules/feasibility/annualEngine.js). Used only by tests/pppTax.test.js to
// prove 0%-tax and Tax Depreciation = None results are bit-identical. Never edit.
/* eslint-disable */
/**
 * annualEngine.js
 * ---------------------------------------------------------------------------
 * Annual / basic feasibility engine — pure JS, framework-free.
 *
 * Extracted verbatim from src/pages/FeasibilityProject.jsx for testability.
 * Function bodies, signatures, and behavior are byte-identical to the
 * previous inline definitions. No math changes. No new logic.
 *
 * Engines exported:
 *   runEngine(assumptions, defaults)  — Real Estate (Sale / Rental / Mixed)
 *   runPPPEngine(assumptions)         — PPP Availability Payment
 *
 * Helpers exported (used by engines and consumed elsewhere in the app):
 *   getVal, getUnit, getDefault, pppVal, r2
 *   annuity, npvCalc, irrCalc
 *
 * PPP-side helpers exported:
 *   PPP_DSCR_FLOOR, PPP_IRR_HURDLE                      — institutional thresholds
 *   isPPPAvailabilityPayment(project, assumptions)      — PPP-AP project gate
 *   computePPPBankability(modelOutput, dscrFloor)       — derived bankability metrics
 *   computeRequiredPayment(assumptions, targetDSCR)     — DSCR solver
 *
 *   (Previously these lived in FeasibilityProject.jsx; extracted here on
 *   2026-05-15 to make them testable by Jest. Byte-identical move — no
 *   math, signature, or behavior changes.)
 * ---------------------------------------------------------------------------
 * @module annualEngine
 */

function getVal(assumptions, name) {
  var a = assumptions.find(function(a) { return a.name === name })
  return a ? a.value : null
}
function getUnit(assumptions, name) {
  var a = assumptions.find(function(a) { return a.name === name })
  return a ? a.unit : null
}
function getDefault(defaults, key) {
  var d = defaults.find(function(d) { return d.key === key })
  return d ? Number(d.value) : null
}
function annuity(P, r, n) {
  if (!P || P <= 0 || !n || n <= 0) return 0
  if (r === 0) return P / n
  return P * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)
}
function npvCalc(rate, cfs) {
  return cfs.reduce(function(acc, cf, t) { return acc + cf / Math.pow(1 + rate, t) }, 0)
}
function irrCalc(cfs) {
  var hasNeg = cfs.some(function(c) { return c < 0 })
  var hasPos = cfs.some(function(c) { return c > 0 })
  if (!hasNeg || !hasPos) return null
  var rate = 0.15
  for (var i = 0; i < 2000; i++) {
    var npv = 0, dnpv = 0
    for (var t = 0; t < cfs.length; t++) {
      var disc = Math.pow(1 + rate, t)
      npv += cfs[t] / disc
      dnpv -= t * cfs[t] / (disc * (1 + rate))
    }
    if (Math.abs(dnpv) < 1e-12) break
    var next = rate - npv / dnpv
    if (Math.abs(next - rate) < 1e-9) { rate = next; break }
    rate = next
    if (rate <= -0.999 || rate > 50) return null
  }
  if (Math.abs(npvCalc(rate, cfs)) > 10000) return null
  if (rate <= -0.999 || rate > 50) return null
  return rate
}
// P-016: IRR for sub-annual periods. irrCalc (unchanged, used for annual
// models) starts Newton at 15% per PERIOD, which is ~75% p.a. for quarters
// and fails to converge on long quarterly series. This variant starts at
// the periodic equivalent of 15% p.a. and, if Newton fails, brackets the
// root by scanning for an NPV sign change and bisecting. Same acceptance
// test as irrCalc (|NPV| ≤ 10,000 at the solution). Returns the PERIODIC
// rate (caller annualises).
function irrCalcPeriodic(cfs, periodsPerYear) {
  var hasNeg = cfs.some(function(c) { return c < 0 })
  var hasPos = cfs.some(function(c) { return c > 0 })
  if (!hasNeg || !hasPos) return null
  var rate = Math.pow(1.15, 1 / periodsPerYear) - 1
  for (var i = 0; i < 200; i++) {
    var npv = 0, dnpv = 0
    for (var t = 0; t < cfs.length; t++) {
      var disc = Math.pow(1 + rate, t)
      npv += cfs[t] / disc
      dnpv -= t * cfs[t] / (disc * (1 + rate))
    }
    if (Math.abs(dnpv) < 1e-12) break
    var next = rate - npv / dnpv
    if (!(next > -0.999 && next < 10)) break
    if (Math.abs(next - rate) < 1e-12) { rate = next; break }
    rate = next
  }
  if (rate > -0.999 && rate < 10 && Math.abs(npvCalc(rate, cfs)) <= 10000) return rate
  // Bracket and bisect (annual −99% … +1000% expressed per period)
  var lo = Math.pow(0.01, 1 / periodsPerYear) - 1, hi = Math.pow(11, 1 / periodsPerYear) - 1
  var steps = 400, prevR = lo, prevV = npvCalc(lo, cfs)
  for (var k = 1; k <= steps; k++) {
    var r = lo + (hi - lo) * k / steps, v = npvCalc(r, cfs)
    if ((prevV <= 0 && v >= 0) || (prevV >= 0 && v <= 0)) {
      var a = prevR, b = r, fa = prevV
      for (var j = 0; j < 200; j++) {
        var m = (a + b) / 2, fm = npvCalc(m, cfs)
        if ((fa <= 0 && fm <= 0) || (fa >= 0 && fm >= 0)) { a = m; fa = fm } else { b = m }
      }
      var root = (a + b) / 2
      return Math.abs(npvCalc(root, cfs)) <= 10000 ? root : null
    }
    prevR = r; prevV = v
  }
  return null
}

function r2(n) { return Math.round(n * 100) / 100 }

// ─────────────────────────────────────────────────────────────────────────────
// Null-aware numeric helpers (Fix Batch 2A, 2026-05-16)
//
// safeNum:  null/undefined → defaultVal; finite Number → respected (incl. 0);
//           NaN/Infinity/unparseable → defaultVal (more defensive than `||`).
// safePct:  same as safeNum, then ÷100. For percentage-shaped inputs.
//
// Replaces the long-standing `(value || default)` pattern across the engines
// so that an explicit zero is no longer silently collapsed to the default.
// Used by the F08 validation block and the PPP-input derivation in 2A.
// ─────────────────────────────────────────────────────────────────────────────
function safeNum(value, defaultVal) {
  if (value === null || value === undefined) return defaultVal
  var n = Number(value)
  return Number.isFinite(n) ? n : defaultVal
}
function safePct(value, defaultVal) {
  return safeNum(value, defaultVal) / 100
}

function runEngine(assumptions, defaults) {
  var gfa           = getVal(assumptions, 'GFA') || 0

  // ── F08: Capital structure validation (engine-side hardening) ──
  // Raw values respect explicit zero (no falsy-fallback collapse on these
  // two fields specifically) so legitimate 100/0 and 0/100 structures pass.
  // Missing/null fields fall back to 0 to align with UI guard semantics
  // (handleApprove / handleApproveScenario in FeasibilityProject.jsx both
  // treat null as 0). The old internal defaults (30 / 60) summed to only
  // 90%, which was itself a silent funding-gap source — removed by F08.
  // Sum must equal 100% within ±0.01 percentage-points (= 1e-4 fraction;
  // handles 2dp form-input rounding). Wider than the UI guard's 1e-6;
  // UI fires first as a friendly precheck, engine is defense in depth.
  // Refactored to use safeNum in Batch 2A (byte-equivalent for getVal sources).
  var eqNum  = safeNum(getVal(assumptions, 'Equity %'), 0)
  var sdNum  = safeNum(getVal(assumptions, 'Senior Debt %'), 0)
  var subNum = safeNum(getVal(assumptions, 'Subordinated Debt %'), 0)
  var slNum  = safeNum(getVal(assumptions, 'Shareholder Loan %'), 0)
  var capTotal = eqNum + sdNum + subNum + slNum
  if (Math.abs(capTotal - 100) > 0.01) {
    var capErr = new Error(
      'CAPITAL_STRUCTURE_INVALID: Equity % (' + eqNum +
      ') + Senior Debt % (' + sdNum +
      ') + Sub Debt % (' + subNum +
      ') + SHL % (' + slNum +
      ') must sum to 100%; currently sums to ' + capTotal + '%.'
    )
    capErr.code            = 'CAPITAL_STRUCTURE_INVALID'
    capErr.equity_pct      = eqNum
    capErr.senior_debt_pct = sdNum
    capErr.sub_debt_pct    = subNum
    capErr.shl_pct         = slNum
    capErr.sum             = capTotal
    throw capErr
  }
  var equityPct     = eqNum / 100
  var seniorDebtPct = sdNum / 100
  var revenueModel  = getUnit(assumptions, 'Revenue Model') || 'Sale'
  var isSale        = revenueModel === 'Sale'
  var isRental      = revenueModel === 'Rental'
  // F01 (Batch 2C, 2026-05-16): explicit-zero respect on Sale Split % so a
  // legitimate "0% sale = all rental" Mixed-mode project is not silently
  // collapsed to 50/50. Null/undefined still falls back to 50.
  var saleSplit     = isSale ? 1 : isRental ? 0 : safePct(getVal(assumptions, 'Sale Split %'), 50)
  var rentalSplit   = 1 - saleSplit
  var efficiency    = getVal(assumptions, 'Efficiency %')
  efficiency        = efficiency !== null ? efficiency / 100 : 1.0
  var saleableGfa   = gfa * efficiency
  var saleGfa       = saleableGfa * saleSplit
  var rentalGfa     = saleableGfa * rentalSplit
  // F01 (Batch 2C): explicit-zero respect + PROJECT_LIFE_INVALID validator.
  // Null/undefined still defaults to 20. 0 or negative is rejected upfront
  // (deterministic error before any computation runs).
  var lifeYears     = safeNum(getVal(assumptions, 'Project Life Years'), 20)
  if (lifeYears < 1) {
    var plErr = new Error(
      'PROJECT_LIFE_INVALID: Project Life Years must be >= 1; received ' + lifeYears + '.'
    )
    plErr.code  = 'PROJECT_LIFE_INVALID'
    plErr.value = lifeYears
    throw plErr
  }
  var csDate        = getUnit(assumptions, 'Construction Start Date')
  var osDate        = getUnit(assumptions, 'Operations Start Date')
  var constrYrs     = 2
  if (csDate && osDate && csDate.length > 4 && osDate.length > 4) {
    var diff = (new Date(osDate) - new Date(csDate)) / (1000 * 60 * 60 * 24)
    constrYrs = Math.max(1, Math.round(diff / 365))
  }
  var opsYrs = Math.max(1, lifeYears - constrYrs)

  // F01 (Batch 2C, 2026-05-16): explicit-zero respect on all 18 RE defaults.
  // The legacy `(getDefault(...) || X)` pattern silently collapsed an
  // explicit zero in the project defaults table to the engine fallback.
  // After 2C, null/missing keys still fall back to the institutional
  // default below; an explicit zero is respected (e.g. 0% interest for
  // sovereign-backed projects, 0% tax for tax-free zones, 0% land cost
  // for granted/leased land, etc.).
  var constCost   = safeNum(getDefault(defaults, 'construction_cost_per_sqm_residential'), 650)
  var contingency = safeNum(getDefault(defaults, 'contingency_pct'), 0.05)
  var landPct     = safeNum(getDefault(defaults, 'land_cost_pct_of_tdc'), 0.20)
  var salePrice   = safeNum(getDefault(defaults, 'sale_price_per_sqm_residential'), 1200)
  var absRate     = safeNum(getDefault(defaults, 'sales_absorption_rate_pct_per_year'), 0.35)
  var rentYield   = safeNum(getDefault(defaults, 'rental_yield_residential'), 0.06)
  var maxOcc      = safeNum(getDefault(defaults, 'occupancy_rate_stabilized'), 0.88)
  var rentEsc     = safeNum(getDefault(defaults, 'rent_escalation_pct_per_year'), 0.03)
  var priceEsc    = safeNum(getDefault(defaults, 'price_escalation_pa'), 0.025)
  var mgmtFee     = safeNum(getDefault(defaults, 'property_management_fee_pct'), 0.05)
  var maintPct    = safeNum(getDefault(defaults, 'maintenance_cost_pct_of_value'), 0.01)
  var insrPct     = safeNum(getDefault(defaults, 'insurance_pct_of_value'), 0.005)
  var debtRate    = safeNum(getDefault(defaults, 'senior_debt_interest_rate'), 0.085)
  var debtTenor   = safeNum(getDefault(defaults, 'loan_tenor_years'), 15)
  var graceYrs    = safeNum(getDefault(defaults, 'grace_period_years'), 2)
  var taxRate     = safeNum(getDefault(defaults, 'corporate_income_tax_rate'), 0.20)
  var wacc        = safeNum(getDefault(defaults, 'discount_rate_wacc'), 0.12)
  var arrFeeRate  = safeNum(getDefault(defaults, 'debt_arrangement_fee_pct'), 0.01)

  // F01 (Batch 2C): LOAN_TENOR_INVALID validator.
  // Reject zero-tenor loans only when senior debt > 0; zero-tenor with
  // zero debt is harmless because loan-term derivations are inert.
  if (seniorDebtPct > 0 && debtTenor < 1) {
    var ltErr = new Error(
      'LOAN_TENOR_INVALID: Loan tenor must be >= 1 year when senior debt > 0; received ' + debtTenor + '.'
    )
    ltErr.code  = 'LOAN_TENOR_INVALID'
    ltErr.value = debtTenor
    throw ltErr
  }

  var tdc         = gfa * constCost * (1 + contingency)
  var land        = tdc * landPct
  var tpc         = tdc + land
  var equity      = tpc * equityPct
  var debt        = tpc * seniorDebtPct
  var arrFee      = debt * arrFeeRate
  var capFactor   = Math.pow(1 + debtRate, constrYrs)
  var saleDebt    = debt * saleSplit * capFactor
  var rentalDebt  = debt * rentalSplit * capFactor
  var rentalAnnuity = annuity(rentalDebt, debtRate, Math.max(1, debtTenor - graceYrs))
  var assetVal    = gfa * salePrice

  var cfs = [], cfTable = [], dscrSeries = []
  var remSaleGfa = saleGfa, outSale = saleDebt, outRental = rentalDebt

  for (var y = 0; y < constrYrs; y++) {
    var eqCF = y === 0 ? -((equity / constrYrs) + arrFee) : -(equity / constrYrs)
    cfs.push(eqCF)
    cfTable.push({ year: y, phase: 'Construction', revenue: 0, opex: 0, ebitda: 0,
      interest: 0, pbt: 0, tax: 0, net_income: 0, principal: 0,
      capex: r2(tpc / constrYrs), equity_cf: r2(eqCF), dscr: null })
  }

  for (var op = 1; op <= opsYrs; op++) {
    var yr = constrYrs + op - 1
    var hasDebt = outSale > 0.01 || outRental > 0.01
    var saleRev = 0
    if (saleGfa > 0 && remSaleGfa > 0.01) {
      var sold = Math.min(remSaleGfa, saleGfa * absRate)
      saleRev = sold * salePrice * Math.pow(1 + priceEsc, op - 1)
      remSaleGfa = Math.max(0, remSaleGfa - sold)
    }
    var rentRev = 0
    if (rentalGfa > 0) {
      var occ = Math.min(maxOcc, 0.55 + 0.15 * (op - 1))
      var rpsqm = (assetVal / Math.max(gfa, 1)) * rentYield * Math.pow(1 + rentEsc, op - 1)
      rentRev = rentalGfa * rpsqm * occ
    }
    var rev = saleRev + rentRev
    var mgmt = rev * mgmtFee
    var maint = assetVal * (rentalGfa / Math.max(gfa, 1)) * maintPct
    var insr = assetVal * (rentalGfa / Math.max(gfa, 1)) * insrPct
    var opex = mgmt + maint + insr
    var ebitda = rev - opex
    var saleInt = outSale > 0.01 ? outSale * debtRate : 0
    var rentInt = outRental > 0.01 ? outRental * debtRate : 0
    var interest = saleInt + rentInt
    var pbt = ebitda - interest
    var tax = Math.max(0, pbt * taxRate)
    var netInc = pbt - tax
    var salePrin = 0, rentPrin = 0
    if (outSale > 0.01) { salePrin = Math.min(outSale, Math.max(0, netInc)); outSale = Math.max(0, outSale - salePrin) }
    if (outRental > 0.01 && op > graceYrs) { rentPrin = Math.max(0, Math.min(outRental, rentalAnnuity - rentInt)); outRental = Math.max(0, outRental - rentPrin) }
    var principal = salePrin + rentPrin
    var eqCF2 = netInc - principal
    cfs.push(eqCF2)
    var totalDS = interest + principal
    var dscr = (totalDS > 0) ? r2(ebitda / totalDS) : null
    if (hasDebt) dscrSeries.push({ year: op, dscr: dscr })
    cfTable.push({ year: yr, phase: 'Operations', revenue: r2(rev), opex: r2(opex), ebitda: r2(ebitda),
      interest: r2(interest), pbt: r2(pbt), tax: r2(tax), net_income: r2(netInc),
      principal: r2(principal), capex: 0, equity_cf: r2(eqCF2), dscr: dscr })
  }

  var rawIrr = irrCalc(cfs)
  var irr = rawIrr !== null ? r2(rawIrr * 100) : null
  var npv = r2(npvCalc(wacc, cfs))
  var totalIn = Math.abs(cfs.filter(function(c) { return c < 0 }).reduce(function(a, b) { return a + b }, 0))
  var totalOut = cfs.filter(function(c) { return c > 0 }).reduce(function(a, b) { return a + b }, 0)
  var em = totalIn > 0 ? r2(totalOut / totalIn) : null

  return {
    irr, npv, equity_multiple: em,
    tdc: r2(tpc), debt_amount: r2(debt), equity_amount: r2(equity),
    dscr_series: dscrSeries, cash_flows: cfTable,
    construction_years: constrYrs, operations_years: opsYrs
  }
}
// ─────────────────────────────────────────────────────────────────────────────
// PPP AVAILABILITY PAYMENT ENGINE
// ─────────────────────────────────────────────────────────────────────────────
function pppVal(assumptions, name) {
  var a = assumptions.find(function(a) { return a.name === name })
  return a && a.value !== null ? Number(a.value) : null
}

// ───────────────────────────────────────────────────────────────────────────
// PPP roadmap notes — logged 2026-05-24, not implemented.
//
// P-015 (implemented): A — equity-first construction drawdown; C — IDC
//   accrued on the drawn construction balance and capitalized into the
//   COD balance (simulateConstructionFunding / solveConstructionDebt);
//   D — COD conversion to the term loan with an engine-emitted
//   debt_schedule. Note: the earlier claim that IDC explains the Madaba
//   debt gap was disproven on tracing the benchmark workbook — see
//   XCEPTA_GATE1_FINDINGS.md §9.
//
// P-016 (deferred): quarterly periodicity. Engine is currently annual.
//   Quarterly resolution would improve construction interest accrual,
//   pre-completion sales timing (RE side), and DSCR granularity. Out of
//   scope for the current PPP-fix sequence.
//
// Madaba benchmark rate note (input correction, NOT an engine change):
//   Future Madaba benchmark comparison runs should use operating rate 8.3%
//   (6.5% base + 1.8% margin), not 7.0%. The 7.0% in our P-009/P-013 dry-
//   runs was an input error in the test fixture, not an engine defect. No
//   default or rate-handling code in this file should change as a result.
// ───────────────────────────────────────────────────────────────────────────

// ── DSCR-driven debt-sizing helper (P-009 / P-013 fix) ─────────────────────
// Returns the maximum starting debt balance such that, with DSCR-sculpted
// amortization, the schedule fully repays over `repayYears`.
//
// Sculpt rule per post-grace year t:
//   interest_t = outDebt_t × rate
//   tax_t      = max(0, (ebitda − interest_t) × taxRate)     ← tax shield on debt
//   cfads_t    = ebitda − tax_t                              ← post-tax CFADS
//   ds_t       = cfads_t / target                            ← sculpted DS at target DSCR
//   principal_t = ds_t − interest_t                          ← debt reduction
//   outDebt_{t+1} = outDebt_t − principal_t
//
// CFADS depends on tax which depends on interest which depends on outstanding,
// so the equation is implicit. We binary-search the starting debt that drives
// outDebt to 0 at end of repayYears (tolerance: ±1 JOD).
//
// For flat EBITDA (e.g. flat availability payment), this resolves to a
// near-flat debt-service / rising-principal / falling-interest profile —
// exactly what flat-CFADS sculpting should produce.
//
// Edge cases: returns 0 if ebitda, repayYears, or target ≤ 0.
function sculptSupportableDebt(ebitda, taxRate, target, rate, repayYears) {
  if (ebitda <= 0 || repayYears <= 0 || target <= 0) return 0

  // Upper bound: conservative no-shield supportable × 3 (tax shield only adds
  // a few % of capacity; ×3 is a safe ceiling for all realistic inputs).
  var af = (rate === 0) ? repayYears : (1 - Math.pow(1 + rate, -repayYears)) / rate
  var noShieldDebt = ebitda * (1 - taxRate) / target * af
  var lo = 0
  var hi = noShieldDebt * 3 + 1   // +1 to avoid lo==hi at zero-tax extremes

  for (var iter = 0; iter < 100; iter++) {
    var debt = (lo + hi) / 2
    var outDebt = debt
    for (var k = 1; k <= repayYears; k++) {
      var interest = outDebt * rate
      var tax      = Math.max(0, (ebitda - interest) * taxRate)
      var cfads    = ebitda - tax
      var ds       = cfads / target
      var principal = ds - interest   // unconstrained — sign indicates direction
      outDebt = outDebt - principal
    }
    if (outDebt > 1) hi = debt          // residual balance → too much starting debt
    else if (outDebt < -1) lo = debt    // over-repaid → too little starting debt
    else return debt
    if (hi - lo < 0.5) return (lo + hi) / 2
  }
  return (lo + hi) / 2
}

// ── Generic DSCR-constrained debt capacity (P-016 / Phase 3) ───────────────
// Used when operating EBITDA varies across the loan life (escalation,
// revenue profile, seasonality) or when the repayment profile is not
// sculpted. `ebitda[t]` covers the loan life from COD, t = 0 … tenor−1
// (in model periods). Debt D (the COD balance) is feasible when, at the
// target DSCR in EVERY period of the loan life:
//   grace periods       interest_t ≤ CFADS_t / target        (interest only)
//   'sculpted'          principal_t = CFADS_t / target − interest_t ≥ 0 and
//                       the balance is fully repaid by the end of the tenor
//   'annuity'           level debt service (set on the balance at the start
//                       of repayment) ≤ CFADS_t / target
//   'equal_principal'   interest_t + D / repayPeriods ≤ CFADS_t / target
// CFADS_t = EBITDA_t − max(0, (EBITDA_t − interest_t) × tax) depends on D
// through the interest tax shield, so there is no closed form. Feasibility
// is monotone in D (more debt → more interest → less headroom), so the
// largest feasible D is found by bisection. Where CFADS cannot cover the
// required debt service in some period, capacity falls (to zero if need
// be) — the engine never produces a schedule below the target DSCR.
function debtFeasible(D, ebitda, taxRate, target, rate, gracePeriods, repayPeriods, profile) {
  var bal = D, level = 0, eqPrin = 0
  for (var t = 0; t < gracePeriods + repayPeriods; t++) {
    if (bal <= 1e-9) return true
    var interest = bal * rate
    var cfads    = ebitda[t] - Math.max(0, (ebitda[t] - interest) * taxRate)
    var allowed  = cfads / target
    var tol      = 1e-9 * Math.max(1, Math.abs(allowed))
    if (t < gracePeriods) {
      if (interest > allowed + tol) return false
      continue
    }
    if (t === gracePeriods) {
      level  = annuity(bal, rate, repayPeriods)
      eqPrin = bal / repayPeriods
    }
    var principal
    if (profile === 'annuity') {
      if (level > allowed + tol) return false
      principal = level - interest
    } else if (profile === 'equal_principal') {
      if (interest + eqPrin > allowed + tol) return false
      principal = eqPrin
    } else {
      principal = allowed - interest
      if (principal < -tol) return false
    }
    bal -= Math.min(Math.max(0, principal), bal)
  }
  return bal <= 0.005
}

function solveSupportableDebtGeneric(ebitda, taxRate, target, rate, gracePeriods, repayPeriods, profile) {
  if (repayPeriods <= 0 || target <= 0) return 0
  var hi = 1
  for (var t = 0; t < gracePeriods + repayPeriods; t++) hi += Math.max(0, ebitda[t]) / target
  if (!debtFeasible(0.01, ebitda, taxRate, target, rate, gracePeriods, repayPeriods, profile)) return 0
  var lo = 0
  for (var i = 0; i < 200 && hi - lo > 0.005; i++) {
    var mid = (lo + hi) / 2
    if (debtFeasible(mid, ebitda, taxRate, target, rate, gracePeriods, repayPeriods, profile)) lo = mid
    else hi = mid
  }
  return lo
}

// ── Construction funding with IDC (P-015A + P-015C) ────────────────────────
// Simulates the equity-first construction waterfall for a given total of
// PRINCIPAL debt draws and returns the per-year funding rows plus the
// capitalized interest and the COD balance.
//
// Conventions (per model period — year or quarter; FINDINGS §9.3, §11):
//   • Base capex (TPC) follows capexByPeriod: even across construction
//     periods by default, or the user's Construction Cost Profile.
//   • Equity first: each period draws equity up to the remaining equity
//     budget (TPC − principal), then debt principal for the balance.
//   • Draws are assumed to occur evenly through the period, so a period's
//     new draw accrues on average half a period of interest:
//         idc_t = periodRate × (opening_t + ½ × draw_t)
//     opening_t already contains prior periods' capitalized IDC, so IDC
//     compounds once per period.
//   • IDC is capitalized (added to the loan balance), not paid in cash and
//     not charged to equity:  closing_t = opening_t + draw_t + idc_t.
//   • COD balance = Σ principal draws + Σ IDC = operations opening balance.
function simulateConstructionFunding(capexByPeriod, tpc, principalTotal, constrRate) {
  var eqLeft    = Math.max(0, tpc - principalTotal)
  var opening   = 0
  var idcTotal  = 0
  var rows      = []
  for (var y = 0; y < capexByPeriod.length; y++) {
    var capex    = capexByPeriod[y]
    var eqDraw   = Math.min(capex, eqLeft)
    var debtDraw = capex - eqDraw
    eqLeft      -= eqDraw
    var idc      = constrRate * (opening + 0.5 * debtDraw)
    var closing  = opening + debtDraw + idc
    rows.push({ capex: capex, equity_draw: eqDraw, debt_draw: debtDraw,
                opening: opening, idc: idc, closing: closing })
    idcTotal += idc
    opening   = closing
  }
  return { rows: rows, idcTotal: idcTotal, codBalance: opening }
}

// Solves the principal draw total P such that the COD balance P + IDC(P)
// respects every debt-capacity constraint (P-015C):
//   (a) COD balance ≤ supportable (DSCR-sculpted capacity at COD — this is
//       independent of IDC because it depends only on operating CFADS,
//       rate, tenor and target DSCR);
//   (b) COD balance ≤ Debt % × total funding requirement (TPC + IDC);
//   (c) P ≤ TPC (principal cannot fund more than the base project cost).
// IDC(P) is increasing in P, so headroom(P) = cap(P) − (P + IDC(P)) is
// strictly decreasing and the largest feasible P is found by bisection.
// No circular reference or plug: IDC is recomputed from the draws at each
// candidate P. With constrRate = 0 this reduces exactly to the pre-IDC
// sizing min(supportable, Debt % × TPC, TPC).
function solveConstructionDebt(capexByPeriod, tpc, constrRate, debtPct, supportable) {
  function headroom(P) {
    var sim = simulateConstructionFunding(capexByPeriod, tpc, P, constrRate)
    var cap = Math.min(supportable, debtPct * (tpc + sim.idcTotal))
    return cap - sim.codBalance
  }
  if (tpc <= 0 || supportable <= 0 || debtPct <= 0) return 0
  if (headroom(tpc) >= 0) return tpc
  var lo = 0, hi = tpc
  for (var i = 0; i < 200 && hi - lo > 1e-4; i++) {
    var mid = (lo + hi) / 2
    if (headroom(mid) >= 0) lo = mid
    else hi = mid
  }
  return lo
}

// ─────────────────────────────────────────────────────────────────────────────
// PPP INPUTS, VALIDATION (blocking) AND OUTPUT SANITY CONTROLS (P-023)
// ─────────────────────────────────────────────────────────────────────────────
// Blocking errors are reserved for inputs that are mathematically invalid,
// incomplete, or that would make the outputs demonstrably unreliable. They
// throw an Error whose message starts with, and whose `.code` equals, a
// stable machine-readable code. Economically unusual but possible results
// never block: they are returned as `warnings` (see computePPPWarnings).
function pppInputError(code, message, extra) {
  var e = new Error(code + ': ' + message)
  e.code = code
  if (extra) Object.keys(extra).forEach(function(k) { e[k] = extra[k] })
  return e
}

// ── F02 (Batch 2A, 2026-05-16): explicit-zero respect on PPP inputs ──
// safeNum/safePct distinguish missing/null (→ default) from explicit zero
// (→ respected). TPC and Annual Availability Payment default to 0 when
// missing; P-023 then rejects a missing/zero TPC explicitly.
function readPPPInputs(assumptions) {
  var inp = {
    tpc:            safeNum(pppVal(assumptions, 'Total Project Cost'), 0),
    debtPct:        safePct(pppVal(assumptions, 'Debt %'), 80),
    equityPct:      safePct(pppVal(assumptions, 'Equity %'), 20),
    annualPayment:  safeNum(pppVal(assumptions, 'Annual Availability Payment'), 0),
    concessionYrs:  safeNum(pppVal(assumptions, 'Concession Period'), 25),
    constrMonths:   safeNum(pppVal(assumptions, 'Construction Period'), 24),
    opexPct:        safePct(pppVal(assumptions, 'OPEX % of Revenue'), 5),
    opexFixed:      pppVal(assumptions, 'OPEX Amount (JOD)'),
    interestRate:   safePct(pppVal(assumptions, 'Interest Rate'), 7),
    loanTenorYrs:   safeNum(pppVal(assumptions, 'Loan Tenor'), 10),
    gracePeriodYrs: safeNum(pppVal(assumptions, 'Grace Period'), 2),
    taxRate:        safePct(pppVal(assumptions, 'Tax Rate'), 20),
    wacc:           safePct(pppVal(assumptions, 'WACC'), 10),
    // P-009 / P-013: Target DSCR is the sizing constraint. Default 1.20
    // mirrors the institutional DSCR floor (PPP_DSCR_FLOOR).
    targetDSCR:     safeNum(pppVal(assumptions, 'Target DSCR'), PPP_DSCR_FLOOR),
    // P-018: the underwriting (lender acceptance) threshold is distinct from
    // the sculpting target. Default = PPP_DSCR_FLOOR (1.20×).
    underwritingDSCR: safeNum(pppVal(assumptions, 'Lender Minimum DSCR'), PPP_DSCR_FLOOR),
    debtPctGiven:   pppVal(assumptions, 'Debt %') !== null,
    equityPctGiven: pppVal(assumptions, 'Equity %') !== null,
  }
  // P-015C: construction-period (IDC) rate; defaults to the operating rate
  // (single-facility assumption). Explicit 0 is respected.
  inp.constrRate = safePct(pppVal(assumptions, 'Construction Interest Rate'), inp.interestRate * 100)
  // F09: OPEX Amount = 0 means fixed zero opex; null falls through to %.
  inp.useFixedOpex = inp.opexFixed !== null

  // ── P-016 / Phase 3 optional inputs. All default to the pre-existing
  // behaviour (annual, flat revenue and opex, even capex, sculpted debt),
  // so existing projects calculate exactly as before.
  var periodicity = (pppText(assumptions, 'Model Periodicity') || 'Annual').toLowerCase()
  inp.periodicityRaw  = periodicity
  inp.periodsPerYear  = periodicity === 'quarterly' ? 4 : periodicity === 'annual' ? 1 : NaN
  inp.apEscalation    = safePct(pppVal(assumptions, 'Availability Payment Escalation %'), 0)
  inp.opexEscalation  = safePct(pppVal(assumptions, 'OPEX Escalation %'), 0)
  inp.revenueProfile  = parseNumberList(pppText(assumptions, 'Revenue Profile'))
  inp.revenueBasis    = pppText(assumptions, 'Revenue Basis') || 'Contractual'
  inp.constrProfile   = parseNumberList(pppText(assumptions, 'Construction Cost Profile'))
  inp.quarterWeights  = parseNumberList(pppText(assumptions, 'Quarterly Revenue Weights'))
  var rp = (pppText(assumptions, 'Repayment Profile') || 'Sculpted').toLowerCase().replace(/\s+/g, '_')
  inp.repaymentProfile = rp
  return inp
}

// Text-valued assumptions are stored in `unit` with value null (the app's
// convention for Contract Model, Revenue Model, …); a string `value` is
// also accepted.
function pppText(assumptions, name) {
  var a = assumptions.find(function(x) { return x.name === name })
  if (!a) return null
  if (typeof a.value === 'string' && a.value.trim() !== '') return a.value.trim()
  if (typeof a.unit === 'string' && a.unit.trim() !== '') return a.unit.trim()
  return null
}

// "10, 20, 30" → [10, 20, 30]; null when absent; NaN entries kept so that
// validation can reject them explicitly.
function parseNumberList(text) {
  if (text === null || text === undefined) return null
  var parts = String(text).split(/[,;\s]+/).filter(function(s) { return s !== '' })
  if (!parts.length) return null
  return parts.map(function(s) { return Number(s.replace(/%$/, '')) })
}

function validatePPPInputs(inp) {
  function pct01(name, v, maxExclusive) {
    if (!Number.isFinite(v) || v < 0 || (maxExclusive ? v >= 1 : v > 1)) {
      throw pppInputError('INPUT_OUT_OF_RANGE',
        name + ' must be between 0% and ' + (maxExclusive ? 'below ' : '') + '100%; received ' + r2(v * 100) + '%.',
        { field: name, value: v * 100 })
    }
  }
  if (!(inp.tpc > 0)) {
    throw pppInputError('TOTAL_PROJECT_COST_INVALID',
      'Total Project Cost must be a positive amount; received ' + inp.tpc + '.', { value: inp.tpc })
  }
  if (inp.annualPayment < 0) {
    throw pppInputError('AVAILABILITY_PAYMENT_INVALID',
      'Annual Availability Payment cannot be negative; received ' + inp.annualPayment + '.', { value: inp.annualPayment })
  }
  if (inp.useFixedOpex && !(Number(inp.opexFixed) >= 0)) {
    throw pppInputError('OPEX_AMOUNT_INVALID',
      'OPEX Amount (JOD) cannot be negative; received ' + inp.opexFixed + '.', { value: inp.opexFixed })
  }
  pct01('Debt %', inp.debtPct)
  pct01('Equity %', inp.equityPct)
  pct01('OPEX % of Revenue', inp.opexPct)
  pct01('Tax Rate', inp.taxRate, true)
  if (!(inp.interestRate >= 0 && inp.interestRate <= 1) || !(inp.constrRate >= 0 && inp.constrRate <= 1)) {
    throw pppInputError('INTEREST_RATE_INVALID',
      'Interest rates must be between 0% and 100% p.a.; received operating ' + r2(inp.interestRate * 100) +
      '%, construction ' + r2(inp.constrRate * 100) + '%.')
  }
  if (!(inp.wacc > -1 && inp.wacc <= 1)) {
    throw pppInputError('DISCOUNT_RATE_INVALID',
      'WACC must be greater than −100% and at most 100%; received ' + r2(inp.wacc * 100) + '%.', { value: inp.wacc * 100 })
  }
  if (!(inp.underwritingDSCR >= 1)) {
    throw pppInputError('UNDERWRITING_DSCR_INVALID',
      'Lender Minimum DSCR must be at least 1.00× (below 1.00× debt service exceeds available cash flow); received ' +
      inp.underwritingDSCR + '.', { value: inp.underwritingDSCR })
  }
  if (!(inp.targetDSCR >= 0)) {
    throw pppInputError('TARGET_DSCR_INVALID',
      'Target DSCR cannot be negative; received ' + inp.targetDSCR + '.', { value: inp.targetDSCR })
  }
  // ── F02 validation: Concession Period and Construction Period must be ≥ 1 ──
  if (inp.concessionYrs < 1) {
    throw pppInputError('CONCESSION_PERIOD_INVALID',
      'Concession Period must be >= 1 year; received ' + inp.concessionYrs + '.', { value: inp.concessionYrs })
  }
  if (inp.constrMonths < 1) {
    throw pppInputError('CONSTRUCTION_PERIOD_INVALID',
      'Construction Period must be >= 1 month; received ' + inp.constrMonths + '.', { value: inp.constrMonths })
  }
  // ── P-016 / Phase 3 inputs ──
  if (!(inp.periodsPerYear === 1 || inp.periodsPerYear === 4)) {
    throw pppInputError('MODEL_PERIODICITY_INVALID',
      'Model Periodicity must be Annual or Quarterly; received "' + inp.periodicityRaw + '".')
  }
  ;[['Availability Payment Escalation %', inp.apEscalation], ['OPEX Escalation %', inp.opexEscalation]]
    .forEach(function(e) {
      if (!(e[1] > -1 && e[1] <= 1)) {
        throw pppInputError('ESCALATION_INVALID',
          e[0] + ' must be greater than −100% and at most 100% per year; received ' + r2(e[1] * 100) + '%.',
          { field: e[0], value: e[1] * 100 })
      }
    })
  if (['sculpted', 'annuity', 'equal_principal'].indexOf(inp.repaymentProfile) < 0) {
    throw pppInputError('REPAYMENT_PROFILE_INVALID',
      'Repayment Profile must be Sculpted, Annuity or Equal Principal; received "' + inp.repaymentProfile + '".')
  }
  if (['contractual', 'demand estimate'].indexOf(String(inp.revenueBasis).toLowerCase()) < 0) {
    throw pppInputError('REVENUE_BASIS_INVALID',
      'Revenue Basis must be Contractual or Demand Estimate; received "' + inp.revenueBasis + '".')
  }
  // ── P-025: whole model periods. A fractional concession/tenor/grace was
  // previously floored silently (e.g. 9.5 → 9). Annual models need whole
  // years; quarterly models need whole quarters (multiples of 0.25 yrs).
  var ppy = inp.periodsPerYear
  function whole(name, v) {
    if (Math.abs(v * ppy - Math.round(v * ppy)) > 1e-9) {
      throw pppInputError(ppy === 1 ? 'PERIOD_NOT_WHOLE_YEARS' : 'PERIOD_NOT_WHOLE_QUARTERS',
        name + (ppy === 1
          ? ' must be a whole number of years in an annual model; received ' + v + '. Use whole years (or quarterly periodicity for quarter-year terms).'
          : ' must be a whole number of quarters (a multiple of 0.25 years) in a quarterly model; received ' + v + '.'),
        { field: name, value: v })
    }
  }
  whole('Concession Period', inp.concessionYrs)
  function listOk(list) {
    return list.every(function(x) { return Number.isFinite(x) && x >= 0 }) &&
           list.reduce(function(s, x) { return s + x }, 0) > 0
  }
  if (inp.revenueProfile) {
    if (Math.abs(inp.concessionYrs - Math.round(inp.concessionYrs)) > 1e-9 ||
        inp.revenueProfile.length !== Math.round(inp.concessionYrs) ||
        !inp.revenueProfile.every(function(x) { return Number.isFinite(x) && x >= 0 })) {
      throw pppInputError('REVENUE_PROFILE_INVALID',
        'Revenue Profile must list one non-negative annual revenue per operating year (' + inp.concessionYrs +
        ' values for the concession); received ' + inp.revenueProfile.length + ' value(s).',
        { expected: inp.concessionYrs, received: inp.revenueProfile.length })
    }
  }
  if (inp.constrProfile) {
    var nC = Math.max(1, Math.ceil(inp.constrMonths / (12 / ppy)))
    if (inp.constrProfile.length !== nC || !listOk(inp.constrProfile)) {
      throw pppInputError('CONSTRUCTION_PROFILE_INVALID',
        'Construction Cost Profile must list ' + nC + ' non-negative weights (one per construction ' +
        (ppy === 1 ? 'year' : 'quarter') + ') with a positive total; received ' + inp.constrProfile.length + '.',
        { expected: nC, received: inp.constrProfile.length })
    }
  }
  if (inp.quarterWeights && ppy === 4 && (inp.quarterWeights.length !== 4 || !listOk(inp.quarterWeights))) {
    throw pppInputError('QUARTERLY_WEIGHTS_INVALID',
      'Quarterly Revenue Weights must list 4 non-negative weights with a positive total; received ' +
      inp.quarterWeights.length + '.')
  }
  // ── P-024: debt maturity must fall within the concession ──
  // Tenor is measured from COD (P-015D), grace years are part of the tenor,
  // and the concession (operations period) also starts at COD. So:
  //   loan maturity      = COD + tenor        = project year constrYears + tenor
  //   concession expiry  = COD + concession   = project year constrYears + concession
  // A loan that matures after expiry would be sized on cash flows the SPV
  // never receives and leave principal outstanding at hand-back. The engine
  // rejects such terms rather than shortening them: the user must correct
  // the financing assumptions. Only enforced when debt is requested.
  if (inp.debtPct > 0) {
    var constrYears = Math.max(1, Math.ceil(inp.constrMonths / 12))
    var tenor = inp.loanTenorYrs, grace = inp.gracePeriodYrs, conc = inp.concessionYrs
    if (tenor < 1) {
      throw pppInputError('LOAN_TENOR_INVALID',
        'Loan Tenor must be at least 1 year when Debt % > 0; received ' + tenor + '.', { value: tenor })
    }
    if (grace < 0 || grace >= tenor) {
      throw pppInputError('GRACE_PERIOD_INVALID',
        'Grace Period (' + grace + ' yrs) must be ≥ 0 and shorter than the Loan Tenor (' + tenor +
        ' yrs), otherwise the loan has no repayment period.', { value: grace })
    }
    whole('Loan Tenor', tenor)
    whole('Grace Period', grace)
    if (tenor > conc) {
      throw pppInputError('LOAN_MATURITY_EXCEEDS_CONCESSION',
        'the loan matures ' + tenor + ' yrs after COD (project year ' + (constrYears + tenor) + ' incl. ' +
        constrYears + ' construction yrs), but the concession expires ' + conc + ' yrs after COD (project year ' +
        (constrYears + conc) + '). Reduce the Loan Tenor (including the ' + grace + '-yr grace period) to at most ' +
        conc + ' yrs, or extend the Concession Period.',
        { loan_tenor: tenor, concession: conc, construction: constrYears })
    }
  }
}

// ── P-023: output reconciliation gate ─────────────────────────────────────
// Re-checks the funding and debt identities on the finished result. A
// failure means the outputs are demonstrably unreliable, so the engine
// throws rather than returning numbers that do not reconcile. Returns the
// measured differences for audit (persisted with the result, P-022).
function checkPPPIntegrity(result, inp) {
  var rows   = result.cash_flows
  var sched  = result.debt_schedule
  var constr = rows.filter(function(r) { return r.phase === 'Construction' })
  var sumC   = function(k) { return constr.reduce(function(s, r) { return s + (r[k] || 0) }, 0) }
  var tol    = Math.max(1, 0.01 * rows.length)
  var sourcesUses = sumC('equity_draw') + sumC('debt_draw') + sumC('idc') - (inp.tpc + result.idc_capitalized)
  var codDiff     = result.debt_amount - (result.debt_sizing.principal_drawn + result.idc_capitalized)
  var maxGap = 0
  ;[sched, result.debt_schedule_periodic || []].forEach(function(sc) {
    for (var i = 0; i < sc.length; i++) {
      var s = sc[i]
      maxGap = Math.max(maxGap, Math.abs(s.closing - (s.opening + s.draw + s.idc - s.principal)))
      if (i > 0) maxGap = Math.max(maxGap, Math.abs(s.opening - sc[i - 1].closing))
    }
  })
  // Annual rows of a quarterly model are sums of 2-dp rows: widen the
  // tolerance by the number of periods aggregated.
  if (result.periods_per_year > 1) tol = Math.max(tol, 0.01 * (result.debt_schedule_periodic || []).length)
  var finalBalance = sched.length ? sched[sched.length - 1].closing : 0
  var finalTol     = Math.max(2, tol)
  var failures = []
  if (Math.abs(sourcesUses) > tol)   failures.push('sources ≠ uses by ' + r2(sourcesUses))
  if (Math.abs(codDiff) > tol)       failures.push('COD debt ≠ principal + IDC by ' + r2(codDiff))
  if (maxGap > tol)                  failures.push('debt roll-forward breaks by ' + r2(maxGap))
  if (Math.abs(finalBalance) > finalTol) failures.push('debt not repaid by concession expiry (residual ' + r2(finalBalance) + ')')
  if (failures.length) {
    throw pppInputError('OUTPUT_RECONCILIATION_FAILED',
      'the calculated schedules do not reconcile: ' + failures.join('; ') + '. Results withheld.',
      { failures: failures })
  }
  return {
    passed: true,
    sources_uses_diff: r2(sourcesUses),
    cod_diff: r2(codDiff),
    max_rollforward_gap: r2(maxGap),
    final_balance: r2(finalBalance),
    tolerance: tol,
  }
}

// ── P-023: reasonableness warnings ─────────────────────────────────────────
// Invariant-ratio checks that hold across sectors and deal sizes. They flag
// results that are possible but economically suspicious (typically an input
// scaling error) and never change or block the result. Severity:
//   'warning' — likely input error or unreliable metric, review before use
//   'info'    — material modelling outcome the user should be aware of
function computePPPWarnings(result, inp) {
  var w = []
  function add(code, severity, message, value) {
    w.push({ code: code, severity: severity, message: message, value: value === undefined ? null : value })
  }
  var ops   = result.cash_flows.filter(function(r) { return r.phase === 'Operations' })
  var debt  = result.debt_amount
  var ds    = result.debt_sizing
  var fmt   = function(n) { return Math.round(n).toLocaleString('en-US') }

  var peakRevenue = ops.reduce(function(m, r) { return Math.max(m, r.revenue) }, 0)
  if (peakRevenue > inp.tpc) {
    add('POSSIBLE_INPUT_SCALE_ERROR', 'warning',
      'Annual revenue (peak ' + fmt(peakRevenue) + ') exceeds Total Project Cost (' + fmt(inp.tpc) +
      '). Check both are entered in the same units (e.g. missing zeros).', peakRevenue / inp.tpc)
  }
  // Item 4 (scope): tax depreciation and loss carry-forward are not modelled.
  // For taxable projects this overstates tax, so CFADS, debt capacity and
  // equity returns are understated (conservative) — material in magnitude
  // (e.g. +1.3pp to +6.3pp equity IRR on tested cases). Always disclosed.
  if (inp.taxRate > 0 && ops.some(function(r) { return r.tax > 0 })) {
    add('TAX_DEPRECIATION_NOT_MODELLED', 'warning',
      'Tax is charged on EBITDA less interest with no tax depreciation of the project cost and no loss carry-forward. ' +
      'Tax is therefore overstated: CFADS, debt capacity and equity returns are understated (conservative) for this taxable project.',
      inp.taxRate * 100)
  }
  if (result.revenue_basis === 'demand_estimate') {
    add('DEMAND_REVENUE_ESTIMATE', 'info',
      'Revenue is an estimate of demand, not a contractual payment: debt capacity and returns depend on traffic/usage ' +
      'forecasts. Lenders typically require higher DSCRs and downside sensitivities for demand risk.', null)
  }
  if (inp.quarterWeights && inp.periodsPerYear === 1) {
    add('QUARTERLY_WEIGHTS_IGNORED', 'info',
      'Quarterly Revenue Weights are ignored in an annual model.', null)
  }
  var ebitda0 = ops.length ? ops[0].ebitda : 0
  if (ops.length && ops.every(function(r) { return r.ebitda <= 0 })) {
    add('NON_POSITIVE_EBITDA', 'warning',
      'Operating EBITDA is zero or negative in every year (revenue does not cover operating costs).', ebitda0)
  }
  if (debt > 0.01) {
    if (inp.interestRate < 0.005) {
      add('INTEREST_COST_IMPLAUSIBLY_LOW', 'warning',
        'Debt interest rate is ' + r2(inp.interestRate * 100) + '% p.a. (below 0.5%). Check the rate was entered ' +
        'as a percentage (e.g. 7 for 7%).', inp.interestRate * 100)
    }
    var maxDS = ops.reduce(function(m, r) { return Math.max(m, r.interest + r.principal) }, 0)
    if (maxDS / debt < 0.01) {
      add('DEBT_SERVICE_IMPLAUSIBLY_LOW', 'warning',
        'Peak annual debt service is ' + r2(maxDS / debt * 100) + '% of the debt (below 1%).', maxDS / debt)
    }
  }
  if (ds.min_dscr !== null && ds.min_dscr > 20) {
    add('DSCR_EXTREME', 'warning', 'Minimum DSCR is ' + ds.min_dscr + '× (above 20×). Check revenue and debt inputs.', ds.min_dscr)
  }
  if (result.equity_multiple !== null && result.equity_multiple > 50) {
    add('EQUITY_MULTIPLE_EXTREME', 'warning', 'Equity multiple is ' + result.equity_multiple + '× (above 50×).', result.equity_multiple)
  }
  if (result.irr !== null && result.irr > 100) {
    add('IRR_EXTREME', 'warning', 'Equity IRR is ' + result.irr + '% (above 100%). Check input scaling.', result.irr)
  }
  if (result.irr === null) {
    add('IRR_NOT_COMPUTABLE', 'warning',
      'Equity IRR could not be computed (the equity cash flows have no sign change or no convergent solution). ' +
      'Rely on NPV and equity multiple.', null)
  }
  var invested = -result.cash_flows.filter(function(r) { return r.phase === 'Construction' })
    .reduce(function(s, r) { return s + r.equity_cf }, 0)
  if (invested > 0 && ops.length && ops[0].equity_cf >= invested) {
    add('PAYBACK_UNDER_ONE_YEAR', 'warning',
      'Equity is paid back within the first operating year, which is implausible for a PPP. Check input scaling.', null)
  }
  // P-018: sculpting target vs underwriting threshold
  var uw = inp.underwritingDSCR
  if (inp.targetDSCR > 0 && inp.targetDSCR < uw) {
    add('SCULPT_TARGET_BELOW_UNDERWRITING', 'warning',
      'Debt is sculpted to a ' + inp.targetDSCR.toFixed(2) + '× DSCR target, below the ' + uw.toFixed(2) + '× lender minimum (underwriting) ' +
      'threshold: the project will not meet underwriting coverage at this debt size.', inp.targetDSCR)
  }
  if (ds.min_dscr !== null && ds.min_dscr < uw) {
    add('DSCR_BELOW_UNDERWRITING', 'warning',
      'Minimum ' + ds.dscr_basis + ' DSCR ' + ds.min_dscr.toFixed(2) + '× is below the ' + uw.toFixed(2) + '× lender minimum (underwriting) threshold.', ds.min_dscr)
  }
  if (inp.targetDSCR === 0) {
    add('NO_DSCR_CONSTRAINT', 'warning',
      'Target DSCR is 0, so debt is not limited by cash flow: Debt % alone sets the debt amount.', 0)
  } else if (inp.targetDSCR < 1) {
    add('TARGET_DSCR_BELOW_ONE', 'warning',
      'Target DSCR ' + inp.targetDSCR + '× is below 1.00×: debt service is sized above available cash flow.', inp.targetDSCR)
  }
  if (inp.debtPct > 0 && debt <= 0.01) {
    add('NO_DEBT_CAPACITY', 'warning',
      'Operating cash flows cannot support any debt at the target DSCR; the project is modelled as fully equity-funded.', 0)
  } else if (ds.binding_constraint === 'dscr') {
    add('DEBT_LIMITED_BY_DSCR', 'info',
      'Requested debt (' + fmt(ds.requested_debt) + ') exceeds what CFADS supports at ' + ds.target_dscr +
      '× DSCR (' + fmt(ds.supportable_debt) + '). Debt was reduced and equity increased by ' +
      fmt(ds.debt_shortfall) + '.', ds.debt_shortfall)
  }
  if (inp.debtPctGiven && inp.equityPctGiven && Math.abs((inp.debtPct + inp.equityPct) * 100 - 100) > 0.01) {
    add('INPUT_GEARING_NOT_100', 'info',
      'Debt % (' + r2(inp.debtPct * 100) + ') + Equity % (' + r2(inp.equityPct * 100) + ') ≠ 100%. Debt % is the ' +
      'requested gearing; equity is calculated as the balancing item, so the Equity % input is informational only.', null)
  }
  return w
}

// ─────────────────────────────────────────────────────────────────────────────
// runPPPEngine — period-based PPP availability-payment engine
// ─────────────────────────────────────────────────────────────────────────────
// Periodicity (P-016): every calculation runs on model periods — years
// (p = 1, default) or quarters (p = 4). Annual inputs are applied as
// follows (FINDINGS §11.2):
//   • Interest rates (operating, construction) are NOMINAL annual rates:
//     periodic rate = annual / p, applied to the opening balance.
//   • WACC is an EFFECTIVE annual rate: periodic = (1 + WACC)^(1/p) − 1.
//   • Equity IRR is solved on the periodic equity cash flows and reported
//     as an effective annual rate: (1 + periodic IRR)^p − 1.
//   • Escalation (AP, OPEX) is an annual step: operating year k (k = 1 at
//     COD) carries (1 + g)^(k − 1); it is not compounded within a year.
//   • Revenue within a year follows Quarterly Revenue Weights when given
//     (contractual timing / seasonality), otherwise equal instalments.
//     Fixed OPEX is spread evenly; % OPEX follows revenue.
//   • Construction capex follows the Construction Cost Profile per period
//     when given, otherwise it is spread evenly.
//   • Tax is charged per period on period profit (no loss carry-forward,
//     unchanged from the annual engine).
// Annual reporting (cash_flows, debt_schedule, dscr_series) for a quarterly
// model aggregates the quarters: flows are summed; balances (stocks) take
// the opening of the first and the closing of the last quarter; the annual
// DSCR is Σ CFADS / Σ debt service. Construction years are counted from
// financial close and operating years from COD; a partial final
// construction year is its own row. Quarterly detail is returned in
// cash_flows_periodic / debt_schedule_periodic.
//
// With p = 1 and no optional inputs, every arithmetic step (including the
// 2-dp rounding sequence) is the same as the pre-P-016 annual engine.
function runPPPEngine(assumptions) {
  var inp = readPPPInputs(assumptions)
  validatePPPInputs(inp)
  var p               = inp.periodsPerYear
  var tpc             = inp.tpc
  var debtPct         = inp.debtPct
  var equityPct       = inp.equityPct
  var annualPayment   = inp.annualPayment
  var concessionYrs   = inp.concessionYrs
  var constrMonths    = inp.constrMonths
  var opexPct         = inp.opexPct
  var interestRate    = inp.interestRate
  var loanTenorYrs    = inp.loanTenorYrs
  var gracePeriodYrs  = inp.gracePeriodYrs
  var taxRate         = inp.taxRate
  var wacc            = inp.wacc
  var targetDSCR      = inp.targetDSCR
  var constrRate      = inp.constrRate
  var opexFixed       = inp.opexFixed
  var useFixedOpex    = inp.useFixedOpex
  var profile         = inp.repaymentProfile

  var constrYears   = Math.max(1, Math.ceil(constrMonths / 12))
  var opsYears      = Math.max(1, concessionYrs)  // concession = service/operations period; total life = construction + operations
  var nC            = p === 1 ? constrYears : Math.max(1, Math.ceil(constrMonths / 3))
  var nO            = Math.round(opsYears * p)
  var gracePeriods  = Math.round(gracePeriodYrs * p)
  var repayPeriods  = Math.max(0, Math.round(loanTenorYrs * p) - gracePeriods)
  var repayYears    = Math.max(0, loanTenorYrs - gracePeriodYrs)
  var rateP         = p === 1 ? interestRate : interestRate / p
  var constrRateP   = p === 1 ? constrRate : constrRate / p
  var weights       = p === 1 ? [1] : normaliseWeights(inp.quarterWeights || [1, 1, 1, 1])

  // ── Operating EBITDA by period (independent of debt) ──
  function annualRevenue(opYear) {
    return inp.revenueProfile ? inp.revenueProfile[opYear - 1]
      : annualPayment * Math.pow(1 + inp.apEscalation, opYear - 1)
  }
  function periodRevenue(q) {                         // q = 1 … nO
    var opYear = Math.ceil(q / p)
    return p === 1 ? annualRevenue(opYear) : annualRevenue(opYear) * weights[(q - 1) % p]
  }
  function periodOpexRaw(q, revenue) {
    if (!useFixedOpex) return revenue * opexPct
    var opYear = Math.ceil(q / p)
    var fixed = opexFixed * Math.pow(1 + inp.opexEscalation, opYear - 1)
    return p === 1 ? fixed : fixed / p
  }
  var ebitdaByPeriod = []
  for (var q0 = 1; q0 <= nO; q0++) {
    var rv = periodRevenue(q0)
    ebitdaByPeriod.push(rv - periodOpexRaw(q0, rv))
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DEBT SIZING (P-009 / P-013): sculpt to Target DSCR
  // ─────────────────────────────────────────────────────────────────────────
  // Debt capacity flexes to fit the operating cash flows and Target DSCR:
  //   1. Flat EBITDA over the loan life with sculpted repayment →
  //      sculptSupportableDebt() (closed binary search, unchanged).
  //   2. Varying EBITDA (escalation, revenue profile, seasonality) or an
  //      annuity / equal-principal profile → solveSupportableDebtGeneric(),
  //      which enforces the target DSCR in every period of the loan life.
  //   3. COD debt = min(DSCR capacity, Debt % × (TPC + IDC)); principal
  //      ≤ TPC (P-015C, solveConstructionDebt()).
  //   4. Equity funds TPC − principal draws.
  // targetDSCR = 0 ("no DSCR constraint", F03) → Debt % is the only cap.
  // Non-viable economics (EBITDA ≤ 0, no repayment period) → zero capacity.
  var loanPeriods = gracePeriods + repayPeriods
  var loanEbitda  = ebitdaByPeriod.slice(0, loanPeriods)
  var flat = loanEbitda.every(function(e) { return e === loanEbitda[0] })
  var sizingEbitda = loanEbitda.length ? loanEbitda[0] : 0
  var sizingMethod
  var supportableDebt
  if (targetDSCR <= 0) {
    // F03-style "no DSCR constraint" → DSCR capacity is unbounded; Debt %
    // (applied to TPC + IDC inside the solver) is the only debt cap.
    supportableDebt = Infinity
    sizingMethod = 'none'
  } else if (repayPeriods <= 0 || !loanEbitda.some(function(e) { return e > 0 })) {
    supportableDebt = 0                                   // non-viable economics
    sizingMethod = 'none'
  } else if (flat && profile === 'sculpted') {
    supportableDebt = sizingEbitda > 0
      ? sculptSupportableDebt(sizingEbitda, taxRate, targetDSCR, rateP, repayPeriods)
      : 0
    sizingMethod = 'sculpted_flat'
  } else {
    supportableDebt = solveSupportableDebtGeneric(loanEbitda, taxRate, targetDSCR, rateP,
      gracePeriods, repayPeriods, profile)
    sizingMethod = 'per_period_' + profile
  }

  // ── Construction capex by period ──
  var capexByPeriod = []
  var cw = inp.constrProfile ? normaliseWeights(inp.constrProfile) : null
  for (var c = 0; c < nC; c++) capexByPeriod.push(cw ? tpc * cw[c] : tpc / nC)

  // P-015C: solve principal draws so that COD balance (principal + IDC)
  // respects DSCR capacity, gearing on total funding, and TPC.
  var principalDrawn = solveConstructionDebt(capexByPeriod, tpc, constrRateP, debtPct, supportableDebt)
  var construction   = simulateConstructionFunding(capexByPeriod, tpc, principalDrawn, constrRateP)
  var idcTotal       = construction.idcTotal
  var totalFunding   = tpc + idcTotal                     // total uses (Convention A + IDC)
  var debt           = construction.codBalance            // COD term-loan balance (P-015D)
  var equity         = Math.max(0, tpc - principalDrawn)
  var requestedDebt  = totalFunding * debtPct
  if (supportableDebt === Infinity) supportableDebt = requestedDebt   // report a finite figure

  // Debt-capacity diagnostics (per the P-009/P-013 spec)
  var debtShortfall    = Math.max(0, requestedDebt - supportableDebt)
  var userEquityNominal = totalFunding * equityPct           // what user wanted to contribute
  var additionalEquity = Math.max(0, equity - userEquityNominal)
  var bindingConstraint =
    debt <= 0.01                                  ? 'none'
    : principalDrawn >= tpc - 0.01                ? 'project_cost'
    : supportableDebt < requestedDebt - 1         ? 'dscr'
    : 'gearing'

  var cfs = [], rowsP = [], schedP = []

  // ── Construction phase: equity-first funding waterfall (P-015A) + IDC (P-015C) ──
  // Each construction period draws equity first (up to the equity budget),
  // then debt principal for the balance of that period's capex. Interest
  // during construction accrues on the drawn balance and is capitalized
  // into the loan (row field `idc`); it is not a cash cost to equity and
  // `interest` (cash interest paid) stays 0 in construction rows.
  // By COD: Σ equity_draw = equity, Σ debt_draw = principalDrawn,
  // Σ debt_draw + Σ idc = debt (COD balance).
  for (var cy = 0; cy < nC; cy++) {
    var cRow = construction.rows[cy]
    var eqCF = -cRow.equity_draw
    cfs.push(eqCF)
    rowsP.push({
      year: cy, phase: 'Construction',
      revenue: 0, opex: 0, ebitda: 0,
      interest: 0, pbt: 0, tax: 0, net_income: 0,
      principal: 0, capex: r2(cRow.capex),
      equity_draw: r2(cRow.equity_draw),
      debt_draw:   r2(cRow.debt_draw),
      idc:         r2(cRow.idc),
      equity_cf: r2(eqCF), dscr: null,
    })
    schedP.push({
      year: cy, phase: 'Construction',
      opening: r2(cRow.opening), draw: r2(cRow.debt_draw), idc: r2(cRow.idc),
      interest: 0, principal: 0, closing: r2(cRow.closing),
    })
  }

  // ── Operations phase ──
  // Sculpted (P-013): DS_t = CFADS_t / target, principal_t = DS_t − interest_t
  // (flat CFADS → ~flat DS, rising principal). Annuity: level DS set on the
  // balance at the start of repayment. Equal principal: balance / repayment
  // periods. Grace periods are interest-only; no principal after the tenor.
  //
  // P-015D: COD conversion. Operations open at exactly the construction
  // closing balance (principal + capitalized IDC). Loan tenor is measured
  // FROM COD; each operating row is also written to the debt schedule from
  // the SAME variables used in the P&L / cash-flow rows.
  var outDebt = debt
  var levelDS = 0, eqPrincipal = 0
  for (var op = 1; op <= nO; op++) {
    var yr       = nC + op - 1
    var isGrace  = op <= gracePeriods
    var inRepay  = !isGrace && op <= (gracePeriods + repayPeriods)
    var lastRepay = op === gracePeriods + repayPeriods
    var hasDebt  = outDebt > 0.01
    var openingDebt = outDebt
    if (op === gracePeriods + 1) {
      levelDS     = annuity(outDebt, rateP, repayPeriods)
      eqPrincipal = repayPeriods > 0 ? outDebt / repayPeriods : 0
    }

    var revenue  = periodRevenue(op)
    var opex     = r2(periodOpexRaw(op, revenue))
    var ebitda   = r2(revenue - opex)
    var interest = hasDebt ? r2(outDebt * rateP) : 0

    // CFADS uses the actual tax shield on this period's interest (consistent
    // with the sizing). Principal is clamped to [0, outDebt].
    var principal = 0
    if (inRepay && hasDebt) {
      if (profile === 'annuity') {
        principal = r2(lastRepay ? outDebt : Math.min(outDebt, Math.max(0, levelDS - interest)))
      } else if (profile === 'equal_principal') {
        principal = r2(lastRepay ? outDebt : Math.min(outDebt, eqPrincipal))
      } else {
        var pbtPre  = ebitda - interest
        var taxPre  = Math.max(0, pbtPre * taxRate)
        var cfadsT  = ebitda - taxPre
        var sculptedDS = cfadsT / targetDSCR
        principal = r2(Math.min(outDebt, Math.max(0, sculptedDS - interest)))
      }
    }
    outDebt = r2(Math.max(0, outDebt - principal))

    var pbt    = r2(ebitda - interest)
    var tax    = r2(Math.max(0, pbt * taxRate))
    var netInc = r2(pbt - tax)
    var eqCFo  = r2(netInc - principal)

    // CFADS = ebitda minus tax (pre-debt-service, post-tax)
    var cfads   = r2(ebitda - tax)
    var totalDS = r2(interest + principal)
    // Null when debt service < 1 JOD — eliminates division-by-zero spikes
    // in grace years and post-repayment free-cash years
    var dscr = totalDS > 1 ? r2(cfads / totalDS) : null

    cfs.push(eqCFo)
    rowsP.push({
      year: yr, phase: 'Operations',
      revenue: r2(revenue), opex: opex, ebitda: ebitda,
      interest: interest, pbt: pbt, tax: tax, net_income: netInc,
      principal: principal, capex: 0,
      equity_draw: 0, debt_draw: 0, idc: 0,
      equity_cf: eqCFo, dscr: dscr,
    })
    schedP.push({
      year: yr, phase: 'Operations',
      opening: r2(openingDebt), draw: 0, idc: 0,
      interest: interest, principal: principal, closing: r2(outDebt),
    })
  }

  // ── Returns on the periodic equity cash flows ──
  var rawIrr = p === 1 ? irrCalc(cfs) : irrCalcPeriodic(cfs, p)
  // Project IRR (Phase 4): unlevered, post-tax, before financing — base
  // capex out during construction (no IDC, no debt), EBITDA less tax on
  // EBITDA (no interest shield) during operations. With zero debt it equals
  // the equity IRR by construction.
  var projCfs = rowsP.map(function(r) {
    return r.phase === 'Construction' ? -r.capex : r.ebitda - Math.max(0, r.ebitda * taxRate)
  })
  var rawProjIrr = p === 1 ? irrCalc(projCfs) : irrCalcPeriodic(projCfs, p)
  var projectIrr = rawProjIrr !== null ? r2((p === 1 ? rawProjIrr : Math.pow(1 + rawProjIrr, p) - 1) * 100) : null
  var irr    = rawIrr !== null ? r2((p === 1 ? rawIrr : Math.pow(1 + rawIrr, p) - 1) * 100) : null
  var npv    = r2(npvCalc(p === 1 ? wacc : Math.pow(1 + wacc, 1 / p) - 1, cfs))
  var totalIn  = Math.abs(cfs.filter(function(v) { return v < 0 }).reduce(function(a, b) { return a + b }, 0))
  var totalOut = cfs.filter(function(v) { return v > 0 }).reduce(function(a, b) { return a + b }, 0)
  var em = totalIn > 0 ? r2(totalOut / totalIn) : null

  // ── Annual reporting ──
  var cfTable, debtSchedule, dscrSeries = []
  if (p === 1) {
    cfTable = rowsP
    debtSchedule = schedP
    rowsP.forEach(function(r, i) {
      if (r.phase === 'Operations' && r.dscr !== null) dscrSeries.push({ year: i - nC + 1, dscr: r.dscr })
    })
  } else {
    var agg = aggregateToYears(rowsP, schedP, nC, p)
    cfTable = agg.cash_flows
    debtSchedule = agg.debt_schedule
    dscrSeries = agg.dscr_series
  }

  // DSCR aggregates for the debt_sizing report — on the model periods
  // (the covenant-test frequency): annual for annual models, quarterly for
  // quarterly models. The annual series is reported alongside.
  var periodDSCR = rowsP
    .filter(function(r) { return r.phase === 'Operations' && r.dscr !== null && Number.isFinite(r.dscr) })
    .map(function(r) { return r.dscr })
  var minDSCR = periodDSCR.length ? Math.min.apply(null, periodDSCR) : null
  var avgDSCR = periodDSCR.length
    ? periodDSCR.reduce(function(a, b) { return a + b }, 0) / periodDSCR.length
    : null
  var annualDSCR = dscrSeries.map(function(d) { return d.dscr })

  var result = {
    irr, npv, equity_multiple: em,
    tdc: r2(tpc), debt_amount: r2(debt), equity_amount: r2(equity),
    project_irr: projectIrr,
    dscr_series: dscrSeries, cash_flows: cfTable,
    construction_years: p === 1 ? constrYears : Math.ceil(nC / p), operations_years: opsYears,
    // ── P-015C / P-015D ──
    // tdc stays the BASE project cost input (Convention A: excludes IDC).
    // total_funding_requirement = tdc + idc_capitalized = total sources.
    // debt_amount = COD term-loan balance = principal_drawn + idc_capitalized.
    idc_capitalized:           r2(idcTotal),
    total_funding_requirement: r2(totalFunding),
    debt_schedule:             debtSchedule,
    // ── P-016 ──
    periodicity:               p === 1 ? 'annual' : 'quarterly',
    periods_per_year:          p,
    construction_periods:      nC,
    operations_periods:        nO,
    cash_flows_periodic:       p === 1 ? null : rowsP,
    debt_schedule_periodic:    p === 1 ? null : schedP,
    // ── Phase 3: revenue / repayment basis (labelled for the reader) ──
    revenue_basis:             /demand/i.test(inp.revenueBasis) ? 'demand_estimate' : 'contractual',
    repayment_profile:         profile,
    // ── Debt-capacity diagnostics (P-009 / P-013) ──
    debt_sizing: {
      requested_debt:             r2(requestedDebt),
      supportable_debt:           r2(supportableDebt),
      debt_shortfall:             r2(debtShortfall),
      additional_equity_required: r2(additionalEquity),
      resulting_equity:           r2(equity),
      min_dscr:                   minDSCR !== null ? r2(minDSCR) : null,
      avg_dscr:                   avgDSCR !== null ? r2(avgDSCR) : null,
      target_dscr:                targetDSCR,
      actual_debt:                r2(debt),
      // P-015C / P-015D additions
      principal_drawn:            r2(principalDrawn),
      idc_capitalized:            r2(idcTotal),
      total_funding_requirement:  r2(totalFunding),
      cod_debt_balance:           r2(debt),
      construction_interest_rate: constrRate,
      binding_constraint:         bindingConstraint,   // 'dscr' | 'gearing' | 'project_cost' | 'none'
      loan_tenor_years:           loanTenorYrs,        // measured from COD
      grace_years:                gracePeriodYrs,      // interest-only operating years
      repayment_years:            repayYears,          // tenor − grace
      // P-016 / Phase 3 additions
      dscr_basis:                 p === 1 ? 'annual' : 'quarterly',
      // P-018: underwriting (acceptance) threshold vs sculpting target
      underwriting_dscr:          inp.underwritingDSCR,
      meets_underwriting:         minDSCR === null ? null : r2(minDSCR) >= inp.underwritingDSCR,
      min_dscr_annual:            annualDSCR.length ? Math.min.apply(null, annualDSCR) : null,
      sizing_method:              sizingMethod,
      repayment_profile:          profile,
    },
  }
  // P-023: reconciliation gate (throws if the outputs do not reconcile) and
  // reasonableness warnings (never block).
  result.integrity = checkPPPIntegrity(result, inp)
  result.warnings  = computePPPWarnings(result, inp)
  result.engine_version = PPP_ENGINE_VERSION
  return result
}

function normaliseWeights(list) {
  var s = list.reduce(function(a, b) { return a + b }, 0)
  return list.map(function(x) { return x / s })
}

// Quarterly → annual reporting rows (see runPPPEngine header).
function aggregateToYears(rowsP, schedP, nC, p) {
  var FLOW = ['revenue', 'opex', 'ebitda', 'interest', 'pbt', 'tax', 'net_income', 'principal',
              'capex', 'equity_draw', 'debt_draw', 'idc', 'equity_cf']
  var cash_flows = [], debt_schedule = [], dscr_series = []
  function groups(start, end) {
    var g = []
    for (var i = start; i < end; i += p) g.push([i, Math.min(i + p, end)])
    return g
  }
  var spans = groups(0, nC).map(function(g) { return g.concat('Construction') })
    .concat(groups(nC, rowsP.length).map(function(g) { return g.concat('Operations') }))
  spans.forEach(function(span, k) {
    var a = span[0], b = span[1], phase = span[2]
    var row = { year: k, phase: phase, periods: b - a }
    FLOW.forEach(function(f) {
      var s = 0
      for (var i = a; i < b; i++) s += rowsP[i][f] || 0
      row[f] = r2(s)
    })
    var cfads = 0, ds = 0
    for (var i2 = a; i2 < b; i2++) { cfads += rowsP[i2].ebitda - rowsP[i2].tax; ds += rowsP[i2].interest + rowsP[i2].principal }
    row.dscr = phase === 'Operations' && ds > 1 ? r2(cfads / ds) : null
    cash_flows.push(row)
    if (row.dscr !== null) {
      var opsYear = k - Math.ceil(nC / p) + 1
      dscr_series.push({ year: opsYear, dscr: row.dscr })
    }
    debt_schedule.push({
      year: k, phase: phase,
      opening: schedP[a].opening,
      draw: row.debt_draw, idc: row.idc, interest: row.interest, principal: row.principal,
      closing: schedP[b - 1].closing,
    })
  })
  return { cash_flows: cash_flows, debt_schedule: debt_schedule, dscr_series: dscr_series }
}


// ─────────────────────────────────────────────────────────────────────────────
// PPP HELPERS — extracted verbatim from src/pages/FeasibilityProject.jsx
// 2026-05-15. Byte-identical to the previous inline definitions.
// ─────────────────────────────────────────────────────────────────────────────

// Solver: find minimum annual payment to achieve targetDSCR
// Only iterates over payment — all other assumptions are fixed.
//
// Fix Batch 1B (F05 + F06, 2026-05-16): returns a structured object that
// explicitly distinguishes convergence from cap exhaustion. The returned
// required_payment is always the LAST ACTUALLY-EVALUATED value (no longer
// one step past the last tested value).
//   converged          — true iff the loop broke because minDSCR ≥ target
//   required_payment   — last payment value the engine was run against
//   payment_gap        — required_payment − currentPayment
//   target_dscr        — target DSCR used (after the targetDSCR || 1.20 default)
//   achieved_min_dscr  — minDSCR at the last engine evaluation (null only if
//                        every iteration produced an empty dscr_series)
function computeRequiredPayment(assumptions, targetDSCR) {
  var currentPayment = pppVal(assumptions, 'Annual Availability Payment') || 0
  // F03 (Batch 2B, 2026-05-16): explicit `targetDSCR = 0` respected — means
  // "accept any non-negative DSCR" (converge at currentPayment). Null/
  // undefined still falls back to the institutional default of 1.20.
  var target = safeNum(targetDSCR, PPP_DSCR_FLOOR)
  var step = 10000
  var maxIterations = 2000
  var testPayment = currentPayment
  var minDSCR = null
  var converged = false

  for (var i = 0; i < maxIterations; i++) {
    var testAssumptions = assumptions.map(function(a) {
      if (a.name === 'Annual Availability Payment') return Object.assign({}, a, { value: testPayment })
      return a
    })
    var result = runPPPEngine(testAssumptions)
    // F07 (Batch 2B, 2026-05-16): defensive NaN / Infinity guard.
    // Number.isFinite excludes null, undefined, NaN, and ±Infinity in one
    // strict (non-coercing) check. No currently-reachable trigger from
    // normal inputs (Batch 2A's safeNum eliminates NaN at the PPP input
    // boundary), but this hardens the solver against any future regression
    // that lets NaN enter dscr_series.
    var dscrVals = (result.dscr_series || [])
      .filter(function(d) { return Number.isFinite(d.dscr) })
      .map(function(d) { return d.dscr })
    minDSCR = dscrVals.length ? Math.min.apply(null, dscrVals) : null
    if (minDSCR !== null && minDSCR >= target) {
      converged = true
      break
    }
    // F06: only advance to the next candidate if another iteration will
    // follow. Prevents returning a payment value that was never actually
    // evaluated by runPPPEngine.
    if (i < maxIterations - 1) testPayment += step
  }

  return {
    converged: converged,
    required_payment: testPayment,
    payment_gap: testPayment - currentPayment,
    target_dscr: target,
    achieved_min_dscr: minDSCR,
  }
}

// Returns true when the project is Infrastructure/PPP with Availability Payment contract
function isPPPAvailabilityPayment(project, assumptions) {
  if (!project) return false
  // New taxonomy: revenue_model field is the single source of truth
  if (project.revenue_model) return project.revenue_model === 'Availability Payment'
  // Legacy fallback: project_type + Contract Model assumption
  if (project.project_type !== 'Infrastructure / PPP') return false
  var cm = assumptions && assumptions.find(function(a) { return a.name === 'Contract Model' })
  return !!(cm && cm.unit === 'Availability Payment')
}

// ─── PPP BANKABILITY ASSESSMENT ──────────────────────────────────────────────
// Derived purely from stored modelOutput — no re-run needed.
// P-022: version stamped on every PPP result. Bump whenever any financial
// output for the same inputs changes; list in PPP_ENGINE_COMPATIBLE_VERSIONS
// every earlier version whose outputs are identical to the current engine.
// Results from versions not listed are flagged as outdated (stale_engine).
var PPP_ENGINE_VERSION = '2.0.0'
var PPP_ENGINE_COMPATIBLE_VERSIONS = ['2.0.0']

var PPP_DSCR_FLOOR  = 1.20
var PPP_IRR_HURDLE  = 10    // % equity IRR

function computePPPBankability(modelOutput, dscrFloor) {
  if (!modelOutput) return null
  // F04 (Batch 2B, 2026-05-16): explicit `dscrFloor = 0` respected — means
  // "no DSCR constraint" (any non-negative minDSCR passes the gate). Null/
  // undefined/NaN still falls back to the institutional default of 1.20.
  var floor = safeNum(dscrFloor, PPP_DSCR_FLOOR)

  var irr = modelOutput.irr !== null && modelOutput.irr !== undefined ? Number(modelOutput.irr) : null
  var npv = modelOutput.npv !== null && modelOutput.npv !== undefined ? Number(modelOutput.npv) : null

  var dscrSeries = modelOutput.dscr_series || []
  var cashFlows  = modelOutput.cash_flows  || []

  // Min DSCR across all debt-service years
  var dscrVals = dscrSeries.filter(function(d) { return d.dscr !== null }).map(function(d) { return d.dscr })
  var minDSCR  = dscrVals.length ? Math.min.apply(null, dscrVals) : null
  // P-018: gate on the covenant-frequency minimum (quarterly for quarterly
  // models) when the result carries it; never on a less strict figure.
  var periodMin = modelOutput.debt_sizing && Number.isFinite(modelOutput.debt_sizing.min_dscr)
    ? modelOutput.debt_sizing.min_dscr : null
  if (periodMin !== null) minDSCR = minDSCR === null ? periodMin : Math.min(minDSCR, periodMin)

  // Cash-trap years — all ops years where DSCR < floor
  var cashTrapYears = dscrSeries
    .filter(function(d) { return d.dscr !== null && d.dscr < floor })
    .map(function(d) { return d.year })

  // Liquidity warnings — track SPV retained-cash balance; warn when < 3 months OPEX
  var opsCFs = cashFlows.filter(function(r) { return r.phase === 'Operations' })
  var constrCount = cashFlows.filter(function(r) { return r.phase === 'Construction' }).length

  var annualOpex = 0
  for (var oi = 0; oi < opsCFs.length; oi++) {
    if (Number(opsCFs[oi].opex) > 0) { annualOpex = Number(opsCFs[oi].opex); break }
  }
  var liquidityThreshold = annualOpex / 4   // 3 months = 25% of annual opex

  var ssvBalance = 0
  var liquidityWarnings = []

  opsCFs.forEach(function(r) {
    var rawEqCF = Number(r.equity_cf) || 0
    var dscr    = (r.dscr !== undefined && r.dscr !== null) ? Number(r.dscr) : null
    var trapped = dscr !== null && dscr < floor

    if (trapped) {
      ssvBalance = ssvBalance + rawEqCF
    } else {
      ssvBalance = 0
    }

    var opsYr = r.year - constrCount + 1
    // F11 (Batch 2B, 2026-05-16): only fire a liquidity warning during a
    // trapped year. Pre-fix, ssvBalance reset to 0 on every non-trapped year
    // then immediately fired a warning (0 < threshold). Result: warnings on
    // every ops year when opex > 0, even outside cash-trap sequences. After
    // the fix, warnings are scoped to genuine trap-window liquidity stress.
    if (trapped && liquidityThreshold > 0 && ssvBalance < liquidityThreshold) {
      liquidityWarnings.push({ ops_year: opsYr, total_year: r.year, balance: Math.round(ssvBalance) })
    }
  })

  // Recommendation gates
  var irrOk  = irr !== null && irr >= PPP_IRR_HURDLE
  var npvOk  = npv !== null && npv >= 0
  var dscrOk = minDSCR === null || minDSCR >= floor

  var failures = [!irrOk, !npvOk, !dscrOk].filter(function(f) { return f }).length

  var recommendation, investmentCase, verdictColor, verdictBg
  if (failures === 0) {
    recommendation = 'Proceed'
    investmentCase = irr > PPP_IRR_HURDLE * 1.3 ? 'Strong Investment Case' : 'Acceptable Investment Case'
    verdictColor = '#3fb950'; verdictBg = '#3fb95015'
  } else if (failures === 1) {
    recommendation = 'Proceed with Conditions'
    investmentCase = 'Acceptable Investment Case'
    verdictColor = '#d29922'; verdictBg = '#d2992215'
  } else {
    recommendation = 'Do Not Proceed'
    investmentCase = 'Weak Investment Case'
    verdictColor = '#f85149'; verdictBg = '#f8514915'
  }

  return {
    recommendation, investmentCase,
    verdictColor, verdictBg,
    irrOk, npvOk, dscrOk,
    minDSCR, cashTrapYears, liquidityWarnings,
    failures, PPP_DSCR_FLOOR: floor, PPP_IRR_HURDLE,
  }
}
// ─────────────────────────────────────────────────────────────────────────────

export {
  getVal, getUnit, getDefault, pppVal, r2,
  annuity, npvCalc, irrCalc,
  runEngine, runPPPEngine,
  PPP_DSCR_FLOOR, PPP_IRR_HURDLE, PPP_ENGINE_VERSION, PPP_ENGINE_COMPATIBLE_VERSIONS,
  isPPPAvailabilityPayment, computePPPBankability, computeRequiredPayment,
}
