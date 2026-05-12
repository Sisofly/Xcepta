// A5b — Early-sales surplus without IRR explosion
// Keep pre-sales (50% of GDV) but raise landCost so the month-0 land outflow
// exceeds the pre-sale deposit inflow. CF[0] stays negative → IRR is bounded.
//
// Inputs: pre=0.5, deposit=0.2, GDV=2.5M → m0 deposit = 0.5 * 0.2 * 2.5M = 250k.
//         landCost = 500k > 250k → m0 net = -250k.
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const presalesInputs = {
  projectName:          'A5b — pre-sales, bounded IRR',
  T:                    18,
  landCost:             500_000,                       // raised so m0 stays negative
  hardCostTotal:        800_000,
  softCostTotal:        100_000,
  equityAmount:         1_500_000,
  loanAmount:           500_000,
  annualInterestRate:   0.08,
  capitalizeInterest:   true,
  exitMethod:           'gdv',
  totalGDV:             2_500_000,
  phaseWeights:         { pre: 0.5, during: 0.3, post: 0.2 },
  paymentSchedule:      { deposit: 0.2, installments: 0.5, handover: 0.3 },
  discountRate:         0.12,
};

const noPresalesInputs = {
  ...presalesInputs,
  projectName:  'A5b — control: no pre-sales',
  phaseWeights: { pre: 0.0, during: 0.3, post: 0.7 },
};

const withPS = runCashFlowEngine(presalesInputs);
const noPS   = runCashFlowEngine(noPresalesInputs);

const eqWith = withPS.summary.totalEquityDeployed;
const eqNo   = noPS.summary.totalEquityDeployed;

const cf0_withPS = withPS.schedule[0].unleveragedCF;
const cf0_noPS   = noPS.schedule[0].unleveragedCF;

const irrUnlev_with = withPS.summary.irrDetail.unleveraged.annualIRR;
const irrLev_with   = withPS.summary.irrDetail.leveraged.annualIRR;
const irrUnlev_no   = noPS.summary.irrDetail.unleveraged.annualIRR;
const irrLev_no     = noPS.summary.irrDetail.leveraged.annualIRR;

const finite = x => Number.isFinite(x);

// Verify the per-month surplus relation on the with-presales schedule
const T   = presalesInputs.T;
const TOL = 1e-6;
let surplusMonths = 0;
let surplusViolations = [];
for (let m = 1; m <= T; m++) {
  const r = withPS.schedule[m];
  if (r.salesInflow > r.totalCostDraw + TOL) {
    surplusMonths++;
    if (r.equityDraw > TOL || r.loanDraw > TOL) {
      surplusViolations.push({ m, sales: r.salesInflow, cost: r.totalCostDraw, equityDraw: r.equityDraw, loanDraw: r.loanDraw });
    }
  }
}

// ── Binding pass/fail criteria ───────────────────────────────────────────────
const binding = [];
binding.push({ label: 'unleveragedCF[0] < 0 (m0 not positive)',     ok: cf0_withPS < 0,                detail: cf0_withPS });
binding.push({ label: 'pre-sales reduce equity deployment',         ok: eqWith < eqNo - 0.01,          detail: `with=${eqWith} no=${eqNo}` });
binding.push({ label: 'with-PS unleveragedIRR finite',              ok: finite(irrUnlev_with),         detail: irrUnlev_with });
binding.push({ label: 'with-PS leveragedIRR finite',                ok: finite(irrLev_with),           detail: irrLev_with });
binding.push({ label: 'with-PS unleveragedIRR < 5.0 (sanity)',      ok: irrUnlev_with < 5.0,           detail: irrUnlev_with });
binding.push({ label: 'with-PS leveragedIRR < 5.0 (sanity)',        ok: irrLev_with < 5.0,             detail: irrLev_with });
binding.push({ label: 'surplus months ⇒ equityDraw=loanDraw=0',     ok: surplusViolations.length === 0, detail: surplusViolations.length === 0 ? `${surplusMonths} surplus months, all clean` : surplusViolations.slice(0,3) });

console.log('\n=== A5b — Early-sales surplus without IRR explosion ===');
console.log(`\nMonth-0 unleveragedCF (with pre-sales): ${cf0_withPS}`);
console.log(`Month-0 unleveragedCF (no pre-sales):   ${cf0_noPS}`);
console.log(`\ntotalEquityDeployed (with pre-sales):    ${eqWith}`);
console.log(`totalEquityDeployed (no pre-sales):      ${eqNo}`);
console.log(`Δ (no-presales − with-presales):         ${(eqNo - eqWith).toFixed(2)}`);

console.log(`\nWith pre-sales:  unleveragedIRR=${withPS.summary.unleveragedIRR}   leveragedIRR=${withPS.summary.leveragedIRR}   leverageLift=${withPS.summary.leverageLift}`);
console.log(`No  pre-sales:  unleveragedIRR=${noPS.summary.unleveragedIRR}   leveragedIRR=${noPS.summary.leveragedIRR}   leverageLift=${noPS.summary.leverageLift}`);

console.log(`\nSurplus months in with-PS run: ${surplusMonths}`);

console.log('\n[Binding pass/fail criteria]');
for (const c of binding) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
}

console.log(`\nKPI (with pre-sales): totalLoanDrawn=${withPS.summary.totalLoanDrawn}  finalLoanBalance=${withPS.summary.finalLoanBalance}  ltv=${withPS.summary.ltv}`);
console.log(`KPI (no pre-sales):    totalLoanDrawn=${noPS.summary.totalLoanDrawn}  finalLoanBalance=${noPS.summary.finalLoanBalance}  ltv=${noPS.summary.ltv}`);

const allOk = binding.every(c => c.ok);
console.log(`\nOVERALL (binding): ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
