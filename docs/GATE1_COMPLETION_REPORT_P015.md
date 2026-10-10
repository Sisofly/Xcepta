# XCEPTA — Gate 1 Completion Report: P-015B / P-015C / P-015D + Madaba reconciliation

**Date:** 2026-10-10 · **Engine:** `src/modules/feasibility/annualEngine.js` · **Branch:** `master` (local, not pushed)
**Status:** awaiting product-owner authorization. Work stopped at this checkpoint. P-022, P-023 and P-016 were not started.

**Recommended classification: CONDITIONAL PASS** (rationale in §13).

---

## 0. Commits

| Commit | Scope |
|---|---|
| `8967f92` | Permanent PPP funding/debt-continuity invariant suite (169 checks) + frozen pre-IDC control baseline `docs/baselines/ppp_pre_idc_control_baseline.json` (engine @ `5b9cacc`). |
| `617100e` | P-015C IDC capitalization + P-015D COD conversion in `runPPPEngine`. B34.1/1b/4 re-baselined to closed-form values. IDC/COD tests C1–C5, R1–R4. |
| `f8c4a2c` | Results › Debt Schedule renders the engine's `debt_schedule` verbatim (legacy fallback kept for old baselines). |
| *(this commit)* | This report, post-IDC baseline `docs/baselines/ppp_post_idc_baseline.json`, findings/governance updates. |

---

## 1. Repository audit

| Finding | Actual status (2026-10-10) | Evidence | Action taken |
|---|---|---|---|
| P-015A | Implemented and correct | `23d134c`. Equity-first loop. The new invariants I1, I3, I5 pass on 13 fixtures. | Preserved. Loop now reads from `simulateConstructionFunding()`. Behaviour at rate 0 is byte-identical (R1). |
| P-015B | **Satisfied by P-015A. Closed.** | Progressive draws (B34.4, I5). Equity-first (I5). Σ draws = debt (I2). COD balance = ops opening (I7). Handoff (I6). The one gap was that the balance roll-forward lived only in the UI. That gap is P-015D scope and is closed there. | Closed. No duplicate code written. |
| P-015C | Was missing (IDC = 0) | `interest: 0` in construction rows, no IDC term. | **Implemented** (§3). |
| P-015D | Partly done: handoff correct, but schedule recomputed separately in the UI | `FeasibilityProject.jsx` rebuilt balances from `cash_flows`. | **Implemented**: engine-emitted `debt_schedule`, explicit tenor/grace basis (§4). |
| P-022 | Open, and more severe than recorded | §5d recorded post-015A IRR −10.2% / NPV −4,295,923. The post-015A engine actually gives **−7.28% / −5,342,533**. −4,295,923 is exactly the *pre-015A even-split* NPV, so stale output was documented as current. | Not addressed (after checkpoint). Evidence recorded. |
| P-023 | Open | No validation layer. Four further input-integrity defects found (§12). | Not addressed (after checkpoint). |

Test suite at start: **304/304 pass** (confirmed from main tree). At end: **559/559**.

---

## 2. Pre-IDC control baseline (Part 3)

`tests/pppFundingInvariants.test.js` contains identities only. No engine-produced number is used as an expectation. They were run against the unmodified engine first (169/169) and committed before any engine change.

| ID | Identity |
|---|---|
| I1 | Σ equity_draw = equity_amount |
| I2 | Σ debt_draw + Σ IDC = COD debt |
| I3 | equity_draw + debt_draw = capex (per row). Σ sources = TPC + IDC = Σ uses |
| I4 | Draws ≥ 0. COD debt ≤ requested (authorized) and ≤ supportable |
| I5 | Equity first: no debt drawn while undrawn equity remains |
| I6 | closing = opening + draw + IDC − principal. Next opening = prior closing. Balance ≥ 0 |
| I7 | Construction closing = operations opening = debt_amount |
| I8 | Operating interest = opening balance × rate |
| I9 | Σ principal = COD debt. Final balance = 0 |
| I10 | tax = max(0,(EBITDA − interest)·t). CFADS = EBITDA − tax. DSCR = CFADS / (interest + principal) |
| I11 | DSCR-bound debt → each amortizing year at target DSCR |
| I12 | Equity CF = −equity_draw (construction); = CFADS − debt service (operations) |
| I13 | IRR/NPV/EM recomputed from the reported equity_cf series. NPV(IRR) ≈ 0 |

Tolerances: 1 JOD per row; 0.01 JOD × rows for sums of 2-dp-rounded rows (floor 1 JOD); 0.01 for ratios.

Fixtures (13): base, Madaba June inputs, target DSCR 0 (gearing binds), low gearing, all-equity, no grace, 6/13/48-month builds, 15% and 0% rates, fixed opex, zero tax. After IDC: + benchmark-aligned, construction-rate override, Debt % 100.

---

## 3. P-015C — Interest during construction

### 3.1 Total Project Cost convention — decision

XCEPTA has always treated the TPC input as **base project cost excluding financing costs (Convention A)**. It sets `capex = TPC / constrYears` and `equity = TPC − debt`. I kept that. Switching to Convention B would silently change what every stored TPC input means.

| Line | Treatment |
|---|---|
| Base construction expenditure | TPC input (`tdc`, unchanged meaning) |
| Financing fees | Not modeled separately. Enter in TPC if material (backlog) |
| Capitalized IDC | Engine-computed, `idc_capitalized` |
| **Total uses** | `total_funding_requirement` = TPC + IDC |
| Equity | TPC − principal draws |
| Debt principal | `principal_drawn` (funds base capex) |
| Capitalized-interest financing | IDC added to the loan balance (lender-funded) |
| **Total sources** | equity + principal + IDC = TPC + IDC ✔ (test C2) |

**Consequence for benchmarking:** the benchmark's "TPC 56.29M" is a Convention-B figure. It equals 50.55M hard cost + 0.24M upfront fee + **5.50M IDC**. Entering 56.29M into XCEPTA now double-counts IDC. The correct like-for-like input is **50,788,939**.

### 3.2 Mechanics

- Rate: optional `Construction Interest Rate`. Otherwise `Interest Rate` (single-facility assumption). Explicit 0 is respected.
- Annual mid-period draw convention: **IDC_t = r × (opening_t + ½ × draw_t)**. `opening_t` already includes earlier IDC, so IDC compounds annually. IDC of year t is capitalized at year end.
- IDC is capitalized and never paid in cash. Construction `interest` (cash) stays 0. IDC is never in `equity_cf`.

### 3.3 IDC and debt capacity — decision

The DSCR-supportable amount is a **COD balance**. It depends only on operating CFADS, rate, tenor and target, so IDC does not change it. The engine therefore solves the principal P so that:

```
P + IDC(P) ≤ supportable              (DSCR capacity at COD)
P + IDC(P) ≤ Debt % × (TPC + IDC(P))  (gearing on total funding)
P ≤ TPC
```

`IDC(P)` increases with P, so headroom is strictly decreasing. Bisection on P recomputes IDC from the draws at every step. There is no circular reference and no plug. At construction rate 0 this collapses exactly to the old `min(supportable, Debt% × TPC, TPC)`. Test R1 proves this field-by-field against the frozen baseline.

**This overturns the §5d qualitative expectation.** §5d said "COD debt rises above 44.42M; equity falls". That cannot happen when debt is already at DSCR capacity. In that case IDC *consumes* capacity: COD debt stays 44.42M, principal falls by the IDC amount, and **equity rises by the IDC amount** (test R2). IDC is debt-financed on top of principal only when gearing binds (R3). Adding IDC on top of a fully-used DSCR capacity would have produced unserviceable debt. The mandate explicitly prohibits that.

### 3.4 Construction interest schedule — Madaba benchmark-aligned inputs (post-IDC)

| Yr | Opening | Principal draw | IDC (8.25%) | Closing | Equity draw |
|---|---:|---:|---:|---:|---:|
| 0 | 0 | 8,545,396.60 | 352,497.61 | 8,897,894.21 | 8,384,249.74 |
| 1 | 8,897,894.21 | 16,929,646.33 | 1,432,424.18 | 27,259,964.72 | 0 |
| 2 | 27,259,964.72 | 16,929,646.33 | 2,947,295.00 | **47,136,906.06** | 0 |
| Σ | | **42,404,689.26** | **4,732,216.79** | | **8,384,249.74** |

Hand check, year 2: 0.0825 × (27,259,964.72 + ½ × 16,929,646.33) = 2,947,295.00 ✔.

---

## 4. P-015D — COD conversion

- The construction facility converts at COD with **no adjustment**. Operations open at the construction closing balance (C4, I7).
- **Tenor is measured from COD.** Construction years are not part of the tenor. `grace_years` = interest-only operating years. `repayment_years` = tenor − grace, over which principal is DSCR-sculpted. No principal is paid in grace or after tenor end (C5).
- The engine emits `debt_schedule` rows built from the **same variables** as `cash_flows`. Test C4 asserts field-by-field equality and continuity. The UI renders it verbatim (`f8c4a2c`), so the schedule can no longer disagree with the engine.
- New `debt_sizing` fields: `principal_drawn`, `idc_capitalized`, `total_funding_requirement`, `cod_debt_balance`, `construction_interest_rate`, `binding_constraint` (`dscr` | `gearing` | `project_cost` | `none`), `loan_tenor_years`, `grace_years`, `repayment_years`. All existing fields are kept. `debt_amount` = `actual_debt` = COD term-loan balance.

### 4.1 COD reconciliation (benchmark-aligned)

| | JOD |
|---|---:|
| Σ principal draws | 42,404,689.26 |
| + Σ capitalized IDC | 4,732,216.79 |
| = Construction closing balance | 47,136,906.05 |
| Operations opening balance | 47,136,906.06 (r2 rounding) |
| Gearing check: 84.899% × TFR 55,521,155.79 | 47,136,906.06 ✔ (binding: gearing) |
| DSCR capacity (9-yr sculpt @1.00) | 54,039,742.66 (not binding) |

### 4.2 Full operating debt schedule (benchmark-aligned)

| Op yr | Opening | Interest | Principal | Closing | CFADS | DSCR | Equity CF |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 47,136,906.06 | 3,888,794.75 | 4,852,015.25 | 42,284,890.81 | 8,740,810 | 1.00 | 0 |
| 2 | 42,284,890.81 | 3,488,503.49 | 5,252,306.51 | 37,032,584.30 | 8,740,810 | 1.00 | 0 |
| 3 | 37,032,584.30 | 3,055,188.20 | 5,685,621.80 | 31,346,962.50 | 8,740,810 | 1.00 | 0 |
| 4 | 31,346,962.50 | 2,586,124.41 | 6,154,685.59 | 25,192,276.91 | 8,740,810 | 1.00 | 0 |
| 5 | 25,192,276.91 | 2,078,362.85 | 6,662,447.15 | 18,529,829.76 | 8,740,810 | 1.00 | 0 |
| 6 | 18,529,829.76 | 1,528,710.96 | 7,212,099.04 | 11,317,730.72 | 8,740,810 | 1.00 | 0 |
| 7 | 11,317,730.72 | 933,712.78 | 7,807,097.22 | 3,510,633.50 | 8,740,810 | 1.00 | 0 |
| 8 | 3,510,633.50 | 289,627.26 | 3,510,633.50 | 0 | 8,740,810 | 2.30 | 4,940,549.24 |
| 9–10 | 0 | 0 | 0 | 0 | 8,740,810 | — | 8,740,810 /yr |
| Σ | | **17,849,024** | **47,136,906** | | **87,408,100** | | **22,422,169** |

Interest = opening × 8.25% (I8). Σ principal = COD debt (I9). Because gearing binds below the DSCR capacity, sculpting at 1.00 sweeps all CFADS to debt until repaid in op-year 8. The benchmark does the same (repaid in ops quarter 30).

---

## 5. DSCR validation

- In every amortizing year, DSCR = CFADS / (interest + principal) with CFADS = EBITDA − tax (I10, 16 fixtures).
- When debt is DSCR-bound, each amortizing year is at target. IDC does not disturb this, because COD debt stays at the DSCR capacity (I11, R2). Madaba June inputs post-IDC: Min DSCR **1.00**, unchanged.
- Definition note: XCEPTA `avg_dscr` is a **simple average of annual DSCRs where debt service > 1 JOD**. The benchmark's "Average DSCR 1.29" is **Σ CFADS over the 38-quarter debt term ÷ Σ actual debt service**. These are different metrics (§9).

## 6. Equity IRR / NPV validation

- IRR, NPV and EM are recomputed independently from the reported `equity_cf` series. NPV at the IRR is ≈ 0 (I13, all fixtures).
- IRR is period-indexed (t = 0 is construction year 0, annual). NPV discounts to t = 0 at WACC. Both are internally consistent. The timing *convention* is a material comparability limitation (§9, row "end-of-period equity dating").

---

## 7. Baseline vs post-IDC

| Case | Metric | Pre-IDC (frozen, `5b9cacc`) | Post-IDC (`617100e`) | Why |
|---|---|---:|---:|---|
| Madaba **June inputs** (DSCR-bound) | IDC | 0 | 3,331,259.64 | 7% on equity-first draws, 3 yrs |
| | COD debt | 44,417,516.90 | 44,417,516.90 | DSCR capacity is CFADS-determined |
| | Principal drawn | 44,417,516.90 | 41,086,257.25 | IDC consumes capacity |
| | Equity | 11,872,483.10 | 15,203,742.75 | +IDC |
| | Min DSCR | 1.00 | 1.00 | |
| | IRR / NPV / EM | −7.28% / −5,342,533 / 0.77× | −13.56% / −8,673,793 / 0.60× | More equity, same distributions |
| **Base fixture** (100M, 24m) | IDC / equity | 0 / 52,492,680 | 1,606,528 / 54,099,208 | Closed form P = 47,507,319.59 / 1.035 |
| Madaba **aligned** (gearing-bound) | IDC | 0 | 4,732,217 | |
| | COD debt | 43,119,301 | 47,136,906 | Gearing on TPC + IDC |
| | Equity | 7,669,638 | 8,384,250 | |
| | IRR / NPV / EM | 13.49% / +3,027,921 / 3.87× | 9.23% / −630,762 / 2.67× | |

**§5d correction:** the frozen pre-IDC IRR/NPV for the June inputs are **−7.28% / −5,342,533**, not −10.2% / −4,295,923 (stale pre-015A values). Debt, equity, Min DSCR and EM in §5d were correct.

---

## 8. Test B — benchmark trace (what the Madaba workbook actually does)

Traced from `Madaba Hospital Model - Etihad 30-3-2026.xlsm` (read-only, no macros executed). A scratch-only replica of the workbook mechanics reproduces it **exactly**:

| | Workbook | Replica |
|---|---:|---:|
| IDC (k JOD) | 5,498.9 | 5,498.9 |
| Term loan | 47,787.8 | 47,787.8 |
| Σ ops interest | 16,403.7 | 16,403.7 |
| Σ debt service | 64,191.5 | 64,191.5 |
| Σ dividends | 23,216.6 | 23,216.6 |
| Equity IRR | 8.9932% | 8.9932% |
| NPV @10% | −827.3 | −827.3 |

Benchmark facts that differ from the June input mapping:

| Item | June mapping | Workbook |
|---|---|---|
| TPC | 56.29M treated as cost | 56.29M **includes 5.50M IDC + 0.24M fee**. Hard cost 50.55M |
| Rate | 7.0% (later noted as 8.3%) | **8.25%** = 6.5% + **1.75%** margin (act/360 in construction) |
| Tax | 20% | **None.** No tax line in CFADS, CF or Val |
| Grace | 2 yrs post-COD | **None.** Sculpted repayment from the first ops quarter |
| Tenor | 10 yrs | 9.5 yrs (38 quarters) from COD |
| Opex | 0% | ~591.9K over 10 yrs (SPV G&A, escalating) |
| Debt sizing | Assumed sized to DSCR capacity | **Equity is an input (8.5M)**. Debt = funding gap. DSCR 1.00 *sculpt* = all CFADS to debt; repaid in ops quarter 30 (7.5 yrs), below capacity |
| Avg DSCR 1.29 | Read as coverage average | Σ CFADS over the 38-qtr term ÷ Σ DS. Inflated by 8 debt-free quarters inside the term |

**Implications:**
1. The June "exact Min/Avg DSCR match" was **coincidental**. It did not prove "the sculpting mechanism, per-period CFADS, *tax treatment*, and DSCR computation are correct" (§4.4). The benchmark has no tax, and its average is a different metric.
2. The §5/§5c claim that the residual debt gap is "fully explained by IDC (~3.4M)" is **disproven**. Under the June inputs, debt was DSCR-bound, and IDC cannot raise DSCR-bound debt. The 44.4M vs 47.8M gap came from input mis-mapping (tax, grace, tenor, rate) and the sizing basis (equity input vs DSCR capacity).

---

## 9. Benchmark reconciliation & variance bridge

### 9.1 Assumption bridge — June inputs → benchmark-aligned (XCEPTA post-IDC, each step cumulative)

| Step | TFR | IDC | COD debt | Equity | Binds | IRR | NPV |
|---|---:|---:|---:|---:|---|---:|---:|
| 0 June inputs, pre-IDC (frozen) | 56.290M | 0 | 44.418M | 11.872M | dscr | −7.28% | −5.343M |
| 1 + IDC (P-015C) | 59.621M | 3.331M | 44.418M | 15.204M | dscr | −13.56% | −8.674M |
| 2 rate 7% → 8.25% | 59.813M | 3.523M | 42.697M | 17.115M | dscr | −18.16% | −11.060M |
| 3 tax 20% → 0% | 61.147M | 4.857M | 50.094M | 11.053M | dscr | −4.71% | −4.359M |
| 4 grace 2→0, tenor 10→9 | 61.548M | 5.258M | 52.316M | 9.232M | gearing | 3.02% | −4.933M |
| 5 opex → 59,190/yr | 61.548M | 5.258M | 52.316M | 9.232M | gearing | 2.45% | −5.214M |
| 6 TPC 56.29M → 50.79M (excl. IDC) | 55.533M | 4.744M | 47.203M | 8.330M | gearing | 9.23% | −0.625M |
| 7 Debt % 85 → 84.899 | **55.521M** | **4.732M** | **47.137M** | **8.384M** | gearing | **9.23%** | **−0.631M** |

### 9.2 Required reconciliation table — XCEPTA (aligned, post-IDC) vs benchmark

| Metric | Benchmark | XCEPTA | Variance | Cause | Class | Code change? |
|---|---:|---:|---:|---|---|---|
| Total project uses | 56.288M | 55.521M | −0.767M | Entirely the IDC variance (base cost equal by construction) | Convention / periodicity | No |
| Initial equity | 8.500M | 8.384M | −0.116M | Benchmark equity is an input. XCEPTA = gearing × TFR, and TFR is lower | Convention | No |
| Construction debt principal (excl. IDC) | 42.289M | 42.405M | +0.116M | Mirror of equity | Convention | No |
| Capitalized IDC | 5.499M | 4.732M | −0.767M | +27.8K equity amount; −77.7K act/360 → 30/360; **−580.6K benchmark S-curve → even capex**; −136.1K monthly → annual mid-year | Structural (P-016) + missing capex-profile input | No (backlog) |
| COD debt balance | 47.788M | 47.137M | −0.651M | 84.899% × IDC variance | Follows IDC | No |
| Annual revenue | 8.80M | 8.80M | 0 | | — | — |
| CFADS (Σ 10 yrs) | 87.408M | 87.408M | 0 | No tax; opex total aligned (benchmark escalates within the period) | — | — |
| Σ interest (ops) | 16.404M | 17.849M | +1.445M | Annual in-arrears balance vs quarterly amortization: +1.979M on identical debt (replica), offset by lower COD debt | **Structural (annual periodicity)** | No (P-016) |
| Σ debt service | 64.191M | 64.986M | +0.795M | As above | Structural | No |
| Min DSCR | 1.00 | 1.00 | 0 | Both sculpt at 1.00. Matches by construction, not as validation | — | — |
| Avg DSCR | 1.294 (ΣCFADS₃₈q / ΣDS) | 1.16 simple; 1.211 same-definition over 9-yr term | — | Metric definition + term length (9 vs 9.5 yrs) | Convention | No (backlog: define) |
| Total distributions | 23.217M | 22.422M | −0.794M | = extra annual-period debt service | Structural | No |
| Equity IRR | 8.99% | 9.23% | +0.24pp | **Offsetting** effects, see §9.3 | Structural + convention | No |
| Equity NPV @10% | −0.827M | −0.631M | +0.196M | Same as IRR, plus a different valuation date (2026-01-01 vs construction year 0) | Convention | No |
| Equity multiple | 2.73× | 2.67× | −0.06× | Distributions −0.79M on equity −0.12M | Structural | No |
| Debt fully repaid | Ops qtr 30 (yr 7.5) | Ops yr 8 | ~½ yr | Annual granularity | Structural | No |

### 9.3 Equity IRR bridge (benchmark → XCEPTA; replica-based, one convention at a time)

| Step | IRR | Δ |
|---|---:|---:|
| B0 Benchmark (monthly construction, quarterly ops, XIRR) | 8.99% | |
| B1 Annual operations sculpting instead of quarterly | 7.84% | **−1.15pp** |
| B2 XCEPTA construction amounts (IDC 4.73M, equity 8.38M, COD 47.14M), actual equity dates | 8.51% | +0.67pp |
| B3 All equity dated at financial close | 8.43% | −0.08pp |
| B4 Equity dated at end of construction year 0 (XCEPTA's implicit convention) | 9.22% | **+0.79pp** |
| XCEPTA engine (period-index IRR) | 9.23% | +0.01pp |

**IRR proximity is not validation.** The two large effects, annual operations (−1.15pp) and end-of-period dating of equity-first equity (+0.79pp), roughly cancel. On another project with a different construction length or gearing they will not cancel.

---

## 10. Automated regression results

| Suite | Tests |
|---|---:|
| `tests/feasibilityEngine.test.js` (B1–B57; B34.1/1b/4 re-baselined with closed-form arithmetic inline) | 258 |
| `tests/engine.test.js` (cash-flow engine, untouched) | 46 |
| `tests/pppFundingInvariants.test.js` (I1–I13 × 13 fixtures, C1–C5 × 16 fixtures, R1–R4) | 255 |
| **Total** | **559 / 559 pass** |

`vite build` passes. ESLint is unchanged from before (1 pre-existing engine error; test files have no Jest-globals config, also pre-existing).

Re-baselined tests (Governance §13): only B34.1, B34.1b, B34.4. All three were validated by closed form before updating. The base fixture is DSCR-bound, year 0 is equity-funded, so all principal P is drawn in year 1 and IDC = 0.07 × ½ × P. Hence P = 47,507,319.59 / 1.035 = 45,900,791.87, IDC = 1,606,527.72, equity = 54,099,208.13.

---

## 11. Remaining unresolved modeling differences (all documented, none hidden)

1. **Annual periodicity (P-016).** Ops interest overstated ≈ 2.0M on Madaba-size debt (−1.15pp IRR). IDC −136K. Repayment granularity.
2. **Equity timing convention (new, P-026).** The period-index IRR places construction-year-0 equity a full period before op-year-1 flows. Combined with equity-first funding, that dates equity ~1 yr late relative to operations (+0.79pp here).
3. **Construction cost profile (new, P-027).** Even annual capex is used. The benchmark's front-loaded S-curve (−581K IDC) cannot be represented. Also `ceil(months/12)`: a 30-month build accrues IDC over 3 full years (= same IDC as 36 months).
4. **Day count.** act/360 vs annual simple (−78K IDC).
5. **Sizing basis.** The benchmark fixes equity and sculpts the resulting debt. XCEPTA sizes debt from gearing/DSCR. Both are legitimate. Inputs must be mapped deliberately (§8).
6. **Tax / depreciation.** XCEPTA taxes EBITDA − interest with no depreciation or IDC amortization. Not testable against Madaba (no tax). Unvalidated.
7. **Avg DSCR definition** differs (§5).
8. **Financing fees** are not modeled. They must be entered in TPC.

## 12. New defects found (not fixed — need authorization; candidates for P-023 / P-015D follow-up)

| ID | Defect | Evidence | Severity |
|---|---|---|---|
| **P-024** | **Tenor longer than the concession leaves debt unpaid with no error.** Sizing uses tenor − grace even when the concession is shorter. | Base fixture, concession 5 / tenor 10: final closing balance **32,159,639.94**, no warning. Pre-existing. | **High.** Needs a policy decision: cap the repayment window at the concession (sizes less debt) or reject the input. |
| P-025 | A fractional tenor (e.g. 9.5) is silently floored to whole years in sizing and repayment. `repayment_years` reports 7.5 while 7 are used. | Tenor 9 and 9.5 give identical COD debt 42,678,580.05. | Medium (validation) |
| P-026 | Equity-timing convention in IRR (see §11.2). | IRR bridge B3→B4. | Medium (convention, P-016-adjacent) |
| P-027 | No construction cost profile input; non-multiple-of-12 builds round up for IDC. | 30m = 36m IDC 2,428,697.90. | Low–Medium |
| — | `Debt %` + `Equity %` are not validated to sum to 100 on the PPP path. | Equity % only feeds diagnostics. | Low (P-023) |

## 13. Classification

**CONDITIONAL PASS.**

- **Core identities reconcile and are independently tested.** Sources = uses, debt continuity, COD handoff, interest basis, amortization, the DSCR definition and the equity-return series all pass across 16 fixtures. Values come from first principles, not engine read-back. Rate-0 regression matches the frozen baseline field-by-field.
- **The benchmark is understood, not just compared.** The workbook was replicated to the unit. Every material variance is quantified and attributed to a named convention or structural limitation. None is an unexplained calculation error.
- **Conditions:**
  - (a) Annual periodicity has a material effect on debt service and returns (−1.15pp IRR); it is offset here by the equity-timing convention (+0.79pp), so close headline IRR agreement is not evidence of correctness.
  - (b) P-024 is a pre-existing correctness defect in the debt mechanics that can leave a schedule unreconciled. It should be resolved before any claim beyond "annual, tenor ≤ concession".
  - (c) The validated scope is **annual, tenor ≤ concession, no-depreciation-tax** availability-payment PPP.

## 14. Decisions requested

1. Approve Convention A for TPC and gearing-on-(TPC + IDC) for `Debt %` (§3.1, §3.3). Alternatively, direct a change.
2. Choose the P-024 resolution: cap the repayment window at the concession, or block the input.
3. Should the benchmark replica script and extracted benchmark series be committed (e.g. `docs/benchmark/`)? They are proprietary Etihad workbook data, so I have kept them out of the repo for now.
4. Authorize the next package (P-023, then P-022). Note: §5d shows P-022 already caused stale numbers to be recorded as validated.
5. Pushing to `origin/master` and deployment are **not** done. Approved baselines in production are untouched and will show pre-IDC outputs until re-approved (P-022).
