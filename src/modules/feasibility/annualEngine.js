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
function r2(n) { return Math.round(n * 100) / 100 }

function runEngine(assumptions, defaults) {
  var gfa           = getVal(assumptions, 'GFA') || 0
  var equityPct     = (getVal(assumptions, 'Equity %') || 30) / 100
  var seniorDebtPct = (getVal(assumptions, 'Senior Debt %') || 60) / 100
  var revenueModel  = getUnit(assumptions, 'Revenue Model') || 'Sale'
  var isSale        = revenueModel === 'Sale'
  var isRental      = revenueModel === 'Rental'
  var saleSplit     = isSale ? 1 : isRental ? 0 : (getVal(assumptions, 'Sale Split %') || 50) / 100
  var rentalSplit   = 1 - saleSplit
  var efficiency    = getVal(assumptions, 'Efficiency %')
  efficiency        = efficiency !== null ? efficiency / 100 : 1.0
  var saleableGfa   = gfa * efficiency
  var saleGfa       = saleableGfa * saleSplit
  var rentalGfa     = saleableGfa * rentalSplit
  var lifeYears     = getVal(assumptions, 'Project Life Years') || 20
  var csDate        = getUnit(assumptions, 'Construction Start Date')
  var osDate        = getUnit(assumptions, 'Operations Start Date')
  var constrYrs     = 2
  if (csDate && osDate && csDate.length > 4 && osDate.length > 4) {
    var diff = (new Date(osDate) - new Date(csDate)) / (1000 * 60 * 60 * 24)
    constrYrs = Math.max(1, Math.round(diff / 365))
  }
  var opsYrs = Math.max(1, lifeYears - constrYrs)

  var constCost   = getDefault(defaults, 'construction_cost_per_sqm_residential') || 650
  var contingency = getDefault(defaults, 'contingency_pct') || 0.05
  var landPct     = getDefault(defaults, 'land_cost_pct_of_tdc') || 0.20
  var salePrice   = getDefault(defaults, 'sale_price_per_sqm_residential') || 1200
  var absRate     = getDefault(defaults, 'sales_absorption_rate_pct_per_year') || 0.35
  var rentYield   = getDefault(defaults, 'rental_yield_residential') || 0.06
  var maxOcc      = getDefault(defaults, 'occupancy_rate_stabilized') || 0.88
  var rentEsc     = getDefault(defaults, 'rent_escalation_pct_per_year') || 0.03
  var priceEsc    = getDefault(defaults, 'price_escalation_pa') || 0.025
  var mgmtFee     = getDefault(defaults, 'property_management_fee_pct') || 0.05
  var maintPct    = getDefault(defaults, 'maintenance_cost_pct_of_value') || 0.01
  var insrPct     = getDefault(defaults, 'insurance_pct_of_value') || 0.005
  var debtRate    = getDefault(defaults, 'senior_debt_interest_rate') || 0.085
  var debtTenor   = getDefault(defaults, 'loan_tenor_years') || 15
  var graceYrs    = getDefault(defaults, 'grace_period_years') || 2
  var taxRate     = getDefault(defaults, 'corporate_income_tax_rate') || 0.20
  var wacc        = getDefault(defaults, 'discount_rate_wacc') || 0.12
  var arrFeeRate  = getDefault(defaults, 'debt_arrangement_fee_pct') || 0.01

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

function runPPPEngine(assumptions) {
  var tpc             = pppVal(assumptions, 'Total Project Cost')          || 0
  var debtPct         = (pppVal(assumptions, 'Debt %')                     || 80) / 100
  var equityPct       = (pppVal(assumptions, 'Equity %')                   || 20) / 100
  var annualPayment   = pppVal(assumptions, 'Annual Availability Payment') || 0
  var concessionYrs   = pppVal(assumptions, 'Concession Period')           || 25
  var constrMonths    = pppVal(assumptions, 'Construction Period')          || 24
  var opexPct         = (pppVal(assumptions, 'OPEX % of Revenue')          || 5)  / 100
  var interestRate    = (pppVal(assumptions, 'Interest Rate')              || 7)  / 100
  var loanTenorYrs    = pppVal(assumptions, 'Loan Tenor')                  || 10
  var gracePeriodYrs  = pppVal(assumptions, 'Grace Period')                || 2
  var taxRate         = (pppVal(assumptions, 'Tax Rate')                   || 20) / 100
  var wacc            = (pppVal(assumptions, 'WACC')                       || 10) / 100

  var constrYears = Math.max(1, Math.ceil(constrMonths / 12))
  var opsYears    = Math.max(1, concessionYrs)  // concession = service/operations period; total life = constrYears + opsYears
  var debt        = tpc * debtPct
  var equity      = tpc * equityPct

  // OPEX: use fixed JOD amount if stored, otherwise % of revenue (default)
  var opexFixed   = pppVal(assumptions, 'OPEX Amount (JOD)')
  var useFixedOpex = opexFixed !== null && opexFixed > 0

  // Level annuity repayment over (loanTenor - grace) years
  var repayYears  = Math.max(1, loanTenorYrs - gracePeriodYrs)
  var annuityAmt  = annuity(debt, interestRate, repayYears)

  var cfs = [], cfTable = [], dscrSeries = []

  // ── Construction phase: equity drawn evenly, zero revenue ──
  var equityPerConstrYr = equity / constrYears
  for (var cy = 0; cy < constrYears; cy++) {
    var eqCF = -equityPerConstrYr
    cfs.push(eqCF)
    cfTable.push({
      year: cy, phase: 'Construction',
      revenue: 0, opex: 0, ebitda: 0,
      interest: 0, pbt: 0, tax: 0, net_income: 0,
      principal: 0, capex: r2(tpc / constrYears),
      equity_cf: r2(eqCF), dscr: null,
    })
  }

  // ── Operations phase ──
  var outDebt = debt
  for (var op = 1; op <= opsYears; op++) {
    var yr       = constrYears + op - 1
    var isGrace  = op <= gracePeriodYrs
    var hasDebt  = outDebt > 0.01

    var revenue  = annualPayment
    var opex     = useFixedOpex ? r2(opexFixed) : r2(revenue * opexPct)
    var ebitda   = r2(revenue - opex)
    var interest = hasDebt ? r2(outDebt * interestRate) : 0

    // Principal: 0 during grace; annuity minus interest during repayment
    var principal = 0
    if (!isGrace && hasDebt) {
      principal = r2(Math.min(outDebt, Math.max(0, annuityAmt - interest)))
    }
    outDebt = r2(Math.max(0, outDebt - principal))

    var pbt    = r2(ebitda - interest)
    var tax    = r2(Math.max(0, pbt * taxRate))
    var netInc = r2(pbt - tax)
    var eqCF   = r2(netInc - principal)

    // CFADS = ebitda minus tax (pre-debt-service, post-tax)
    var cfads   = r2(ebitda - tax)
    var totalDS = r2(interest + principal)
    // Null when debt service < 1 JOD — eliminates division-by-zero spikes
    // in grace years and post-repayment free-cash years
    var dscr = totalDS > 1 ? r2(cfads / totalDS) : null

    cfs.push(eqCF)
    // Only include years with a valid DSCR ratio in the series
    if (dscr !== null) dscrSeries.push({ year: op, dscr: dscr })

    cfTable.push({
      year: yr, phase: 'Operations',
      revenue: r2(revenue), opex: opex, ebitda: ebitda,
      interest: interest, pbt: pbt, tax: tax, net_income: netInc,
      principal: principal, capex: 0, equity_cf: eqCF, dscr: dscr,
    })
  }

  var rawIrr = irrCalc(cfs)
  var irr    = rawIrr !== null ? r2(rawIrr * 100) : null
  var npv    = r2(npvCalc(wacc, cfs))
  var totalIn  = Math.abs(cfs.filter(function(c) { return c < 0 }).reduce(function(a, b) { return a + b }, 0))
  var totalOut = cfs.filter(function(c) { return c > 0 }).reduce(function(a, b) { return a + b }, 0)
  var em = totalIn > 0 ? r2(totalOut / totalIn) : null

  return {
    irr, npv, equity_multiple: em,
    tdc: r2(tpc), debt_amount: r2(debt), equity_amount: r2(equity),
    dscr_series: dscrSeries, cash_flows: cfTable,
    construction_years: constrYears, operations_years: opsYears,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PPP HELPERS — extracted verbatim from src/pages/FeasibilityProject.jsx
// 2026-05-15. Byte-identical to the previous inline definitions.
// ─────────────────────────────────────────────────────────────────────────────

// Solver: find minimum annual payment to achieve targetDSCR
// Only iterates over payment — all other assumptions are fixed
function computeRequiredPayment(assumptions, targetDSCR) {
  var currentPayment = pppVal(assumptions, 'Annual Availability Payment') || 0
  var target = targetDSCR || 1.20
  var step = 10000
  var maxIterations = 2000
  var testPayment = currentPayment

  for (var i = 0; i < maxIterations; i++) {
    var testAssumptions = assumptions.map(function(a) {
      if (a.name === 'Annual Availability Payment') return Object.assign({}, a, { value: testPayment })
      return a
    })
    var result = runPPPEngine(testAssumptions)
    var dscrVals = (result.dscr_series || [])
      .filter(function(d) { return d.dscr !== null })
      .map(function(d) { return d.dscr })
    var minDSCR = dscrVals.length ? Math.min.apply(null, dscrVals) : null
    if (minDSCR !== null && minDSCR >= target) break
    testPayment += step
  }

  return {
    required_payment: testPayment,
    payment_gap: testPayment - currentPayment,
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
var PPP_DSCR_FLOOR  = 1.20
var PPP_IRR_HURDLE  = 10    // % equity IRR

function computePPPBankability(modelOutput, dscrFloor) {
  if (!modelOutput) return null
  // Use caller-supplied floor (user target DSCR) or fall back to global constant
  var floor = (dscrFloor != null && dscrFloor > 0) ? dscrFloor : PPP_DSCR_FLOOR

  var irr = modelOutput.irr !== null && modelOutput.irr !== undefined ? Number(modelOutput.irr) : null
  var npv = modelOutput.npv !== null && modelOutput.npv !== undefined ? Number(modelOutput.npv) : null

  var dscrSeries = modelOutput.dscr_series || []
  var cashFlows  = modelOutput.cash_flows  || []

  // Min DSCR across all debt-service years
  var dscrVals = dscrSeries.filter(function(d) { return d.dscr !== null }).map(function(d) { return d.dscr })
  var minDSCR  = dscrVals.length ? Math.min.apply(null, dscrVals) : null

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
    if (liquidityThreshold > 0 && ssvBalance < liquidityThreshold) {
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
  PPP_DSCR_FLOOR, PPP_IRR_HURDLE,
  isPPPAvailabilityPayment, computePPPBankability, computeRequiredPayment,
}
