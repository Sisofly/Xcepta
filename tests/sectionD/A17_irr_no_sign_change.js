// A17 — IRR solver no-sign-change guard
// Three sub-cases exercise the solver's defensive behavior. In each case the solver
// must throw rather than return a junk number.
//
//  (a) all-negative cash flows   → "no sign change"
//  (b) all-positive cash flows   → "no sign change"
//  (c) single-element series     → "at least 2"
//
// Plus an end-to-end case via runCashFlowEngine: totalGDV=0 with cap-rate exit
// disabled (use 'gdv' method) produces an all-negative CF (no revenue, no exit
// proceeds), which the engine's IRR step must surface as a thrown error instead
// of returning a numeric result.
import { solveIRR } from '../../src/modules/feasibility/irr.js';
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const tryCall = (fn) => {
  try { const r = fn(); return { threw: false, result: r }; }
  catch (e) { return { threw: true, message: e.message }; }
};

// (a) all-negative
const r_a = tryCall(() => solveIRR([-100, -200, -300, -50]));
// (b) all-positive
const r_b = tryCall(() => solveIRR([100, 200, 300, 50]));
// (c) too few periods
const r_c = tryCall(() => solveIRR([-100]));

// (d) end-to-end: GDV=0 with method='gdv' → no positive cash flow at all
const noRevenueInputs = {
  projectName:          'A17 — no-revenue engine run',
  T:                    12,
  landCost:             200_000,
  hardCostTotal:        500_000,
  softCostTotal:        80_000,
  equityAmount:         1_000_000,
  loanAmount:           0,
  annualInterestRate:   0.08,
  capitalizeInterest:   true,
  exitMethod:           'gdv',
  totalGDV:             0,                       // no sales revenue
  phaseWeights:         { pre: 0.0, during: 0.0, post: 1.0 },
  paymentSchedule:      { deposit: 0.1, installments: 0.6, handover: 0.3 },
  discountRate:         0.10,
};
const r_d = tryCall(() => runCashFlowEngine(noRevenueInputs));

const binding = [];
binding.push({ label: '(a) all-negative CF: solveIRR throws',                ok: r_a.threw && /sign change/i.test(r_a.message),  detail: r_a });
binding.push({ label: '(b) all-positive CF: solveIRR throws',                ok: r_b.threw && /sign change/i.test(r_b.message),  detail: r_b });
binding.push({ label: '(c) single-element CF: solveIRR throws',              ok: r_c.threw && /at least 2/i.test(r_c.message),   detail: r_c });
binding.push({ label: '(d) runCashFlowEngine with GDV=0: throws (no junk IRR)', ok: r_d.threw && /sign change/i.test(r_d.message), detail: r_d });

console.log('\n=== A17 — IRR solver no-sign-change guard ===');
for (const c of binding) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
}

const allOk = binding.every(c => c.ok);
console.log(`\nOVERALL (binding): ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
