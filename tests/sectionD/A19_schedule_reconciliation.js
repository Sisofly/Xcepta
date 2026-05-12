// A19 — Schedule reconciliation
// Sum row-level fields across the schedule and verify each sum equals the
// corresponding summary KPI. Uses upfrontSoftCosts > 0 so the soft-cost
// reconciliation exercises both m=0 and m=1..T draws.
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const inputs = {
  projectName:          'A19 — reconciliation',
  T:                    24,
  landCost:             500_000,
  hardCostTotal:        1_500_000,
  softCostTotal:        300_000,
  upfrontSoftCosts:     50_000,                  // exercises m=0 soft draw
  equityAmount:         400_000,
  loanAmount:           2_000_000,
  annualInterestRate:   0.085,
  capitalizeInterest:   true,
  exitMethod:           'gdv',
  totalGDV:             3_500_000,
  phaseWeights:         { pre: 0.0, during: 0.3, post: 0.7 },
  paymentSchedule:      { deposit: 0.1, installments: 0.6, handover: 0.3 },
  discountRate:         0.12,
};

const out = runCashFlowEngine(inputs);
const s   = out.summary;

const sumField = (field) => out.schedule.reduce((acc, row) => acc + (row[field] || 0), 0);

const sumHard      = sumField('hardCostDraw');
const sumSoft      = sumField('softCostDraw');
const sumSales     = sumField('salesInflow');
const sumLoanDraw  = sumField('loanDraw');
const sumCapInt    = sumField('capitalizedInterest');

const TOL_ABS = 1.0;        // monetary tolerance ($1) — engine rounds to 2dp per row

const binding = [];
binding.push({ label: 'sum(hardCostDraw) ≈ hardCostTotal',                   ok: Math.abs(sumHard     - s.totalHardCost)              < TOL_ABS, detail: `sum=${sumHard.toFixed(2)} target=${s.totalHardCost}` });
binding.push({ label: 'sum(softCostDraw) ≈ totalSoftCost',                   ok: Math.abs(sumSoft     - s.totalSoftCost)              < TOL_ABS, detail: `sum=${sumSoft.toFixed(2)} target=${s.totalSoftCost}` });
binding.push({ label: 'sum(salesInflow) ≈ totalSalesCollected',              ok: Math.abs(sumSales    - s.totalSalesCollected)        < TOL_ABS, detail: `sum=${sumSales.toFixed(2)} target=${s.totalSalesCollected}` });
binding.push({ label: 'sum(loanDraw) ≈ totalLoanDrawn',                      ok: Math.abs(sumLoanDraw - s.totalLoanDrawn)             < TOL_ABS, detail: `sum=${sumLoanDraw.toFixed(2)} target=${s.totalLoanDrawn}` });
binding.push({ label: 'sum(capitalizedInterest) ≈ totalCapitalizedInterest', ok: Math.abs(sumCapInt   - s.totalCapitalizedInterest)   < TOL_ABS, detail: `sum=${sumCapInt.toFixed(2)} target=${s.totalCapitalizedInterest}` });

console.log('\n=== A19 — Schedule reconciliation ===');
console.log('\nField                       sum across schedule        summary KPI');
console.log(`hardCostDraw                ${String(sumHard.toFixed(2)).padStart(20)}    ${s.totalHardCost}`);
console.log(`softCostDraw                ${String(sumSoft.toFixed(2)).padStart(20)}    ${s.totalSoftCost}    (incl. upfrontSoftCosts=${inputs.upfrontSoftCosts})`);
console.log(`salesInflow                 ${String(sumSales.toFixed(2)).padStart(20)}    ${s.totalSalesCollected}`);
console.log(`loanDraw                    ${String(sumLoanDraw.toFixed(2)).padStart(20)}    ${s.totalLoanDrawn}`);
console.log(`capitalizedInterest         ${String(sumCapInt.toFixed(2)).padStart(20)}    ${s.totalCapitalizedInterest}`);

console.log('\n[Binding pass/fail criteria]');
for (const c of binding) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
}

console.log(`\nSanity KPIs: totalDevelopmentCost=${s.totalDevelopmentCost}  ltv=${s.ltv}  unleveragedIRR=${s.unleveragedIRR}  leveragedIRR=${s.leveragedIRR}`);

const allOk = binding.every(c => c.ok);
console.log(`\nOVERALL (binding): ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
