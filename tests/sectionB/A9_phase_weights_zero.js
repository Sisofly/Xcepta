// A9 — Phase weights sum to zero
// Expectation: engine (via salesTiming.validateSalesConfig) must throw with a
// message referencing phase weights.
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const inputs = {
  projectName:          'A9 — phase weights sum to zero',
  T:                    18,
  landCost:             300_000,
  hardCostTotal:        700_000,
  softCostTotal:        100_000,
  equityAmount:         500_000,
  loanAmount:           1_000_000,
  annualInterestRate:   0.08,
  capitalizeInterest:   true,
  totalGDV:             2_000_000,
  exitMethod:           'gdv',
  phaseWeights:         { pre: 0.0, during: 0.0, post: 0.0 },
  paymentSchedule:      { deposit: 0.1, installments: 0.6, handover: 0.3 },
  discountRate:         0.12,
};

let threw = false;
let errMsg = null;
try {
  runCashFlowEngine(inputs);
} catch (e) {
  threw = true;
  errMsg = e.message;
}

const mentionsPhase = !!(errMsg && /phase\s*weight/i.test(errMsg));

const binding = [];
binding.push({ label: 'engine throws',                        ok: threw,         detail: threw ? errMsg : 'did not throw' });
binding.push({ label: 'error message references phase weights', ok: mentionsPhase, detail: errMsg });

console.log('\n=== A9 — Phase weights sum to zero ===');
for (const c of binding) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
}

const allOk = binding.every(c => c.ok);
console.log(`\nOVERALL (binding): ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
