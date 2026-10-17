# XCEPTA — PPP / Project Finance Module: Consolidated Completion Report

**Release candidate rc1.1** · 2026-10-10
- **Branch:** `rc/ppp-v1`, PR [Sisofly/Xcepta#3](https://github.com/Sisofly/Xcepta/pull/3). Based on production `7a59b14`; includes and supersedes #2.
- **Engine:** `PPP_ENGINE_VERSION = 2.0.0`
- **Status:** not merged, not deployed. Awaiting final product-owner authorization.

## Final release-readiness assessment

**PASS for release, subject to one product decision and the deployment sequence in §8.**
- **Calculations:** every financial identity reconciles under independent tests, including a real Postgres database lifecycle.
- **Annual outputs:** byte-identical to production for every valid input.
- **Quarterly and variable CFADS:** validated against closed-form benchmarks and the Madaba workbook.
- **DSCR gates:** consistent (P-018).
- **Unsupported capabilities:** disclosed or blocked.

**Open decision (methodology): tax depreciation.** XCEPTA charges tax without depreciation or loss carry-forward. This is now disclosed on every taxable result, but it understates equity IRR by about **+1.3pp to +6.3pp** on tested taxable cases. The bias is conservative, and adding depreciation is a methodology change (§7.1).
- **Option A — release now.** The disclosure is in place; depreciation becomes the next item. Recommended if near-term projects are tax-exempt or zero-tax, like Madaba.
- **Option B — add depreciation before release.** Recommended if taxable projects will be approved immediately.

---

## 1. Implemented changes (one logical commit each)

| Commit | Item | Summary |
|---|---|---|
| `bf6e155` | PR #2 | Saved debt schedules include capitalised IDC. Production understated COD debt by the IDC. |
| `20304b4` | P-024 | Loan maturity after concession expiry is blocked; terms are never shortened automatically. |
| `856d59d` | P-023 / P-025 | 15 blocking input codes; output reconciliation gate; reasonableness warnings; no silent flooring of fractional periods; render-time crash removed. |
| `e981d86` | P-022 | Immutable, versioned results (payload, engine version, inputs snapshot) via an additive migration. Saved-only display. Current / outdated / legacy / inputs-changed disclosure. |
| `d7a9b50` | P-016, Phase 3 | Annual / quarterly engine. Escalation, revenue profile and basis, construction cost profile, seasonal weights, annuity and equal-principal profiles. Per-period DSCR-constrained sizing. |
| `0e06df4` | Phase 6 | Input editors; optional-inputs panel with neutral defaults; annual / quarterly labels; quarterly debt schedule view. |
| `2d323f1` | Phase 4/5 | Quarterly Madaba fixture; quarterly persistence; rc1 baseline. |
| `c7cc4a7` | Phase 4/6 | Project IRR; result provenance in the PDF; shared formatters. |
| `b1d9889` | **P-018** | Sculpting target separated from the underwriting DSCR threshold across engine, gates, recommendation, remediation and PDF. |
| `fa62550` | **DB integration** | Store module shared by the page and tests; 32 PGlite lifecycle tests on the real migration; scope disclosures; unsupported project-finance contract models blocked. |
| `0e15bc3` | **Scope** | Tax-depreciation disclosure on every taxable result; formatting. |

---

## 2. Financial methodology decisions

| Topic | Decision |
|---|---|
| Total Project Cost | Base cost **excluding** IDC. Total funding = TPC + IDC (approved). |
| Debt % | Requested gearing on TPC + IDC. Equity is the balancing item. The Equity % input is informational (approved). |
| Loan tenor | Measured from COD, including grace. Must be ≤ concession (blocking, approved). |
| **DSCR (P-018)** | **Two separate concepts.**<br>• **Target DSCR** sizes and sculpts the debt.<br>• **Lender Minimum DSCR** (new optional input; default `PPP_DSCR_FLOOR` = **1.20×**; must be ≥ 1.00×) is the **underwriting acceptance threshold** used by every pass/fail gate: bankability panel, KPI pass, breach year, recommendation floor and PDF.<br>• Gates use the covenant-frequency minimum (quarterly for quarterly models).<br>• A Target DSCR of 0 means "no sculpting constraint", and that project still faces the underwriting gate.<br>• Approved results are judged against the threshold saved with them. |
| Interest / IDC | Nominal annual rate / p on opening balances. IDC on (opening + ½ draw), capitalised. |
| WACC / IRR | WACC effective annual → periodic. IRR solved on periodic flows and reported as an effective annual rate. Project IRR is unlevered, post-tax, before financing. |
| Escalation / timing | Annual indexation steps. Contractual quarterly weights if given. Construction cost profile if given. |
| Debt sizing | Flat CFADS + sculpted: the existing solver. Otherwise per-period bisection enforcing the target in every period, including grace. Capacity falls rather than producing a sub-target schedule. |
| Quarterly → annual reporting | Flows summed; balances as stocks; annual DSCR = ΣCFADS / ΣDS. |
| Persistence | Insert-only rows. "Outdated" decided by the engine version and its compatible-version list. Legacy rows are shown as historical with an inferred engine generation. |

Methodological implication of P-018: projects sculpted below 1.20×, such as Madaba at 1.00×, now **fail** the DSCR gate and carry underwriting warnings. Previously the bankability panel compared min DSCR with the sculpting target and passed them. The remediation card now shows the project re-sized at the underwriting threshold (debt, equity, IRR, NPV) instead of a payment solver that cannot converge when the target is below the threshold.

---

## 3. Independent test results

### 3.1 Automated suite — 725 / 725 pass, 8 suites (304 at the start of Gate 1)

| Suite | Tests | Scope |
|---|---:|---|
| `feasibilityEngine.test.js` | 259 | Original B1–B57; B34 and B38.5 re-baselined with documented reasons |
| `engine.test.js` | 46 | Real-estate cash-flow engine (untouched) |
| `pppFundingInvariants.test.js` | 255 | 13 identities × 13 fixtures; IDC/COD × 16 fixtures; frozen-baseline regression |
| `pppQuarterlyVariable.test.js` | 78 | Quarterly identities (incl. Madaba); annual↔quarterly; closed-form benchmarks; variable CFADS; 150 randomised; project IRR |
| `pppValidation.test.js` | 35 | P-024; blocking codes; warnings; **P-018 U1–U5**; **tax disclosure S1** |
| `resultPersistence.test.js` | 10 | Record/JSON round trip; drift; stale / legacy |
| `debtSchedule.test.js` | 10 | Persisted-shape debt schedule |
| **`pppLifecycle.integration.test.js`** | **32** | **Real Postgres (PGlite 0.5.8, in-memory) + the real migration file** — see §3.2 |

- `vite build` passes.
- All new and changed PPP modules are ESLint-clean. The engine is lint-clean; the page has 11 errors, all pre-existing.

### 3.2 Database persistence and migration (item 2)

The production database was not used; the sandbox blocks network access to it and no production records were read or written. Tests run on an embedded Postgres engine, applying the **actual** migration file to a base schema reconstructed from the columns the app uses. The page and the tests run the same store functions (`pppResultStore.js`).

**Migration:**
- M1: additive — legacy rows are byte-identical afterwards; the 5 new columns are NULL with the exact intended types.
- M2: idempotent.
- M3: before the migration, PPP approval is refused and **nothing is written**; the version stays a draft.

**Lifecycle × 4 cases** (annual IDC; quarterly; variable CFADS with escalation + demand profile + annuity; quarterly Madaba). Inputs → Calculation → Save → Approve → Reload → Display → PDF values:
- L1: approval metadata — status, label, approved_at, created_by, computed_at, engine version, periodicity, schema version.
- L2: exact numeric and jsonb round trip of the full payload and inputs snapshot.
- L3: reload equals the engine output verbatim (no recalculation).
- L4: display — debt schedule = engine schedule; COD = principal + IDC; full repayment; funding summary; bankability and recommendation consistent with `meets_underwriting`.
- L5: PDF values.
- L6: inputs edited after approval are disclosed, while saved figures are unchanged.

**History and failure:**
- H1: legacy approvals stay displayable and are flagged historical, with no fabricated summary.
- H2: an outdated engine version is flagged and not recalculated.
- H3: re-approval creates a new row and leaves the earlier approval byte-identical.
- H4: when version approval fails, the inserted result is rolled back. A mutation test (rollback disabled) makes H4 fail, so the test has teeth.
- H5: unsupported project-finance contract models are identified.

**Backward compatibility:** the production engine `7a59b14` and the RC agree on **593/593** valid annual scenarios. Real-estate approval and loading are unchanged apart from a hidden provenance flag.

### 3.3 Independent release harness (own arithmetic, not engine helpers)
1,000 random annual and quarterly scenarios with every new input showed **zero failures** on all of:
- sources / uses
- IDC rule
- COD
- roll-forward
- interest rule
- tax rule
- DSCR ≥ target
- amortisation
- aggregation
- NPV
- IRR
- project IRR
- equity multiple
- integrity

### 3.4 Display and PDF
- **Server-rendered screens with real saved outputs:** current quarterly Madaba, inputs-changed, legacy, outdated engine, P-024 blocking error, underwriting warnings, scope notes. The funding summary reconciles: principal 42,324,398 + IDC 5,263,909 = COD 47,588,307.
- **PDF:** values come from the saved record (tested in L5). PDF text passes through the existing `safe()` sanitiser.
- **Not yet done:** a live signed-in click-through. It's in the checklist (§8.4).

---

## 4. Madaba benchmark reconciliation (item 5, final)

The independent replica of the Etihad workbook reproduces it exactly: IDC 5,498.9k; loan 47,787.8k; IRR 8.9932%; NPV −827.3k.

XCEPTA inputs are traced from the workbook, not fitted:
- TPC 50,788,939 excluding IDC;
- gearing 84.899%;
- 8.25%;
- no tax, no grace;
- tenor 9.5 years;
- opex 54,020 escalating 2.015%;
- the workbook's own quarterly construction timing.

Results re-run on the final engine are unchanged by P-018.

| Metric | Benchmark | XCEPTA quarterly | Δ | Fully explained by |
|---|---:|---:|---:|---|
| Capitalised IDC | 5.499M | 5.264M | −235k | +8.5k equity amount; −77.4k day count (act/360 vs nominal/12); −166.1k accrual frequency (monthly vs quarterly mid-period) |
| COD senior debt | 47.788M | 47.588M | −200k | Gearing × IDC Δ: 84.899% × −235k = −199.6k |
| Equity | 8.500M | 8.465M | −35k | 15.101% × lower total funding (the benchmark fixes equity as an input) |
| CFADS | 87.408M | 87.408M | 0 | — |
| Quarterly debt service, q1–29 | — | — | ≤ 116 JOD per quarter | Annual-step vs quarterly opex escalation |
| Debt fully repaid | ops q30 | ops q30 | 0 | — |
| Equity IRR | 8.99% | 9.38% | +0.39pp | +0.20pp lower IDC/debt → more dividends; +0.175pp equity dated at quarter ends vs actual months; +0.01pp period-index vs dated XIRR |
| Equity NPV | −0.827M | −0.526M | +0.30M | Same causes, plus valuation date |
| Min DSCR | 1.00 | 1.00 | 0 | Sculpted at 1.00. **Fails the 1.20× underwriting threshold**, consistent with the Gate 1 finding that the deal is marginal |

All residuals are documented calculation conventions. No formula was adjusted to converge.

---

## 5. Reconciliation gates (every calculation)

`checkPPPIntegrity` withholds results unless all of these hold:
- sources = uses;
- COD = principal + IDC;
- debt roll-forward continuity (annual and quarterly schedules);
- full repayment by concession expiry.

The measured differences are saved with each approved result.

---

## 6. Completion criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Material known defects resolved | ✅ PR #2, P-024, P-023, P-025, P-022, **P-018**, unsupported-contract-model routing |
| 2 | Annual and quarterly reconcile | ✅ |
| 3 | IDC and financing schedules reconcile | ✅ |
| 4 | Debt sizing for flat and variable CFADS | ✅ |
| 5 | Maturity / concession enforced | ✅ |
| 6 | Investment returns verified | ✅ |
| 7 | Invalid inputs / implausible outputs handled | ✅ |
| 8 | Persisted and displayed outputs consistent | ✅ (database lifecycle tests); live click-through in §8.4 |
| 9 | Historical approvals auditable | ✅ (H1–H3) |
| 10 | Regression and integration tests pass | ✅ 725/725, including 32 database tests |
| 11 | Benchmark differences explained | ✅ §4 |
| 12 | Limitations documented and disclosed in the product | ✅ §7 |

---

## 7. Financial scope and limitations (item 4) — disclosed in the product, not presented as validated

Every PPP result shows a "Model scope — not modelled" note. Specific engine warnings fire where a limitation affects the result.

1. **Tax depreciation and loss carry-forward: not modelled.**
   - Tax = rate × max(0, EBITDA − interest) each period.
   - For taxable projects this overstates tax, so CFADS, debt capacity and returns are understated (conservative).
   - Measured with debt held fixed: equity IRR +1.3pp (100M, 25-year concession, 20% tax) and +6.3pp (capital-heavy 10-year concession, 20% tax).
   - Warning `TAX_DEPRECIATION_NOT_MODELLED` appears on **every** taxable result.
   - Zero-tax projects (e.g. Madaba) are unaffected.
   - **Decision required** (summary at the top of this report): implementing it means choosing the depreciation basis (capex, with or without IDC), the asset life (concession, i.e. IFRIC 12 intangible, or other) and carry-forward rules. It changes every taxable result (engine version bump, re-approvals).
2. **Reserve accounts:**
   - No DSRA / MMRA, lock-up or cash-sweep tests.
   - Dividends = CFADS − debt service each period.
   - Lender reserve requirements are not reflected in returns.
3. **Demand-based projects:**
   - Projects created with a Demand-based, Hybrid, PPA or other non-AP contract model have **no validated engine**. They previously fell through to the real-estate engine with no inputs; they are now **blocked** (banner, approval disabled).
   - Demand revenue is supported inside availability-payment projects via Revenue Profile with Revenue Basis = Demand Estimate. That is labelled and carries a demand-risk disclosure.
4. **Other:**
   - single senior facility; no separate financing fees (include them in TPC);
   - annual or quarterly only (no monthly);
   - equity is dated at period end (+0.175pp IRR on quarterly Madaba);
   - `computeRequiredPayment` (P-017) solves only for a flat AP.

---

## 8. Release preparation

### 8.1 Pre-migration check (read-only — Supabase SQL editor)

```sql
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name in ('model_outputs', 'versions')
order by table_name, ordinal_position;

select kcu.column_name as model_outputs_primary_key
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
where tc.table_schema = 'public' and tc.table_name = 'model_outputs' and tc.constraint_type = 'PRIMARY KEY';

select count(*) as model_outputs_rows_before from public.model_outputs;
```

Expected:
- `model_outputs` has `version_id`, `irr`, `npv`, `equity_multiple` (numeric), `dscr_series` and `cash_flows` (json/jsonb), `created_by`, `computed_at`, and **none** of the five P-022 columns.
- The primary key is `output_id`, `model_output_id` or `id`. If it is anything else, tell me before deploying: the approval-failure rollback uses it.
- Record the row count.

### 8.2 Migration and deployment sequence
1. Take a Supabase backup or confirm point-in-time recovery is enabled.
2. Run §8.1 and confirm the expectations.
3. Apply `db/migrations/2026-10-10_p022_versioned_model_outputs.sql` (additive; nullable columns; no data touched; idempotent).
4. Run the verification query at the end of the migration file:
   - `legacy_rows` = the row count from step 2;
   - `versioned_rows` = 0.
5. Run the smoke test (§8.4) on the PR #3 Vercel preview. **The preview uses the production Supabase database**, so use a dedicated test project.
6. Authorize the merge: PR #3 into `master` as a merge commit, pinned to the tested head. This triggers the Vercel production deployment.
7. Confirm production deployed the merge SHA, then close #2 as superseded.
8. **Rollback, if needed:** revert the merge commit. The new columns can stay: they are nullable and ignored by the previous code, so no database rollback is required.

### 8.3 After deployment
- Existing PPP approvals display as **historical** until each is re-approved. Nothing is recalculated automatically.
- Re-approve projects whose figures are relied on: create a new draft, then approve. The earlier approval stays in history.

### 8.4 Signed-in preview smoke-test checklist (≈10 minutes, dedicated test project)
1. Open a copy of a PPP project. Assumptions shows "Checks on the current inputs". For a taxable project, it includes the tax-depreciation warning.
2. Set Loan Tenor > Concession. A ⛔ `LOAN_MATURITY_EXCEEDS_CONCESSION` error appears and Approve is disabled. Restore the tenor.
3. Approve (annual). The confirmation lists the model checks. Results shows "Saved result · engine v2.0.0 · annual model".
4. Funding & debt summary: COD debt = principal + IDC. The debt schedule shows IDC in construction rows and a final closing ≈ 0.
5. Set Target DSCR to 1.00 on a new draft. Results show Meets underwriting = No, the DSCR gate fails, and the underwriting-check card appears.
6. Add *Model Periodicity* (Optional PPP inputs), set it to Quarterly, then create a draft and approve. The label reads "quarterly model", and "Show quarterly detail" works.
7. Edit any input after approval. The "Inputs changed since approval" banner lists it, and the figures are unchanged.
8. Reload the page. Identical figures and banners.
9. Export the PDF. Key Metrics shows the result basis, project IRR, IDC / COD debt and underwriting minimum / met.
10. Open an older approved PPP project. It shows the "Historical result" banner and is not recalculated.

---

## 9. Out of scope (not started, per instruction)
- Valuation & Equity Research.
- Portfolio Management.
- Quarterly-only enhancements beyond the above.
- Tax depreciation (pending decision).
