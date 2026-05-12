// A10 — Full sale in month one (everything pre-sold, 100% deposit at booking)
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const inputs = {
  projectName:          'A10 — Full sale at booking',
  T:                    12,
  landCost:             200_000,
  hardCostTotal:        500_000,
  softCostTotal:        80_000,
  equityAmount:         1_000_000,
  loanAmount:           0,
  annualInterestRate:   0.08,             // not specified but required by engine
  capitalizeInterest:   true,
  totalGDV:             1_500_000,
  exitMethod:           'gdv',
  phaseWeights:         { pre: 1.0, during: 0.0, post: 0.0 },
  paymentSchedule:      { deposit: 1.0, installments: 0.0, handover: 0.0 },
  discountRate:         0.12,
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
  const s   = out.summary;
  const TOL = 1e-2;
  binding.push({ label: 'summary.salesPreAndDuring = totalGDV (±1e-2)', ok: Math.abs(s.salesPreAndDuring - s.totalGDV) < TOL, detail: `salesPreAndDuring=${s.salesPreAndDuring} totalGDV=${s.totalGDV}` });
  binding.push({ label: 'summary.totalLoanDrawn = 0',                    ok: Math.abs(s.totalLoanDrawn) < TOL,                  detail: s.totalLoanDrawn });

  console.log('\n=== A10 — Full sale in month one ===');
  for (const c of binding) {
    console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
  }
  console.log(`\nKPI: totalSalesCollected=${s.totalSalesCollected}  salesPreAndDuring=${s.salesPreAndDuring}  salesPost=${s.salesPost}`);
  console.log(`     totalEquityDeployed=${s.totalEquityDeployed}  totalLoanDrawn=${s.totalLoanDrawn}  finalLoanBalance=${s.finalLoanBalance}`);
  console.log(`     unleveragedIRR=${s.unleveragedIRR}  leveragedIRR=${s.leveragedIRR}`);
  console.log(`\nFirst 3 months (deposit lands in m0):`);
  console.log('  m | salesInflow | totalCostDraw | equityDraw | loanDraw');
  for (let m = 0; m <= 2; m++) {
    const r = out.schedule[m];
    console.log(`  ${m} | ${String(r.salesInflow).padStart(11)} | ${String(r.totalCostDraw).padStart(13)} | ${String(r.equityDraw).padStart(10)} | ${String(r.loanDraw).padStart(8)}`);
  }
} else {
  console.log('\n=== A10 — Full sale in month one ===');
  for (const c of binding) {
    console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
  }
}

const allOk = binding.every(c => c.ok);
console.log(`\nOVERALL (binding): ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
