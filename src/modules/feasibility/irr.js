/**
 * irr.js
 * ---------------------------------------------------------------------------
 * IRR solver for XCEPTA RE Development Cash Flow Engine.
 *
 * Method: Newton-Raphson iteration on the NPV equation.
 *
 *   NPV(r) = Σ_t [ CF_t / (1 + r)^t ] = 0
 *
 *   f(r)  = NPV(r)
 *   f'(r) = −Σ_t [ t × CF_t / (1 + r)^(t+1) ]
 *
 *   r_new = r_old − f(r_old) / f'(r_old)
 *
 * Cash flows are MONTHLY. The function returns:
 *   - monthlyIRR  : periodic monthly rate
 *   - annualIRR   : effective annual rate = (1 + monthlyIRR)^12 − 1
 *
 * Two IRR perspectives:
 *
 *  UNLEVERAGED IRR (Project IRR):
 *    Cash flows: −total development cost (month 0) + construction outflows
 *                + all sales proceeds + exit proceeds
 *    i.e., before any financing (no loan draws, no interest, no equity/loan distinction)
 *
 *  LEVERAGED IRR (Equity IRR):
 *    Cash flows: −equity invested (month 0 and subsequent equity draws)
 *                + net cash to equity after loan repayment + exit proceeds
 *    i.e., what equity actually put in and took out
 *
 * Convention: t=0 is the land purchase / project start month.
 * ---------------------------------------------------------------------------
 * @module irr
 */

const MAX_ITERATIONS  = 1000;
const CONVERGENCE_TOL = 1e-10;
const INITIAL_GUESS   = 0.01;   // 1% monthly = ~12.7% annual starting guess

/**
 * Compute NPV of a cash flow series at rate r (monthly, 0-based index).
 *
 * @param {number[]} cashFlows - Array where index = month (0-based)
 * @param {number}   r         - Periodic (monthly) discount rate
 * @returns {number}
 */
export function npv(cashFlows, r) {
  if (r <= -1) return Infinity; // avoid division by zero / negative base
  return cashFlows.reduce((sum, cf, t) => sum + cf / Math.pow(1 + r, t), 0);
}

/**
 * Compute first derivative of NPV with respect to r.
 *
 * @param {number[]} cashFlows
 * @param {number}   r
 * @returns {number}
 */
function npvDerivative(cashFlows, r) {
  return cashFlows.reduce((sum, cf, t) => {
    if (t === 0) return sum;
    return sum - (t * cf) / Math.pow(1 + r, t + 1);
  }, 0);
}

/**
 * Solve for IRR using Newton-Raphson.
 *
 * @param {number[]} cashFlows          - Monthly cash flows, index = month
 * @param {number}   [guess=INITIAL_GUESS] - Starting monthly rate
 * @returns {{ monthlyIRR: number, annualIRR: number, iterations: number, converged: boolean }}
 * @throws {Error} if the series has no sign change (IRR undefined) or fails to converge
 */
export function solveIRR(cashFlows, guess = INITIAL_GUESS) {
  if (!cashFlows || cashFlows.length < 2) {
    throw new Error('IRR requires at least 2 cash flow periods');
  }

  // Guard: must have at least one sign change
  const hasPositive = cashFlows.some(cf => cf > 0);
  const hasNegative = cashFlows.some(cf => cf < 0);
  if (!hasPositive || !hasNegative) {
    throw new Error('IRR is undefined: cash flow series has no sign change');
  }

  let r    = guess;
  let iter = 0;

  while (iter < MAX_ITERATIONS) {
    const f  = npv(cashFlows, r);
    const df = npvDerivative(cashFlows, r);

    if (Math.abs(df) < 1e-15) {
      throw new Error('Newton-Raphson: derivative too small, cannot converge');
    }

    const rNew = r - f / df;

    // Clamp to avoid nonsensical rates during iteration
    const rClamped = Math.max(-0.9999, Math.min(rNew, 10.0));

    if (Math.abs(rClamped - r) < CONVERGENCE_TOL) {
      const annualIRR = Math.pow(1 + rClamped, 12) - 1;
      return {
        monthlyIRR: rClamped,
        annualIRR,
        iterations: iter + 1,
        converged:  true,
      };
    }

    r = rClamped;
    iter++;
  }

  throw new Error(`IRR did not converge after ${MAX_ITERATIONS} iterations. Last rate: ${r}`);
}

/**
 * Build the UNLEVERAGED (project-level) cash flow series.
 *
 * Unleveraged perspective ignores financing entirely:
 *   Month 0:   −landCost − upfrontSoftCosts
 *   Month 1..T: −(hardCostDraw + softCostDraw)  (construction outflows)
 *   Month 0..T+n: +salesProceeds (inflows as they arrive)
 *   Exit month: +netExitProceeds
 *
 * @param {Object} params
 * @param {number}   params.landCost            - Land/acquisition cost (month 0 outflow)
 * @param {number}   params.upfrontSoftCosts    - Soft costs paid at month 0
 * @param {number[]} params.monthlyHardCosts    - Hard cost draws months 1..T
 * @param {number[]} params.monthlySoftCosts    - Soft cost draws months 1..T
 * @param {number[]} params.monthlySalesProceeds - All sales inflows, index = project month
 * @param {number}   params.netExitProceeds     - Exit cash received at exitMonth
 * @param {number}   params.exitMonth           - Month index for exit proceeds
 * @param {number}   params.T                   - Construction duration
 * @param {number}   params.totalMonths         - Full timeline length (covers post-sale months)
 * @returns {number[]} Monthly cash flows (0-indexed), length = totalMonths
 */
export function buildUnleveragedCF(params) {
  const {
    landCost,
    upfrontSoftCosts = 0,
    monthlyHardCosts,
    monthlySoftCosts,
    monthlySalesProceeds,
    netExitProceeds,
    exitMonth,
    T,
    totalMonths,
  } = params;

  const length = totalMonths;
  const cf     = new Array(length).fill(0);

  // Month 0: land + upfront soft costs (outflows)
  cf[0] = -(landCost + upfrontSoftCosts);

  // Months 1..T: construction outflows
  for (let m = 1; m <= T; m++) {
    const idx = m - 1;
    cf[m] -= (monthlyHardCosts[idx] || 0) + (monthlySoftCosts[idx] || 0);
  }

  // Sales inflows (overlapping with construction period)
  for (let m = 0; m < Math.min(monthlySalesProceeds.length, length); m++) {
    cf[m] += monthlySalesProceeds[m] || 0;
  }

  // Exit proceeds
  if (exitMonth < length) {
    cf[exitMonth] += netExitProceeds;
  }

  return cf;
}

/**
 * Build the LEVERAGED (equity-level) cash flow series.
 *
 * Leveraged perspective: what equity investor puts in and gets back.
 *   Outflows: equity draws each month (negative)
 *   Inflows:  sales proceeds that flow to equity (after loan service) + exit net of loan repayment
 *
 * At exit:
 *   Net to equity = netExitProceeds + post-construction sales − finalLoanBalance
 *   (loan is repaid from exit/sales proceeds first)
 *
 * @param {Object} params
 * @param {import('./funding.js').MonthlyFundingRow[]} params.fundingRows - From buildFundingSchedule
 * @param {number[]} params.monthlySalesProceeds - All sales inflows (project timeline)
 * @param {number}   params.netExitProceeds      - Gross exit cash
 * @param {number}   params.exitMonth            - Month index for exit
 * @param {number}   params.finalLoanBalance     - Outstanding loan at exit (to be repaid)
 * @param {number}   params.T                    - Construction duration
 * @param {number}   [params.month0EquityOutflow=0] - Equity deployed at month 0 (land + upfront soft)
 * @param {number}   params.totalMonths          - Full timeline length
 * @returns {number[]} Equity cash flows (0-indexed), length = totalMonths
 */
export function buildLeveragedCF(params) {
  const {
    fundingRows,
    monthlySalesProceeds,
    netExitProceeds,
    exitMonth,
    finalLoanBalance,
    T,
    month0EquityOutflow = 0,
    totalMonths,
    unleveragedCF = [],
  } = params;

  const length = totalMonths;
  const cf     = new Array(length).fill(0);

  // ── Approach: LeveragedCF = UnleveragedCF + NetLoanEffect ─────────────────
  //
  // This is the standard project finance identity. The loan effect each month is:
  //   +loanDraw  (cash in from lender — reduces equity requirement)
  //   −loanRepayment (cash out from surplus going to loan — reduces equity upside)
  //   −cashInterestPaid (cash out for interest if not capitalized)
  //
  // The unleveraged CF is passed in (already computed).
  // At exit: equity receives (netExitProceeds − finalLoanBalance).
  //
  // We reconstruct from unleveragedCF + loan adjustments.
  // unleveragedCF is passed as a reference; we reconstruct from funding rows.

  // Copy unleveraged CF into leveraged CF as starting point
  for (let m = 0; m < Math.min(unleveragedCF.length, length); m++) {
    cf[m] = unleveragedCF[m];
  }

  // Apply loan effect per construction month: +loanDraw, -loanRepayment, -cashInterest
  for (const row of fundingRows) {
    const m = row.month; // 1-indexed
    if (m < length) {
      cf[m] += row.loanDraw;
      cf[m] -= row.loanRepayment;
      cf[m] -= row.cashInterestPaid;
    }
  }

  // At exit month: deduct final loan balance (repayment obligation)
  if (exitMonth < length) {
    cf[exitMonth] -= finalLoanBalance;
  }

  return cf;
}

/**
 * Compute both IRRs and return a summary.
 *
 * @param {number[]} unleveragedCF
 * @param {number[]} leveragedCF
 * @returns {{ unleveraged: Object, leveraged: Object }}
 */
export function computeIRRs(unleveragedCF, leveragedCF) {
  const unleveraged = solveIRR(unleveragedCF);
  const leveraged   = solveIRR(leveragedCF);

  return {
    unleveraged: {
      monthlyIRR:  round4(unleveraged.monthlyIRR),
      annualIRR:   round4(unleveraged.annualIRR),
      annualIRRpct: `${(unleveraged.annualIRR * 100).toFixed(2)}%`,
      iterations:  unleveraged.iterations,
    },
    leveraged: {
      monthlyIRR:  round4(leveraged.monthlyIRR),
      annualIRR:   round4(leveraged.annualIRR),
      annualIRRpct: `${(leveraged.annualIRR * 100).toFixed(2)}%`,
      iterations:  leveraged.iterations,
    },
    leverageLift: round4(leveraged.annualIRR - unleveraged.annualIRR),
    leverageLiftPct: `${((leveraged.annualIRR - unleveraged.annualIRR) * 100).toFixed(2)}%`,
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function round4(n) { return Math.round(n * 10000) / 10000; }
