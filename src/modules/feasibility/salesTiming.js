/**
 * salesTiming.js
 * ---------------------------------------------------------------------------
 * Sales cash flow scheduling for XCEPTA RE Development Cash Flow Engine.
 *
 * Sales phases:
 *   - PRE-CONSTRUCTION  : units sold before construction starts (month 0)
 *   - DURING            : units sold between month 1 and month T (construction)
 *   - POST-COMPLETION   : units sold after construction ends (month T+1 onward)
 *
 * Payment schedule (applied per unit):
 *   - deposit     : paid at time of sale (booking)
 *   - installments: spread across construction period for pre/during sales
 *   - handover    : paid at practical completion (month T)
 *
 * Revenue representation:
 *   - Inputs are in aggregate monetary values (not per-unit),
 *     since unit count and price mix are upstream concerns.
 *
 * Output:
 *   - Array of monthly cash inflows covering months 0..T+postSaleMonths
 * ---------------------------------------------------------------------------
 * @module salesTiming
 */

/**
 * @typedef {Object} SalesConfig
 * @property {number} totalGDV              - Total gross development value (all sales)
 * @property {number} T                     - Construction duration in months
 * @property {Object} phaseWeights         - Fraction of GDV sold in each phase
 * @property {number} phaseWeights.pre     - Pre-construction fraction  [0,1]
 * @property {number} phaseWeights.during  - During-construction fraction [0,1]
 * @property {number} phaseWeights.post    - Post-completion fraction [0,1]
 * @property {Object} paymentSchedule
 * @property {number} paymentSchedule.deposit      - Fraction paid at booking [0,1]
 * @property {number} paymentSchedule.installments - Fraction paid over construction [0,1]
 * @property {number} paymentSchedule.handover     - Fraction paid at completion [0,1]
 * @property {number} [postSaleMonths=6]   - Months after completion for post-sales to close
 * @property {string} [duringSalePattern='linear'] - 'linear' or 'backend' distribution of during-sales
 */

/**
 * Validate that phase weights and payment schedule each sum to 1.0.
 * Throws if validation fails.
 *
 * @param {SalesConfig} config
 */
function validateSalesConfig(config) {
  const { phaseWeights, paymentSchedule } = config;

  const phaseSum = phaseWeights.pre + phaseWeights.during + phaseWeights.post;
  if (Math.abs(phaseSum - 1.0) > 1e-9) {
    throw new Error(`Phase weights must sum to 1.0; got ${phaseSum.toFixed(6)}`);
  }

  const paySum = paymentSchedule.deposit + paymentSchedule.installments + paymentSchedule.handover;
  if (Math.abs(paySum - 1.0) > 1e-9) {
    throw new Error(`Payment schedule fractions must sum to 1.0; got ${paySum.toFixed(6)}`);
  }

  if (config.T <= 0 || !Number.isInteger(config.T)) {
    throw new Error('T must be a positive integer');
  }
  if (config.totalGDV < 0) {
    throw new Error('totalGDV must be >= 0');
  }
}

/**
 * Distribute booking-month collections across a segment.
 *
 * For a revenue block of size `revenue` sold across months `startMonth..endMonth`:
 *   - Each booking month collects: depositFrac × monthlyRevenue
 *   - Installments from each booking: spread from bookingMonth+1 to T (construction months)
 *   - Handover from each booking: hits month T (completion)
 *
 * Returns contributions to the master cash flow array (mutates `cf` in place).
 *
 * @param {number[]} cf              - Master cash flow array (mutated)
 * @param {number}   revenue         - Total revenue for this segment
 * @param {number}   startMonth      - First month units are sold (0-indexed project month)
 * @param {number}   endMonth        - Last month units are sold (inclusive)
 * @param {number}   completionMonth - Month T (handover date)
 * @param {Object}   ps              - Payment schedule {deposit, installments, handover}
 * @param {string}   salePattern     - 'linear' (equal per month) or 'backend' (60% last third)
 */
function distributeRevenue(cf, revenue, startMonth, endMonth, completionMonth, ps, salePattern) {
  const saleDuration = endMonth - startMonth + 1;
  if (saleDuration <= 0) return;

  // Build monthly sale fraction weights
  const weights = new Array(saleDuration).fill(0);

  if (salePattern === 'backend') {
    // 20% in first third, 30% in second third, 50% in final third
    const t1 = Math.floor(saleDuration / 3);
    const t2 = Math.floor((2 * saleDuration) / 3);
    for (let i = 0; i < saleDuration; i++) {
      const bIdx = i < t1 ? 0 : i < t2 ? 1 : 2;
      const months = bIdx === 0 ? Math.max(t1, 1) : bIdx === 1 ? Math.max(t2 - t1, 1) : Math.max(saleDuration - t2, 1);
      weights[i] = [0.20, 0.30, 0.50][bIdx] / months;
    }
  } else {
    // linear: equal monthly
    const w = 1 / saleDuration;
    for (let i = 0; i < saleDuration; i++) weights[i] = w;
  }

  // Normalise weights (floating-point safety)
  const wSum = weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < saleDuration; i++) weights[i] /= wSum;

  for (let idx = 0; idx < saleDuration; idx++) {
    const saleMonth    = startMonth + idx;
    const monthRevenue = revenue * weights[idx];

    // 1. Deposit: collected at booking
    cf[saleMonth] = (cf[saleMonth] || 0) + monthRevenue * ps.deposit;

    // 2. Installments: spread from month after booking to completion - 1
    const installStart = saleMonth + 1;
    const installEnd   = completionMonth - 1;
    const installMonths = installEnd - installStart + 1;

    if (installMonths > 0 && ps.installments > 0) {
      const monthlyInstall = (monthRevenue * ps.installments) / installMonths;
      for (let m = installStart; m <= installEnd; m++) {
        cf[m] = (cf[m] || 0) + monthlyInstall;
      }
    } else if (ps.installments > 0) {
      // Collapse installments into handover if no room
      cf[completionMonth] = (cf[completionMonth] || 0) + monthRevenue * ps.installments;
    }

    // 3. Handover: paid at completion month
    cf[completionMonth] = (cf[completionMonth] || 0) + monthRevenue * ps.handover;
  }
}

/**
 * Build the full sales cash inflow schedule.
 *
 * @param {SalesConfig} config
 * @returns {{ monthlySalesCF: number[], totalArrayLength: number }}
 *   monthlySalesCF: array of monthly cash inflows, index = project month (0 = pre-construction)
 *   totalArrayLength: length of the array
 */
export function buildSalesCashFlows(config) {
  validateSalesConfig(config);

  const {
    totalGDV,
    T,
    phaseWeights,
    paymentSchedule: ps,
    postSaleMonths = 6,
    duringSalePattern = 'linear',
  } = config;

  const completionMonth  = T;                             // month index of handover
  const totalMonths      = T + postSaleMonths + 1;       // 0..T+postSaleMonths
  const cf               = new Array(totalMonths).fill(0);

  // ── PRE-SALES ─────────────────────────────────────────────────────────────
  // All pre-sales booked at month 0 (before construction starts)
  if (phaseWeights.pre > 0) {
    const preRevenue = totalGDV * phaseWeights.pre;
    distributeRevenue(cf, preRevenue, 0, 0, completionMonth, ps, 'linear');
  }

  // ── DURING-CONSTRUCTION SALES ─────────────────────────────────────────────
  // Booked across months 1..T-1 (during construction, before handover)
  if (phaseWeights.during > 0 && T > 1) {
    const duringRevenue = totalGDV * phaseWeights.during;
    distributeRevenue(cf, duringRevenue, 1, T - 1, completionMonth, ps, duringSalePattern);
  }

  // ── POST-COMPLETION SALES ─────────────────────────────────────────────────
  // Booked across months T+1..T+postSaleMonths.
  // Post-sales: no installments (full payment at booking + handover split).
  // Simplified payment: deposit at booking, handover at same month (immediate settlement).
  if (phaseWeights.post > 0 && postSaleMonths > 0) {
    const postRevenue = totalGDV * phaseWeights.post;
    // Post-sale payment: deposit + installments both collected at booking; handover at same time.
    // Represent as: full GDV collected at time of sale (since property is complete).
    const postStart = completionMonth + 1;
    const postEnd   = completionMonth + postSaleMonths;
    const perMonth  = postRevenue / postSaleMonths;
    for (let m = postStart; m <= postEnd && m < totalMonths; m++) {
      cf[m] += perMonth; // 100% at sale since property complete
    }
  }

  return {
    monthlySalesCF:  cf,
    totalArrayLength: totalMonths,
  };
}

/**
 * Summarise total revenue collected by phase for audit/reconciliation.
 *
 * @param {number[]} monthlySalesCF
 * @param {number}   T
 * @param {number}   [postSaleMonths=6]
 * @returns {{ preAndDuring: number, postCompletion: number, total: number }}
 */
export function summariseSalesRevenue(monthlySalesCF, T, postSaleMonths = 6) {
  let preAndDuring = 0;
  let postCompletion = 0;

  for (let m = 0; m <= T; m++) {
    preAndDuring += monthlySalesCF[m] || 0;
  }
  for (let m = T + 1; m < monthlySalesCF.length; m++) {
    postCompletion += monthlySalesCF[m] || 0;
  }

  return {
    preAndDuring: Math.round(preAndDuring * 100) / 100,
    postCompletion: Math.round(postCompletion * 100) / 100,
    total: Math.round((preAndDuring + postCompletion) * 100) / 100,
  };
}
