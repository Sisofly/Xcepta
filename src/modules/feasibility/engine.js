/**
 * XCEPTA Financial Engine v2.1
 * Sale: cash sweep debt repayment from proceeds
 * Rental: annuity debt
 * Mixed: proportional split
 */

function getVal(assumptions, name) {
  const a = assumptions.find(a => a.name === name)
  return a ? a.value : null
}

function getUnit(assumptions, name) {
  const a = assumptions.find(a => a.name === name)
  return a ? a.unit : null
}

function getDef(defaults, key) {
  const d = defaults.find(d => d.key === key)
  return d ? Number(d.value) : null
}

function annuity(principal, rate, periods) {
  if (principal <= 0 || periods <= 0) return 0
  if (rate === 0) return principal / periods
  return principal * (rate * Math.pow(1 + rate, periods)) / (Math.pow(1 + rate, periods) - 1)
}

function npvCalc(rate, cfs) {
  return cfs.reduce(function(acc, cf, t) { return acc + cf / Math.pow(1 + rate, t) }, 0)
}

function irrCalc(cfs) {
  var hasNeg = cfs.some(function(cf) { return cf < 0 })
  var hasPos = cfs.some(function(cf) { return cf > 0 })
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

  var check = npvCalc(rate, cfs)
  if (Math.abs(check) > 10000) return null
  if (rate <= -0.999 || rate > 50) return null
  return rate
}

function r2(n) {
  return Math.round(n * 100) / 100
}

export function runEngine(assumptions, defaults) {

  var gfa            = getVal(assumptions, 'GFA') || 0
  var equityPct      = (getVal(assumptions, 'Equity %') || 30) / 100
  var seniorDebtPct  = (getVal(assumptions, 'Senior Debt %') || 60) / 100
  var revenueModel   = getUnit(assumptions, 'Revenue Model') || 'Sale'
  var isSale         = revenueModel === 'Sale'
  var isRental       = revenueModel === 'Rental'

  var saleSplitRatio = isSale ? 1 : isRental ? 0 : (getVal(assumptions, 'Sale Split %') || 50) / 100
  var rentalSplitRatio = 1 - saleSplitRatio

  var saleGfa    = gfa * saleSplitRatio
  var rentalGfa  = gfa * rentalSplitRatio

  var projectLifeYears = getVal(assumptions, 'Project Life Years') || 20

  var csDate = getUnit(assumptions, 'Construction Start Date')
  var osDate = getUnit(assumptions, 'Operations Start Date')
  var constructionYears = 2
  if (csDate && osDate && csDate.length > 0 && osDate.length > 0) {
    var diffDays = (new Date(osDate) - new Date(csDate)) / (1000 * 60 * 60 * 24)
    constructionYears = Math.max(1, Math.round(diffDays / 365))
  }
  var opsYears = Math.max(1, projectLifeYears - constructionYears)

  var constCostSqm  = getDef(defaults, 'construction_cost_per_sqm_residential') || 650
  var contingency   = getDef(defaults, 'contingency_pct') || 0.05
  var landCostPct   = getDef(defaults, 'land_cost_pct_of_tdc') || 0.20
  var salePriceSqm  = getDef(defaults, 'sale_price_per_sqm_residential') || 1200
  var absorption    = getDef(defaults, 'sales_absorption_rate_pct_per_year') || 0.35
  var rentalYield   = getDef(defaults, 'rental_yield_residential') || 0.06
  var maxOcc        = getDef(defaults, 'occupancy_rate_stabilized') || 0.88
  var rentEsc       = getDef(defaults, 'rent_escalation_pct_per_year') || 0.03
  var priceEsc      = getDef(defaults, 'price_escalation_pa') || 0.025
  var mgmtFee       = getDef(defaults, 'property_management_fee_pct') || 0.05
  var maintPct      = getDef(defaults, 'maintenance_cost_pct_of_value') || 0.01
  var insurePct     = getDef(defaults, 'insurance_pct_of_value') || 0.005
  var debtRate      = getDef(defaults, 'senior_debt_interest_rate') || 0.085
  var debtTenor     = getDef(defaults, 'loan_tenor_years') || 15
  var gracePeriod   = getDef(defaults, 'grace_period_years') || 2
  var taxRate       = getDef(defaults, 'corporate_income_tax_rate') || 0.20
  var wacc          = getDef(defaults, 'discount_rate_wacc') || 0.12
  var arrangFeePct  = getDef(defaults, 'debt_arrangement_fee_pct') || 0.01

  var baseCost    = gfa * constCostSqm
  var tdc         = baseCost * (1 + contingency)
  var landCost    = tdc * landCostPct
  var tpc         = tdc + landCost

  var equityAmount = tpc * equityPct
  var debtAmount   = tpc * seniorDebtPct
  var arrangeFee   = debtAmount * arrangFeePct

  var capFactor    = Math.pow(1 + debtRate, constructionYears)
  var outSaleDebt  = debtAmount * saleSplitRatio * capFactor
  var outRentalDebt = debtAmount * rentalSplitRatio * capFactor

  var rentalAnnuity = annuity(outRentalDebt, debtRate, Math.max(1, debtTenor - gracePeriod))

  var assetValue   = gfa * salePriceSqm

  var cashFlows    = []
  var cfTable      = []
  var dscrSeries   = []
  var remainingSaleGfa = saleGfa

  for (var y = 0; y < constructionYears; y++) {
    var eqCF = y === 0
      ? -((equityAmount / constructionYears) + arrangeFee)
      : -(equityAmount / constructionYears)
    cashFlows.push(eqCF)
    cfTable.push({
      year: y, phase: 'Construction',
      revenue: 0, opex: 0, ebitda: 0,
      interest: 0, pbt: 0, tax: 0, net_income: 0,
      principal: 0, capex: r2(tpc / constructionYears),
      equity_cf: r2(eqCF), dscr: null
    })
  }

  for (var op = 1; op <= opsYears; op++) {
    var year = constructionYears + op - 1

    // Snapshot debt balance at START of year — used to decide DSCR reporting
    var startSaleDebt   = outSaleDebt
    var startRentalDebt = outRentalDebt
    var hasDebtAtStart  = startSaleDebt > 0.01 || startRentalDebt > 0.01

    // Sale revenue
    var saleRev = 0
    if (saleGfa > 0 && remainingSaleGfa > 0.01) {
      var sold = Math.min(remainingSaleGfa, saleGfa * absorption)
      saleRev = sold * salePriceSqm * Math.pow(1 + priceEsc, op - 1)
      remainingSaleGfa = Math.max(0, remainingSaleGfa - sold)
    }

    // Rental revenue
    var rentalRev = 0
    if (rentalGfa > 0) {
      var occ = Math.min(maxOcc, 0.55 + 0.15 * (op - 1))
      var rentPsqm = (assetValue / Math.max(gfa, 1)) * rentalYield * Math.pow(1 + rentEsc, op - 1)
      rentalRev = rentalGfa * rentPsqm * occ
    }

    var revenue = saleRev + rentalRev

    // Opex
    var mgmt   = revenue * mgmtFee
    var maint  = assetValue * (rentalGfa / Math.max(gfa, 1)) * maintPct
    var insure = assetValue * (rentalGfa / Math.max(gfa, 1)) * insurePct
    var opex   = mgmt + maint + insure
    var ebitda = revenue - opex

    // Sale debt: cash sweep from proceeds
    var saleInt = 0, salePrin = 0
    if (outSaleDebt > 0.01) {
      saleInt = outSaleDebt * debtRate
      var netForSweep = saleRev * (1 - mgmtFee) - saleInt
      salePrin = Math.min(outSaleDebt, Math.max(0, netForSweep))
      outSaleDebt = Math.max(0, outSaleDebt - salePrin)
    }

    // Rental debt: annuity
    var rentalInt = 0, rentalPrin = 0
    if (outRentalDebt > 0.01) {
      rentalInt = outRentalDebt * debtRate
      if (op > gracePeriod) {
        rentalPrin = Math.max(0, Math.min(outRentalDebt, rentalAnnuity - rentalInt))
        outRentalDebt = Math.max(0, outRentalDebt - rentalPrin)
      }
    }

    var interest  = saleInt + rentalInt
    var principal = salePrin + rentalPrin
    var pbt       = ebitda - interest
    var tax       = Math.max(0, pbt * taxRate)
    var netIncome = pbt - tax
    var equityCF  = netIncome - principal

    cashFlows.push(equityCF)

    // DSCR: only report years where debt was active at start of year
    var totalDS = interest + principal
    var dscr = null
    if (totalDS > 0) dscr = r2(ebitda / totalDS)
    if (hasDebtAtStart) dscrSeries.push({ year: op, dscr: dscr })

    cfTable.push({
      year: year, phase: 'Operations',
      revenue: r2(revenue), opex: r2(opex), ebitda: r2(ebitda),
      interest: r2(interest), pbt: r2(pbt), tax: r2(tax),
      net_income: r2(netIncome), principal: r2(principal),
      capex: 0, equity_cf: r2(equityCF), dscr: dscr
    })
  }

  var rawIrr = irrCalc(cashFlows)
  var irr    = rawIrr !== null ? r2(rawIrr * 100) : null
  var npv    = r2(npvCalc(wacc, cashFlows))

  var totalIn  = Math.abs(cashFlows.filter(function(cf) { return cf < 0 }).reduce(function(a, b) { return a + b }, 0))
  var totalOut = cashFlows.filter(function(cf) { return cf > 0 }).reduce(function(a, b) { return a + b }, 0)
  var em       = totalIn > 0 ? r2(totalOut / totalIn) : null

  return {
    irr: irr,
    npv: npv,
    equity_multiple: em,
    tdc: r2(tpc),
    debt_amount: r2(debtAmount),
    equity_amount: r2(equityAmount),
    dscr_series: dscrSeries,
    cash_flows: cfTable,
    construction_years: constructionYears,
    operations_years: opsYears
  }
}
