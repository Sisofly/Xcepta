// A3b — High leverage with actual debt draw
// Stresses the leverage path by removing all pre- and during-sales so cost draws
// can't be offset by sales. Equity is sized low (200k) to be exhausted quickly,
// forcing real loan principal that compounds through construction.
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const inputs = {
  projectName:          'A3b — High leverage, forced loan draw',
  T:                    24,
  landCost:             500_000,
  hardCostTotal:        1_000_000,
  softCostTotal:        200_000,
  equityAmount:         200_000,           // low — gets exhausted
  loanAmount:           1_500_000,         // plenty of capacity
  annualInterestRate:   0.085,
  capitalizeInterest:   true,
  exitMethod:           'gdv',
  totalGDV:             3_000_000,
  phaseWeights:         { pre: 0.0, during: 0.0, post: 1.0 },  // no construction-period offsets
  paymentSchedule:      { deposit: 0.1, installments: 0.6, handover: 0.3 },
  discountRate:         0.12,
};

const out = runCashFlowEngine(inputs);
const s   = out.summary;
const lev   = s.irrDetail.leveraged.annualIRR;
const unlev = s.irrDetail.unleveraged.annualIRR;
const lift  = s.irrDetail.leverageLift;

const finite = x => Number.isFinite(x);

// ── Binding pass/fail criteria ───────────────────────────────────────────────
const binding = [];
binding.push({ label: 'totalLoanDrawn > 0',                ok: s.totalLoanDrawn > 0,             detail: s.totalLoanDrawn });
binding.push({ label: 'ltv materially above 0.5',          ok: s.ltv > 0.5,                       detail: s.ltv });
binding.push({ label: 'totalCapitalizedInterest > 0',      ok: s.totalCapitalizedInterest > 0,   detail: s.totalCapitalizedInterest });
binding.push({ label: 'unleveragedIRR finite',             ok: finite(unlev),                     detail: unlev });
binding.push({ label: 'leveragedIRR finite',               ok: finite(lev),                       detail: lev });
binding.push({ label: 'leverageLift logic valid (lev>unlev)', ok: lev > unlev && lift > 0,        detail: `lev=${lev} unlev=${unlev} lift=${lift}` });
binding.push({ label: 'leveragedIRR < 5.0 (sanity bound)',  ok: lev < 5.0,                         detail: lev });

console.log('\n=== A3b — High leverage with actual debt draw ===');
console.log('\n[Binding pass/fail criteria]');
for (const c of binding) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
}
console.log(`\nKPI: ltv=${s.ltv}  totalLoanDrawn=${s.totalLoanDrawn}  totalDevelopmentCost=${s.totalDevelopmentCost}`);
console.log(`     totalCapitalizedInterest=${s.totalCapitalizedInterest}  finalLoanBalance=${s.finalLoanBalance}`);
console.log(`     totalEquityDeployed=${s.totalEquityDeployed}  equityShortfall=${s.equityShortfall}`);
console.log(`     unleveragedIRR=${s.unleveragedIRR}  leveragedIRR=${s.leveragedIRR}  leverageLift=${s.leverageLift}`);

const allOk = binding.every(c => c.ok);
console.log(`\nOVERALL (binding): ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
