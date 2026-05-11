/**
 * cashflowEngine.js
 * ---------------------------------------------------------------------------
 * XCEPTA Real Estate Development Cash Flow Engine — Main Orchestrator
 *
 * Wires together:
 *   1. S-curve construction drawdown  (scurve.js)
 *   2. Sales timing                   (salesTiming.js)
 *   3. Equity-first / loan funding    (funding.js)
 *   4. Exit valuation                 (exitValuation.js)
 *   5. Leveraged + unleveraged IRR    (irr.js)
 *
 * Entry point: runCashFlowEngine(inputs)
 * Returns:     full monthly schedule + summary KPIs
 *
 * All monetary values in the same currency unit (e.g. JOD thousands).
 * ---------------------------------------------------------------------------
 * @module cashflowEngine
 */

import { buildSCurveSchedule, buildSoftCostSchedule } from './scurve.js';
import { buildSalesCashFlows, summariseSalesRevenue  } from './salesTiming.js';
import { buildFundingSchedule, totalFinancingCost     } from './funding.js';
import { computeExitValuation, computeDevelopmentProfit } from './exitValuation.js';
import {
  buildUnleveragedCF,
  buildLeveragedCF,
  computeIRRs,
  npv,
} from './irr.js';

/**
 * @typedef {Object} EngineInputs
 *
 * ── Project fundamentals ─────────────────────────────────────────────────────
 * @property {string}  projectName
 * @property {number}  T                     - Construction duration (months)
 * @property {number}  landCost              - Acquisition cost (month 0 outflow)
 *
 * ── Cost structure ───────────────────────────────────────────────────────────
 * @property {number}  hardCostTotal         - Total construction hard costs
 * @property {number}  softCostTotal         - Total soft costs (design, legal, etc.)
 * @property {number}  [upfrontSoftCosts=0]  - Soft costs paid at month 0 (pre-construction)
 * @property {number}  [sCurveAlpha=1]       - S-curve shape (1=symmetric, <1 front-loaded)
 * @property {string}  [softCostMode='flat'] - 'flat' | 'front' | 'proportional'
 *
 * ── Sales ────────────────────────────────────────────────────────────────────
 * @property {number}  totalGDV
 * @property {Object}  phaseWeights          - { pre, during, post } must sum to 1
 * @property {Object}  paymentSchedule       - { deposit, installments, handover } must sum to 1
 * @property {number}  [postSaleMonths=6]
 * @property {string}  [duringSalePattern='linear']
 *
 * ── Financing ────────────────────────────────────────────────────────────────
 * @property {number}  equityAmount
 * @property {number}  loanAmount
 * @property {number}  annualInterestRate     - e.g. 0.08 for 8%
 * @property {boolean} [capitalizeInterest=true]
 *
 * ── Exit ─────────────────────────────────────────────────────────────────────
 * @property {'gdv'|'cap_rate'} exitMethod
 * @property {number}  [exitDelay=0]          - Months after completion for exit
 * @property {number}  [sellingCostRate=0.02]
 * For GDV:     (totalGDV and phaseWeights.post already captured)
 * For cap_rate: grossRentalIncome, vacancyRate, operatingExpenses, exitCapRate
 *
 * ── IRR ──────────────────────────────────────────────────────────────────────
 * @property {number}  [discountRate=0.10]   - For NPV calculation (annual)
 */

/**
 * Run the full XCEPTA development cash flow engine.
 *
 * @param {EngineInputs} inputs
 * @returns {EngineOutput}
 */
export function runCashFlowEngine(inputs) {
  const {
    projectName          = 'Untitled Project',
    T,
    landCost,
    hardCostTotal,
    softCostTotal,
    upfrontSoftCosts     = 0,
    sCurveAlpha          = 1.0,
    softCostMode         = 'flat',
    totalGDV,
    phaseWeights,
    paymentSchedule,
    postSaleMonths       = 6,
    duringSalePattern    = 'linear',
    equityAmount,
    loanAmount,
    annualInterestRate,
    capitalizeInterest   = true,
    exitMethod,
    exitDelay            = 0,
    sellingCostRate      = 0.02,
    discountRate         = 0.10,
    // cap_rate exit params (pass-through)
    grossRentalIncome,
    vacancyRate          = 0.05,
    operatingExpenses    = 0,
    exitCapRate,
  } = inputs;

  // ── STEP 1: Cost Schedules ──────────────────────────────────────────────────
  const hardCostSchedule = buildSCurveSchedule(hardCostTotal, T, sCurveAlpha);

  const constructionSoftCosts = softCostTotal - upfrontSoftCosts;
  const softCostSchedule      = buildSoftCostSchedule(
    constructionSoftCosts, T, softCostMode, sCurveAlpha
  );

  // ── STEP 2: Sales Cash Flows ────────────────────────────────────────────────
  const salesResult = buildSalesCashFlows({
    totalGDV,
    T,
    phaseWeights,
    paymentSchedule,
    postSaleMonths,
    duringSalePattern,
  });
  const { monthlySalesCF } = salesResult;

  // ── STEP 3: Funding Schedule ────────────────────────────────────────────────
  // monthlyCostDraws covers months 1..T (no month 0 here; land is handled separately)
  const monthlyCostDraws = hardCostSchedule.map((h, i) => h + (softCostSchedule[i] || 0));

  const funding = buildFundingSchedule({
    equityAmount,
    loanAmount,
    annualInterestRate,
    monthlyCostDraws,
    monthlySalesProceeds: monthlySalesCF.slice(1, T + 1), // construction months only
    T,
    capitalizeInterest,
  });

  // ── STEP 4: Exit Valuation ──────────────────────────────────────────────────
  // For GDV exit: presolved fraction = ALL phase weights (pre + during + post = 1.0 when all
  // units are captured in the sales phase model). Residual exit GDV only applies when there are
  // genuinely unsold units outside the phaseWeights model (e.g. bulk unsold disposal).
  // If phaseWeights sum to 1.0, residualGDV = 0 — all revenue is in the sales cash flows.
  const presoldFraction = phaseWeights.pre + phaseWeights.during + phaseWeights.post;

  const exitConfig = {
    method:          exitMethod,
    T,
    exitDelay,
    sellingCostRate,
    // GDV params
    totalGDV,
    presolvedFraction: presoldFraction,
    // cap_rate params
    grossRentalIncome,
    vacancyRate,
    operatingExpenses,
    exitCapRate,
  };

  const exit = computeExitValuation(exitConfig);

  // ── STEP 5: Compute full project timeline ──────────────────────────────────
  // Must cover construction period, all post-sale months, AND exit delay
  const totalMonths = Math.max(exit.exitMonth, T + postSaleMonths) + 1;

  // ── STEP 6: Unleveraged Cash Flows ─────────────────────────────────────────
  const unleveragedCF = buildUnleveragedCF({
    landCost,
    upfrontSoftCosts,
    monthlyHardCosts:     hardCostSchedule,
    monthlySoftCosts:     softCostSchedule,
    monthlySalesProceeds: monthlySalesCF,
    netExitProceeds:      exit.netExitProceeds,
    exitMonth:            exit.exitMonth,
    T,
    totalMonths,
  });

  // ── STEP 7: Leveraged (Equity) Cash Flows ──────────────────────────────────
  const leveragedCF = buildLeveragedCF({
    fundingRows:          funding.rows,
    monthlySalesProceeds: monthlySalesCF,
    netExitProceeds:      exit.netExitProceeds,
    exitMonth:            exit.exitMonth,
    finalLoanBalance:     funding.finalLoanBalance,
    T,
    month0EquityOutflow:  landCost + upfrontSoftCosts,
    totalMonths,
    unleveragedCF,
  });

  // ── STEP 8: IRR ─────────────────────────────────────────────────────────────
  const irrs = computeIRRs(unleveragedCF, leveragedCF);

  // ── STEP 8: NPV ─────────────────────────────────────────────────────────────
  const monthlyDiscountRate = Math.pow(1 + discountRate, 1 / 12) - 1;
  const projectNPV          = npv(unleveragedCF, monthlyDiscountRate);
  const equityNPV           = npv(leveragedCF,   monthlyDiscountRate);

  // ── STEP 9: Summary KPIs ────────────────────────────────────────────────────
  const totalHardCost     = hardCostTotal;
  const totalSoftCost     = softCostTotal;
  const totalFinCost      = totalFinancingCost(funding);
  const totalDevCost      = landCost + totalHardCost + totalSoftCost + totalFinCost;

  const salesSummary = summariseSalesRevenue(monthlySalesCF, T, postSaleMonths);
  const devProfit    = computeDevelopmentProfit(totalGDV, totalDevCost, exit.sellingCosts);

  // ── STEP 11: Assemble Monthly Schedule ─────────────────────────────────────
  const maxMonth = totalMonths - 1;
  const schedule = [];

  for (let m = 0; m <= maxMonth; m++) {
    const fRow         = funding.rows.find(r => r.month === m) || null;
    const isConstruct  = m >= 1 && m <= T;

    schedule.push({
      month:                m,
      hardCostDraw:         isConstruct ? round2(hardCostSchedule[m - 1] || 0) : 0,
      softCostDraw:         m === 0
        ? round2(upfrontSoftCosts)
        : isConstruct ? round2(softCostSchedule[m - 1] || 0) : 0,
      totalCostDraw:        m === 0
        ? round2(landCost + upfrontSoftCosts)
        : isConstruct ? round2((hardCostSchedule[m-1]||0) + (softCostSchedule[m-1]||0)) : 0,
      salesInflow:          round2(monthlySalesCF[m] || 0),
      equityDraw:           fRow ? fRow.equityDraw : 0,
      loanDraw:             fRow ? fRow.loanDraw : 0,
      loanBalance:          fRow ? fRow.loanBalance : m > T ? round2(funding.finalLoanBalance) : 0,
      capitalizedInterest:  fRow ? fRow.capitalizedInterest : 0,
      cashInterestPaid:     fRow ? fRow.cashInterestPaid : 0,
      unleveragedCF:        round2(unleveragedCF[m] || 0),
      leveragedCF:          round2(leveragedCF[m] || 0),
      exitProceeds:         m === exit.exitMonth ? round2(exit.netExitProceeds) : 0,
    });
  }

  return {
    projectName,
    schedule,
    summary: {
      // Cost breakdown
      landCost:                   round2(landCost),
      totalHardCost:              round2(totalHardCost),
      totalSoftCost:              round2(totalSoftCost),
      totalCapitalizedInterest:   round2(funding.totalCapitalizedInterest),
      totalFinancingCost:         round2(totalFinCost),
      totalDevelopmentCost:       round2(totalDevCost),

      // Revenue
      totalGDV:                   round2(totalGDV),
      salesPreAndDuring:          salesSummary.preAndDuring,
      salesPost:                  salesSummary.postCompletion,
      totalSalesCollected:        salesSummary.total,

      // Exit
      grossExitValue:             exit.grossExitValue,
      sellingCosts:               exit.sellingCosts,
      netExitProceeds:            exit.netExitProceeds,
      exitMonth:                  exit.exitMonth,
      exitDetail:                 exit.detail,

      // Profitability
      developmentProfit:          devProfit.profit,
      profitOnCost:               devProfit.profitOnCost,
      profitOnCostPct:            `${(devProfit.profitOnCost * 100).toFixed(2)}%`,
      profitOnGDV:                devProfit.profitOnGDV,
      profitOnGDVpct:             `${(devProfit.profitOnGDV * 100).toFixed(2)}%`,

      // Financing
      totalEquityDeployed:        round2(funding.totalEquityDeployed),
      totalLoanDrawn:             round2(funding.totalLoanDrawn),
      finalLoanBalance:           round2(funding.finalLoanBalance),
      loanCapacityBreached:       funding.loanCapacityBreached,
      equityShortfall:            round2(funding.equityShortfall),
      ltv:                        round4(funding.totalLoanDrawn / totalDevCost),

      // Returns
      projectNPV:                 round2(projectNPV),
      equityNPV:                  round2(equityNPV),
      unleveragedIRR:             irrs.unleveraged.annualIRRpct,
      leveragedIRR:               irrs.leveraged.annualIRRpct,
      leverageLift:               irrs.leverageLiftPct,
      irrDetail:                  irrs,

      // Flags
      constructionMonths:         T,
      sCurveAlpha,
    },
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
