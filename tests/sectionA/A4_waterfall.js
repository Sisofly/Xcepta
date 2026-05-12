// A4 — Debt drawdown timing (equity-first waterfall)
// Binding pass/fail: "waterfall monotonic — loan never drawn while equity remained."
//
// Because runCashFlowEngine returns the engine-level schedule (not the funding rows),
// we re-derive the construction-period waterfall from output.schedule[1..T].
// The funding module's `equityRemaining` field is exposed via the schedule indirectly:
// we check that for every construction month, if cumulativeEquityDraw < equityAmount
// at the start of the month, loanDraw for that month must be 0.
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const inputs = {
  projectName:          'A4 — Equity-first waterfall',
  T:                    24,
  landCost:             300_000,
  hardCostTotal:        1_000_000,
  softCostTotal:        150_000,
  equityAmount:         580_000,
  loanAmount:           5_000_000,
  annualInterestRate:   0.08,
  capitalizeInterest:   true,
  exitMethod:           'gdv',
  totalGDV:             3_000_000,
  phaseWeights:         { pre: 0.0, during: 0.5, post: 0.5 },
  paymentSchedule:      { deposit: 0.1, installments: 0.6, handover: 0.3 },
  discountRate:         0.12,
  sCurveAlpha:          1.0,
};

const out = runCashFlowEngine(inputs);
const s   = out.summary;

const T            = inputs.T;
const equityCap    = inputs.equityAmount;
const TOL          = 1e-6;

// Walk construction months in order. Equity is "remaining" if cumulative < cap (within tol).
let cumEquity = 0;
let firstViolationMonth = null;
let firstLoanMonth      = null;

for (let m = 1; m <= T; m++) {
  const row = out.schedule[m];
  const equityRemainingBeforeDraw = equityCap - cumEquity;

  if (firstLoanMonth === null && row.loanDraw > TOL) firstLoanMonth = m;

  // Violation: loanDraw > 0 while equity still has headroom > tol
  if (row.loanDraw > TOL && equityRemainingBeforeDraw > 1e-2) {
    if (firstViolationMonth === null) firstViolationMonth = m;
  }
  cumEquity += row.equityDraw;
}

const waterfallOk     = firstViolationMonth === null;
const equityExhausted = Math.abs(cumEquity - equityCap) < 0.01;

console.log('\n=== A4 — Equity-first waterfall ===');
console.log(`equityAmount = ${equityCap}`);
console.log(`cumulative equity drawn during construction = ${cumEquity.toFixed(2)}`);
console.log(`equity fully exhausted? ${equityExhausted}`);
console.log(`first month with loanDraw > 0: ${firstLoanMonth ?? '(none)'}`);
console.log(`first month with a waterfall violation: ${firstViolationMonth ?? '(none)'}`);

console.log('\nFirst 10 construction months:');
console.log('  m | equityDraw | loanDraw | totalCostDraw | salesInflow');
for (let m = 1; m <= Math.min(10, T); m++) {
  const r = out.schedule[m];
  console.log(`  ${String(m).padStart(2)} | ${String(r.equityDraw).padStart(10)} | ${String(r.loanDraw).padStart(8)} | ${String(r.totalCostDraw).padStart(13)} | ${String(r.salesInflow).padStart(11)}`);
}

console.log(`\nKPI: totalEquityDeployed=${s.totalEquityDeployed}  totalLoanDrawn=${s.totalLoanDrawn}  finalLoanBalance=${s.finalLoanBalance}`);
console.log(`     totalCapitalizedInterest=${s.totalCapitalizedInterest}  ltv=${s.ltv}`);
console.log(`     unleveragedIRR=${s.unleveragedIRR}  leveragedIRR=${s.leveragedIRR}  leverageLift=${s.leverageLift}`);

console.log(`\nOVERALL (binding): ${waterfallOk ? 'PASS' : 'FAIL'}`);
process.exit(waterfallOk ? 0 : 1);
