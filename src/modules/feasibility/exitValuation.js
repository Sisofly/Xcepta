/**
 * exitValuation.js
 * ---------------------------------------------------------------------------
 * Exit valuation for XCEPTA RE Development Cash Flow Engine.
 *
 * Two exit approaches (caller selects via config.method):
 *
 *  1. GDV-BASED (residential / for-sale developments)
 *     Exit value = totalGDV minus any unsold units' value already in sales CF.
 *     Residual exit = GDV of unsold units (if any remain at completion month).
 *     In a fully pre-sold project, residual exit GDV = 0.
 *
 *  2. CAP-RATE (income-producing / hold-to-rent developments)
 *     Exit value = Stabilised NOI / exitCapRate
 *     Stabilised NOI = grossRentalIncome × (1 - vacancyRate) - operatingExpenses
 *
 * The exit proceeds come in at completionMonth + exitMonth (default 0 = at completion).
 *
 * Selling costs (agency fees, transfer fees, legal) are deducted from gross exit value.
 * ---------------------------------------------------------------------------
 * @module exitValuation
 */

/**
 * @typedef {Object} ExitConfig
 * @property {'gdv' | 'cap_rate'}  method           - Valuation method
 * @property {number}              T                 - Construction completion month (project timeline index)
 * @property {number}              [exitDelay=0]     - Months after completion before exit cash received
 *
 * For GDV method:
 * @property {number}              [totalGDV]        - Total gross development value
 * @property {number}              [presolvedFraction=0] - Fraction already collected in sales CF (0–1)
 *
 * For cap_rate method:
 * @property {number}              [grossRentalIncome]   - Annual gross rental income at stabilisation
 * @property {number}              [vacancyRate=0.05]    - Vacancy as decimal (e.g. 0.05 = 5%)
 * @property {number}              [operatingExpenses]   - Annual operating expenses
 * @property {number}              [exitCapRate]         - Exit cap rate (e.g. 0.07 = 7%)
 *
 * Common:
 * @property {number}              [sellingCostRate=0.02] - Selling costs as fraction of gross value
 */

/**
 * @typedef {Object} ExitResult
 * @property {number} grossExitValue   - Valuation before selling costs
 * @property {number} sellingCosts     - Transaction costs
 * @property {number} netExitProceeds  - Cash received (gross - selling costs)
 * @property {number} exitMonth        - Project timeline month the cash is received
 * @property {string} method           - Method used
 * @property {Object} [detail]         - Method-specific breakdown
 */

/**
 * Compute exit valuation and return net cash proceeds.
 *
 * @param {ExitConfig} config
 * @returns {ExitResult}
 */
export function computeExitValuation(config) {
  const {
    method,
    T,
    exitDelay = 0,
    sellingCostRate = 0.02,
  } = config;

  if (!['gdv', 'cap_rate'].includes(method)) {
    throw new Error(`Unknown exit method: "${method}". Use 'gdv' or 'cap_rate'`);
  }
  if (T <= 0 || !Number.isInteger(T)) throw new Error('T must be a positive integer');
  if (exitDelay < 0) throw new Error('exitDelay must be >= 0');
  if (sellingCostRate < 0 || sellingCostRate >= 1) {
    throw new Error('sellingCostRate must be in [0, 1)');
  }

  let grossExitValue = 0;
  let detail         = {};

  if (method === 'gdv') {
    const { totalGDV = 0, presolvedFraction = 0 } = config;
    if (totalGDV < 0) throw new Error('totalGDV must be >= 0');
    if (presolvedFraction < 0 || presolvedFraction > 1) {
      throw new Error('presolvedFraction must be in [0, 1]');
    }

    // Residual GDV = portion not yet monetised through sales cash flows
    const residualGDV = totalGDV * (1 - presolvedFraction);
    grossExitValue    = residualGDV;

    detail = {
      totalGDV:          round2(totalGDV),
      presolvedFraction,
      residualGDVvalue:  round2(residualGDV),
    };
  }

  if (method === 'cap_rate') {
    const {
      grossRentalIncome = 0,
      vacancyRate       = 0.05,
      operatingExpenses = 0,
      exitCapRate,
    } = config;

    if (!exitCapRate || exitCapRate <= 0 || exitCapRate >= 1) {
      throw new Error('exitCapRate must be a positive decimal less than 1 (e.g. 0.07)');
    }
    if (vacancyRate < 0 || vacancyRate >= 1) throw new Error('vacancyRate must be in [0, 1)');
    if (grossRentalIncome < 0) throw new Error('grossRentalIncome must be >= 0');
    if (operatingExpenses < 0) throw new Error('operatingExpenses must be >= 0');

    const effectiveGrossIncome = grossRentalIncome * (1 - vacancyRate);
    const noi                  = effectiveGrossIncome - operatingExpenses;

    if (noi < 0) {
      throw new Error(`NOI is negative (${round2(noi)}). Check rental income and operating expenses.`);
    }

    grossExitValue = noi / exitCapRate;

    detail = {
      grossRentalIncome:    round2(grossRentalIncome),
      vacancyRate,
      effectiveGrossIncome: round2(effectiveGrossIncome),
      operatingExpenses:    round2(operatingExpenses),
      noi:                  round2(noi),
      exitCapRate,
      impliedMultiple:      round2(1 / exitCapRate),
    };
  }

  const sellingCosts    = grossExitValue * sellingCostRate;
  const netExitProceeds = grossExitValue - sellingCosts;
  const exitMonth       = T + exitDelay;

  return {
    grossExitValue:  round2(grossExitValue),
    sellingCosts:    round2(sellingCosts),
    netExitProceeds: round2(netExitProceeds),
    exitMonth,
    method,
    detail,
  };
}

/**
 * Compute development profit margin and development yield (cost yield).
 *
 * @param {number} gdv           - Gross development value
 * @param {number} totalCost     - Total development cost (land + hard + soft + finance)
 * @param {number} [sellingCosts=0] - Selling costs (if not already in totalCost)
 * @returns {{ profit: number, profitOnCost: number, profitOnGDV: number, developmentYield: number }}
 */
export function computeDevelopmentProfit(gdv, totalCost, sellingCosts = 0) {
  if (gdv < 0) throw new Error('gdv must be >= 0');
  if (totalCost <= 0) throw new Error('totalCost must be > 0');

  const netGDV       = gdv - sellingCosts;
  const profit       = netGDV - totalCost;
  const profitOnCost = profit / totalCost;
  const profitOnGDV  = profit / gdv;

  return {
    profit:         round2(profit),
    profitOnCost:   round4(profitOnCost),   // e.g. 0.2345 = 23.45%
    profitOnGDV:    round4(profitOnGDV),
    netGDV:         round2(netGDV),
    totalCost:      round2(totalCost),
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
