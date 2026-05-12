# XCEPTA Financial Engine Validation — Section A QA Summary

**Engine under test:** monthly development cash flow engine
**Entry point:** `src/modules/feasibility/cashflowEngine.js` → `runCashFlowEngine(inputs)`
**Supporting modules:** `irr.js`, `funding.js`, `scurve.js`, `salesTiming.js`, `exitValuation.js`
**Validation pack:** XCEPTA Financial Engine Validation Test Pack v1, Section A (tests A1–A19)
**Approach:** standalone Node.js ESM scripts under `tests/section{A,B,C,D}/`. No Jest, no new packages, no engine modifications.

## Totals

| Metric | Count |
|---|---|
| Tests written | **22** (A1, A2, A3, A3b, A4, A4b, A5, A5b, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18, A19) |
| Binding pass | **22 / 22** |
| Binding fail | **0** |
| Engine files modified | **0** |

## Commits on this branch

| Hash | Files | Tests | Message |
|---|---|---|---|
| `2fa8553` | 8 | A1, A2, A3, A3b, A4, A4b, A5, A5b | Add Section A financial engine tests A1-A5b |
| `d3cceea` | 5 | A6, A7, A8, A9, A10 | Add Section A tests A6-A10 for monthly cash flow engine |
| `f965f30` | 5 | A11, A12, A13, A14, A15 | Add monthly engine tests A11-A15 for exit valuation and DSCR scope |
| `80f49bd` | 4 | A16, A17, A18, A19 | Add monthly engine tests A16-A19 for leverage, IRR, and reconciliation |

Not pushed.

## Test inventory by section

### Section A (`tests/sectionA/`) — funding waterfall + leverage core
- **A1** Zero-debt baseline — engine degenerates correctly with 100% equity.
- **A2** 100% debt funding (zero equity) — engine handles loan-first path without throwing.
- **A3** High leverage (LTV ≈ 80%) — diagnostic; sales offsets reduce drawn LTV well below the facility ratio. Binding criteria (lift > 0, IRR < 5.0) hold.
- **A3b** High leverage with forced loan draw — post-only sales, low equity; **real loan principal of 1M, capitalized interest 72.5k, LTV 56.4%, lift +11.28%**.
- **A4** Equity-first waterfall (diagnostic) — vacuous pass: sales offsets prevent any loan draw.
- **A4b** Equity-first waterfall with forced loan draw — **clean transition observed at m=8**: equity exhausted, loan picks up the residual same month, loan-only thereafter.
- **A5** Early-sales surplus (diagnostic) — surplus months correctly produce zero equity/loan draws.
- **A5b** Pre-sales without IRR explosion — landCost raised so month-0 CF stays negative; IRR bounded.

### Section B (`tests/sectionB/`) — funding modes, breaches, edge inputs
- **A6** Capitalized vs cash interest — confirms compounding direction: `totalFinancingCost_cap > totalFinancingCost_cash` and `unleveragedIRR` invariant across runs.
- **A7** Loan capacity breach — engine flags breach without throwing; reports `equityShortfall` and partial loan draw.
- **A8** All-post-completion sales — sales land exclusively in m=T+1..T+postSaleMonths.
- **A9** Phase weights sum to zero — engine throws with `"Phase weights must sum to 1.0; got 0.000000"`.
- **A10** Full sale in month one — `salesPreAndDuring = totalGDV`, no loan needed.

### Section C (`tests/sectionC/`) — exit valuation, NPV, scope
- **A11** GDV exit, fully sold — `presoldFraction=1.0` → `residualGDV=0`, no double-counting at exit.
- **A12** Cap-rate exit valuation — NOI / capRate identity holds; selling costs reduce net proceeds.
- **A13** Cap-rate sensitivity — `grossExitValue`, `projectNPV`, `unleveragedIRR` decline monotonically across 5%/7%/9%/11%.
- **A14** Negative NPV case — `unleveragedIRR < discountRate ⇔ projectNPV < 0`.
- **A15** DSCR scope — confirmed no DSCR field in `summary` or `schedule`. Out of scope by design.

### Section D (`tests/sectionD/`) — leverage direction, IRR robustness, reconciliation
- **A16** Positive vs negative leverage — both directions observed: `sign(projectIRR − rate) == sign(leverageLift)`.
- **A17** IRR no-sign-change guard — solver throws on all-negative, all-positive, and single-element series; `runCashFlowEngine` propagates this cleanly when totalGDV=0.
- **A18** IRR convergence — Newton-Raphson converges in 6 iterations on realistic CF; `NPV(cf, solvedRate) = 7.6e−10`; engine summary IRR matches solver to ±1e−3.
- **A19** Schedule reconciliation — all 5 row-sum invariants hold within $1 across hardCost, softCost (incl. upfrontSoftCosts), salesInflow, loanDraw, capitalizedInterest.

## Key engine behaviors confirmed

1. **Funding waterfall is strict equity-first.** Loan never draws while equity has untapped headroom. Transition months may legitimately mix equity and loan draws when equity is exhausted mid-month.
2. **Sales proceeds correctly offset cost draws** in the funding waterfall. Surplus months produce zero equity and zero loan draw.
3. **Capitalized interest is rolled into `loanBalance`** at each construction month and accrues against the growing base (compounding).
4. **Cash-paid interest does not compound** — balance stays at principal — so total cash interest is strictly less than capitalized interest given identical inputs.
5. **`unleveragedIRR` is invariant to financing structure.** Capitalized vs cash interest produce bit-identical project-level IRR (verified to ±1e−6 in A6).
6. **Leverage lift signed correctly.** Positive when `projectIRR > rate`, negative when `projectIRR < rate`. Negative-leverage runs reveal debt destroying equity value, as expected (A14, A16).
7. **GDV-method exit residual is zero when `phaseWeights` sum to 1.0** — all revenue flows through the sales schedule, no exit double-counting.
8. **Cap-rate exit valuation follows `NOI / capRate − selling costs`** identity to floating-point precision (A12, A13).
9. **IRR solver is defensive** — throws on no-sign-change CF rather than returning a junk number. The engine propagates this cleanly when inputs produce a degenerate CF (e.g. `totalGDV=0`).
10. **Schedule rows reconcile to summary KPIs.** Per-row sums equal headline totals within ±$1 (rounding tolerance from `round2()` on each row).
11. **Validation guards fire as expected.** `phaseWeights` and `paymentSchedule` are both checked for sum=1.0; `exitCapRate` must be (0,1); `NOI<0` throws; bad `equityAmount`/`loanAmount`/`annualInterestRate` throw with specific messages.
12. **Loan capacity breach is non-fatal.** Engine draws up to the facility limit, records the unfunded portion in `equityShortfall`, sets `loanCapacityBreached=true`, and continues — no throw. (Worth confirming this matches business intent.)

## Known limitations / diagnostics

1. **DSCR (Debt Service Coverage Ratio) does not apply to `cashflowEngine.js`.**
   DSCR is a stabilised-operations metric for income-producing assets after construction completion. This engine models the construction + exit phase only. `summary` and `schedule` correctly contain no DSCR field — verified in A15. If DSCR is needed, it belongs on a separate operating-period engine downstream.

2. **GDV exit value is zero when sales phase weights sum to 100%.**
   Per `cashflowEngine.js:145`, `presoldFraction = phaseWeights.pre + during + post`. When this equals 1.0 (the normal case), `residualGDV = totalGDV × (1 − presoldFraction) = 0`, so `grossExitValue`, `sellingCosts`, and `netExitProceeds` are all zero on the GDV path. All revenue is captured through the monthly sales cash flows — no double counting at exit. The non-zero `residualGDV` branch only fires if the caller intentionally sets `phaseWeights` summing to less than 1.0, representing unsold units to be disposed at exit (verified in A11).

3. **Capitalized interest compounds, so total financing cost is higher than equivalent cash-paid interest.**
   Per `funding.js:116-121`, when `capitalizeInterest=true`, accrued interest is added to `loanBalance` so the next month's accrual is on a larger base. When `capitalizeInterest=false`, interest is paid out each month and the balance stays at principal. The two scenarios are NOT economically equivalent in total interest paid — A6 observed `cap=true: 45,368.14` vs `cap=false: 43,839.56` (+3.5% delta on a 24-month construction loan at 8%). The financing-structure-invariant metric is `unleveragedIRR`, not total financing cost.

4. **IRR can be non-meaningful in lender-style cash flows where month-0 CF is positive.**
   When a project pre-sells aggressively (e.g. pre=50% × deposit=20% = 10% of GDV landing at m=0) and the m=0 deposit inflow exceeds the land outflow, the project's CF starts positive and only goes negative. Newton-Raphson still solves for a rate, but the resulting "IRR" is mathematically a financing-side rate, not an investor return rate. Examples: A5 (original) reported IRR of 3.1e14% before correction; A11 reports 225.63% because m=0 deposit (~340k) > m=0 land cost (300k). A5b deliberately raises `landCost` to keep CF[0] negative and bound the IRR. This is a known limitation of single-IRR for mixed-sign CFs; the engine's behavior is mathematically correct, but interpretation requires care.

5. **No engine files were modified.**
   All 22 test scripts import the engine modules read-only. `src/modules/feasibility/cashflowEngine.js`, `irr.js`, `funding.js`, `scurve.js`, `salesTiming.js`, and `exitValuation.js` are unchanged from the start of the validation run.

## How to run

From the repo root, ESM mode (package.json has `"type": "module"`):

```bash
# Run any individual test
node tests/sectionA/A1_zero_debt.js
node tests/sectionB/A6_cap_vs_cash_interest.js
# ... etc

# Run all tests in a section (PowerShell)
Get-ChildItem tests/sectionA/*.js | ForEach-Object { node $_.FullName }
```

Exit code 0 = PASS, 1 = FAIL. Each script prints a per-check breakdown and an overall verdict.
