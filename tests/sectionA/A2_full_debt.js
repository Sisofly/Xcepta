// A2 — 100% debt funding (zero equity)
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const inputs = {
  projectName:          'A2 — 100% debt funding',
  T:                    24,
  landCost:             500_000,
  hardCostTotal:        1_000_000,
  softCostTotal:        200_000,
  equityAmount:         0,
  loanAmount:           3_000_000,
  annualInterestRate:   0.08,
  capitalizeInterest:   true,
  exitMethod:           'gdv',
  totalGDV:             3_000_000,
  phaseWeights:         { pre: 0.2, during: 0.5, post: 0.3 },
  paymentSchedule:      { deposit: 0.1, installments: 0.6, handover: 0.3 },
  discountRate:         0.12,
};

const checks = [];
const log = (label, ok, detail) => checks.push({ label, ok, detail });

let threw = false;
let out;
try {
  out = runCashFlowEngine(inputs);
} catch (e) {
  threw = true;
  console.log(`Engine threw: ${e.message}`);
}

log('engine does not throw', !threw, threw ? 'threw' : 'returned');

if (!threw) {
  const s = out.summary;
  // "totalEquityDeployed = 0 or very small (land outflow only)"
  // funding.totalEquityDeployed only counts construction-month equity draws (excludes month 0 land)
  log('summary.totalEquityDeployed = 0 (or land-only)', s.totalEquityDeployed <= 500_000 + 1e-2, s.totalEquityDeployed);
  log('summary.loanCapacityBreached = false',           s.loanCapacityBreached === false, s.loanCapacityBreached);

  console.log('\n=== A2 — 100% debt funding (zero equity) ===');
  for (const c of checks) {
    console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
  }
  console.log(`\nKPI: totalEquityDeployed=${s.totalEquityDeployed}  totalLoanDrawn=${s.totalLoanDrawn}  finalLoanBalance=${s.finalLoanBalance}`);
  console.log(`     totalCapitalizedInterest=${s.totalCapitalizedInterest}  ltv=${s.ltv}  loanCapacityBreached=${s.loanCapacityBreached}`);
  console.log(`     unleveragedIRR=${s.unleveragedIRR}  leveragedIRR=${s.leveragedIRR}`);
} else {
  console.log('\n=== A2 — 100% debt funding (zero equity) ===');
  for (const c of checks) {
    console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
  }
}

const allOk = checks.every(c => c.ok);
console.log(`\nOVERALL: ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
