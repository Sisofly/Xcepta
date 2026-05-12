// A6 — Capitalized vs cash interest
// Run twice with identical inputs, toggling capitalizeInterest.
//
// Note on totalFinancingCost: capitalized interest compounds (each month's
// accrued interest is added to loanBalance, so next month's accrual is on
// a larger base). Cash interest does not compound (it is paid out each month
// and the balance stays at principal). Therefore the two runs do NOT produce
// the same totalFinancingCost — capitalized > cash by the compounding term.
// The right financing-structure-invariant is unleveragedIRR, which is
// independent of how interest is paid.
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const baseInputs = {
  projectName:          'A6 — capitalized vs cash interest',
  T:                    24,
  landCost:             300_000,
  hardCostTotal:        800_000,
  softCostTotal:        100_000,
  equityAmount:         200_000,
  loanAmount:           1_000_000,
  annualInterestRate:   0.08,
  exitMethod:           'gdv',
  totalGDV:             2_500_000,
  phaseWeights:         { pre: 0.0, during: 0.0, post: 1.0 },
  paymentSchedule:      { deposit: 0.1, installments: 0.6, handover: 0.3 },
  discountRate:         0.12,
};

const capTrue  = runCashFlowEngine({ ...baseInputs, capitalizeInterest: true  });
const capFalse = runCashFlowEngine({ ...baseInputs, capitalizeInterest: false });

const sT = capTrue.summary;
const sF = capFalse.summary;

// Engine reports cashInterestPaid per row; sum across construction months 1..T.
const sumCashInterest = (out) => {
  let total = 0;
  for (let m = 1; m <= baseInputs.T; m++) total += out.schedule[m].cashInterestPaid || 0;
  return total;
};

const cashIntT = sumCashInterest(capTrue);
const cashIntF = sumCashInterest(capFalse);

const TOL_FIN  = 1e-2;
const TOL_IRR  = 1e-6;

const irrUnlevT = sT.irrDetail.unleveraged.annualIRR;
const irrUnlevF = sF.irrDetail.unleveraged.annualIRR;

// ── Binding pass/fail criteria (revised) ────────────────────────────────────
const binding = [];

// (1) cap=true:
binding.push({ label: 'cap=true: totalCapitalizedInterest > 0',           ok: sT.totalCapitalizedInterest > 0,                 detail: sT.totalCapitalizedInterest });
binding.push({ label: 'cap=true: cashInterestPaid = 0',                    ok: Math.abs(cashIntT) < TOL_FIN,                    detail: cashIntT });

// (2) cap=false:
binding.push({ label: 'cap=false: totalCapitalizedInterest = 0',          ok: Math.abs(sF.totalCapitalizedInterest) < TOL_FIN, detail: sF.totalCapitalizedInterest });
binding.push({ label: 'cap=false: cashInterestPaid > 0',                   ok: cashIntF > 0,                                     detail: cashIntF });

// (3) compounding effect: capitalized financing cost strictly greater than cash
binding.push({ label: 'totalFinancingCost_cap > totalFinancingCost_cash',  ok: sT.totalFinancingCost > sF.totalFinancingCost,   detail: `cap=${sT.totalFinancingCost} cash=${sF.totalFinancingCost} delta=${(sT.totalFinancingCost - sF.totalFinancingCost).toFixed(2)}` });

// (4) unleveragedIRR invariance: project-level IRR is independent of financing
binding.push({ label: 'unleveragedIRR identical across runs (±1e-6)',      ok: Math.abs(irrUnlevT - irrUnlevF) < TOL_IRR,        detail: `cap=${irrUnlevT} cash=${irrUnlevF}` });

console.log('\n=== A6 — Capitalized vs cash interest ===');
console.log(`\ncap=true :  totalCapitalizedInterest=${sT.totalCapitalizedInterest}   sum(cashInterestPaid)=${cashIntT}   totalFinancingCost=${sT.totalFinancingCost}`);
console.log(`cap=false:  totalCapitalizedInterest=${sF.totalCapitalizedInterest}   sum(cashInterestPaid)=${cashIntF.toFixed(2)}   totalFinancingCost=${sF.totalFinancingCost}`);
console.log(`compounding delta (cap − cash) = ${(sT.totalFinancingCost - sF.totalFinancingCost).toFixed(2)}`);
console.log(`unleveragedIRR (cap=true) =${sT.unleveragedIRR}   (cap=false)=${sF.unleveragedIRR}`);
console.log(`leveragedIRR   (cap=true) =${sT.leveragedIRR}   (cap=false)=${sF.leveragedIRR}`);

console.log('\n[Binding pass/fail criteria]');
for (const c of binding) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
}

const allOk = binding.every(c => c.ok);
console.log(`\nOVERALL (binding): ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
