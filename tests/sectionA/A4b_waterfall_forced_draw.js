// A4b — Equity-first waterfall with real loan draw
// Sized so cumulative equity draws hit the cap mid-construction, after which
// loan must start drawing. No pre/during sales so cost draws are not offset.
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const inputs = {
  projectName:          'A4b — Waterfall forced loan draw',
  T:                    24,
  landCost:             200_000,
  hardCostTotal:        1_500_000,
  softCostTotal:        300_000,
  equityAmount:         400_000,           // < construction need (1.8M) → exhausted mid-build
  loanAmount:           2_000_000,         // plenty of capacity
  annualInterestRate:   0.08,
  capitalizeInterest:   true,
  exitMethod:           'gdv',
  totalGDV:             3_000_000,
  phaseWeights:         { pre: 0.0, during: 0.0, post: 1.0 },  // no offsets
  paymentSchedule:      { deposit: 0.1, installments: 0.6, handover: 0.3 },
  discountRate:         0.12,
  sCurveAlpha:          1.0,
};

const out = runCashFlowEngine(inputs);
const s   = out.summary;
const T   = inputs.T;
const eqCap = inputs.equityAmount;
const TOL = 1e-6;

// Walk construction months, tracking when equity is exhausted.
// CORRECT invariant: in any month where loan draws, equity must already be exhausted
// OR equity must be filled to cap THIS month (i.e., equityDraw == equityRemainingBefore).
// Violation: loanDraw > 0 AND equityDraw left untapped headroom (< equityRemainingBefore).
let cumEquity = 0;
let exhaustionMonth = null;       // first month where cumulative equity reaches the cap
let firstLoanMonth  = null;
let waterfallViolations = [];

for (let m = 1; m <= T; m++) {
  const r = out.schedule[m];
  const equityRemainingBefore = eqCap - cumEquity;

  if (firstLoanMonth === null && r.loanDraw > TOL) firstLoanMonth = m;

  // Violation: loan drew while equity still had untapped headroom this month
  if (r.loanDraw > TOL && (equityRemainingBefore - r.equityDraw) > 0.01) {
    waterfallViolations.push({ m, equityRemainingBefore, equityDraw: r.equityDraw, loanDraw: r.loanDraw });
  }

  cumEquity += r.equityDraw;
  if (exhaustionMonth === null && Math.abs(cumEquity - eqCap) < 0.01) {
    exhaustionMonth = m;
  }
}

// Did the loan eventually draw (after equity exhausted)?
const totalLoanDrawn = s.totalLoanDrawn;

// ── Binding pass/fail criteria ───────────────────────────────────────────────
const equityFullyExhausted = Math.abs(cumEquity - eqCap) < 0.01;
const loanDrawnAfterExhaustion = totalLoanDrawn > 0;
const waterfallMonotonic = waterfallViolations.length === 0;
// firstLoanMonth must be >= exhaustionMonth (loan never starts before equity is gone)
const loanStartsAfterEquityGone = firstLoanMonth !== null && exhaustionMonth !== null && firstLoanMonth >= exhaustionMonth;

const binding = [];
binding.push({ label: 'equity fully exhausted during construction',  ok: equityFullyExhausted,        detail: `cum=${cumEquity.toFixed(2)} cap=${eqCap}` });
binding.push({ label: 'loanDraw > 0 after equity exhaustion',        ok: loanDrawnAfterExhaustion,    detail: totalLoanDrawn });
binding.push({ label: 'no loanDraw while equity headroom untapped', ok: waterfallMonotonic,          detail: waterfallViolations.length === 0 ? 'no violations' : waterfallViolations.slice(0, 3) });
binding.push({ label: 'first loan month ≥ equity exhaustion month',  ok: loanStartsAfterEquityGone,   detail: `firstLoan=m${firstLoanMonth}  exhaustion=m${exhaustionMonth}` });

console.log('\n=== A4b — Equity-first waterfall with real loan draw ===');
console.log(`\nequityAmount = ${eqCap}   totalLoanDrawn = ${totalLoanDrawn}`);
console.log(`equity exhaustion month: ${exhaustionMonth ?? '(never)'}`);
console.log(`first month with loanDraw > 0: ${firstLoanMonth ?? '(never)'}`);
console.log(`cumulative equity drawn during construction: ${cumEquity.toFixed(2)}`);

console.log('\nWaterfall around the transition:');
const window = [];
const start = Math.max(1, (exhaustionMonth ?? 1) - 3);
const end   = Math.min(T, (exhaustionMonth ?? T) + 3);
console.log('  m  | equityDraw | loanDraw | totalCostDraw | salesInflow | capitalizedInt | loanBalance');
for (let m = start; m <= end; m++) {
  const r = out.schedule[m];
  console.log(`  ${String(m).padStart(2)} | ${String(r.equityDraw).padStart(10)} | ${String(r.loanDraw).padStart(8)} | ${String(r.totalCostDraw).padStart(13)} | ${String(r.salesInflow).padStart(11)} | ${String(r.capitalizedInterest).padStart(14)} | ${String(r.loanBalance).padStart(11)}`);
}

console.log('\n[Binding pass/fail criteria]');
for (const c of binding) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
}

console.log(`\nKPI: totalEquityDeployed=${s.totalEquityDeployed}  totalLoanDrawn=${s.totalLoanDrawn}  finalLoanBalance=${s.finalLoanBalance}`);
console.log(`     totalCapitalizedInterest=${s.totalCapitalizedInterest}  ltv=${s.ltv}  equityShortfall=${s.equityShortfall}`);
console.log(`     unleveragedIRR=${s.unleveragedIRR}  leveragedIRR=${s.leveragedIRR}  leverageLift=${s.leverageLift}`);

const allOk = binding.every(c => c.ok);
console.log(`\nOVERALL (binding): ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
