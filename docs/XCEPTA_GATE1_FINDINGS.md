# XCEPTA — Gate 1 Validation Findings

**Status:** Closed — first correctness defect fixed and benchmark-validated. P-010 (debt schedule) now built; production deployment current.
**Date:** 2026-06-03 (original) · Updated 2026-06-08 (post-deployment verification)
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

| Field | Run A (target 1.15) | Run B (target 1.00) | Benchmark | Δ (B) |
|---|---:|---:|---:|---:|
| Supportable debt | 36.43M | 42.20M | 47.79M | −5.59M |
| Resulting equity | 19.86M | 14.09M | 8.50M | +5.59M |
| **Min DSCR** | 1.15 | **1.00** | **1.00** | **0.00 ✓** |
| **Avg DSCR** | 1.48 | **1.29** | **1.29** | **0.00 ✓** |
| Equity IRR | −3.66% | −18.01% | 8.99% | — |
| NPV | −8.11M | −6.65M | −0.83M | — |

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

```
XCEPTA Run B supportable debt (target 1.00):   42,196,641
Benchmark capitalized IDC (ConFin):           + 5,498,890
                                              ────────────
                                                47,695,531
Benchmark term loan:                            47,787,827
Residual after IDC:                                 92,296   (0.19%)
```

The equity gap mirrors it exactly: XCEPTA equity (14.09M) − benchmark equity
(8.50M) = 5.59M = the same IDC. XCEPTA makes **equity** plug the hole the
benchmark plugs with **IDC-funded debt** — which is precisely why its IRR craters
(more equity, same dividends). Once IDC is modeled, debt rises ~5.5M toward
47.8M, equity falls toward 8.5M, and IRR should converge toward 8.99%.

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

**⚠️ Open question — debt figure discrepancy at Target DSCR 1.00.**
The deployed engine sizes **44.42M** at DSCR 1.00, but §4.4 Run B (a local
dry-run during the fix) recorded **42.20M** for the same inputs — a ~2.2M
difference. Both hold Min DSCR at 1.00 and both reconcile, so this is not a
correctness failure, but the two figures disagree and the IDC reconciliation
arithmetic in §5 was built on the 42.20M figure. Consequences:

- The residual-to-benchmark gap is now **~3.4M** (47.79M − 44.42M), not the
  ~5.5M documented in §5. The IDC capability (P-015) must still close it, but
  the target magnitude is smaller than the §5 arithmetic implies.
- **Action (next session):** reconcile which figure is authoritative. Likely the
  42.20M was an intermediate dry-run state and 44.42M is the shipped engine — in
  which case §4.4 and §5 should be re-baselined to 44.42M. If instead something
  changed sizing between dry-run and ship, identify what, because it moves the
  IDC reconciliation. Do NOT treat 44.42M as validated until this is explained —
  per §13 (test-integrity), a number is not accepted until its origin is known.

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

## 6. Findings register

| ID | Finding | Status |
|---|---|---|
| **P-009** | Target DSCR validated but never consumed in debt sizing (`debt = tpc × debtPct`) | ✅ **Fixed** (`bd5dca9`) |
| **P-013** | Grace deferred principal + full interest, compressed annuity into `tenor − grace` → principal cliff | ✅ **Fixed** (`bd5dca9`) |
| **P-015** | No construction debt draw / IDC capitalization / equity-first drawdown | 🔴 **Open — dominant residual gap. Next P0.** Residual to benchmark ~3.4M on live engine (was documented ~5.5M; see §5c open question). Build order: 015A equity-first funding waterfall → 015B construction debt draw → 015C IDC capitalization → 015D COD term-loan conversion. Validate each layer against the Target-DSCR-1.00 run and the debt schedule before committing. |
| **P-010** | PPP debt schedule (opening/draw/IDC/interest/principal/closing) exposed in Results | ✅ **Built** (`31ebde4`, `c142310`). Display-only; rolls schedule from `cash_flows` + `debt_sizing.actual_debt`, with a principal-sum fallback so it renders on old baselines. Draw/IDC are zero placeholder columns for P-015 to populate. Reconciles to ~0 closing balance on both nadeem runs. Built **before** P-015 deliberately — it is the validation surface for IDC. |
| **P-016** | Annual periodicity only; benchmark is quarterly | 🟡 Backlog |
| **P-017** | `computeRequiredPayment` remediation now largely redundant — DSCR sizing already solves coverage, so the solver returns ~zero gap for any self-sized project. Reassess its UI role. | 🟡 Backlog |
| **P-018** | PPP DSCR default duplicated across three literals (sizing target `annualEngine.js:386`, solver `:609`, floor `:664`) instead of referencing the single `PPP_DSCR_FLOOR` constant. Section 5 "no duplicated thresholds" violation. Also: dead `?? 1.30` fallback + stale 1.30 docblocks in `recommend.js`. Fix when next touching the debt module. | 🟡 Backlog — Low |
| **P-019** | Two-tier DSCR model (size to lender-minimum 1.20, approve to institutional 1.30) — deferred underwriting-stance option, not adopted. | 🟡 Backlog — option |
| **P-020** | Project insert failed `projects_project_type_check` for PF sectors (Healthcare/Energy/Industrial) added in E-0.3a — wizard sent raw sector, not in the CHECK whitelist. | ✅ **Fixed** (`652de13`). `getLegacyProjectType` maps all PF projects to constraint-legal `'Infrastructure / PPP'`; true sector stays in `projects.sector`. FPA display paths made sector-first. No DB migration. |
| **P-021** | No runnable test invocation in main tree — `"type":"module"` + jest 30, no `test` script; raw `npx jest` failed on ESM. 304-test suite only ran inside Claude Code worktrees. | ✅ **Fixed** (`bdc3951`). Added `test` script (`node --experimental-vm-modules`); `npm test` → 304/304 from main tree. `.claude/` gitignored; stale worktrees removed. |
| **P-022** | Approved baselines carry old-engine output shapes; features built against the newer return shape (e.g. debt schedule needing `debt_sizing`) don't find their fields, and stale cached output can show invalid results behind only a warning banner. Re-approval regenerates correct output. | 🟠 Open — Med. Mitigated for debt schedule by the principal-sum fallback (`c142310`). Consider hard-blocking (not just warning) approved results when engine version changes, and/or auto-regenerating on engine upgrade. |
| **P-023** | No input/output sanity validation. A missing-zeros TPC entry (56,290 vs 56,290,000) produced a confident "Strong Investment Case / Proceed / 1257% IRR" — dangerous for an institutional tool. | 🟠 Open — **High severity, low effort.** Build on **invariant ratios**, not deal-size thresholds: warn (not block) if Interest/Debt <0.5%, Debt-Service/Debt <1%, DSCR >20×, Equity Multiple >50×, IRR >100%, or simple payback <1yr. These hold across sectors. Schedule after P-015, before P-016. |
| ~~P-005~~ | "OPEX 570" percentage bug | ⛔ **Struck** — input was 0%; 570 is correct. No Madaba evidence. |
| ~~P-012~~ | Operating rate 8.25% vs 7.0% | ⛔ **Struck** — engine reads 7% correctly; 8.25% was a service ratio, not the coupon. |

**Input-error note (not a defect):** future Madaba benchmark comparison runs
should use operating rate **8.3%** (6.5% base + 1.8% margin), not 7.0%. The 7.0%
used in these runs was a benchmarking input error on our side, not an engine
issue. No code or default was changed.

---

## 7. Validated scope statement

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
2026-06-08). One open item carries into the P-015 work: the debt-figure
discrepancy at Target DSCR 1.00 (§5c) must be reconciled — confirm whether
44.42M (live) or 42.20M (documented dry-run) is authoritative before the IDC
reconciliation arithmetic is re-based. All other workstreams — taxonomy,
mixed-use, villas, capability-matrix expansion, positioning — remain paused until
PPP correctness is complete through IDC.

**Session log 2026-06-08:** P-020 (constraint), P-021 (test runner), P-010 (debt
schedule), P-022 mitigation all shipped and deployed. Live convergence re-test
confirms Min DSCR → 1.00 exactly on the deployed engine. Next session: reconcile
the §5c debt figure, then begin P-015A (equity-first funding waterfall).
