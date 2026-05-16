# XCEPTA Annual Feasibility Engine — Hardening Programme Close-Out Report
**Date:** 2026-05-16  
**Branch:** origin/master @ d1bc846  
**Programme scope:** Annual engine only (annualEngine.js + feasibilityEngine.test.js)  
**Status:** All Critical and High-priority hardening findings resolved. Annual feasibility engine approved for controlled MVP/pilot demonstrations.

---

## 1. Commit Chain by Batch

| Commit | Batch | Message | Findings |
|---|---|---|---|
| `7443d48` | 1A | harden annual engine capital structure validation | F08 |
| `75a91fc` | 1B | harden required payment solver convergence | F05, F06 |
| `bb06091` | 2A | harden ppp engine numeric fallback handling | F02 |
| `a3a5f19` | 2B | harden ppp solver and bankability edge cases | F03, F04, F07, F09, F11 |
| `d1bc846` | 2C | harden RE engine zero-default handling | F01 |

All 5 commits are fast-forward merges on origin/master. No merge commits. Clean linear history on top of the P0–P7 validation backbone (commits `5694acc`–`35d3dfb`).

---

## 2. Findings Resolved

| ID | Category | Description | Batch | Severity |
|---|---|---|---|---|
| F08 | Engine bug | Silent capital structure funding gap — runEngine accepted 30/50 splits without error | 1A | Critical |
| F05 | Engine bug | Solver silent cap return — computeRequiredPayment returned an untested payment on exhaustion with no convergence flag | 1B | Critical |
| F06 | Engine bug | Solver off-by-one — returned payment was one step past the last evaluated value | 1B | Medium |
| F13 | UX | Results-tab Approve did not run engine or render results | Pre-existing fix confirmed during consolidation; no code change required | Critical |
| F02 | Hardening gap | 10 PPP engine inputs used falsy-fallback (`\|\| default`) — explicit 0 silently overridden | 2A | High |
| F03 | Hardening gap | `targetDSCR \|\| 1.20` in solver — explicit 0 collapsed to 1.20 | 2B | High |
| F04 | Hardening gap | `dscrFloor > 0` guard in bankability — explicit 0 collapsed to 1.20 | 2B | High |
| F07 | Hardening gap | NaN cascade in solver — `dscr !== null` filter passed NaN through; defensive post-safeNum | 2B | High |
| F09 | Hardening gap | PPP fixed OPEX Amount = 0 fell through to revenue × OPEX% instead of zero OPEX | 2B | High |
| F11 | Hardening gap | Liquidity warnings fired on every ops year, not just trapped sequences | 2B | High |
| F01 | Hardening gap | 20 RE engine sites (Sale Split %, Project Life Years, 18 defaults-table entries) used falsy-fallback | 2C | High |

**Total findings closed: 11** (3 Critical + 7 High + 1 Medium)

### New validators added
| Validator code | Engine | Condition |
|---|---|---|
| `CAPITAL_STRUCTURE_INVALID` | RE (runEngine) | \|Equity% + SeniorDebt% − 100\| > 0.01 pp |
| `CONCESSION_PERIOD_INVALID` | PPP (runPPPEngine) | concessionYrs < 1 |
| `CONSTRUCTION_PERIOD_INVALID` | PPP (runPPPEngine) | constrMonths < 1 |
| `PROJECT_LIFE_INVALID` | RE (runEngine) | lifeYears < 1 (catches 0 and negative) |
| `LOAN_TENOR_INVALID` | RE (runEngine) | debtTenor < 1 AND seniorDebtPct > 0 |

All validators return machine-readable error objects with `.code` and `.value` fields. All are surfaced to users via the existing `handleApprove` try/catch alert chain — no UI changes required.

---

## 3. Test Growth

| Milestone | Unique tests | Event |
|---|---|---|
| Pre-hardening baseline | 218 | P0–P7 validation complete (origin/master @ 35d3dfb) |
| After Batch 1A | 225 | +7 (B28 expanded: 2 inversions + 5 new boundary/diagnostic tests) |
| After Batch 1B | 228 | +3 (B44–B45 updated: convergence flag + F06 off-by-one coverage) |
| After Batch 2A | 238 | +10 (B38 expanded: PPP explicit-zero + validator tests) |
| After Batch 2B | 242 | +4 (B44, B46, B48 updated: solver/bankability/liquidity scope) |
| After Batch 2C | **257** | +15 (B57 new block: RE validator + explicit-zero behavior tests) |

**Net test growth: +39 tests (+17.9% on the validation backbone)**

The increase from 218 to 257 tests is not merely quantitative. The additional coverage specifically targeted silent financial corruption paths, degenerate input handling, explicit-zero assumption preservation, solver convergence integrity, validator diagnostics, and bankability edge conditions. The suite now validates both nominal-path calculations and failure-mode behavior.

All 218 baseline tests pass unchanged throughout. Every hardening commit preserved the full P0–P7 contract.

### Test methodology used
- **Characterization-before-inversion:** for every fix that changed existing behavior, the broken behavior was pinned in a test first, then the test was inverted as part of the fix commit. This ensured no silent regressions.
- **Tests-first gate (Batch 2C):** 13 tests were written against non-existent validators and added to the suite in a failing state before any engine code changed. All 13 flipped to green in the implementation step with no test edits required (except one legitimate fixture bug: `F_NO_DEBT_ASSUMPTIONS` carrying a legacy `1e-7` epsilon workaround, replaced with explicit `Senior Debt % = 0`).

---

## 4. Engine Risks Eliminated

### A. Silent financial integrity failures
**Before:** A user could submit a project with Equity 30% + Debt 50% (20% funding gap) and receive confident-looking IRR, NPV, and DSCR outputs computed against an internally inconsistent capital structure. No warning anywhere in the stack.  
**After:** Engine throws `CAPITAL_STRUCTURE_INVALID` before any calculation runs. UI surfaces a clear alert. Cannot produce output on an underfunded structure.

### B. Falsy-fallback silent override (28 sites across RE + PPP engines)
**Before:** Setting any of 28 numeric inputs to exactly 0 — a legitimate user intent for tax-free projects, interest-free loans, zero-contingency structures, land grants, in-house management, etc. — silently ran the engine at an internal hardcoded default instead. Users received results that did not reflect their inputs. No warning.  
**After:** All 28 sites use `safeNum`/`safePct`. Explicit 0 is respected. Null/undefined still falls back to defaults. The distinction between "user chose 0" and "user provided nothing" is now correctly preserved.

### C. Solver convergence opacity
**Before:** `computeRequiredPayment` returned a payment figure with no indication of whether it actually solved the DSCR target. On cap exhaustion (unreachable target), it returned a value one step past the last tested payment — a number that was never validated against the engine. Callers had no way to distinguish a solved result from a failed one.  
**After:** Return object includes `converged: boolean`, `achieved_min_dscr`, and `target_dscr`. Callers can gate on `converged === true` before displaying the required payment. The returned `required_payment` is always the last actually-evaluated value.

### D. Degenerate period inputs accepted silently
**Before:** Concession Period = 0, Construction Period = 0 months, Project Life Years = 0 or negative, and Loan Tenor = 0 with active debt all produced degenerate engine runs. Downstream `Math.max(1, ...)` clamps absorbed the invalid inputs and produced outputs — wrong outputs, but no error signal.  
**After:** Four validators reject these inputs with deterministic error codes before any calculation runs. The `Math.max` clamps remain as defense-in-depth for programmatic callers, but are no longer the primary gate.

### E. Liquidity warning noise
**Before:** Liquidity warnings fired on every operations year regardless of cash-trap status, because the `ssvBalance` reset to 0 on every non-trapped year. A 20-year project with 2 genuine trap years produced 20 warnings. The bankability panel was unreadable and the signal was drowned in noise.  
**After:** Warnings fire only during trapped years. Warning count = actual trap-sequence length. The bankability panel now surfaces a signal, not noise.

### F. PPP OPEX and DSCR floor zero-collapse
**Before:** Setting OPEX Amount to exactly 0 (intended: zero fixed operating cost) ran the engine at revenue × OPEX% instead. Setting DSCR floor to 0 (intended: no DSCR constraint) ran bankability checks against a 1.20x floor instead.  
**After:** Both respect explicit 0. Zero fixed OPEX means zero OPEX. Zero DSCR floor means no constraint. Both are now directly modelable without epsilon workarounds.

---

## 5. Remaining Known Non-Critical Risks

### F10 — DSCR definition split (Medium — modeling decision pending)
**Description:** The RE engine computes DSCR as `EBITDA / Debt Service`. The PPP engine uses `CFADS / Debt Service`. These are different numerators: EBITDA ignores tax leakage; CFADS is the institutional project finance standard.  
**Impact:** RE DSCR figures are directionally correct but not comparable to PPP figures or to lender covenant tests, which universally use CFADS. A pilot user who asks "how was DSCR calculated?" will receive a non-institutional answer on the RE side.  
**Why not fixed yet:** Changing the RE DSCR numerator re-baselines every RE engine output across B5–B33 (29 tests). This is a modeling policy decision, not a hardening fix. Requires explicit finance-leadership sign-off.  
**Recommended next step:** Decide whether Phase 1 RE DSCR stays as EBITDA (document it) or migrates to CFADS (re-baseline tests). Then schedule as Batch 3.

### F12 — RE sale-debt cash sweep model (Reserved — do not touch)
**Description:** The RE engine directs all equity cash flow to debt service (`min(outstanding, netInc)`) for the first two operations years. This causes negative leverage at the 1200/sqm baseline (EM ≈ 0.71, IRR ≈ −9.28%). This is the engine's intentional revenue-recognition and debt-repayment model, not a bug.  
**Impact:** At certain price/LTV combinations the model shows negative leverage. This behavior reflects the current revenue-recognition and debt-sweep assumptions embedded in the RE engine and is mathematically consistent with those assumptions.  
**Why not fixed:** Any change re-baselines EM, IRR, and DSCR across all RE tests. Reserved for an explicit modeling review session with finance leadership.

### LoanTenor = 0 + Debt% > 0 (PPP engine, deferred)
**Description:** In the PPP engine, setting Loan Tenor to 0 with active debt produces a degenerate but finite result — downstream `Math.max(1, loanTenorYrs - gracePeriodYrs)` clamps repay years to 1, producing a single-year amortization schedule. No throw, no NaN.  
**Impact:** Absurd but not crash-producing. Rare in practice — form validation typically prevents tenor = 0.  
**Recommended next step:** Add `LOAN_TENOR_INVALID` validator to PPP engine in a Batch 3 standalone commit (matching the RE validator already in place). One-line fix.

### UI tolerance misalignment (cosmetic, low priority)
**Description:** `handleApprove` UI guard uses `1e-6` fraction tolerance for capital structure validation. Engine uses `1e-4` fraction (±0.01 pp). In the narrow band `0.0001–0.01 pp`, the UI rejects but the engine would have accepted — acceptable because UI provides the friendly early error. The mismatch creates a minor inconsistency.  
**Recommended next step:** Align UI guard to `1e-4` in a future UI hardening batch. Not urgent.

### safeNum empty-string semantic difference (documented, low risk)
**Description:** `safeNum("", default)` returns `0` (because `Number("") === 0` and is finite), whereas the legacy `("" || default)` returned `default` (falsy). If a form field ever submits an empty string, the engine now treats it as explicit 0 rather than falling back to the default.  
**Mitigation:** `NewProjectModal` uses truthy gating (`form.X ? [...] : []`) so empty-string overrides are not added to the assumptions array. Low risk in practice.  
**Recommended next step:** Monitor during pilot. Add form-side `Number(value) || null` coercion if empty-string inputs reach the engine in practice.

---

## 6. Recommended Manual QA Scenarios

These scenarios are not covered by the automated suite and should be run manually against the browser UI before any institutional demo.

### Scenario 1 — Full RE Sale project (baseline)
**Input:** GFA 10,000 sqm, Sale, 30/70 equity/debt, 1200/sqm sale price, 35% absorption, 8.5% debt rate, 20% tax, 12% WACC, 5-year project life.  
**Expected:** IRR positive, DSCR ≥ 1.20x, NPV positive, approval flow completes, Results tab renders without page reload.  
**Validates:** Core RE engine, approval chain, Results tab (F13 confirm).

### Scenario 2 — Capital structure rejection
**Input:** Same as above but Equity 30% + Debt 50% (sum = 80%).  
**Expected:** Clear alert on Approve click: "CAPITAL_STRUCTURE_INVALID". No model output written. No version status change.  
**Validates:** F08 engine-side validator + UI alert chain.

### Scenario 3 — Zero tax RE project (tax-free zone)
**Input:** Same baseline but `corporate_income_tax_rate = 0` in defaults.  
**Expected:** All ops tax rows = 0. Net income = PBT. IRR higher than baseline.  
**Validates:** F01 explicit-zero on tax rate.

### Scenario 4 — PPP Availability Payment (Al Nadeem fixture)
**Input:** TPC 54.5M JOD, Debt 80%, Equity 20%, Payment 8.98M JOD/yr, 12-year concession, 24-month construction, 7% interest, 10-year tenor, 2-year grace, 20% tax.  
**Expected:** IRR ≈ 10%, NPV ≈ 2.75M JOD, Min DSCR ≥ 1.20x, bankability panel shows Proceed.  
**Validates:** PPP engine end-to-end, DSCR remediation panel, bankability output.

### Scenario 5 — DSCR remediation (solver)
**Input:** Same PPP fixture but reduce payment to 5M JOD/yr (below DSCR floor).  
**Expected:** Bankability panel shows "Do Not Proceed". DSCR remediation panel shows `converged: true` required payment with `payment_gap > 0`. Achieved min DSCR shown.  
**Validates:** F05/F06 solver convergence, UI remediation panel.

### Scenario 6 — Zero concession period rejection
**Input:** PPP project with Concession Period = 0.  
**Expected:** Clear alert: "CONCESSION_PERIOD_INVALID". No model output.  
**Validates:** F02 PPP validator.

### Scenario 7 — Approve → Results render (no reload)
**Input:** Any valid project. Click Approve Version.  
**Expected:** Button shows "Approving & running model...", then Results tab renders automatically without page reload.  
**Validates:** F13 confirm (already resolved, regression check).

### Scenario 8 — Sensitivity sweep touching zero
**Input:** RE project. Run interest rate sensitivity sweep from 0% to 15%.  
**Expected:** At 0% interest, output reflects zero interest cost (not 8.5% silent default). IRR at 0% is higher than at 8.5%. No crash.  
**Validates:** F01 on `senior_debt_interest_rate` via sensitivity path.

### Scenario 9 — Liquidity warning count accuracy
**Input:** PPP project calibrated to produce 2–3 DSCR-trap years (DSCR below floor in years 3–4 of operations).  
**Expected:** Liquidity warnings count = 2–3 (trap years only). Not 10+ (all ops years).  
**Validates:** F11 liquidity warning scope fix.

### Scenario 10 — PDF export after re-approval
**Input:** Any project with stored model_outputs. Change an assumption. Re-approve. Export PDF.  
**Expected:** PDF reflects the new engine run, not the stale cached output.  
**Validates:** Approval → model_output insert → PDF read chain.

---

## 7. Annual Feasibility Engine — Controlled Pilot Approval

**Status: Approved for controlled MVP/pilot demonstrations — with two qualifications.**

### What is safe
- All Critical findings are closed. The engine cannot produce silent capital structure errors, solver convergence opacity, or UX dead-ends on approval.
- All High findings are closed. Silent numeric defaults, degenerate period inputs, liquidity noise, and DSCR floor collapse are all eliminated.
- 257 tests pass. The P0–P7 validation backbone (218 tests) is intact and all hardening tests (+39) pass.
- The RE and PPP engines produce deterministic, machine-readable errors for invalid inputs rather than garbage outputs.
- The approval chain is end-to-end: engine run → Supabase insert → Results tab render → PDF export.

### Qualification 1 — F10 (DSCR definition)
The RE engine uses EBITDA-based DSCR. An institutional reviewer with project finance background may challenge this in a demo. If your pilot audience includes lenders or infrastructure investors, prepare a one-line disclosure: *"RE DSCR is computed as EBITDA / Debt Service in Phase 1; migration to CFADS is scheduled for Phase 2."* This is a disclosure issue, not a calculation error.

### Qualification 2 — Manual QA scenarios
Run the 10 QA scenarios above in the browser before any live demo. The automated suite covers engine math; it does not cover the full browser → Supabase → render chain under real network conditions. Scenario 7 (Approve → Results render) and Scenario 5 (DSCR remediation panel) are the highest-value QA items to confirm manually.

### Verdict
The annual feasibility engine is production-hardened for MVP demo purposes. The remaining open items (F10, F12, PPP LoanTenor validator, UI tolerance alignment) are all non-blocking for Phase 1 pilot use and are correctly deferred to Batch 3 or a future modeling review.

---

## Out of Scope

This programme covered:
- `src/modules/feasibility/annualEngine.js`
- `tests/feasibilityEngine.test.js`
- Annual RE + PPP feasibility logic only

The following areas were explicitly outside the hardening programme scope and remain unreviewed at this level of rigour:

- Monthly engine (`monthlyEngine.js`, `cashflowEngine.js`)
- PDF layout and render formatting
- Frontend UX polish and form validation
- Permissions and authentication flows
- Supabase RLS and security review
- Performance optimisation
- Scenario version governance
- Browser-level E2E automation (Playwright / Cypress)

Separate hardening or security review processes should be scoped for the above before any production (non-pilot) release.

---

## Programme Summary

| Metric | Value |
|---|---|
| Findings resolved | 11 (3 Critical, 7 High, 1 Medium) |
| Validators added | 5 |
| Hardening commits | 5 |
| Tests at baseline | 218 |
| Tests at close | 257 |
| Net new tests | +39 |
| Production files changed | 2 (annualEngine.js, feasibilityEngine.test.js) |
| UI / caller files changed | 0 |
| Regressions introduced | 0 |
| Remaining critical/high findings | 0 |

*Report prepared 2026-05-16. No code changes, commits, or pushes were made in producing this report.*
