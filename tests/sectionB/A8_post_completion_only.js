// A8 — Delayed sales, all post-completion
// pre=0, during=0, post=1.0 → no sales should land in months 0..T.
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const inputs = {
  projectName:          'A8 — All sales post-completion',
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
  discountRate:         0.12,
};

const out = runCashFlowEngine(inputs);
const s   = out.summary;
const T   = inputs.T;
const TOL = 1e-2;

// Check construction months 0..T for any sales inflow
let firstViolation = null;
for (let m = 0; m <= T; m++) {
  if ((out.schedule[m].salesInflow || 0) > TOL) {
    firstViolation = { m, salesInflow: out.schedule[m].salesInflow };
    break;
  }
}

const binding = [];
binding.push({ label: 'summary.salesPreAndDuring = 0',         ok: Math.abs(s.salesPreAndDuring) < TOL,          detail: s.salesPreAndDuring });
binding.push({ label: 'summary.salesPost = totalGDV (±1e-2)',  ok: Math.abs(s.salesPost - s.totalGDV) < TOL,     detail: `salesPost=${s.salesPost} totalGDV=${s.totalGDV}` });
binding.push({ label: 'schedule[m].salesInflow = 0 ∀ m ≤ T',    ok: firstViolation === null,                       detail: firstViolation ?? 'all 0' });

console.log('\n=== A8 — Delayed sales, all post-completion ===');
for (const c of binding) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
}

// Show where the sales actually land
console.log('\nMonths T+1..end with salesInflow > 0:');
console.log('  m  | salesInflow');
for (let m = T + 1; m < out.schedule.length; m++) {
  const r = out.schedule[m];
  if ((r.salesInflow || 0) > TOL) {
    console.log(`  ${String(m).padStart(2)} | ${r.salesInflow}`);
  }
}

console.log(`\nKPI: totalSalesCollected=${s.totalSalesCollected}  totalGDV=${s.totalGDV}`);
console.log(`     totalEquityDeployed=${s.totalEquityDeployed}  totalLoanDrawn=${s.totalLoanDrawn}  ltv=${s.ltv}`);
console.log(`     unleveragedIRR=${s.unleveragedIRR}  leveragedIRR=${s.leveragedIRR}  leverageLift=${s.leverageLift}`);

const allOk = binding.every(c => c.ok);
console.log(`\nOVERALL (binding): ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
