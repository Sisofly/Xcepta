// A16 — Positive vs negative leverage
// Two scenarios. Same engine, same project shape, different relationship between
// project IRR and cost of debt.
//
// Run #1 (positive leverage):  high-margin project, cheap debt → projectIRR > rate
// Run #2 (negative leverage):  low-margin project, expensive debt → projectIRR < rate
//
// Expected:
//   Run #1: leverageLift > 0 (debt accretive)
//   Run #2: leverageLift < 0 (debt dilutive)
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

// ── Run 1: positive leverage — strong margin, cheap debt ────────────────────
const positiveInputs = {
  projectName:          'A16-pos — projectIRR > cost of debt',
  T:                    18,
  landCost:             300_000,
  hardCostTotal:        700_000,
  softCostTotal:        100_000,
  equityAmount:         300_000,
  loanAmount:           1_000_000,
  annualInterestRate:   0.05,                   // cheap
  capitalizeInterest:   true,
  exitMethod:           'gdv',
  totalGDV:             2_000_000,
  phaseWeights:         { pre: 0.0, during: 0.0, post: 1.0 },
  paymentSchedule:      { deposit: 0.1, installments: 0.6, handover: 0.3 },
  discountRate:         0.10,
};

// ── Run 2: negative leverage — thin margin, expensive debt ──────────────────
const negativeInputs = {
  projectName:          'A16-neg — projectIRR < cost of debt',
  T:                    24,
  landCost:             500_000,
  hardCostTotal:        3_000_000,
  softCostTotal:        300_000,
  equityAmount:         1_000_000,
  loanAmount:           3_000_000,
  annualInterestRate:   0.10,                   // expensive
  capitalizeInterest:   true,
  exitMethod:           'gdv',
  totalGDV:             4_000_000,              // small margin over TDC
  phaseWeights:         { pre: 0.0, during: 0.0, post: 1.0 },
  paymentSchedule:      { deposit: 0.1, installments: 0.6, handover: 0.3 },
  discountRate:         0.12,
};

const pos = runCashFlowEngine(positiveInputs);
const neg = runCashFlowEngine(negativeInputs);

const posUnlev = pos.summary.irrDetail.unleveraged.annualIRR;
const posLev   = pos.summary.irrDetail.leveraged.annualIRR;
const posLift  = pos.summary.irrDetail.leverageLift;
const posRate  = positiveInputs.annualInterestRate;

const negUnlev = neg.summary.irrDetail.unleveraged.annualIRR;
const negLev   = neg.summary.irrDetail.leveraged.annualIRR;
const negLift  = neg.summary.irrDetail.leverageLift;
const negRate  = negativeInputs.annualInterestRate;

const binding = [];
binding.push({ label: 'Run 1: unleveragedIRR > interestRate',  ok: posUnlev > posRate, detail: `unlev=${posUnlev} rate=${posRate}` });
binding.push({ label: 'Run 1: leverageLift > 0',                ok: posLift > 0,        detail: posLift });
binding.push({ label: 'Run 1: leveragedIRR > unleveragedIRR',   ok: posLev > posUnlev,  detail: `lev=${posLev} unlev=${posUnlev}` });

binding.push({ label: 'Run 2: unleveragedIRR < interestRate',  ok: negUnlev < negRate, detail: `unlev=${negUnlev} rate=${negRate}` });
binding.push({ label: 'Run 2: leverageLift < 0',                ok: negLift < 0,        detail: negLift });
binding.push({ label: 'Run 2: leveragedIRR < unleveragedIRR',   ok: negLev < negUnlev,  detail: `lev=${negLev} unlev=${negUnlev}` });

binding.push({ label: 'Sign relationship: sign(unlev-rate) == sign(lift) [Run1]', ok: Math.sign(posUnlev - posRate) === Math.sign(posLift), detail: `unlev-rate=${(posUnlev-posRate).toFixed(4)} lift=${posLift}` });
binding.push({ label: 'Sign relationship: sign(unlev-rate) == sign(lift) [Run2]', ok: Math.sign(negUnlev - negRate) === Math.sign(negLift), detail: `unlev-rate=${(negUnlev-negRate).toFixed(4)} lift=${negLift}` });

console.log('\n=== A16 — Positive vs negative leverage ===');
console.log('\n--- Run 1 (positive leverage) ---');
console.log(`  interestRate=${posRate}   unleveragedIRR=${pos.summary.unleveragedIRR}   leveragedIRR=${pos.summary.leveragedIRR}   leverageLift=${pos.summary.leverageLift}`);
console.log(`  totalLoanDrawn=${pos.summary.totalLoanDrawn}  totalCapitalizedInterest=${pos.summary.totalCapitalizedInterest}`);
console.log('\n--- Run 2 (negative leverage) ---');
console.log(`  interestRate=${negRate}   unleveragedIRR=${neg.summary.unleveragedIRR}   leveragedIRR=${neg.summary.leveragedIRR}   leverageLift=${neg.summary.leverageLift}`);
console.log(`  totalLoanDrawn=${neg.summary.totalLoanDrawn}  totalCapitalizedInterest=${neg.summary.totalCapitalizedInterest}`);

console.log('\n[Binding pass/fail criteria]');
for (const c of binding) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
}

const allOk = binding.every(c => c.ok);
console.log(`\nOVERALL (binding): ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
