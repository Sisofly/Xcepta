// A18 — IRR solver convergence on a realistic alternating-sign profile
// A realistic RE project: outflows for ~T months, then inflows on completion +
// post-completion sales, then exit proceeds. Confirms solveIRR converges and
// returns a finite, well-defined number, and that NPV at the solved rate ≈ 0.
import { solveIRR, npv } from '../../src/modules/feasibility/irr.js';
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

// Use a clean engine scenario (mirrors A8) and pull its unleveragedCF for the solver.
const inputs = {
  projectName:          'A18 — convergence',
  T:                    18,
  landCost:             300_000,
  hardCostTotal:        700_000,
  softCostTotal:        100_000,
  equityAmount:         300_000,
  loanAmount:           1_000_000,
  annualInterestRate:   0.08,
  capitalizeInterest:   true,
  totalGDV:             2_000_000,
  exitMethod:           'gdv',
  phaseWeights:         { pre: 0.0, during: 0.0, post: 1.0 },
  paymentSchedule:      { deposit: 0.1, installments: 0.6, handover: 0.3 },
  discountRate:         0.10,
};

const out = runCashFlowEngine(inputs);
const cf  = out.schedule.map(r => r.unleveragedCF);   // realistic monthly series

// Sign-change inventory
let signChanges = 0;
for (let i = 1; i < cf.length; i++) {
  if (Math.sign(cf[i]) !== 0 && Math.sign(cf[i-1]) !== 0 && Math.sign(cf[i]) !== Math.sign(cf[i-1])) signChanges++;
}

const solved = solveIRR(cf);
const npvAtSolved = npv(cf, solved.monthlyIRR);

const binding = [];
binding.push({ label: 'series has at least one sign change',          ok: signChanges >= 1,                          detail: signChanges });
binding.push({ label: 'solver reports converged',                     ok: solved.converged === true,                 detail: solved.converged });
binding.push({ label: 'monthlyIRR is a finite number',                ok: Number.isFinite(solved.monthlyIRR),         detail: solved.monthlyIRR });
binding.push({ label: 'annualIRR is a finite number',                 ok: Number.isFinite(solved.annualIRR),          detail: solved.annualIRR });
binding.push({ label: 'NPV(cf, solvedRate) ≈ 0 (±1e-4)',              ok: Math.abs(npvAtSolved) < 1e-4,               detail: npvAtSolved });
binding.push({ label: 'iterations < 1000 (terminated normally)',       ok: solved.iterations < 1000,                  detail: solved.iterations });
binding.push({ label: 'engine summary unleveragedIRR matches solver', ok: Math.abs(out.summary.irrDetail.unleveraged.annualIRR - solved.annualIRR) < 1e-3, detail: `engine=${out.summary.irrDetail.unleveraged.annualIRR} solver=${solved.annualIRR}` });

console.log('\n=== A18 — IRR solver convergence ===');
console.log(`\ncashFlow length: ${cf.length}    sign changes: ${signChanges}`);
console.log(`first 5 CF: ${cf.slice(0,5).map(x=>x.toFixed(2)).join(', ')}`);
console.log(`last 5 CF:  ${cf.slice(-5).map(x=>x.toFixed(2)).join(', ')}`);
console.log(`\nsolver: monthlyIRR=${solved.monthlyIRR}  annualIRR=${solved.annualIRR}  iterations=${solved.iterations}  converged=${solved.converged}`);
console.log(`NPV at solved rate: ${npvAtSolved}`);

console.log('\n[Binding pass/fail criteria]');
for (const c of binding) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
}

const allOk = binding.every(c => c.ok);
console.log(`\nOVERALL (binding): ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
