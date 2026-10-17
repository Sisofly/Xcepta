# P-028 — Tax depreciation, loss carry-forward and cash-tax timing

**Engine:** PPP v2.1.0. **Branch:** `rc/ppp-v1`. **Status:** implemented and tested. Awaiting product-owner review. Not pushed or deployed.

> **These are modelling assumptions, not confirmed Jordanian tax treatment.**
>
> The following must be confirmed by a Jordanian tax adviser before results are relied on:
> - the allowable depreciation period (it depends on asset classification and the project's tax position);
> - the loss rules;
> - the sector tax rate;
> - the payment dates.
>
> Every taxable result carries `TAX_ASSUMPTIONS_UNCONFIRMED` and `tax_assumptions.confirmed = false`.

## Scope

| Tax rate / method | Treatment |
|---|---|
| Tax Rate = 0% (exempt) | No tax calculation. Every output is bit-identical to v2.0.0 |
| Tax Depreciation = None | The v2.0.0 method (tax on EBITDA − interest each period, no relief). Bit-identical to v2.0.0 |
| Tax Rate > 0, default | The P-028 method (`src/modules/feasibility/pppTax.js`) |

## Inputs

All inputs are ordinary assumption rows, so there is no schema change. A missing row uses the default shown.

| Input | Default | Notes |
|---|---|---|
| Tax Rate | — | The combined burden: income tax + national contribution (e.g. 20% + 1% general, 24% + 3% electricity). Always disclosed as an assumed rate |
| Tax Depreciation | Straight-line | Straight-line or None |
| Tax Depreciation Life (years) | Concession period | Preliminary assumption |
| Depreciable Share % | 100, with a warning | Excludes land and other non-depreciable cost. Asked for in the wizard |
| Eligible IDC % | 100 | Share of capitalised IDC in the depreciation basis |
| Tax Loss Carry-Forward (years) | 5 | Whole number ≥ 0, or Unlimited. Model clock (see below) |
| Terminal Tax Write-off | No | Yes only if supported by the tax position |
| Tax Year End Month | 12 | Calendar tax years. Needs the Construction Start Date; without it, 12-month years run from COD (`TAX_YEAR_FALLBACK`) |
| Tax Payment Lag (months) | 4 | Cash payment after each tax-year end |

## Formulas

**Calendar mapping**
- Operating period *k* covers months [k·M, (k+1)·M) after COD.
- A period's EBITDA and interest are spread evenly over its months.
- Tax years follow the Tax Year End Month. The first and final tax years may be partial.

**Depreciation** (non-cash; tax only)
- Straight-line from the COD month: cumulative allowance after *j* months = min(B, B·j / (Life·12)).
- Levered basis: B = share × (TPC + eligible × IDC), using the reported (cent-rounded) IDC.
- Unlevered basis: B_u = share × TPC.

**Taxable income and losses**
- TI_y = Σ EBITDA − Σ interest − depreciation (− write-off, final year only).
- A loss is tagged with its tax year *o* and can be used in years *o*+1 … *o*+N, **oldest first**. It then expires. There is no carry-back and no refund.
- Tax expense_y = r2(rate × max(0, TI_y − losses used)).

**Model clock vs legal rule**
- The model counts loss expiry from the year the loss arises, and a partial first year counts as a full year.
- Jordan counts from when losses are final and audited, which is usually later.
- The model's expiry is therefore earlier, i.e. conservative (`TAX_LOSS_CLOCK_SIMPLIFIED`).

**Cash timing**
- Each tax year's expense is paid in month (year end + lag).
- Payments due after the concession are paid in the final period (`TAX_PAYMENT_AFTER_CONCESSION`).
- Total paid = total expense, exactly.

**CFADS and equity**
- CFADS = EBITDA − cash tax paid. **Depreciation is never deducted from CFADS.**
- Equity cash flow = CFADS − (interest + principal), checked in every period.
- `pbt` = EBITDA − interest − depreciation.
- `tax_expense` per period = each tax year's tax allocated by positive taxable income. This is a **modelling estimate, not an accounting-standard tax provision** (`TAX_EXPENSE_ALLOCATION_ESTIMATE`).

**Project IRR**
- A separate unlevered tax run: no interest, basis B_u, its own loss pool, same tax years and lag.

## Calculation sequence (no circular references)

1. Compute EBITDA, then the tax calendar.
2. **IDC fixed point.** Repeat: basis(IDC) → size debt with the tax-aware solver → fund construction → new IDC. Stop when the IDC changes by less than 0.01. If that doesn't happen within 50 iterations, the engine blocks with `TAX_SIZING_NOT_CONVERGED`.
3. **Each sizing trial runs forward in time.** Tax paid in period *k* depends only on periods ≤ *k*, because a tax year is settled at its last period and paid no earlier. Interest_k is the opening balance × rate, known before principal_k.
4. **Maximum-debt validation.** The bisection result must be feasible; D + δ must be infeasible; and none of 64 scan points above D across [0, 1 + Σ EBITDA/target] may be feasible. Otherwise the engine blocks with `DEBT_SIZING_UNRESOLVED`. This search range is a valid upper bound because cash tax is never negative.
5. Run operations with the same tax state, then a reporting pass (expense allocation, net income).
6. Run the unlevered tax pass, then compute the IRRs.
7. **Tax reconciliation gate** (`OUTPUT_RECONCILIATION_FAILED` if any check fails):
   - paid = expense;
   - period expense = tax-year expense;
   - loss roll-forward holds every year;
   - depreciation ≤ basis;
   - equity CF = CFADS − debt service.

## Approved results

- Stored results and input snapshots are never changed.
- A v2.0.0 result counts as current **only** if it is tax-exempt (its saved inputs record Tax Rate 0) **and** re-running v2.1.0 on its saved inputs reproduces every stored value exactly.
- Taxable v2.0.0 results show "Outdated engine".

## Validation

| Item | Result |
|---|---|
| New tests (`tests/pppTax.test.js`) | **97 pass**. They cover: an independent month-by-month reference (calendar dates, FIFO loss queue) matched to the cent on 15 cases and a 64-case matrix (annual/quarterly × 4 COD months × 2 year-ends × 4 lags); hand-worked examples; the no-circularity proof; validation of the debt range; frozen v2.0.0 regression (Madaba plus 80 randomized cases); disclosures; validation codes; currency and jsonb persistence |
| Full suite | **853 pass** |
| Mutations | **11/11 caught**: loss expiry, payment lag, depreciation in CFADS, IDC loop, unlevered basis, FIFO, tax-year end, refunds, 0%-tax routing, currency rule, sizing validation |
| `verify:staging` | **41/41 PASS**, including a 21% taxable case |
| Existing tests that encode the v2.0.0 tax method | Now select `Tax Depreciation = None` explicitly. **Their assertions and expected values are unchanged** (B34/B35, I10, R1/R2/R4, Q3, X5, V8, PI1, S1; T1/T11 scoped, T1b/T11b added) |
