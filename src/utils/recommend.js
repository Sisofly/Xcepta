/**
 * src/utils/recommend.js
 * ---------------------------------------------------------------------------
 * XCEPTA deterministic recommendation engine — pure threshold logic.
 *
 * Locked thresholds and verdict ladder. No AI, no randomness, no I/O.
 * Inputs are feasibility-engine outputs; output is an investment-committee
 * recommendation object suitable for inline rendering or PDF export.
 *
 * ── IRR bands (vs hurdle) ────────────────────────────────────────────────
 *   Strong:  irr >= hurdle + 5
 *   Pass:    irr >= hurdle
 *   Watch:   irr >= hurdle - 5
 *   Weak:    irr < hurdle - 5
 *
 * ── DSCR bands ───────────────────────────────────────────────────────────
 *   PPP:
 *     Strong:     minDSCR >= pppDscrFloor (1.30x)
 *     Acceptable: minDSCR >= 1.20x
 *     Watch:      minDSCR >= 1.00x
 *     Breach:     minDSCR < 1.00x
 *   RE / general:
 *     Strong:     minDSCR >= 1.25x
 *     Acceptable: minDSCR >= 1.20x
 *     Watch:      minDSCR >= 1.00x
 *     Breach:     minDSCR < 1.00x
 *
 * ── NPV ──────────────────────────────────────────────────────────────────
 *   Pass:   npv > 0
 *   Fail:   npv <= 0
 *
 * ── Equity Multiple ──────────────────────────────────────────────────────
 *   Strong:     >= 1.8
 *   Acceptable: >= 1.5
 *   Watch:      >= 1.2
 *   Weak:       < 1.2
 *
 * ── Verdict ladder (evaluated in order) ──────────────────────────────────
 *   hardFailures counts: minDSCR<1.00, npv<=0, irr<hurdle-5
 *   Do Not Proceed:           hardFailures >= 2
 *   High Risk:                hardFailures === 1
 *   Review Structure:         no hard failures and any soft watch
 *   Proceed with Conditions:  irr>=hurdle, dscr Acceptable, npv>0
 *   Proceed:                  irr>=hurdle+5, dscr Strong, npv>0, EM>=1.5
 *   Default fallback:         Review Structure
 *
 * No external dependencies — vanilla JS only.
 * ---------------------------------------------------------------------------
 */

// Internal helper — coerce to finite number, or null if not coercible.
function toFiniteOrNull(n) {
  if (n === null || n === undefined) return null
  const value = typeof n === 'string' ? parseFloat(n) : n
  return Number.isFinite(value) ? value : null
}

/**
 * @param {object} inputs
 * @param {number|string} inputs.irr             — display value (e.g. 32.8)
 * @param {number}        inputs.npv
 * @param {number|null}   inputs.minDSCR
 * @param {number|string} inputs.equityMultiple
 * @param {number|null}   inputs.paybackYear
 * @param {number|null}   inputs.dscrBreachYear
 * @param {boolean}       inputs.isPPP
 * @param {number}        inputs.irrHurdle       — display value (e.g. 15)
 * @param {number}        inputs.pppDscrFloor    — e.g. 1.30
 * @returns {{ verdict: string, rationale: string,
 *             riskFlags: Array<{message:string, severity:string}>,
 *             signals:   Array<{message:string}> }}
 */
export function getRecommendation(inputs) {
  // ── Coerce inputs ────────────────────────────────────────────────────────
  const irr             = toFiniteOrNull(inputs.irr)
  const npv             = toFiniteOrNull(inputs.npv)
  const minDSCR         = toFiniteOrNull(inputs.minDSCR)
  const equityMultiple  = toFiniteOrNull(inputs.equityMultiple)
  const paybackYear     = toFiniteOrNull(inputs.paybackYear)
  const dscrBreachYear  = toFiniteOrNull(inputs.dscrBreachYear)
  const isPPP           = Boolean(inputs.isPPP)
  const hurdle          = toFiniteOrNull(inputs.irrHurdle) ?? 15
  const pppDscrFloor    = toFiniteOrNull(inputs.pppDscrFloor) ?? 1.30

  // ── DSCR band (null minDSCR → null band, skipped downstream) ─────────────
  let dscrBand = null
  if (minDSCR !== null) {
    if (isPPP) {
      if      (minDSCR >= pppDscrFloor) dscrBand = 'Strong'
      else if (minDSCR >= 1.20)         dscrBand = 'Acceptable'
      else if (minDSCR >= 1.00)         dscrBand = 'Watch'
      else                              dscrBand = 'Breach'
    } else {
      if      (minDSCR >= 1.25) dscrBand = 'Strong'
      else if (minDSCR >= 1.20) dscrBand = 'Acceptable'
      else if (minDSCR >= 1.00) dscrBand = 'Watch'
      else                      dscrBand = 'Breach'
    }
  }

  // ── Hard-failure count ───────────────────────────────────────────────────
  let hardFailures = 0
  if (minDSCR !== null && minDSCR < 1.00) hardFailures++
  if (npv !== null && npv <= 0)           hardFailures++
  if (irr !== null && irr < hurdle - 5)   hardFailures++

  // ── Verdict ladder (evaluated in order; first match wins) ────────────────
  let verdict
  if (hardFailures >= 2) {
    verdict = 'Do Not Proceed'
  } else if (hardFailures === 1) {
    verdict = 'High Risk'
  } else if (
    irr !== null && npv !== null && equityMultiple !== null &&
    irr >= hurdle + 5 &&
    dscrBand === 'Strong' &&
    npv > 0 &&
    equityMultiple >= 1.5
  ) {
    verdict = 'Proceed'
  } else if (
    irr !== null && npv !== null &&
    irr >= hurdle &&
    dscrBand === 'Acceptable' &&
    npv > 0
  ) {
    verdict = 'Proceed with Conditions'
  } else if (
    (irr !== null && irr < hurdle) ||
    dscrBand === 'Watch' ||
    (equityMultiple !== null && equityMultiple < 1.5)
  ) {
    verdict = 'Review Structure'
  } else {
    verdict = 'Review Structure' // default fallback
  }

  // ── Risk flags (all that apply) ──────────────────────────────────────────
  const riskFlags = []

  if (minDSCR !== null && minDSCR < 1.00) {
    riskFlags.push({
      message: 'DSCR breach: cash flow insufficient to cover debt service',
      severity: 'danger',
    })
  }
  if (isPPP && minDSCR !== null && minDSCR < pppDscrFloor && minDSCR >= 1.00) {
    riskFlags.push({
      message: 'PPP DSCR below project finance floor',
      severity: 'warning',
    })
  }
  if (!isPPP && minDSCR !== null && minDSCR >= 1.00 && minDSCR < 1.20) {
    riskFlags.push({
      message: 'Thin debt-service coverage',
      severity: 'warning',
    })
  }
  if (npv !== null && npv <= 0) {
    riskFlags.push({
      message: 'Negative NPV: project destroys value at current discount rate',
      severity: 'danger',
    })
  }
  if (irr !== null && irr < hurdle) {
    riskFlags.push({
      message: 'IRR below hurdle rate',
      severity: 'danger',
    })
  }
  if (irr !== null && irr >= hurdle && irr < hurdle + 5) {
    riskFlags.push({
      message: 'IRR marginally above hurdle',
      severity: 'warning',
    })
  }
  if (equityMultiple !== null && equityMultiple < 1.2) {
    riskFlags.push({
      message: 'Weak equity multiple',
      severity: 'danger',
    })
  }
  if (equityMultiple !== null && equityMultiple >= 1.2 && equityMultiple < 1.5) {
    riskFlags.push({
      message: 'Equity multiple below target range',
      severity: 'warning',
    })
  }
  if (dscrBreachYear !== null) {
    riskFlags.push({
      message: 'DSCR breach detected in Op. Year ' + dscrBreachYear,
      severity: 'danger',
    })
  }
  if (paybackYear !== null && paybackYear > 10) {
    riskFlags.push({
      message: 'Long payback period',
      severity: 'warning',
    })
  }
  if (paybackYear !== null && paybackYear > 7 && paybackYear <= 10) {
    riskFlags.push({
      message: 'Extended payback — validate holding period',
      severity: 'warning',
    })
  }

  // ── Positive signals (all that apply) ────────────────────────────────────
  const signals = []

  if (irr !== null && irr >= hurdle + 5) {
    signals.push({ message: 'Strong returns above hurdle rate' })
  }
  if (minDSCR !== null && minDSCR >= (isPPP ? pppDscrFloor : 1.25)) {
    signals.push({ message: 'Adequate debt-service coverage' })
  }
  if (npv !== null && npv > 0) {
    signals.push({ message: 'Positive NPV at discount rate' })
  }
  if (equityMultiple !== null && equityMultiple >= 1.8) {
    signals.push({ message: 'Strong equity multiple' })
  }
  if (equityMultiple !== null && equityMultiple >= 1.5 && equityMultiple < 1.8) {
    signals.push({ message: 'Acceptable equity returns' })
  }
  if (paybackYear !== null && paybackYear <= 4) {
    signals.push({ message: 'Fast payback period' })
  }
  if (paybackYear !== null && paybackYear > 4 && paybackYear <= 7) {
    signals.push({ message: 'Acceptable payback period' })
  }
  if (dscrBreachYear === null && minDSCR !== null) {
    signals.push({ message: 'No DSCR breach detected' })
  }

  // ── Rationale (template-based) ───────────────────────────────────────────
  let rationale
  switch (verdict) {
    case 'Proceed':
      rationale =
        'Project demonstrates strong return profile with adequate ' +
        'debt-service coverage and positive value creation. Key metrics ' +
        'are within institutional thresholds.'
      break
    case 'Proceed with Conditions': {
      const n = riskFlags.length
      if (n === 0) {
        rationale =
          'Project meets core investment thresholds. ' +
          'Monitor coverage ratios and key assumptions ' +
          'before final commitment.'
      } else {
        const plural = n === 1 ? '' : 's'
        rationale =
          'Project meets core investment thresholds but presents ' +
          n + ' watch item' + plural +
          ' requiring mitigation before commitment.'
      }
      break
    }
    case 'Review Structure':
      rationale =
        'Return profile is acceptable but structural metrics require ' +
        'review. Capital stack, coverage ratios, or timing assumptions ' +
        'may need adjustment before IC submission.'
      break
    case 'High Risk':
      rationale =
        'Project presents a material risk flag. Resolution of the ' +
        'identified issue is required before IC submission or lender ' +
        'engagement.'
      break
    case 'Do Not Proceed':
      rationale =
        'Project fails multiple core investment thresholds. Reassessment ' +
        'of economics, capital structure, and operating assumptions is ' +
        'required.'
      break
    default:
      rationale = ''
  }

  // ── Context (deterministic outlier interpretation) ──────────────────────
  var context = null
  if (irr !== null && equityMultiple !== null &&
      irr > 100 && equityMultiple > 5) {
    context =
      'Return metrics are materially elevated by minimal capital ' +
      'deployment and accelerated presales timing. Assessment should ' +
      'prioritize profit on cost, equity multiple, and sensitivity ' +
      'outcomes over IRR.'
  }

  return { verdict, rationale, context, riskFlags, signals }
}

// Convenience default export.
export default { getRecommendation }
