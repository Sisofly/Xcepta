// A11 — GDV exit value when fully sold
// When phaseWeights sum to 1.0, all revenue is monetised through sales CF.
// Residual GDV at exit must be 0 — no double counting at the exit month.
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const inputs = {
  projectName:          'A11 — GDV exit, fully sold',
  T:                    18,
  landCost:             300_000,
  hardCostTotal:        700_000,
  softCostTotal:        100_000,
  equityAmount:         500_000,
  loanAmount:           800_000,
  annualInterestRate:   0.08,
  capitalizeInterest:   true,
  exitMethod:           'gdv',
  totalGDV:             2_500_000,
  phaseWeights:         { pre: 0.2, during: 0.5, post: 0.3 },  // sums to 1.0
  paymentSchedule:      { deposit: 0.1, installments: 0.6, handover: 0.3 },
  sellingCostRate:      0.02,
  discountRate:         0.12,
};

const out = runCashFlowEngine(inputs);
const s   = out.summary;
const TOL = 1e-2;

// presoldFraction = sum(phaseWeights) = 1.0 → residual = 0
const phaseSum = inputs.phaseWeights.pre + inputs.phaseWeights.during + inputs.phaseWeights.post;
const exitMonth = s.exitMonth;
const exitRow   = out.schedule[exitMonth];

const binding = [];
binding.push({ label: 'phaseWeights sum to 1.0',                 ok: Math.abs(phaseSum - 1.0) < 1e-9,                detail: phaseSum });
binding.push({ label: 'summary.grossExitValue = 0',              ok: Math.abs(s.grossExitValue) < TOL,               detail: s.grossExitValue });
binding.push({ label: 'summary.sellingCosts = 0',                ok: Math.abs(s.sellingCosts) < TOL,                 detail: s.sellingCosts });
binding.push({ label: 'summary.netExitProceeds = 0',             ok: Math.abs(s.netExitProceeds) < TOL,              detail: s.netExitProceeds });
binding.push({ label: 'totalSalesCollected = totalGDV (±1e-2)',  ok: Math.abs(s.totalSalesCollected - s.totalGDV) < TOL, detail: `sales=${s.totalSalesCollected} GDV=${s.totalGDV}` });
binding.push({ label: 'schedule[exitMonth].exitProceeds = 0',    ok: Math.abs(exitRow.exitProceeds) < TOL,           detail: `m=${exitMonth} exitProceeds=${exitRow.exitProceeds}` });
binding.push({ label: 'exitDetail.residualGDVvalue = 0',         ok: Math.abs((s.exitDetail?.residualGDVvalue ?? 1)) < TOL, detail: s.exitDetail });

console.log('\n=== A11 — GDV exit value when fully sold ===');
for (const c of binding) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
}
console.log(`\nKPI: totalSalesCollected=${s.totalSalesCollected}  totalGDV=${s.totalGDV}`);
console.log(`     grossExitValue=${s.grossExitValue}  sellingCosts=${s.sellingCosts}  netExitProceeds=${s.netExitProceeds}`);
console.log(`     exitMonth=${exitMonth}  schedule.exitProceeds=${exitRow.exitProceeds}`);
console.log(`     unleveragedIRR=${s.unleveragedIRR}  leveragedIRR=${s.leveragedIRR}`);

const allOk = binding.every(c => c.ok);
console.log(`\nOVERALL (binding): ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
