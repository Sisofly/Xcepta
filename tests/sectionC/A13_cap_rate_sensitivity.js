// A13 — Exit cap-rate sensitivity
// Sweep exitCapRate ∈ {5%, 7%, 9%, 11%}, same inputs otherwise.
// As cap rate increases, valuation (NOI/capRate) declines → projectNPV and unleveragedIRR decline.
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const baseInputs = {
  projectName:          'A13 — Cap-rate sensitivity',
  T:                    24,
  landCost:             1_000_000,
  hardCostTotal:        5_000_000,
  softCostTotal:        500_000,
  equityAmount:         2_000_000,
  loanAmount:           5_000_000,
  annualInterestRate:   0.08,
  capitalizeInterest:   true,
  totalGDV:             0,
  phaseWeights:         { pre: 0.0, during: 0.0, post: 1.0 },
  paymentSchedule:      { deposit: 0.1, installments: 0.6, handover: 0.3 },
  exitMethod:           'cap_rate',
  grossRentalIncome:    1_000_000,
  vacancyRate:          0.05,
  operatingExpenses:    200_000,
  sellingCostRate:      0.02,
  discountRate:         0.10,
};

const capRates = [0.05, 0.07, 0.09, 0.11];
const runs = capRates.map(r => {
  const out = runCashFlowEngine({ ...baseInputs, exitCapRate: r });
  return {
    capRate:        r,
    grossExitValue: out.summary.grossExitValue,
    projectNPV:     out.summary.projectNPV,
    unleveragedIRR: out.summary.irrDetail.unleveraged.annualIRR,
    leveragedIRR:   out.summary.irrDetail.leveraged.annualIRR,
  };
});

const monotonicDecline = (key) => {
  for (let i = 1; i < runs.length; i++) {
    if (!(runs[i][key] < runs[i - 1][key])) return { ok: false, i, prev: runs[i-1][key], curr: runs[i][key] };
  }
  return { ok: true };
};

const ge   = monotonicDecline('grossExitValue');
const npv  = monotonicDecline('projectNPV');
const irr  = monotonicDecline('unleveragedIRR');

const binding = [];
binding.push({ label: 'grossExitValue strictly declines with cap rate', ok: ge.ok,  detail: ge.ok ? 'monotonic decline' : ge });
binding.push({ label: 'projectNPV strictly declines with cap rate',     ok: npv.ok, detail: npv.ok ? 'monotonic decline' : npv });
binding.push({ label: 'unleveragedIRR strictly declines with cap rate', ok: irr.ok, detail: irr.ok ? 'monotonic decline' : irr });

console.log('\n=== A13 — Exit cap-rate sensitivity ===');
console.log('\n cap   | grossExitValue | projectNPV       | unleveragedIRR | leveragedIRR');
for (const r of runs) {
  console.log(`  ${(r.capRate*100).toFixed(0).padStart(3)}% | ${String(r.grossExitValue.toFixed(2)).padStart(14)} | ${String(r.projectNPV.toFixed(2)).padStart(16)} | ${(r.unleveragedIRR*100).toFixed(4).padStart(13)}% | ${(r.leveragedIRR*100).toFixed(4)}%`);
}

console.log('\n[Binding pass/fail criteria]');
for (const c of binding) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
}

const allOk = binding.every(c => c.ok);
console.log(`\nOVERALL (binding): ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
