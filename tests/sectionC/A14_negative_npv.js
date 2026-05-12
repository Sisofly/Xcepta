// A14 — Negative NPV case
// Construct a low-margin project (GDV barely > TDC), then apply a high discountRate
// such that NPV becomes negative. The invariant being tested:
//   projectNPV < 0   ⇔   unleveragedIRR < discountRate
// (NPV(IRR) = 0 by definition; raise the discount rate above IRR → NPV becomes < 0.)
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const inputs = {
  projectName:          'A14 — Negative NPV',
  T:                    24,
  landCost:             500_000,
  hardCostTotal:        3_000_000,
  softCostTotal:        300_000,
  equityAmount:         1_000_000,
  loanAmount:           3_000_000,
  annualInterestRate:   0.10,            // expensive debt
  capitalizeInterest:   true,
  exitMethod:           'gdv',
  totalGDV:             4_000_000,       // small margin over TDC (~3.8M before financing)
  phaseWeights:         { pre: 0.0, during: 0.0, post: 1.0 },
  paymentSchedule:      { deposit: 0.1, installments: 0.6, handover: 0.3 },
  sellingCostRate:      0.02,
  discountRate:         0.25,            // high hurdle rate
};

const out = runCashFlowEngine(inputs);
const s   = out.summary;
const unlev = s.irrDetail.unleveraged.annualIRR;
const dr    = inputs.discountRate;

const binding = [];
binding.push({ label: 'summary.projectNPV < 0',                ok: s.projectNPV < 0,                                detail: s.projectNPV });
binding.push({ label: 'unleveragedIRR < discountRate',         ok: unlev < dr,                                       detail: `unlev=${unlev} dr=${dr}` });
binding.push({ label: 'sign of (IRR − DR) matches sign of NPV', ok: (unlev < dr) === (s.projectNPV < 0),             detail: `unlev<dr: ${unlev < dr}   NPV<0: ${s.projectNPV < 0}` });

console.log('\n=== A14 — Negative NPV case ===');
for (const c of binding) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
}
console.log(`\nKPI: totalDevelopmentCost=${s.totalDevelopmentCost}  totalGDV=${s.totalGDV}  developmentProfit=${s.developmentProfit}`);
console.log(`     projectNPV=${s.projectNPV}  equityNPV=${s.equityNPV}  discountRate=${dr}`);
console.log(`     unleveragedIRR=${s.unleveragedIRR}  leveragedIRR=${s.leveragedIRR}  leverageLift=${s.leverageLift}`);
console.log(`     profitOnCost=${s.profitOnCost}  profitOnGDV=${s.profitOnGDV}`);

const allOk = binding.every(c => c.ok);
console.log(`\nOVERALL (binding): ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
