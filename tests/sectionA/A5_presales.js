// A5 — Equity-first with early sales surplus
// Binding pass/fail: "equity deployment lower than equivalent no-presales run."
// Also: in months where salesProceeds > grossCostDraw, equityDraw = 0 and loanDraw = 0
// (verifiable via schedule.salesInflow vs totalCostDraw on the construction months)
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const presalesInputs = {
  projectName:          'A5 — with pre-sales',
  T:                    18,
  landCost:             200_000,
  hardCostTotal:        800_000,
  softCostTotal:        100_000,
  equityAmount:         1_500_000,
  loanAmount:           500_000,
  annualInterestRate:   0.08,
  capitalizeInterest:   true,
  exitMethod:           'gdv',
  totalGDV:             2_500_000,
  phaseWeights:         { pre: 0.5, during: 0.3, post: 0.2 },
  paymentSchedule:      { deposit: 0.2, installments: 0.5, handover: 0.3 },
  discountRate:         0.12,
};

// "Equivalent no-presales run" — same scenario but pre-sales fraction shifted to post
const noPresalesInputs = {
  ...presalesInputs,
  projectName:  'A5 — no pre-sales control',
  phaseWeights: { pre: 0.0, during: 0.3, post: 0.7 },
};

const withPS = runCashFlowEngine(presalesInputs);
const noPS   = runCashFlowEngine(noPresalesInputs);

const eqWith = withPS.summary.totalEquityDeployed;
const eqNo   = noPS.summary.totalEquityDeployed;

// Verify the per-month relation on the with-presales schedule
const T   = presalesInputs.T;
const TOL = 1e-6;
let violations = [];
let surplusMonths = 0;
for (let m = 1; m <= T; m++) {
  const r = withPS.schedule[m];
  if (r.salesInflow > r.totalCostDraw + TOL) {
    surplusMonths++;
    if (r.equityDraw > TOL || r.loanDraw > TOL) {
      violations.push({ m, equityDraw: r.equityDraw, loanDraw: r.loanDraw, sales: r.salesInflow, cost: r.totalCostDraw });
    }
  }
}

const equityLower      = eqWith < eqNo - 1e-2;
const perMonthHolds    = violations.length === 0;

console.log('\n=== A5 — Equity-first with early sales surplus ===');
console.log(`totalEquityDeployed with pre-sales:    ${eqWith}`);
console.log(`totalEquityDeployed no pre-sales:      ${eqNo}`);
console.log(`Δ (no-presales − with-presales):       ${(eqNo - eqWith).toFixed(2)}`);
console.log(`\nConstruction months where salesInflow > totalCostDraw: ${surplusMonths}`);
console.log(`Violations of "surplus ⇒ equityDraw=loanDraw=0":       ${violations.length}`);
if (violations.length) {
  console.log('  First few violations:');
  for (const v of violations.slice(0, 5)) console.log(`  m=${v.m} sales=${v.sales} cost=${v.cost} equityDraw=${v.equityDraw} loanDraw=${v.loanDraw}`);
}

console.log(`\nKPI (with pre-sales): totalLoanDrawn=${withPS.summary.totalLoanDrawn}  finalLoanBalance=${withPS.summary.finalLoanBalance}  ltv=${withPS.summary.ltv}`);
console.log(`KPI (no pre-sales):    totalLoanDrawn=${noPS.summary.totalLoanDrawn}  finalLoanBalance=${noPS.summary.finalLoanBalance}  ltv=${noPS.summary.ltv}`);
console.log(`unleveragedIRR (with PS) = ${withPS.summary.unleveragedIRR}   (no PS) = ${noPS.summary.unleveragedIRR}`);
console.log(`leveragedIRR   (with PS) = ${withPS.summary.leveragedIRR}   (no PS) = ${noPS.summary.leveragedIRR}`);

console.log('\n[Binding pass/fail]');
console.log(`  [${equityLower ? 'PASS' : 'FAIL'}] equity deployment lower than equivalent no-presales run  →  ${eqWith} < ${eqNo}`);

console.log('\n[Diagnostic]');
console.log(`  [${perMonthHolds ? '  ok  ' : ' note '}] surplus months ⇒ equityDraw=0 and loanDraw=0`);

console.log(`\nOVERALL (binding): ${equityLower ? 'PASS' : 'FAIL'}`);
process.exit(equityLower ? 0 : 1);
