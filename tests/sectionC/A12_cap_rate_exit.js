// A12 — Cap-rate exit valuation
// Hold-to-rent setup: totalGDV=0 isolates the cap-rate calculation from for-sale revenue.
// Expected:
//   NOI            = grossRentalIncome * (1 - vacancyRate) - operatingExpenses
//   grossExitValue = NOI / exitCapRate
//   sellingCosts   = grossExitValue * sellingCostRate
//   netExitProceeds= grossExitValue - sellingCosts
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const inputs = {
  projectName:          'A12 — Cap-rate exit',
  T:                    24,
  landCost:             1_000_000,
  hardCostTotal:        5_000_000,
  softCostTotal:        500_000,
  equityAmount:         2_000_000,
  loanAmount:           5_000_000,
  annualInterestRate:   0.08,
  capitalizeInterest:   true,
  // for-sale economics OFF (hold-to-rent)
  totalGDV:             0,
  phaseWeights:         { pre: 0.0, during: 0.0, post: 1.0 },
  paymentSchedule:      { deposit: 0.1, installments: 0.6, handover: 0.3 },
  // cap-rate exit parameters
  exitMethod:           'cap_rate',
  grossRentalIncome:    1_000_000,
  vacancyRate:          0.05,
  operatingExpenses:    200_000,
  exitCapRate:          0.07,
  sellingCostRate:      0.02,
  discountRate:         0.10,
};

const out = runCashFlowEngine(inputs);
const s   = out.summary;
const TOL = 1e-2;

// Reference values
const expectedNOI            = inputs.grossRentalIncome * (1 - inputs.vacancyRate) - inputs.operatingExpenses;
const expectedGrossExitValue = expectedNOI / inputs.exitCapRate;
const expectedSellingCosts   = expectedGrossExitValue * inputs.sellingCostRate;
const expectedNetExit        = expectedGrossExitValue - expectedSellingCosts;

const binding = [];
binding.push({ label: 'NOI = gross * (1-vacancy) - opex',              ok: Math.abs(s.exitDetail.noi            - expectedNOI)            < TOL, detail: `engine=${s.exitDetail.noi} expected=${expectedNOI}` });
binding.push({ label: 'grossExitValue = NOI / exitCapRate',            ok: Math.abs(s.grossExitValue            - expectedGrossExitValue) < 1.0, detail: `engine=${s.grossExitValue} expected=${expectedGrossExitValue.toFixed(2)}` });
binding.push({ label: 'sellingCosts = grossExitValue * rate',          ok: Math.abs(s.sellingCosts              - expectedSellingCosts)   < 1.0, detail: `engine=${s.sellingCosts} expected=${expectedSellingCosts.toFixed(2)}` });
binding.push({ label: 'netExitProceeds = grossExitValue − sellingCosts', ok: Math.abs(s.netExitProceeds          - expectedNetExit)        < 1.0, detail: `engine=${s.netExitProceeds} expected=${expectedNetExit.toFixed(2)}` });
binding.push({ label: 'netExitProceeds < grossExitValue (sellingCosts reduced it)', ok: s.netExitProceeds < s.grossExitValue, detail: `gross=${s.grossExitValue} net=${s.netExitProceeds}` });
binding.push({ label: 'exit method recorded as cap_rate',              ok: s.exitDetail.exitCapRate === inputs.exitCapRate,                       detail: s.exitDetail });

console.log('\n=== A12 — Cap-rate exit valuation ===');
console.log(`\nExpected: NOI=${expectedNOI}  grossExitValue=${expectedGrossExitValue.toFixed(2)}  netExitProceeds=${expectedNetExit.toFixed(2)}`);
console.log(`Engine  : NOI=${s.exitDetail.noi}  grossExitValue=${s.grossExitValue}  netExitProceeds=${s.netExitProceeds}`);

console.log('\n[Binding pass/fail criteria]');
for (const c of binding) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
}
console.log(`\nexitDetail = ${JSON.stringify(s.exitDetail)}`);
console.log(`\nKPI: unleveragedIRR=${s.unleveragedIRR}  leveragedIRR=${s.leveragedIRR}  leverageLift=${s.leverageLift}`);
console.log(`     projectNPV=${s.projectNPV}  equityNPV=${s.equityNPV}`);

const allOk = binding.every(c => c.ok);
console.log(`\nOVERALL (binding): ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
