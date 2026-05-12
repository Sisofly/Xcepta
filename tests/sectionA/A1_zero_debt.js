// A1 — Zero-debt (100% equity) baseline
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const inputs = {
  projectName:          'A1 — Zero-debt baseline',
  T:                    24,
  landCost:             500_000,
  hardCostTotal:        1_000_000,
  softCostTotal:        200_000,
  loanAmount:           0,
  equityAmount:         2_000_000,
  annualInterestRate:   0.08,
  capitalizeInterest:   true,
  exitMethod:           'gdv',
  totalGDV:             3_000_000,
  phaseWeights:         { pre: 0.2, during: 0.5, post: 0.3 },
  paymentSchedule:      { deposit: 0.1, installments: 0.6, handover: 0.3 },
  discountRate:         0.12,
};

const TOL = 1e-2;
const out = runCashFlowEngine(inputs);
const s   = out.summary;

const checks = [];
const log = (label, ok, detail) => checks.push({ label, ok, detail });

log('summary.totalLoanDrawn = 0',          Math.abs(s.totalLoanDrawn)         <= TOL, s.totalLoanDrawn);
log('summary.finalLoanBalance = 0',        Math.abs(s.finalLoanBalance)       <= TOL, s.finalLoanBalance);
log('summary.totalCapitalizedInterest=0',  Math.abs(s.totalCapitalizedInterest)<= TOL, s.totalCapitalizedInterest);
log('summary.totalFinancingCost = 0',      Math.abs(s.totalFinancingCost)     <= TOL, s.totalFinancingCost);
log('summary.ltv = 0',                     Math.abs(s.ltv)                    <= TOL, s.ltv);

const leverageLiftNumeric = s.irrDetail.leverageLift;        // decimal
log('summary.leverageLift ≈ 0',            Math.abs(leverageLiftNumeric)      <= TOL, leverageLiftNumeric);

const anyLoanDraw = out.schedule.find(r => Math.abs(r.loanDraw) > TOL);
log('schedule[m].loanDraw = 0 ∀ m',        !anyLoanDraw, anyLoanDraw ? `month ${anyLoanDraw.month}=${anyLoanDraw.loanDraw}` : 'all 0');

const lev   = s.irrDetail.leveraged.annualIRR;
const unlev = s.irrDetail.unleveraged.annualIRR;
log('leveragedIRR ≈ unleveragedIRR',       Math.abs(lev - unlev)              <= TOL, `lev=${lev} unlev=${unlev}`);

const allOk = checks.every(c => c.ok);
console.log('\n=== A1 — Zero-debt (100% equity) baseline ===');
for (const c of checks) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
}
console.log(`\nKPI: unleveragedIRR=${s.unleveragedIRR}  leveragedIRR=${s.leveragedIRR}  leverageLift=${s.leverageLift}`);
console.log(`     totalEquityDeployed=${s.totalEquityDeployed}  totalLoanDrawn=${s.totalLoanDrawn}`);
console.log(`\nOVERALL: ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
