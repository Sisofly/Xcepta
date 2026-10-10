# XCEPTA — PPP / Project Finance Module: Consolidated Completion Report (Release Candidate rc1)

**Date:** 2026-10-10 · **Branch:** `rc/ppp-v1` (based on production `7a59b14`; includes PR #2) · **Engine:** `PPP_ENGINE_VERSION = 2.0.0`
**Status:** release candidate. Not merged, not deployed. Awaiting product-owner authorization.

**Final assessment: CONDITIONAL PASS — release-ready, subject to the three release conditions in §8.**

---

## 1. Implemented changes

| Commit | Item | Summary |
|---|---|---|
| `bf6e155` | PR #2 hotfix | Results debt schedule rebuilt from persisted cash flows now includes capitalised IDC. Production understated COD debt by the IDC (Madaba: 42.40M shown vs 47.14M). |
| `84cb07d` | Docs | Production verification of PR #1; known limitations. |
| `20304b4` | **P-024** | Blocks loan maturity beyond concession expiry (`LOAN_MATURITY_EXCEEDS_CONCESSION`), grace ≥ tenor, and zero tenor. Messages state maturity and expiry as project years. Terms are never shortened automatically. |
| `856d59d` | **P-023, P-025** | Blocking input controls (15 codes); output reconciliation gate (`OUTPUT_RECONCILIATION_FAILED`); non-blocking reasonableness warnings; fractional-period inputs no longer silently floored. UI: render-time crash removed, errors and warnings visible, Approve disabled on blocking errors. |
| `e981d86` | **P-022** | Versioned, immutable result persistence: full payload, engine version, inputs snapshot, periodicity. Additive DB migration. Approval writes the result before approving. Results reads the saved record only. Banners for current / outdated-engine / legacy results and for inputs changed since approval. |
| `d7a9b50` | **P-016, Phase 3** | Period-based engine (annual / quarterly). Escalation, revenue profile (demand estimate), revenue basis, construction cost profile, quarterly revenue weights, repayment profiles. Per-period DSCR-constrained sizing for variable CFADS. |
| `0e06df4` | Phase 6 UI | Editors for new inputs; "Optional PPP inputs" panel with neutral defaults; annual / quarterly labelling; quarterly debt-schedule view. |
| `2d323f1` | Phase 4/5 | Quarterly Madaba fixture, quarterly persistence round trip, `ppp_rc1_baseline.json`. |
| `c7cc4a7` | Phase 4/6 | Project IRR (unlevered); result provenance in the PDF; shared formatters. |

New and changed files:
- **Engine:** `src/modules/feasibility/annualEngine.js`
- **Feasibility modules:** `src/modules/feasibility/{debtSchedule.js, resultPersistence.js, PPPMessages.jsx, PPPResultProvenance.jsx}`
- **Page:** `src/pages/FeasibilityProject.jsx` (PPP paths only; the real-estate approval path is unchanged)
- **Migration:** `db/migrations/2026-10-10_p022_versioned_model_outputs.sql`
- **Tests:** 4 new test files

---

## 2. Financial methodology decisions

| Topic | Decision | Justification |
|---|---|---|
| Total Project Cost | Base cost **excluding** IDC (Convention A); total funding = TPC + IDC | Approved (Gate 1). |
| Debt % | Gearing on **TPC + IDC**. Equity is the balancing item. The Equity % input is informational, and a mismatch with Debt % is reported as a note, not blocked. | Approved. Distinguishes requested from DSCR-sized financing. |
| Loan tenor | Measured from COD, including grace. It must not exceed the concession (blocking). | Approved P-024. |
| Interest rates | Nominal annual. Periodic rate = annual / p on the opening balance. | Matches the benchmark (`SrDebt!R16`: rate / 4). |
| IDC | Per period on (opening + ½ draw), capitalised and compounding per period. | Standard mid-period draw convention; reconciles to the benchmark within 3% (§4). |
| WACC / NPV | Effective annual. Periodic = (1+WACC)^(1/p) − 1, discounted to the first construction period. | Equivalent to annual discounting on a t/p year basis. |
| IRR | Solved on the periodic equity flows and reported as an effective annual rate (1+r)^p − 1. | The quarterly solver brackets the root if Newton fails; the annual solver is unchanged. |
| Escalation | Annual step per operating year (indexation), not compounded within the year. | Typical contractual indexation. Documented. |
| Within-year timing | AP follows Quarterly Revenue Weights if given, otherwise equal instalments. Fixed OPEX is spread evenly; % OPEX follows revenue. | No equal-allocation assumption where contractual timing is provided. |
| Construction timing | Construction Cost Profile per period if given, otherwise even. | Lets the benchmark's own S-curve be used. |
| Debt sizing (flat CFADS, sculpted) | Unchanged `sculptSupportableDebt` | Byte-identical backward compatibility. |
| Debt sizing (variable CFADS, or annuity / equal principal) | Bisection on COD debt. Target DSCR enforced in **every** period of the loan life, including interest-only grace. | Where CFADS cannot service debt, capacity falls (to zero if necessary) and the constraint is reported. No sub-target schedule is ever produced. |
| Gearing-bound sculpting | DS = CFADS / target until repaid (cash sweep at target), as before. | Same mechanism as the benchmark. |
| Tax | Per period: max(0, (EBITDA − interest) × t). No depreciation, no loss carry-forward. | Unchanged from the annual engine. A known limitation (§7). |
| Annual reporting of quarterly models | Flows summed; balances = opening of the first and closing of the last quarter; annual DSCR = ΣCFADS / ΣDS; construction years from financial close, operating years from COD. | Stocks vs flows handled explicitly. |
| Project IRR | Unlevered, post-tax, before financing: −capex in construction; EBITDA − tax on EBITDA in operations. | Equals equity IRR when there is no debt (tested). |
| Result persistence | Insert-only rows. Engine version + compatible-version list decide "current" vs "outdated". Legacy rows are shown with an inferred engine generation. | Approved P-022 scope. |

None of these changes an established methodology. For annual models with no new inputs, outputs are byte-identical to production (§3.3).

---

## 3. Independent test results

### 3.1 Automated suite — 687 / 687 pass (was 304 at the start of Gate 1)

| Suite | Tests | Scope |
|---|---:|---|
| `feasibilityEngine.test.js` | 259 | Original B1–B57 (B34 and B38.5 re-baselined with documented reasons) |
| `engine.test.js` | 46 | Real-estate cash-flow engine (untouched) |
| `pppFundingInvariants.test.js` | 255 | 13 identities × 13 fixtures; IDC/COD C1–C5 × 16 fixtures; frozen-baseline regression R1–R4 |
| `pppQuarterlyVariable.test.js` | 78 | Quarterly identities × 9 fixtures (incl. Madaba); annual↔quarterly consistency; closed-form benchmarks; variable-CFADS behaviour; 150 randomised scenarios; project IRR |
| `pppValidation.test.js` | 29 | P-024 (incl. 300 randomised scenarios); 15 blocking codes; warnings W1–W8 (incl. the "missing zeros" incident) |
| `resultPersistence.test.js` | 10 | Engine → record → DB JSON → reload → display round trip (annual and quarterly); input drift; stale / legacy; missing-migration guard |
| `debtSchedule.test.js` | 10 | Persisted-shape debt schedule (PR #2) |

`vite build` passes. ESLint: no new errors (18 pre-existing in untouched code). The engine is now lint-clean.

### 3.2 Independent closed-form benchmarks (variable CFADS)
These use textbook arithmetic, independent of the engine. Zero tax, sculpted debt: capacity = PV at the loan rate of CFADS_t / target. Engine vs formula is within **≤ 1 JOD** in each case:
- growing annuity at +2% / 8% / 15 yrs;
- growing annuity at +5% / 6% / 10 yrs;
- declining annuity at −3% / 9% / 12 yrs;
- 2-year grace + 8-year sculpted;
- quarterly flat over 32 quarters;
- annuity profile bound by the weakest period.

### 3.3 Release validation harness (independent arithmetic, not engine helpers)
- **Annual RC vs production engine `7a59b14`:** 593 / 593 accepted scenarios **byte-identical** in every financial field. The other 207 random scenarios are now blocked by P-024. In 98 of them production had silently left debt unpaid at concession end (up to 91% of the loan).
- **RC vs pre-rewrite engine `e981d86`, annual:** 799 / 799 financial outputs identical. 28 differ only in the reworded scale-warning text.
- **1,000 random mixed scenarios:** annual and quarterly; escalation; fixed/% opex; revenue profiles; cost profiles; seasonal weights; all three repayment profiles; fractional quarterly tenors. **Zero failures** on:
  - sources = uses
  - IDC rule
  - COD = principal + IDC
  - roll-forward
  - interest rule
  - tax rule
  - DSCR ≥ target in every serviced period
  - full amortisation
  - annual aggregation
  - NPV
  - equity IRR bracket
  - project IRR bracket
  - equity multiple
  - integrity flag

### 3.4 UI verification
Server-rendered with real engine output, showing correct text for:
- a current quarterly result (with funding summary reconciling: principal + IDC = COD; equity + principal = TPC);
- an inputs-changed banner;
- a legacy result (inferred engine generation, list of missing detail);
- an outdated-engine result;
- a blocking P-024 error.

A live signed-in smoke test still requires the product owner (§8).

---

## 4. Benchmark comparison — Madaba Hospital PPP (Etihad FAST model)

The workbook is replicated cell-for-cell by an independent script (IDC 5,498.9k; loan 47,787.8k; IRR 8.9932%; NPV −827.3k). Inputs were traced from the workbook, not fitted:
- TPC 50,788,939 excluding IDC;
- gearing 84.899%;
- rate 8.25%;
- no tax, no post-COD grace, tenor 9.5 years;
- SPV opex 54,020 escalating 2.015% a year;
- construction timing = the workbook's own monthly costs aggregated to quarters.

| Metric | Benchmark | XCEPTA quarterly (rc1) | Δ | XCEPTA annual | Cause of residual (quarterly) |
|---|---:|---:|---:|---:|---|
| Total funding (uses) | 56.288M | 56.053M | −0.235M | 55.521M | = IDC variance |
| Capitalised IDC | 5.499M | 5.264M | −0.235M | 4.732M | +8.5k equity amount; −77.4k act/360 day count; −166.1k monthly vs quarterly mid-period accrual |
| Equity | 8.500M | 8.465M | −0.035M | 8.384M | Gearing × lower total funding (the benchmark fixes equity as an input) |
| COD senior debt | 47.788M | 47.588M | −0.200M | 47.137M | 84.899% × IDC variance |
| Revenue / CFADS | 88.000M / 87.408M | 88.000M / 87.408M | 0 | 0 | — |
| Σ operating interest | 16.404M | 16.235M | −0.169M | 17.849M | Lower COD debt |
| Σ debt service | 64.191M | 63.823M | −0.368M | 64.986M | Lower COD debt |
| Debt fully repaid | ops quarter 30 | ops quarter 30 | 0 | ops year 8 | — |
| Min DSCR | 1.00 | 1.00 | 0 | 1.00 | By construction (sculpt at 1.00) |
| Weighted avg DSCR (ΣCFADS_term / ΣDS) | 1.294 | 1.301 | +0.007 | 1.211 | Lower debt service |
| Σ dividends | 23.217M | 23.585M | +0.368M | 22.422M | Lower debt service |
| Equity IRR | 8.99% | 9.38% | +0.39pp | 9.23% | +0.20pp lower IDC/debt → more dividends; +0.175pp equity dated at quarter ends vs actual months; +0.01pp period-index vs dated XIRR |
| Equity NPV @10% | −0.827M | −0.526M | +0.301M | −0.631M | Same causes, plus valuation date (2026-01-01 vs first construction quarter) |
| Equity multiple | 2.73× | 2.79× | +0.06× | 2.67× | More dividends on similar equity |

Every material difference is attributed to a named convention (IDC accrual frequency, day count, equity dating), and none is an unexplained calculation error. Nothing was tuned to converge.

Quarterly modelling replaced the annual model's large offsetting conventions (−1.15pp for annual operations vs +0.79pp for annual equity dating) with small, same-direction residuals.

**Variable-CFADS external benchmark.** No independent third-party variable-CFADS model was available.
- External methodological check: the closed-form benchmarks in §3.2 (textbook formulas).
- Real-model check: the Madaba workbook's own mildly varying CFADS (escalating opex):
  - in quarters 1–29, sculpted debt service matches the workbook within 116 JOD per quarter (0.005%; the gap is annual-step vs quarterly opex escalation);
  - repayment completes in the same quarter (30);
  - the final clearing payment is 441k vs 809k, because COD debt is 0.20M lower (IDC, above).

---

## 5. Reconciliation evidence (engine-level gates, every run)

`checkPPPIntegrity` runs inside the engine on every calculation and **withholds results** if any of these break:
- sources = uses;
- COD debt = principal + IDC;
- debt roll-forward continuity (annual and quarterly schedules);
- full repayment by concession expiry.

The measured differences are saved with each approved result (`integrity`). Typical values: sources/uses 0.00–0.02 JOD; roll-forward 0.00; final balance ≤ 1 JOD (sculpting search tolerance).

---

## 6. Completion criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Material known defects in scope resolved | ✅ | PR #2, P-024, P-023, P-025, P-022 (§1) |
| 2 | Annual and quarterly reconcile | ✅ | Q5 aggregation; X1–X3 consistency; zero-rate capacity invariance |
| 3 | IDC and financing schedules reconcile | ✅ | C1–C5, Q2–Q3, 1,000-scenario harness |
| 4 | Debt sizing for flat and variable CFADS | ✅ | Closed-form B1–B4; V1–V8; randomised |
| 5 | Debt maturity and concession constraints enforced | ✅ | P-024 V1–V5; 207 / 800 production cases now blocked |
| 6 | Investment returns verified | ✅ | I13, Q6, PI1–PI3; independent IRR/NPV in harness |
| 7 | Invalid inputs and implausible outputs handled | ✅ | 15 blocking codes; W1–W8; UI blocking / warnings |
| 8 | Persisted and displayed outputs consistent | ✅ (unit-level) | P1–P6 round trip; SSR render. Live smoke test pending |
| 9 | Historical approvals auditable | ✅ | Insert-only rows; legacy / outdated disclosure; inputs snapshot |
| 10 | Regression and integration tests pass | ✅ / ⚠ | 687 / 687. No database-integration tests exist (no Supabase test harness) |
| 11 | External benchmark differences explained | ✅ | §4 |
| 12 | Remaining limitations documented | ✅ | §7 |

---

## 7. Remaining risks and limitations

1. **Migration dependency (release-blocking if skipped).** `db/migrations/2026-10-10_p022_versioned_model_outputs.sql` must be applied before deployment. If it is missing, PPP approvals are refused with a clear message and nothing is written (a safe failure). Real-estate approvals are unaffected.
2. **No database integration tests.** Persistence is tested at the record/JSON level, not against Supabase. The live save → reload path needs a signed-in smoke test.
3. **Tax.** No depreciation or amortisation of capitalised cost, and no loss carry-forward. This is not validated against a tax-bearing benchmark (Madaba has no tax).
4. **Timing conventions.**
   - IDC is calculated quarterly on a mid-period basis, about −3% vs monthly accrual.
   - Equity is dated at period end, which adds +0.175pp IRR on quarterly Madaba (P-026).
   - Day count is nominal / p, not act/360.
   - No monthly periodicity.
5. **Not modelled:**
   - DSRA / MMRA / reserve accounts;
   - lock-up or distribution tests;
   - financing fees (enter them in TPC);
   - sub-debt / shareholder loans in the PPP engine;
   - indexation by period other than annual steps.
6. **Demand-based routing.** Projects created with revenue model "Demand-based" / "Hybrid" are still routed to the real-estate engine, a pre-existing product routing outside this scope. Demand revenue is supported inside AP projects through Revenue Profile + Revenue Basis = Demand Estimate.
7. **`computeRequiredPayment` (P-017).** It solves only for a flat AP and ignores Revenue Profile. It is labelled in the UI as a live analysis, not part of the approved result.
8. **Target DSCR 0 in the UI (P-018).** The page uses `Target DSCR || 1.20` as the bankability floor, while the engine treats 0 as "no constraint". This is the conservative behaviour and is left unchanged.
9. **Legacy classification is conservative.** Results approved in production after `7a59b14` are numerically identical to engine 2.0.0 but are flagged "legacy", because no version was stored.
10. **The variable-CFADS external benchmark is closed-form**, not a third-party model.

---

## 8. Release readiness and conditions

Release candidate: `rc/ppp-v1` head. Conditions before production deployment:
1. **Apply the P-022 migration** in Supabase (additive and nullable; existing rows untouched). Verification query is in the file.
2. **Staging / preview smoke test** (signed in, using a copy of a PPP project):
   - an annual approval and a quarterly approval;
   - reload, and confirm the saved-result banner, funding summary and debt schedule (IDC rows, COD = principal + IDC, final balance ≈ 0);
   - edit an input and confirm the inputs-changed banner;
   - enter tenor > concession and confirm it is blocked;
   - export the PDF and confirm the result-basis line.
3. **Communicate re-approval:** existing PPP approvals are shown as historical until re-approved. Nothing is recalculated automatically.

## 9. Final assessment

**CONDITIONAL PASS.**
- Core financial identities reconcile and are independently tested (687 automated tests, 1,000 randomised independent checks, closed-form benchmarks).
- Annual results are byte-identical to production for every valid input.
- Quarterly and variable-CFADS structures are validated.
- The Madaba benchmark is replicated and every residual is attributed.

The conditions are operational: the migration, a live smoke test, and the absence of database-integration tests. They are not open calculation defects.

Out of scope and not started, per instruction: Valuation & Equity Research and Portfolio Management.
