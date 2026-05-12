// A15 — DSCR does not apply to cashflowEngine.js
// DSCR (Debt Service Coverage Ratio = NOI / Debt Service) is a stabilised-operations
// metric for income-producing assets after construction completion. This engine
// models the construction/exit phase only, so DSCR is intentionally out of scope.
// This test documents that — no defect.
import { runCashFlowEngine } from '../../src/modules/feasibility/cashflowEngine.js';

const inputs = {
  projectName:          'A15 — DSCR scope check',
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
  exitCapRate:          0.07,
  sellingCostRate:      0.02,
  discountRate:         0.10,
};

const out = runCashFlowEngine(inputs);

// Patterns we are explicitly NOT expecting (any of these would mean DSCR-like fields exist)
const dscrPatterns = [/^dscr$/i, /debt.?service.?coverage/i, /coverage.?ratio/i];

const containsDscr = (obj) => {
  if (obj === null || typeof obj !== 'object') return false;
  for (const k of Object.keys(obj)) {
    if (dscrPatterns.some(p => p.test(k))) return k;
    const inner = containsDscr(obj[k]);
    if (inner) return `${k}.${inner}`;
  }
  return false;
};

const summaryHit  = containsDscr(out.summary);
const scheduleHit = out.schedule.reduce((acc, row, i) => acc || (containsDscr(row) ? `schedule[${i}].${containsDscr(row)}` : false), false);

const summaryKeys  = Object.keys(out.summary).sort();
const scheduleKeys = out.schedule.length ? Object.keys(out.schedule[0]).sort() : [];

const binding = [];
binding.push({ label: 'summary contains no DSCR field',  ok: summaryHit  === false, detail: summaryHit  || 'none' });
binding.push({ label: 'schedule contains no DSCR field', ok: scheduleHit === false, detail: scheduleHit || 'none' });

console.log('\n=== A15 — DSCR does not apply to cashflowEngine.js ===');
console.log('\nThe cashflow engine models construction + exit, not stabilised operations.');
console.log('DSCR is correctly omitted — it would belong on a separate operating-period engine.');

console.log('\nsummary keys observed:');
console.log('  ' + summaryKeys.join(', '));
console.log('\nschedule[0] keys observed:');
console.log('  ' + scheduleKeys.join(', '));

console.log('\n[Binding pass/fail criteria]');
for (const c of binding) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}  →  ${JSON.stringify(c.detail)}`);
}

const allOk = binding.every(c => c.ok);
console.log(`\nOVERALL (binding): ${allOk ? 'PASS' : 'FAIL'}  (scope documentation — DSCR not in scope)`);
process.exit(allOk ? 0 : 1);
