/**
 * funding.js
 * ---------------------------------------------------------------------------
 * Equity-first / loan-second funding engine with capitalized interest.
 *
 * Funding waterfall per month:
 *   1. Determine gross cash need for the month (costs - sales proceeds)
 *   2. Draw from equity first until equity is fully deployed
 *   3. Draw from loan for any remaining need
 *   4. Accrued interest on outstanding loan balance (monthly compounding)
 *      is CAPITALIZED (added to loan balance, not a cash outflow) during
 *      the construction period
 *   5. At completion, loan balance (principal + capitalized interest) is
 *      repaid from sales proceeds and/or exit proceeds
 *
 * Interest convention:
 *   - Annual rate provided by caller → monthly rate = annualRate / 12
 *   - Compounding: end-of-month on the opening balance of that month
 *     (i.e., interest accrues on balance before this month's drawdown)
 *
 * Loan structure assumptions:
 *   - Loan is a development facility (drawdown-based, not fully drawn upfront)
 *   - No commitment fee on undrawn balance (can be added later as a parameter)
 *   - Arrangement fee (if any) is treated as an upfront cost in month 0
 * ---------------------------------------------------------------------------
 * @module funding
 */

/**
 * @typedef {Object} FundingConfig
 * @property {number}   equityAmount       - Total equity available
 * @property {number}   loanAmount         - Maximum loan facility amount
 * @property {number}   annualInterestRate - Loan interest rate (e.g., 0.08 for 8%)
 * @property {number[]} monthlyCostDraws   - Array of monthly cost draws (length = T)
 *                                          Index 0 = construction month 1
 * @property {number[]} monthlySalesProceeds - Array of monthly sales cash in (same length or longer)
 * @property {number}   T                  - Construction duration in months
 * @property {boolean}  [capitalizeInterest=true] - Capitalize during construction (default true)
 */

/**
 * @typedef {Object} MonthlyFundingRow
 * @property {number} month              - 1-indexed month number
 * @property {number} grossCostDraw      - Total cost outflow for the month
 * @property {number} salesProceeds      - Sales cash inflow for the month
 * @property {number} netFundingNeed     - grossCostDraw - salesProceeds (>0 means cash needed)
 * @property {number} equityDraw         - Equity drawn this month
 * @property {number} loanDraw           - Loan drawn this month
 * @property {number} equityBalance      - Cumulative equity deployed after this month
 * @property {number} loanBalance        - Outstanding loan balance after this month (incl. cap int)
 * @property {number} accruedInterest    - Interest accrued this month on loan balance
 * @property {number} capitalizedInterest - Interest added to loan balance this month
 * @property {number} cashInterestPaid   - Interest paid as cash this month (0 during construction if capped)
 * @property {number} equityRemaining    - Equity not yet deployed
 */

/**
 * @typedef {Object} FundingSchedule
 * @property {MonthlyFundingRow[]} rows
 * @property {number} totalEquityDeployed
 * @property {number} totalLoanDrawn
 * @property {number} totalCapitalizedInterest
 * @property {number} finalLoanBalance         - Loan balance to repay at exit
 * @property {number} equityShortfall          - > 0 if costs exceeded equity + loan
 * @property {boolean} loanCapacityBreached    - true if loan facility was insufficient
 */

/**
 * Run the monthly funding waterfall.
 *
 * @param {FundingConfig} config
 * @returns {FundingSchedule}
 */
export function buildFundingSchedule(config) {
  const {
    equityAmount,
    loanAmount,
    annualInterestRate,
    monthlyCostDraws,
    monthlySalesProceeds,
    T,
    capitalizeInterest = true,
  } = config;

  // Input validation
  if (equityAmount < 0) throw new Error('equityAmount must be >= 0');
  if (loanAmount < 0) throw new Error('loanAmount must be >= 0');
  if (annualInterestRate < 0) throw new Error('annualInterestRate must be >= 0');
  if (T <= 0 || !Number.isInteger(T)) throw new Error('T must be a positive integer');
  if (monthlyCostDraws.length < T) {
    throw new Error(`monthlyCostDraws must have at least ${T} elements`);
  }

  const monthlyRate = annualInterestRate / 12;

  let equityDeployed     = 0;
  let loanBalance        = 0;
  let totalCapInt        = 0;
  let loanCapacityBreached = false;
  let shortfall          = 0;
  const rows             = [];

  for (let m = 1; m <= T; m++) {
    const idx = m - 1;

    const grossCostDraw   = monthlyCostDraws[idx]      || 0;
    const salesProceeds   = monthlySalesProceeds[idx]  || 0;

    // ── Interest accrual on OPENING loan balance ───────────────────────────
    // Interest accrues on the balance at the START of the month (before new draw)
    const accruedInterest = loanBalance * monthlyRate;

    let capitalizedInterest = 0;
    let cashInterestPaid    = 0;

    if (capitalizeInterest) {
      capitalizedInterest = accruedInterest;
      loanBalance += capitalizedInterest; // Roll into balance
    } else {
      cashInterestPaid = accruedInterest; // Cash outflow
    }

    totalCapInt += capitalizedInterest;

    // ── Net funding need this month ────────────────────────────────────────
    // Sales proceeds offset cost draws before equity/loan is tapped
    const netFundingNeed = Math.max(0, grossCostDraw - salesProceeds);
    // If sales > costs, excess reduces cumulative drawn (handled at exit reconciliation)
    const surplus = Math.max(0, salesProceeds - grossCostDraw);

    // ── Equity-first draw ─────────────────────────────────────────────────
    const equityRemaining = equityAmount - equityDeployed;
    const equityDraw      = Math.min(netFundingNeed, equityRemaining);
    equityDeployed       += equityDraw;

    // ── Loan draw ─────────────────────────────────────────────────────────
    const loanNeed   = netFundingNeed - equityDraw;
    const loanSpace  = loanAmount - (loanBalance - capitalizedInterest); // space before cap int
    const loanDraw   = Math.min(loanNeed, Math.max(0, loanSpace));

    if (loanNeed > loanSpace + 1e-6) {
      loanCapacityBreached = true;
      shortfall += loanNeed - Math.max(0, loanSpace);
    }

    loanBalance += loanDraw;

    // Surplus reduces loan balance (sales proceeds paying down loan)
    let loanRepayment = 0;
    if (surplus > 0 && loanBalance > 0) {
      loanRepayment = Math.min(surplus, loanBalance);
      loanBalance -= loanRepayment;
    }

    rows.push({
      month:               m,
      grossCostDraw:       round2(grossCostDraw),
      salesProceeds:       round2(salesProceeds),
      netFundingNeed:      round2(netFundingNeed),
      surplus:             round2(surplus),
      equityDraw:          round2(equityDraw),
      loanDraw:            round2(loanDraw),
      loanRepayment:       round2(loanRepayment),
      accruedInterest:     round2(accruedInterest),
      capitalizedInterest: round2(capitalizedInterest),
      cashInterestPaid:    round2(cashInterestPaid),
      equityBalance:       round2(equityDeployed),
      loanBalance:         round2(loanBalance),
      equityRemaining:     round2(equityAmount - equityDeployed),
    });
  }

  return {
    rows,
    totalEquityDeployed:      round2(equityDeployed),
    totalLoanDrawn:           round2(rows.reduce((s, r) => s + r.loanDraw, 0)),
    totalCapitalizedInterest: round2(totalCapInt),
    finalLoanBalance:         round2(loanBalance),
    equityShortfall:          round2(shortfall),
    loanCapacityBreached,
  };
}

/**
 * Compute total financing cost (cash interest paid + capitalized interest).
 * Useful as a single TDC line item.
 *
 * @param {FundingSchedule} schedule
 * @returns {number}
 */
export function totalFinancingCost(schedule) {
  const cashInt = schedule.rows.reduce((s, r) => s + r.cashInterestPaid, 0);
  return round2(cashInt + schedule.totalCapitalizedInterest);
}

// ── Utility ──────────────────────────────────────────────────────────────────
function round2(n) {
  return Math.round(n * 100) / 100;
}
