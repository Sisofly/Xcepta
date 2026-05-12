// A7 — Loan capacity breach
// Costs exceed equity + loan combined. Engine must flag the breach and not throw.
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const inputs = {
  projectName:          'A7 — Loan capacity breach',
  T:                    24,
  landCost:             500_000,
  hardCostTotal:        800_000,
  softCostTotal:        100_000,
  equityAmount:         100_000,            // tiny
  loanAmount:           200_000,            // tiny — together 300k vs ~900k of construction need
  annualInterestRate:   0.08,
  capitalizeInterest:   true,
  exitMethod:           'gdv',
  totalGDV:             2_500_000,
  phaseWeights:         { pre: 0.0, during: 0.0, post: 1.0 },
  paymentSchedule:      { deposit: 0.1, installments: 0.6, handover: 0.3 },
};

let threw = false;
let out;
try {
  out = runCashFlowEngine(inputs);
} catch (e) {
  threw = true;
  console.log(`Engine threw: ${e.message}`);
}

const binding = [];
binding.push({ label: 'engine does not throw', ok: !threw, detail: threw ? 'threw' : 'returned' });

if (!threw) {
  const s = out.summary;
  binding.push({ label: 'summary.loanCapacityBreached = true', ok: s.loanCapacityBreached === true, detail: s.loanCapacityBreached });
  binding.push({ label: 'summary.equityShortfall > 0',         ok: s.equityShortfall > 0,           detail: s.equityShortfall });

  console.log('\n=== A7 — Loan capacity breach ===');
  for (const c of binding) {
    console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
  }
  console.log(`\nKPI: totalEquityDeployed=${s.totalEquityDeployed}  totalLoanDrawn=${s.totalLoanDrawn}  finalLoanBalance=${s.finalLoanBalance}`);
  console.log(`     equityShortfall=${s.equityShortfall}  loanCapacityBreached=${s.loanCapacityBreached}  ltv=${s.ltv}`);
  console.log(`     totalDevelopmentCost=${s.totalDevelopmentCost}`);
} else {
  console.log('\n=== A7 — Loan capacity breach ===');
  for (const c of binding) {
    console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
  }
}

const allOk = binding.every(c => c.ok);
console.log(`\nOVERALL (binding): ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
