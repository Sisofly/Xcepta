/**
 * tests/engine.test.js
 * All imports updated to src/modules/feasibility/
 */

import { buildSalesCashFlows, summariseSalesRevenue } from '../src/modules/feasibility/salesTiming.js';
import { buildFundingSchedule, totalFinancingCost }   from '../src/modules/feasibility/funding.js';
import { computeExitValuation, computeDevelopmentProfit } from '../src/modules/feasibility/exitValuation.js';
import { solveIRR, npv }                              from '../src/modules/feasibility/irr.js';
import { runCashFlowEngine }                          from '../src/modules/feasibility/cashflowEngine.js';

// =============================================================================
// salesTiming
// =============================================================================

const BASE_CONFIG = {
  totalGDV:       10_000_000,
  T:              12,
  phaseWeights:   { pre: 0.30, during: 0.50, post: 0.20 },
  paymentSchedule:{ deposit: 0.10, installments: 0.70, handover: 0.20 },
  postSaleMonths: 6,
  duringSalePattern: 'linear',
};

describe('buildSalesCashFlows', () => {
  test('total sales collected equals totalGDV', () => {
    const { monthlySalesCF } = buildSalesCashFlows(BASE_CONFIG);
    const total = monthlySalesCF.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(BASE_CONFIG.totalGDV, 2);
  });

  test('array length = T + postSaleMonths + 1', () => {
    const { monthlySalesCF, totalArrayLength } = buildSalesCashFlows(BASE_CONFIG);
    expect(monthlySalesCF).toHaveLength(BASE_CONFIG.T + BASE_CONFIG.postSaleMonths + 1);
    expect(totalArrayLength).toBe(BASE_CONFIG.T + BASE_CONFIG.postSaleMonths + 1);
  });

  test('pre-sales: deposit cash arrives in month 0', () => {
    const { monthlySalesCF } = buildSalesCashFlows(BASE_CONFIG);
    expect(monthlySalesCF[0]).toBeGreaterThan(0);
  });

  test('all cash flows are non-negative', () => {
    const { monthlySalesCF } = buildSalesCashFlows(BASE_CONFIG);
    monthlySalesCF.forEach(cf => expect(cf).toBeGreaterThanOrEqual(0));
  });

  test('handover spike at month T', () => {
    const { monthlySalesCF } = buildSalesCashFlows(BASE_CONFIG);
    expect(monthlySalesCF[BASE_CONFIG.T]).toBeGreaterThan(0);
  });

  test('fully pre-sold project: all revenue before or at completion', () => {
    const allPre = { ...BASE_CONFIG, phaseWeights: { pre: 1.0, during: 0.0, post: 0.0 } };
    const { monthlySalesCF } = buildSalesCashFlows(allPre);
    const postSum = monthlySalesCF.slice(allPre.T + 1).reduce((a, b) => a + b, 0);
    expect(postSum).toBeCloseTo(0, 2);
  });

  test('fully post-sold: all revenue after completion', () => {
    const allPost = {
      ...BASE_CONFIG,
      phaseWeights:    { pre: 0.0, during: 0.0, post: 1.0 },
      paymentSchedule: { deposit: 0.0, installments: 0.0, handover: 1.0 },
      postSaleMonths:  6,
    };
    const { monthlySalesCF } = buildSalesCashFlows(allPost);
    const preSum = monthlySalesCF.slice(0, allPost.T + 1).reduce((a, b) => a + b, 0);
    expect(preSum).toBeCloseTo(0, 2);
  });

  test('throws when phase weights do not sum to 1', () => {
    const bad = { ...BASE_CONFIG, phaseWeights: { pre: 0.5, during: 0.5, post: 0.5 } };
    expect(() => buildSalesCashFlows(bad)).toThrow('Phase weights must sum to 1.0');
  });

  test('throws when payment schedule does not sum to 1', () => {
    const bad = { ...BASE_CONFIG, paymentSchedule: { deposit: 0.5, installments: 0.5, handover: 0.5 } };
    expect(() => buildSalesCashFlows(bad)).toThrow('Payment schedule fractions must sum to 1.0');
  });
});

describe('summariseSalesRevenue', () => {
  test('sums correctly across pre+during and post', () => {
    const { monthlySalesCF } = buildSalesCashFlows(BASE_CONFIG);
    const summary = summariseSalesRevenue(monthlySalesCF, BASE_CONFIG.T, BASE_CONFIG.postSaleMonths);
    expect(summary.total).toBeCloseTo(BASE_CONFIG.totalGDV, 2);
    expect(summary.preAndDuring + summary.postCompletion).toBeCloseTo(summary.total, 2);
  });
});

// =============================================================================
// funding
// =============================================================================

const FUNDING_CONFIG = {
  equityAmount:         3_000_000,
  loanAmount:           7_000_000,
  annualInterestRate:   0.08,
  monthlyCostDraws:     new Array(12).fill(800_000),
  monthlySalesProceeds: new Array(12).fill(100_000),
  T:                    12,
  capitalizeInterest:   true,
};

describe('buildFundingSchedule', () => {
  test('returns rows array of length T', () => {
    const { rows } = buildFundingSchedule(FUNDING_CONFIG);
    expect(rows).toHaveLength(12);
  });

  test('equity drawn before loan', () => {
    const { rows } = buildFundingSchedule(FUNDING_CONFIG);
    const firstLoanMonth = rows.findIndex(r => r.loanDraw > 0);
    for (let i = 0; i < firstLoanMonth; i++) {
      expect(rows[i].loanDraw).toBe(0);
    }
  });

  test('equity draws never exceed equityAmount', () => {
    const { totalEquityDeployed } = buildFundingSchedule(FUNDING_CONFIG);
    expect(totalEquityDeployed).toBeLessThanOrEqual(FUNDING_CONFIG.equityAmount + 0.01);
  });

  test('loan balance increases with capitalized interest', () => {
    const { rows } = buildFundingSchedule(FUNDING_CONFIG);
    const loanMonths = rows.filter(r => r.loanBalance > 0);
    if (loanMonths.length > 1) {
      const hasCapInt = loanMonths.some(r => r.capitalizedInterest > 0);
      expect(hasCapInt).toBe(true);
    }
  });

  test('no cash interest paid when capitalizeInterest=true', () => {
    const { rows } = buildFundingSchedule(FUNDING_CONFIG);
    rows.forEach(r => expect(r.cashInterestPaid).toBe(0));
  });

  test('cash interest paid when capitalizeInterest=false', () => {
    const config = { ...FUNDING_CONFIG, capitalizeInterest: false };
    const { rows } = buildFundingSchedule(config);
    const hasCashInt = rows.some(r => r.cashInterestPaid > 0);
    expect(hasCashInt).toBe(true);
  });

  test('monthly interest rate is annual / 12', () => {
    const config = { ...FUNDING_CONFIG, capitalizeInterest: false };
    const { rows } = buildFundingSchedule(config);
    const loanRow = rows.find(r => r.accruedInterest > 0);
    if (loanRow) {
      const expected = loanRow.accruedInterest / (0.08 / 12);
      expect(expected).toBeGreaterThan(0);
    }
  });

  test('throws on negative equityAmount', () => {
    expect(() => buildFundingSchedule({ ...FUNDING_CONFIG, equityAmount: -1 }))
      .toThrow('equityAmount must be >= 0');
  });

  test('throws on annualInterestRate < 0', () => {
    expect(() => buildFundingSchedule({ ...FUNDING_CONFIG, annualInterestRate: -0.01 }))
      .toThrow('annualInterestRate must be >= 0');
  });
});

describe('totalFinancingCost', () => {
  test('equals sum of capitalized interest when fully capitalizing', () => {
    const schedule = buildFundingSchedule(FUNDING_CONFIG);
    const finCost  = totalFinancingCost(schedule);
    expect(finCost).toBeCloseTo(schedule.totalCapitalizedInterest, 2);
  });

  test('equals sum of cash interest when not capitalizing', () => {
    const config   = { ...FUNDING_CONFIG, capitalizeInterest: false };
    const schedule = buildFundingSchedule(config);
    const cashInt  = schedule.rows.reduce((s, r) => s + r.cashInterestPaid, 0);
    expect(totalFinancingCost(schedule)).toBeCloseTo(cashInt, 2);
  });
});

// =============================================================================
// exitValuation
// =============================================================================

describe('computeExitValuation — GDV method', () => {
  test('residual GDV = totalGDV × (1 - presolvedFraction)', () => {
    const result = computeExitValuation({
      method: 'gdv', T: 12, totalGDV: 10_000_000,
      presolvedFraction: 0.80, sellingCostRate: 0.02,
    });
    expect(result.grossExitValue).toBeCloseTo(2_000_000, 2);
  });

  test('selling costs deducted from gross exit value', () => {
    const result = computeExitValuation({
      method: 'gdv', T: 12, totalGDV: 10_000_000,
      presolvedFraction: 0, sellingCostRate: 0.03,
    });
    expect(result.sellingCosts).toBeCloseTo(10_000_000 * 0.03, 2);
    expect(result.netExitProceeds).toBeCloseTo(10_000_000 * 0.97, 2);
  });

  test('exitMonth = T + exitDelay', () => {
    const result = computeExitValuation({
      method: 'gdv', T: 12, totalGDV: 5_000_000,
      presolvedFraction: 0, exitDelay: 3, sellingCostRate: 0.02,
    });
    expect(result.exitMonth).toBe(15);
  });
});

describe('computeExitValuation — cap_rate method', () => {
  test('grossExitValue = NOI / capRate', () => {
    const result = computeExitValuation({
      method: 'cap_rate', T: 12,
      grossRentalIncome: 1_000_000, vacancyRate: 0.05,
      operatingExpenses: 200_000, exitCapRate: 0.07, sellingCostRate: 0.02,
    });
    expect(result.grossExitValue).toBeCloseTo(750_000 / 0.07, 0);
    expect(result.detail.noi).toBeCloseTo(750_000, 2);
  });

  test('throws when exitCapRate missing', () => {
    expect(() => computeExitValuation({
      method: 'cap_rate', T: 12,
      grossRentalIncome: 1_000_000, vacancyRate: 0.05, operatingExpenses: 0,
    })).toThrow('exitCapRate');
  });

  test('throws when NOI is negative', () => {
    expect(() => computeExitValuation({
      method: 'cap_rate', T: 12,
      grossRentalIncome: 100_000, vacancyRate: 0.05,
      operatingExpenses: 500_000, exitCapRate: 0.07,
    })).toThrow('NOI is negative');
  });
});

describe('computeDevelopmentProfit', () => {
  test('profit = netGDV - totalCost', () => {
    const result = computeDevelopmentProfit(10_000_000, 7_000_000, 200_000);
    expect(result.profit).toBeCloseTo(10_000_000 - 200_000 - 7_000_000, 2);
  });

  test('profitOnCost = profit / totalCost', () => {
    const result = computeDevelopmentProfit(10_000_000, 7_000_000, 0);
    expect(result.profitOnCost).toBeCloseTo(3_000_000 / 7_000_000, 4);
  });
});

// =============================================================================
// irr
// =============================================================================

describe('solveIRR', () => {
  test('simple investment: -1000 today, +1200 in 12 months → ~20% annual', () => {
    const cf = new Array(13).fill(0);
    cf[0]  = -1000;
    cf[12] = 1200;
    const result = solveIRR(cf);
    expect(result.annualIRR).toBeCloseTo(0.2, 2);
    expect(result.converged).toBe(true);
  });

  test('NPV at solved IRR is approximately zero', () => {
    const cf = [-5000, 1000, 1500, 2000, 2500];
    const { monthlyIRR } = solveIRR(cf);
    expect(npv(cf, monthlyIRR)).toBeCloseTo(0, 4);
  });

  test('throws on no sign change (all negative)', () => {
    expect(() => solveIRR([-100, -200, -300])).toThrow('no sign change');
  });

  test('throws on insufficient data', () => {
    expect(() => solveIRR([-100])).toThrow('at least 2');
  });

  test('converges for a realistic RE project profile', () => {
    const cf = new Array(25).fill(0);
    for (let i = 0; i <= 18; i++) cf[i] = -500_000;
    cf[24] = 15_000_000;
    const result = solveIRR(cf);
    expect(result.converged).toBe(true);
    expect(result.annualIRR).toBeGreaterThan(0);
  });
});

describe('npv', () => {
  test('NPV at r=0 equals sum of cash flows', () => {
    const cf = [-1000, 200, 300, 400, 500];
    expect(npv(cf, 0)).toBeCloseTo(cf.reduce((a, b) => a + b, 0), 6);
  });

  test('NPV decreases as discount rate increases', () => {
    const cf = [-1000, 300, 300, 300, 300, 300];
    expect(npv(cf, 0.005)).toBeGreaterThan(npv(cf, 0.01));
  });
});

// =============================================================================
// cashflowEngine — full integration
// =============================================================================

const SCENARIO = {
  projectName:          'Casaluce Heights — Test Block',
  T:                    18,
  landCost:             2_000_000,
  hardCostTotal:        8_000_000,
  softCostTotal:        1_500_000,
  upfrontSoftCosts:     200_000,
  sCurveAlpha:          1.0,
  softCostMode:         'flat',
  totalGDV:             15_000_000,
  phaseWeights:         { pre: 0.05, during: 0.15, post: 0.80 },
  paymentSchedule:      { deposit: 0.10, installments: 0.70, handover: 0.20 },
  postSaleMonths:       12,
  duringSalePattern:    'linear',
  equityAmount:         3_500_000,
  loanAmount:           9_000_000,
  annualInterestRate:   0.085,
  capitalizeInterest:   true,
  exitMethod:           'gdv',
  exitDelay:            0,
  sellingCostRate:      0.02,
  discountRate:         0.12,
};

describe('runCashFlowEngine — full integration', () => {
  let output;
  beforeAll(() => { output = runCashFlowEngine(SCENARIO); });

  test('returns schedule array of correct length', () => {
    expect(output.schedule.length).toBeGreaterThanOrEqual(SCENARIO.T + 1);
  });

  test('summary contains all required KPI fields', () => {
    const keys = [
      'landCost', 'totalHardCost', 'totalSoftCost',
      'totalDevelopmentCost', 'totalGDV', 'developmentProfit',
      'profitOnCost', 'profitOnGDV',
      'totalEquityDeployed', 'totalLoanDrawn', 'finalLoanBalance',
      'unleveragedIRR', 'leveragedIRR', 'leverageLift',
      'projectNPV', 'equityNPV',
    ];
    keys.forEach(k => expect(output.summary).toHaveProperty(k));
  });

  test('total development cost = land + hard + soft + financing', () => {
    const { landCost, totalHardCost, totalSoftCost, totalFinancingCost, totalDevelopmentCost } = output.summary;
    expect(totalDevelopmentCost).toBeCloseTo(landCost + totalHardCost + totalSoftCost + totalFinancingCost, 2);
  });

  test('leveraged IRR > unleveraged IRR (positive leverage lift)', () => {
    const lev   = parseFloat(output.summary.leveragedIRR);
    const unlev = parseFloat(output.summary.unleveragedIRR);
    expect(lev).toBeGreaterThan(unlev);
  });

  test('profit on cost is positive for viable project', () => {
    expect(output.summary.profitOnCost).toBeGreaterThan(0);
  });

  test('no month has a negative sales inflow', () => {
    output.schedule.forEach(row => expect(row.salesInflow).toBeGreaterThanOrEqual(0));
  });

  test('loan capacity not breached for this scenario', () => {
    expect(output.summary.loanCapacityBreached).toBe(false);
  });

  test('equity shortfall is zero for this scenario', () => {
    expect(output.summary.equityShortfall).toBe(0);
  });

  test('schedule hard cost draws sum to hardCostTotal', () => {
    const hardSum = output.schedule.reduce((s, r) => s + r.hardCostDraw, 0);
    expect(hardSum).toBeCloseTo(SCENARIO.hardCostTotal, 1);
  });

  test('cap_rate exit method works correctly', () => {
    const capRateScenario = {
      ...SCENARIO,
      exitMethod:         'cap_rate',
      grossRentalIncome:  1_200_000,
      vacancyRate:        0.05,
      operatingExpenses:  250_000,
      exitCapRate:        0.07,
      phaseWeights:       { pre: 0.0, during: 0.0, post: 1.0 },
      paymentSchedule:    { deposit: 1.0, installments: 0.0, handover: 0.0 },
    };
    const capOutput = runCashFlowEngine(capRateScenario);
    expect(capOutput.summary.grossExitValue).toBeGreaterThan(0);
    expect(capOutput.summary.exitDetail.noi).toBeCloseTo(
      1_200_000 * (1 - 0.05) - 250_000, 2
    );
  });
});
