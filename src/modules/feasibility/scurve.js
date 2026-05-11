/**
 * scurve.js
 * ---------------------------------------------------------------------------
 * S-curve construction drawdown for XCEPTA RE Development Cash Flow Engine.
 *
 * Formula: cumulative % at month t uses the cosine S-curve:
 *   cumPct(t) = 0.5 × (1 − cos(π × t / T))
 *
 * This is the industry-standard symmetric S-curve used in RE project finance.
 * It produces 0% at t=0, 50% at midpoint, and 100% at t=T.
 *
 * For asymmetric curves (peak earlier or later), the caller can pass a
 * shape-bias parameter α ∈ (0, 2):
 *   - α = 1.0  → symmetric (default)
 *   - α < 1.0  → front-loaded (peak draw early)
 *   - α > 1.0  → back-loaded (peak draw late)
 *
 * Asymmetric formula: cumPct(t) = 0.5 × (1 − cos(π × (t/T)^α))
 * ---------------------------------------------------------------------------
 * @module scurve
 */

/**
 * Compute the cumulative S-curve percentage at a given month.
 *
 * @param {number} t         - Current month index (0-based, 0 = start of construction)
 * @param {number} T         - Total construction duration in months
 * @param {number} [alpha=1] - Shape bias (1 = symmetric, <1 front-loaded, >1 back-loaded)
 * @returns {number}           Cumulative percentage drawn [0, 1]
 */
export function sCurveCumulative(t, T, alpha = 1.0) {
  if (T <= 0) throw new Error('Construction duration T must be > 0');
  if (t < 0) throw new Error('Month index t must be >= 0');
  if (alpha <= 0) throw new Error('Alpha must be > 0');

  if (t === 0) return 0;
  if (t >= T) return 1;

  const normalised = Math.pow(t / T, alpha);
  return 0.5 * (1 - Math.cos(Math.PI * normalised));
}

/**
 * Generate a monthly draw schedule for total hard costs using the S-curve.
 *
 * Returns an array of length T where each element is the cash draw for that
 * month (absolute amount, not percentage). The array sum equals hardCostTotal.
 *
 * NOTE: Construction months are 1-indexed in the output (month 1 = first draw,
 * month T = final draw). The caller maps these to the project timeline.
 *
 * @param {number} hardCostTotal - Total hard construction cost (absolute amount)
 * @param {number} T             - Construction duration in months
 * @param {number} [alpha=1]     - Shape bias
 * @returns {number[]}             Monthly hard cost draws, length T
 */
export function buildSCurveSchedule(hardCostTotal, T, alpha = 1.0) {
  if (hardCostTotal < 0) throw new Error('hardCostTotal must be >= 0');
  if (T <= 0 || !Number.isInteger(T)) throw new Error('T must be a positive integer');

  const schedule = new Array(T).fill(0);
  let allocated = 0;

  for (let month = 1; month <= T; month++) {
    const cumNow  = sCurveCumulative(month, T, alpha);
    const cumPrev = sCurveCumulative(month - 1, T, alpha);
    const draw    = hardCostTotal * (cumNow - cumPrev);
    schedule[month - 1] = draw;
    allocated += draw;
  }

  // Floating-point correction: adjust final month so sum is exact
  const residual = hardCostTotal - allocated;
  schedule[T - 1] += residual;

  return schedule;
}

/**
 * Distribute soft costs across the construction period.
 *
 * Soft cost distribution modes:
 *  - 'flat'        : equal monthly amounts (default)
 *  - 'front'       : 60% in first third, 30% in second third, 10% in final third
 *  - 'proportional': follows the same S-curve as hard costs (peaks at mid)
 *  - 'upfront'     : 100% in month 0 (pre-construction, handled by caller)
 *
 * @param {number} softCostTotal - Total soft costs
 * @param {number} T             - Construction duration in months
 * @param {string} [mode='flat'] - Distribution mode
 * @param {number} [alpha=1]     - Shape bias (only used for 'proportional' mode)
 * @returns {number[]}             Monthly soft cost allocations, length T
 */
export function buildSoftCostSchedule(softCostTotal, T, mode = 'flat', alpha = 1.0) {
  if (softCostTotal < 0) throw new Error('softCostTotal must be >= 0');
  if (T <= 0 || !Number.isInteger(T)) throw new Error('T must be a positive integer');

  const schedule = new Array(T).fill(0);

  switch (mode) {
    case 'flat': {
      const monthly = softCostTotal / T;
      for (let i = 0; i < T; i++) schedule[i] = monthly;
      // Correct rounding on last month
      const allocated = monthly * T;
      schedule[T - 1] += softCostTotal - allocated;
      break;
    }

    case 'front': {
      const t1 = Math.floor(T / 3);
      const t2 = Math.floor((2 * T) / 3);
      const bucket = [0.60, 0.30, 0.10];
      for (let i = 0; i < T; i++) {
        const bIdx = i < t1 ? 0 : i < t2 ? 1 : 2;
        const months = bIdx === 0 ? t1 : bIdx === 1 ? t2 - t1 : T - t2;
        schedule[i] = softCostTotal * bucket[bIdx] / months;
      }
      break;
    }

    case 'proportional': {
      // Use same S-curve shape as hard costs
      schedule.splice(0, T, ...buildSCurveSchedule(softCostTotal, T, alpha));
      break;
    }

    default:
      throw new Error(`Unknown soft cost mode: ${mode}. Use 'flat', 'front', or 'proportional'`);
  }

  return schedule;
}
