# XCEPTA — Gate 1 Validation Findings

**Status:** P-015B/C/D complete — **Gate 1 completion checkpoint: CONDITIONAL PASS (awaiting authorization)**. See §9 and `docs/GATE1_COMPLETION_REPORT_P015.md`.
**Date:** 2026-06-03 (original) · Updated 2026-06-08 (post-deployment verification) · Updated 2026-10-10 (P-015B/C/D, traced benchmark reconciliation)

> **⚠️ 2026-10-10 corrections — read §9 before relying on §3–§5d.** Tracing the
> Madaba workbook cell-by-cell showed that several June inputs were mis-mapped:
> TPC 56.29M already includes 5.50M IDC; rate is 8.25% (1.75% margin, not 1.8%);
> **no tax**; **no post-COD grace**; tenor 9.5 yrs; equity is a fixed input.
> Therefore (a) the June Min/Avg DSCR "exact match" was coincidental, not proof of
> tax or CFADS correctness; (b) the residual debt gap was **not** IDC; (c) §5d's
> frozen IRR/NPV (−10.2% / −4,295,923) were stale pre-015A values. The correct
> post-015A figures are −7.28% / −5,342,533.
**Owner:** Saad (product / finance logic) · Engine: `src/modules/feasibility/annualEngine.js`

**Commit chain (on `origin/master`):**
- `bd5dca9` — fix(ppp): size debt to Target DSCR via CFADS sculpting (P-009, P-013) *(originally `ec592cc` in a worktree; cherry-picked to master)*
- `c88a2ed` — docs: Gate 1 findings + test-integrity rule
- `652de13` — fix(ppp): map PF project_type to constraint-legal value; FPA sector-first (P-020)
- `bdc3951` — chore: local test runner + ignore `.claude` worktrees (P-021)
- `31ebde4` — feat(ppp): add Debt Schedule to PPP results (P-010)
- `c142310` — fix(ppp): derive debt-schedule starting balance from principal sum when `debt_sizing` absent (P-010/P-022)

**Deployment note (2026-06-08):** the GitHub→Vercel auto-deploy integration had
silently disconnected on ~Jun 2, so commits `bd5dca9` through `c142310` were live
on `origin/master` but **not deployed** to production until manually reconnected
and redeployed via Vercel "Create Deployment → master" on Jun 8. Auto-deploy is
restored; verify it fires on the next push. Approved baselines required re-approval
to regenerate output in the current engine's shape (see P-022).

---

## 1. Objective

Determine whether XCEPTA's PPP engine can reproduce the economics of an
institutional-grade project-finance model — not in marketing terms, but against
a real, independently built FAST-standard benchmark with a full debt waterfall,
sculpted debt service, and audited returns.

The governing question: *Can XCEPTA correctly model a Hospital PPP compared to a
manual institutional model, within tolerance, for the right reasons?*

"For the right reasons" is the operative phrase. A number that matches the
benchmark by coincidence or by curve-fitting is a failure, not a pass.

---

## 2. Benchmark

| Item | Detail |
|---|---|
| Reference model | Madaba Hospital PPP — F1F9 / FAST standard (Etihad, 30-03-2026) |
| Structure | Quarterly periods, DSCR-sculpted senior debt, equity-first construction funding, construction debt draw with capitalized IDC converted to term loan |
| Authoritative scenario | Scenario 2, sized to Target DSCR (Debt Sizing) = 1.00 |

The benchmark's documented "case" in the original readiness audit diverged from
the actual model on most inputs (see §6). The actual model values were taken as
canonical and the audit case corrected.

### Authoritative benchmark outputs (last-saved Excel values, JOD)

| Metric | Value |
|---|---|
| Total Project Cost | 56.29M |
| Senior term loan | 47.79M |
| Equity | 8.50M |
| Annual Availability Payment | 8.80M (flat) |
| Equity IRR | 8.99% |
| Shareholders NPV @ 10% Ke | −0.83M |
| Min DSCR | 1.00 |
| Avg DSCR | 1.29 |
| Operating-period rate | 8.3% (6.5% base + 1.8% margin) |
| Periodicity | Quarterly |
| Concession / operations | 10 years |
| Construction | 36 months |

**Commercial note:** the benchmark itself is a marginal deal — equity IRR (8.99%)
sits below the 10% hurdle and NPV is mildly negative. Min DSCR of 1.00 means zero
coverage headroom. The honest reading is that Madaba is over-levered for an 8.8M
availability payment; it requires either more AP (~13M for 1.15×) or less debt to
be bankable. XCEPTA and the benchmark agree on this underlying reality.

---

## 3. Inputs tested

Mapped from the benchmark into XCEPTA's wizard:

| Input | Value | Note |
|---|---|---|
| Model Type | Project Finance | — |
| Sector | Healthcare / Infrastructure | — |
| Contract Model | Availability Payment | — |
| Total Project Cost | 56.29M | — |
| Debt % | 85% | — |
| Annual Availability Payment | 8.80M flat | — |
| Construction Period | 36 months | — |
| Operations / Concession | 10 years | — |
| Interest Rate | **7.0%** | **Input error** — benchmark uses 8.3% (see P-018 note, §6) |
| Loan Tenor | 10 years | — |
| Grace Period | 2 years | — |
| Tax Rate | 20% | — |
| WACC / Ke | 10% | — |
| Target DSCR | 1.15 (bankable run), 1.00 (convergence run) | — |

---

## 4. Result chain

### 4.1 Initial run — FAIL

| Metric | Benchmark | XCEPTA (initial) | Verdict |
|---|---|---|---|
| TPC | 56.29M | 56.30M | ✅ match |
| Equity invested | 8.50M | 8.44M | ✅ match |
| Total revenue | 88.0M | 88.0M | ✅ match |
| Equity IRR | 8.99% | did not solve | ❌ |
| NPV @ 10% | −0.83M | −4.87M | ❌ |
| Min DSCR | 1.00 | 0.77 | ❌ |
| Equity Multiple | 2.73× | 0.56× | ❌ |

Inputs consumed correctly; all four return metrics wrong. Single root-cause
signature: debt sized blind to serviceability.

### 4.2 Code inspection (read-only)

Confirmed in `runPPPEngine`:

- **Debt sized as `tpc * debtPct`** (fixed 85%), never to DSCR.
- **`targetDscr` never read** by the engine sizing path — only by the
  ratio/validation/recommend layer and the standalone `computeRequiredPayment`
  solver. → **P-009 confirmed.**
- **Grace mechanic deferred principal but charged full interest**, then
  compressed a level annuity into `tenor − grace` years, producing a principal
  cliff. → **P-013 confirmed.**
- Operating rate read **correctly** at 7% (no margin/spread/hardcode). The
  observed "8.25%" was a debt-service-to-opening-debt ratio, not the coupon.
  → **P-012 not a defect; struck.**
- "OPEX = 570" was consistent with the **0% OPEX input** entered, not a
  percentage-normalization bug. → **P-005 not a defect on this screen; struck.**

### 4.3 Fix — DSCR-constrained sculpting

`runPPPEngine` rewritten to:

1. Size debt to the user's **Target DSCR** via CFADS sculpting:
   `supportable debt = PV of the CFADS/target-sculpted debt-service stream`.
2. Hold the **Availability Payment fixed** and **flex debt capacity** to fit.
3. **Equity plugs the gap** (`equity = TPC − supportable debt`), recomputed into
   the construction drawdown.
4. Return a `debt_sizing` diagnostic block: requested / supportable / shortfall /
   additional equity / resulting equity / min DSCR / avg DSCR / target / actual.

General CFADS-based form used (not flat-only annuity) so the engine generalizes
to non-flat CFADS later. Verdict/recommendation logic and the
`computeRequiredPayment` solver were **not** modified.

### 4.4 Benchmark convergence — two runs

> **⚠️ Superseded debt/equity/IRR figures (see §5c).** The Run B debt (42.20M)
> and equity (14.09M) below were intermediate **dry-run** values recorded
> mid-fix. The shipped engine sizes **44.42M debt / 11.87M equity** at DSCR 1.00
> (verified live 2026-06-08). The **DSCR rows remain valid** — Min/Avg DSCR match
> the benchmark exactly regardless. Treat the debt/equity/IRR/NPV cells in this
> table as historical estimates; the live figures in §5c are authoritative.

| Field | Run A (target 1.15) | Run B (target 1.00) | Benchmark | Δ (B) |
|---|---:|---:|---:|---:|
| Supportable debt | 36.43M | 42.20M *(superseded → 44.42M)* | 47.79M | −5.59M |
| Resulting equity | 19.86M | 14.09M *(superseded → 11.87M)* | 8.50M | +5.59M |
| **Min DSCR** | 1.15 | **1.00** | **1.00** | **0.00 ✓** |
| **Avg DSCR** | 1.48 | **1.29** | **1.29** | **0.00 ✓** |
| Equity IRR | −3.66% | −18.01% *(superseded → −10.2%)* | 8.99% | — |
| NPV | −8.11M | −6.65M *(superseded → −4.30M)* | −0.83M | — |

**Min DSCR and Avg DSCR match the benchmark exactly.** This proves the sculpting
mechanism, per-period CFADS, tax treatment, and DSCR computation are correct.
DSCR is a ratio, so the exact match is necessary-but-not-sufficient evidence —
it does not alone prove the absolute cash flows match. The remaining debt/IRR/NPV
gap was therefore traced to its source rather than assumed away.

---

## 5. IDC reconciliation — the residual gap is fully explained

The ~5.6M debt shortfall is **not** a sculpting defect. The benchmark draws debt
during construction and **capitalizes interest-during-construction (IDC) into the
term loan**; XCEPTA funds construction with 100% equity and models zero IDC.

> **⚠️ This reconciliation used the superseded 42.20M dry-run figure (see §5c).**
> The arithmetic below is preserved for audit trail. Corrected reconciliation
> using the authoritative live figure (44.42M):
>
> ```
> XCEPTA supportable debt (target 1.00, live):   44,417,516
> Benchmark term loan:                            47,787,827
>                                                ────────────
> Residual IDC gap to close (P-015):              ~3,370,311   (~3.4M)
> ```
>
> The original ~5.5M estimate below was inflated by the low 42.20M dry-run base.
> The true IDC capability target is **~3.4M**, not ~5.5M.

```
XCEPTA Run B supportable debt (target 1.00):   42,196,641   [superseded — see §5c]
Benchmark capitalized IDC (ConFin):           + 5,498,890
                                              ────────────
                                                47,695,531
Benchmark term loan:                            47,787,827
Residual after IDC:                                 92,296   (0.19%)
```

The equity gap mirrors it: XCEPTA equity − benchmark equity = the same IDC.
XCEPTA makes **equity** plug the hole the benchmark plugs with **IDC-funded
debt** — which is precisely why its IRR craters (more equity, same dividends).
Once IDC is modeled, debt rises ~3.4M toward 47.8M, equity falls toward 8.5M,
and IRR should converge toward 8.99%.

**The gap is a missing capability, not a calculation error.**

This finding also vindicated stopping before a tempting "size over full tenor"
code change. That change would have lifted XCEPTA's debt to ~47.8M by
manufacturing capacity from grace years that don't amortize — matching the
benchmark **by the wrong mechanism** and masking the real IDC cause. A number
that matches for the wrong reason is a latent defect.

---

## 5c. Live production convergence re-test (2026-06-08)

After the Vercel deployment was brought current, both Madaba scenarios were re-run
on the **deployed** engine to confirm production matches the validated local
behaviour. Two approved baselines now exist live:

| Field | nadeem 1 (Target 1.15) | Nadeem 2 (Target 1.00) | Benchmark (1.00) |
|---|---:|---:|---:|
| Supportable debt | 38.34M | **44.42M** | 47.79M |
| Resulting equity | 17.95M | 11.87M | 8.50M |
| **Min DSCR** | 1.15 | **1.00** | **1.00** |
| Equity IRR | −0.6% | −10.2% | 8.99% |
| NPV | −5.83M | −4.30M | −0.83M |
| Equity Multiple | 0.97× | 0.77× | 2.73× |
| Debt schedule closing (final yr) | 0 | 0 | — |

**Min DSCR converges to 1.00 exactly on the deployed engine**, confirming the
sculpting logic is live and correct. The debt schedule reconciles to a zero
closing balance on both runs. The 1.15-vs-1.00 pair cleanly demonstrates the
engine flexing debt to the target (lower DSCR target → more debt → less equity).

**✅ Resolved — debt figure reconciled (2026-06-08).** The deployed engine sizes
**44.42M** at DSCR 1.00; §4.4 Run B recorded **42.20M**. Code inspection of
`sculptSupportableDebt` (`annualEngine.js:336`) confirms **44.42M is
authoritative**: the function binary-searches (`:328-329`) for the starting debt
balance that amortizes to exactly zero over `repayYears`, including the tax
shield on interest (`:351`). The live run produced Min DSCR = 1.00 with the debt
schedule closing at exactly 0 — a self-consistent solution, which by definition
is the correct supportable debt for these inputs. The 42.20M was an intermediate
dry-run figure recorded mid-fix before the search settled; it is **superseded**,
not a separate valid result. No code changed between dry-run and ship; the
difference was an early estimate vs the final converged value.

**Consequence for IDC (P-015):** the residual-to-benchmark gap is **~3.4M**
(47.79M − 44.42M), NOT the ~5.5M originally documented in §5. The IDC capability
must close ~3.4M of capitalized construction interest, not ~5.5M. §4.4 and §5
below retain the original 42.20M dry-run figures for audit trail but are marked
superseded; the authoritative sizing is 44.42M.

---

## 5b. DSCR floor reconciliation (incidental finding)

During documentation, Section 5 of `XCEPTA_GOVERNANCE.md` was found to state
`PPP_DSCR_FLOOR = 1.30`, while the code constant and every active consumer use
**1.20** end-to-end. Inspection confirmed:

- The runtime DSCR threshold is **1.20** for both engine sizing and the
  bankability gate. They agree — a self-sized PPP at Min DSCR 1.20 passes its
  own gate and is verdict-eligible. **No sizer-vs-gate conflict exists.**
- The `1.30` in the governance doc and in two `recommend.js` docblocks (plus a
  dead `?? 1.30` fallback that no caller triggers) is **stale legacy reference**,
  never reflected in code.

**Decision:** the PPP DSCR floor is confirmed at **1.20 (lender-minimum stance)**.
Section 5 is corrected to 1.20 to match code. A 1.30 institutional-approval tier
(two-tier: size to lender minimum 1.20, approve to sponsor bar 1.30) is a
legitimate institutional model but is **deferred — see P-019**, not adopted by
default. The 1.20-vs-1.30 question is an underwriting-stance decision and is
recorded here as consciously decided, not inherited.

Inspection also revealed the 1.20 default is **duplicated across three
independent literals** (sizing target, solver, bankability floor) rather than
referencing the single `PPP_DSCR_FLOOR` constant — a Section 5 "no duplicated
thresholds" violation. Logged P-018.

---

## 5d. P-015A complete + frozen pre-IDC baseline (2026-06-08)

**P-015A — equity-first construction funding waterfall — is COMPLETE.**
Commit `23d134c`. Implemented, tested (304/304 with invariant-based assertions,
B34.4 re-baselined), live-verified, and reconciled.

Construction funding now draws equity first, then debt for the balance, instead
of an even equity split. Each construction `cash_flows` row emits `equity_draw`
and `debt_draw`; the debt schedule ramps the balance from 0 to the full sized
debt by COD. This transformed the debt schedule from a reporting artifact into
an actual funding schedule.

**Live-verified construction ramp (Madaba Target DSCR 1.00):**

| Year | Phase | Opening | Draw | Closing |
|---|---|---:|---:|---:|
| 0 | Construction | 0 | 6,890,850 | 6,890,850 |
| 1 | Construction | 6,890,850 | 18,763,333 | 25,654,184 |
| 2 | Construction | 25,654,184 | 18,763,333 | 44,417,517 |
| 3 | Operations | 44,417,517 | 0 | (amortizing) |

**Reconciliation (all PASS):** Σ equity_draw = equity_amount · Σ debt_draw =
actual_debt · COD closing balance = actual_debt (44,417,517) = operations
opening debt · construction IDC = 0 (correctly deferred to 015C) · final
amortization residual = 1 JOD (within ±1 tolerance).

### Frozen pre-IDC base case — Madaba Target DSCR 1.00

This is the **base case** against which 015C (IDC) will be measured. Recorded
here per institutional model discipline: save the base case before changing the
debt structure.

| Metric | Pre-IDC value (post-015A) |
|---|---:|
| Debt (sized) | 44,417,517 |
| Equity | 11,872,483 |
| Min DSCR | 1.00 |
| Equity IRR | ~~−10.2%~~ **−7.28%** *(corrected 2026-10-10)* |
| NPV | ~~−4,295,923~~ **−5,342,533** *(corrected 2026-10-10)* |
| Equity Multiple | 0.77× |
| Construction IDC | 0 |

> **Correction (2026-10-10):** the struck IRR/NPV are the *pre-015A* even-split
> values. Hand check: NPV = −(11.87/3)(1 + 1/1.1 + 1/1.21) + 4.553(1.1⁻³ + 1.1⁻⁴)
> = −4.30M. They were carried over from a stale output (a P-022 symptom). The
> post-015A engine at `5b9cacc` gives −7.28% / −5,342,533. The frozen control
> baseline is now machine-readable: `docs/baselines/ppp_pre_idc_control_baseline.json`.
> The qualitative expectation below that "COD debt increases" is also wrong when
> debt is DSCR-bound (§9.3).

### Expected 015C (IDC) behaviour — QUALITATIVE only, NOT anchored targets

Per §13 test-integrity (and to avoid anchoring the engine toward expected
outputs), the following are the *directional/structural* expectations for IDC.
The *quantitative* outputs are to be **verified against the benchmark model after
the fact**, NOT pre-declared as targets:

- ✓ Interest accrues on drawn construction debt and is **capitalized** into the
  COD balance.
- ✓ COD debt balance **increases** above 44,417,517 (toward, but do not anchor
  to, the benchmark term loan).
- ✓ Operations begin from the larger IDC-adjusted balance.
- ✓ **Sculpting maintains target DSCR** — Min DSCR should **remain ~1.00**. This
  is a *structural invariant of the sculpting mechanism*, not a benchmark target:
  if DSCR drifts off target after IDC, the IDC and sculpting are not composed
  correctly. Treat DSCR-stays-at-target as a correctness check.
- ✓ Equity IRR and NPV adjust consistently (equity falls as IDC-funded debt
  rises; returns improve). Magnitudes verified against benchmark, not assumed.

**Do NOT freeze "IRR should reach 8.99%" or "debt should reach 47.79M" as
expectations** — those are the benchmark's values to *compare against*, not
goals to steer toward. A correct IDC implementation is one that reconciles and
holds DSCR at target; whatever debt/IRR it then produces is *measured*, and the
residual to the benchmark is *explained*, not forced.

### Planned first step of the 015C work (deferred, not done tonight)

Before touching IDC, add a permanent funding-reconciliation invariant test
(Σ equity_draw == equity, Σ debt_draw == actual_debt, COD closing == actual_debt
across fixtures). This guards 015A's reconciliation so that if 015C's COD-balance
change accidentally breaks the funding waterfall, a test catches it. Deferred
from tonight deliberately — it belongs at the start of 015C, not bolted onto the
015A checkpoint.

### Open question for next session — audit P-015B

015A already produces progressive debt draws, COD reconciliation, and operations
handoff — which was 015B's original scope. **Next session opens by auditing
P-015B**, not by coding it: is it (a) fully satisfied by 015A, (b) partially
satisfied, or (c) still requiring implementation? Only then proceed. Likely 015B
is documentation/confirmation rather than new code, allowing a jump to 015C.

---

## 6. Findings register

| ID | Finding | Status |
|---|---|---|
| **P-009** | Target DSCR validated but never consumed in debt sizing (`debt = tpc × debtPct`) | ✅ **Fixed** (`bd5dca9`) |
| **P-013** | Grace deferred principal + full interest, compressed annuity into `tenor − grace` → principal cliff | ✅ **Fixed** (`bd5dca9`) |
| **P-015** | Construction debt draw / IDC capitalization / equity-first drawdown | ✅ **Complete — pending Gate 1 authorization** (§9). **015A** ✅ `23d134c`. **015B** ✅ closed: satisfied by 015A (evidence §9.1); no code. **015C** ✅ `617100e`: IDC capitalized, solved against DSCR capacity and gearing on TPC + IDC. **015D** ✅ `617100e`/`f8c4a2c`: COD conversion with an engine-emitted `debt_schedule` and explicit tenor/grace basis. 559/559 tests. IDC does **not** close the Madaba gap (§9.2). |
| **P-010** | PPP debt schedule (opening/draw/IDC/interest/principal/closing) exposed in Results | ✅ **Built** (`31ebde4`, `c142310`). **Updated `f8c4a2c`:** renders the engine's `debt_schedule` verbatim, including IDC. The legacy reconstruction is kept only for outputs that predate `debt_schedule`. |
| **P-016** | Annual periodicity only; benchmark is quarterly | ✅ **Done in rc1** (`d7a9b50`): annual / quarterly engine. Annual outputs byte-identical to production; quarterly Madaba IRR gap reduced to +0.39pp, fully attributed (§11). |
| **P-017** | `computeRequiredPayment` remediation now largely redundant — DSCR sizing already solves coverage, so the solver returns ~zero gap for any self-sized project. Reassess its UI role. | 🟡 Backlog |
| **P-018** | DSCR default duplicated across literals; UI used the sculpting target as the bankability floor (a 1.00×-sculpted project passed) while KPI / recommendation used 1.20×; UI collapsed Target DSCR 0 to 1.20. | ✅ **Done in rc1.1** (`b1d9889`): Target DSCR (sculpting) is separate from Lender Minimum DSCR (underwriting, default PPP_DSCR_FLOOR 1.20×). All gates use the underwriting threshold at covenant frequency. Defaults reference the constant. |
| **P-019** | Two-tier DSCR model (size to lender-minimum 1.20, approve to institutional 1.30) — deferred underwriting-stance option, not adopted. | 🟡 Backlog — option |
| **P-020** | Project insert failed `projects_project_type_check` for PF sectors (Healthcare/Energy/Industrial) added in E-0.3a — wizard sent raw sector, not in the CHECK whitelist. | ✅ **Fixed** (`652de13`). `getLegacyProjectType` maps all PF projects to constraint-legal `'Infrastructure / PPP'`; true sector stays in `projects.sector`. FPA display paths made sector-first. No DB migration. |
| **P-021** | No runnable test invocation in main tree — `"type":"module"` + jest 30, no `test` script; raw `npx jest` failed on ESM. 304-test suite only ran inside Claude Code worktrees. | ✅ **Fixed** (`bdc3951`). Added `test` script (`node --experimental-vm-modules`); `npm test` → 304/304 from main tree. `.claude/` gitignored; stale worktrees removed. |
| **P-022** | Approved baselines carry old-engine output shapes; stale output could be shown as current. | ✅ **Done in rc1** (`e981d86`): immutable versioned results (payload, engine version, inputs snapshot), additive migration, saved-only display, current / outdated / legacy disclosure. **Migration must be applied before deploy.** |
| **P-023** | No input/output sanity validation (the "1257% IRR" missing-zeros incident). | ✅ **Done in rc1** (`856d59d`): 15 blocking codes, reconciliation gate, invariant-ratio warnings (the incident is now flagged). |
| **P-024** | Loan tenor longer than the concession left debt unpaid with no error. | ✅ **Done in rc1** (`20304b4`): blocking `LOAN_MATURITY_EXCEEDS_CONCESSION`. Production left debt unpaid in 98 of 207 sampled cases (up to 91% of the loan). |
| **P-025** | Fractional tenor silently floored. | ✅ **Done in rc1** (`856d59d`): blocked in annual models; quarter-year terms supported in quarterly models. |
| **P-026** | IRR equity-timing convention (period-end dating of equity-first equity). | 🟡 Residual, reduced: +0.79pp (annual) → +0.175pp (quarterly) on Madaba. Convention, documented. |
| **P-027** | No construction-cost profile; partial-year builds. | ✅ **Done in rc1** (`d7a9b50`): Construction Cost Profile input; quarterly models resolve 30-month builds to 10 quarters. |
| **P-028** | Tax depreciation / loss carry-forward not modelled. Tax overstated for taxable projects; equity IRR understated by +1.3pp to +6.3pp on tested cases. | 🟡 **Implemented, engine v2.1.0 — awaiting review** (`docs/P028_TAX_METHODOLOGY.md`). Approved methodology; modelling assumptions, not confirmed Jordanian tax treatment. 0% tax and Tax Depreciation = None remain bit-identical to v2.0.0. |
| **P-029** | Non-AP project-finance contract models (Demand-based, Hybrid, PPA, …) fell through to the real-estate engine with no inputs. | ✅ **Blocked in rc1.1** (`fa62550`): "not supported" banner, approval disabled. Demand revenue is supported inside AP projects via Revenue Profile. |
| ~~P-005~~ | "OPEX 570" percentage bug | ⛔ **Struck** — input was 0%; 570 is correct. No Madaba evidence. |
| ~~P-012~~ | Operating rate 8.25% vs 7.0% | ⛔ **Struck** — engine reads 7% correctly; 8.25% was a service ratio, not the coupon. |

**Input-error note (not a defect):** ~~8.3% (6.5% + 1.8%)~~ — corrected 2026-10-10
from the workbook (`InpC!F59:F60`): **8.25%** (6.5% base + **1.75%** margin). The
full benchmark-aligned input set is in §9.2. Future Madaba benchmark comparison runs
should not use 7.0%. The 7.0%
used in these runs was a benchmarking input error on our side, not an engine
issue. No code or default was changed.

---

## 7. Validated scope statement

> **Superseded 2026-10-10 — see §9.5.** The statement below is retained for audit trail.

> **XCEPTA's PPP engine is validated for annual, no-IDC, availability-payment PPP
> debt sizing.** It correctly sizes DSCR-sculpted debt to a user-specified Target
> DSCR, holding the availability payment fixed and flexing debt capacity, with
> equity plugging the funding gap. Coverage ratios (Min DSCR, Avg DSCR) match an
> institutional FAST benchmark exactly.
>
> **Exact convergence with institutional F1F9 models requires** construction debt
> draw / IDC capitalization (P-015) and quarterly periodicity (P-016). Until
> those are built, the bankable claim is scoped to **flat availability-payment
> PPP**, not PPP generally — a flat-CFADS benchmark cannot distinguish true
> sculpting from a level annuity, so the sculpting engine's general form remains
> unvalidated against variable-CFADS structures (toll roads, demand-based,
> escalating-AP). That validation belongs to a later gate with a variable-CFADS
> reference case.

---

## 8. Gate 1 verdict

**PASS — for what was built, validated for the right reasons.**

XCEPTA consumes PPP inputs correctly, builds the capital structure correctly,
sizes DSCR-constrained debt correctly (coverage matches benchmark exactly), and
its verdict/recommendation layer fires correctly. The one material correctness
defect (DSCR not consumed in sizing) is fixed and benchmark-validated. The
residual gap to the benchmark is a single, understood, documented capability
(IDC), not an error.

**Next gate is blocked on P-015 (IDC).** The debt schedule (P-010) is now built
and serves as the validation surface for IDC. Production is current (deployed
2026-06-08). The §5c debt-figure question is **resolved**: 44.42M is
authoritative (the 42.20M was a superseded dry-run estimate), which sets the IDC
target at **~3.4M**, not ~5.5M. All other workstreams — taxonomy, mixed-use,
villas, capability-matrix expansion, positioning — remain paused until PPP
correctness is complete through IDC.

**Session log 2026-06-08:** P-020 (constraint), P-021 (test runner), P-010 (debt
schedule), P-022 mitigation all shipped and deployed. Live convergence re-test
confirms Min DSCR → 1.00 exactly on the deployed engine. §5c debt figure
reconciled — 44.42M authoritative, IDC target ~3.4M.

**Session log 2026-06-08 (cont.):** Full test suite confirmed 304/304 from main
tree (worktrees cleaned again). **P-015A (equity-first construction funding)
shipped** (`23d134c`) — live-verified, reconciled; debt schedule now ramps
construction draws (see §5d). Pre-IDC base case frozen in §5d. Next session:
**audit P-015B status** (likely satisfied by 015A), then begin 015C (IDC
capitalization) starting with a funding-reconciliation invariant test. Validate
015C against the §5d frozen baseline and the benchmark — qualitative
expectations only, no anchored target outputs.

---

## 9. Gate 1 completion — P-015B/C/D and traced benchmark reconciliation (2026-10-10)

Full report: **`docs/GATE1_COMPLETION_REPORT_P015.md`**. Summary below.

### 9.1 P-015B — closed (satisfied by P-015A)

015A already provides progressive construction draws, equity-first funding,
Σ draws = debt, COD balance = operations opening balance, and the operations
handoff. These are now permanently guarded by identity tests I1–I13
(`tests/pppFundingInvariants.test.js`, `8967f92`), which passed 169/169 on the
unmodified engine. The one gap was that the balance roll-forward existed only in
the UI. That is P-015D scope and is closed there. No duplicate code was written.

### 9.2 Benchmark trace — what Madaba actually does

The workbook (`Madaba Hospital Model - Etihad 30-3-2026.xlsm`) was read cell by
cell, and a scratch replica reproduces it exactly (IDC 5,498.9k, loan 47,787.8k,
IRR 8.9932%, NPV −827.3k, Σ dividends 23,216.6k). Findings:

- TPC 56.29M = 50.55M hard cost + 0.24M upfront fee + **5.50M IDC** (Convention B).
- Rate 8.25% (6.5% + 1.75%), act/360 in construction; monthly IDC on the opening balance.
- **No tax.** **No post-COD grace.** Tenor 9.5 yrs (38 quarters) from COD. Opex ≈ 59k/yr.
- Equity is a fixed **input** (8.5M). Debt is the funding gap. The DSCR-1.00 sculpt
  sweeps all CFADS to debt, which is repaid in ops quarter 30. Debt is *not* sized at DSCR capacity.
- "Avg DSCR 1.29" = Σ CFADS over the 38-quarter term ÷ Σ debt service.

Benchmark-aligned XCEPTA inputs: TPC 50,788,939 · Debt % 84.899 · AP 8.8M ·
36 m · 10 yrs · OPEX Amount 59,190 · rate 8.25 · tenor 9 · grace 0 · tax 0 ·
WACC 10 · Target DSCR 1.00.

### 9.3 P-015C / P-015D — implemented (`617100e`, `f8c4a2c`)

- TPC stays Convention A (excludes IDC). Total funding = TPC + IDC = equity +
  principal + capitalized IDC.
- IDC_t = r × (opening_t + ½ draw_t), capitalized, compounding annually.
- COD balance (principal + IDC) ≤ DSCR capacity and ≤ Debt % × (TPC + IDC).
  Solved by bisection on principal. At rate 0 the result is identical to pre-IDC.
- When DSCR binds, IDC consumes capacity and **equity rises by IDC**: Madaba
  June inputs give COD 44.42M (unchanged), equity 11.87M → 15.20M. When gearing
  binds, IDC is debt-financed.
- Tenor is measured from COD. The engine emits `debt_schedule` from the same
  variables as `cash_flows`, and the UI renders it verbatim.

### 9.4 Reconciliation (XCEPTA aligned, post-IDC vs benchmark)

| | Benchmark | XCEPTA | Δ | Class |
|---|---:|---:|---:|---|
| Total uses | 56.29M | 55.52M | −0.77M | IDC conventions |
| Equity | 8.50M | 8.38M | −0.12M | sizing convention |
| IDC | 5.50M | 4.73M | −0.77M | S-curve −0.58M, annual −0.14M, day-count −0.08M, equity +0.03M |
| COD debt | 47.79M | 47.14M | −0.65M | follows IDC |
| Σ CFADS | 87.41M | 87.41M | 0 | — |
| Σ ops interest | 16.40M | 17.85M | +1.45M | annual periodicity (+1.98M on equal debt) |
| Σ distributions | 23.22M | 22.42M | −0.79M | annual periodicity |
| Min DSCR | 1.00 | 1.00 | 0 | by construction |
| Equity IRR | 8.99% | 9.23% | +0.24pp | offsetting: annual ops −1.15pp, equity dating +0.79pp |
| NPV @10% | −0.83M | −0.63M | +0.20M | timing + valuation date |
| EM | 2.73× | 2.67× | −0.06× | annual periodicity |

No variance is an unexplained calculation error. The headline IRR proximity is
the result of offsetting conventions and is **not** evidence of correctness.

### 9.5 Validated scope statement (replaces §7)

> XCEPTA's PPP engine is validated for **annual, availability-payment PPP with
> equity-first construction funding and capitalized IDC, where loan tenor ≤
> concession and tax is modeled without depreciation**. Funding, debt-continuity,
> COD-conversion, DSCR and equity-return identities are tested across 16
> fixtures. Against the Madaba FAST benchmark, all material differences are
> attributed to annual periodicity (P-016), timing conventions (P-026, P-027) and
> input-mapping conventions. Exact convergence requires P-016. Validation against
> variable-CFADS and tax-bearing cases is still outstanding.

### 9.6 Gate 1 completion classification

**CONDITIONAL PASS — awaiting product-owner authorization.** Conditions: annual
periodicity has a material effect on returns; P-024 (tenor > concession leaves
debt unpaid) is an open correctness defect; scope as in §9.5. No work has started
on P-022, P-023 or P-016.

---

## 10. Production deployment verification — PR #1 (2026-10-10)

**Merge & deploy.** PR #1 was merged as `7a59b14` (merge commit, pinned to the validated head `6aac781`). Vercel production deployment `6980010752` for `7a59b14` completed with status **success** (alias `xcepta.vercel.app`).

**Deployed = validated.** The tree of `7a59b14` is identical to the tree of `6aac781` (`621d2052…`). `master` had no other commits between `5b9cacc` and the merge.

**Approved PPP results not silently overwritten — confirmed by code inspection.**
- `model_outputs` rows are written only by an explicit user action: *Approve Version* (`handleApprove`) or *Approve and run scenario* (`handleApproveScenario`). Each **inserts a new row**; nothing recalculates or updates stored rows on load or deploy.
- The only delete is the user-confirmed *Delete scenario* action.
- Stored approved baselines therefore still hold their original (pre-IDC) outputs. A database-level check (row counts / `computed_at` before vs after deploy) needs Supabase access and is with the product owner.

**Smoke-test finding → hotfix (PR #2).** The Results tab renders the persisted `model_outputs` row, which stores only `irr`, `npv`, `equity_multiple`, `dscr_series` and `cash_flows`, never `debt_schedule` or `debt_sizing`. The fallback schedule rebuild ignored row-level `idc`. For PPP projects approved after #1, the displayed COD balance therefore omitted IDC, and the schedule closed at −IDC (Madaba aligned: 42,404,689 shown vs 47,136,906; residual −4,732,217). Engine figures were unaffected. Fixed in PR #2 (`buildDebtScheduleRows`, tested on the persisted shape). **Not yet deployed — awaiting approval.**

**Live UI smoke test:** pending. It requires a signed-in session on production, which Claude cannot perform (credentials stay with the user). Steps are in PR #2's review notes.

### Known limitations in production until corrected

| ID | Limitation | User-visible effect | Planned fix |
|---|---|---|---|
| **P-024** | Loan tenor longer than the concession is accepted. | Debt is sized over years that do not exist, and the balance is left unpaid at concession end with no error. | Blocking validation (approved). Next package. |
| **P-022** | Approved baselines are not invalidated by engine changes. | PPP projects approved before `7a59b14` with construction debt show **pre-IDC** results (no IDC, lower equity, higher IRR) as if current, until re-approved. | Controlled stale-baseline handling. Third in order. |
| PR #2 | Debt-schedule display omits IDC for outputs approved after `7a59b14`. | COD balance understated by IDC; −IDC residual note. | Hotfix PR #2, awaiting approval. |


---

## 11. PPP completion sprint — release candidate rc1 (2026-10-10)

The full consolidated report is **`docs/PPP_COMPLETION_REPORT_RC1.md`**. Assessment: **CONDITIONAL PASS**. The conditions are the P-022 migration, a live smoke test, and the absence of database-integration tests.

Summary:
- PR #2, P-024, P-023/P-025, P-022, P-016 (quarterly) and variable-CFADS sizing are implemented on `rc/ppp-v1`.
- 687/687 automated tests pass.
- A 1,000-scenario independent harness found zero failures.
- Annual outputs are byte-identical to production `7a59b14` for every valid input.

Madaba, quarterly, with the workbook's own construction timing, against the benchmark:
- IDC: 5.264M vs 5.499M (−235k: quarterly vs monthly accrual −166k, day count −77k, equity +8.5k)
- COD debt: 47.59M vs 47.79M
- Debt repaid in ops quarter 30 in both
- Equity IRR: 9.38% vs 8.99% (+0.20pp lower IDC, +0.175pp equity dating)

Variable-CFADS sizing matches closed-form growing-annuity capacity within 1 JOD.

New observation (not changed, P-018): the page uses `Target DSCR || 1.20` as the bankability floor, so an explicit 0 is floored to 1.20 for the verdict while the engine applies no DSCR constraint. This is conservative and left as is pending a P-018 decision.


---

## 12. Release-risk closure — rc1.1 (2026-10-10)

- **P-018 resolved:** sculpting target vs underwriting threshold.
- **Database-backed lifecycle tests:** 32 tests on embedded Postgres using the real P-022 migration; rollback verified by mutation.
- **Unsupported contract models blocked:** P-029.
- **Tax-depreciation omission (P-028):** quantified and disclosed; escalated for decision.
- **Madaba reconciliation:** re-run on the final engine; unchanged and fully attributed.
- **Tests:** 725/725.

The deployment sequence, the read-only pre-migration check and the smoke-test checklist are in `docs/PPP_COMPLETION_REPORT_RC1.md` §8.
