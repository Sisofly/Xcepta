# XCEPTA Product Readiness Audit

**Date of audit:** [omit specific date]
**Repo HEAD at audit time:** `0c1acae` (phase E-0.6: normalize benchmark debt terms)
**Audit type:** Discovery and architecture review only — no code changes.
**Methodology:** 6 parallel investigators + synthesis. All findings traced to file:line where possible.

## Executive Summary

The platform's most important structural finding is that **asset taxonomy is decorative**: the project sub-type and PF sector strings collected by the wizard are never consumed by either underwriting engine, so a "Villas", "Retail", "Commercial", or "Healthcare PPP" project is underwritten with hard-coded `_residential` benchmark keys and produces output that is internally consistent but economically wrong for the chosen asset. The next-most-important findings are (1) the benchmark pack is a single misnamed bucket mixing market data, investor policy, accounting policy, operational settings, and deal-level capital-stack inputs — roughly 30 of ~75 keys are true market conditions and the remainder are miscategorised, with duplicates rendering under identical labels; (2) capital structure has four duplicated read paths with three different default policies, and the Dev Engine silently ignores Sub Debt and Shareholder Loan percentages while accepting JOD overrides that drift from the approved feasibility baseline; and (3) the RE engine has no unit mix, no rent roll, no release sequencing, and a cap-rate exit method that is fully implemented but unreachable from the UI. The percentage-storage seam (display-integer assumptions vs fractional benchmarks) is load-bearing and survivable but undocumented.

## Part 1 — Asset Taxonomy Audit

### 1. Which project subtypes currently exist?

**RE Project Sub-types (`NewProjectModal.jsx` L474):**
```
['Residential', 'Mixed-Use', 'Retail', 'Villas', 'Commercial']
```
Hardcoded inline literal in a `<select>`. No enum, no constant, no DB lookup. Stored as the **`unit`** field on the `Project Sub-type` assumption row (L264) — i.e. as a string, not a typed key.

**PF Sectors (`NewProjectModal.jsx` L11):**
```
PF_SECTORS = ['Infrastructure', 'Energy', 'Healthcare', 'Industrial']
```
With Industrial visibly tagged "(Coming Soon)" (L371). The sector drives the **Revenue / Contract Model** dropdown via `revenueOptions` (L14-20), and the legacy `project_type` is derived (`getLegacyProjectType`, L27-31): `Infrastructure + Availability Payment → 'Infrastructure / PPP'`, everything else PF → just the sector string.

**Top revenue model:** `'Sale' | 'Rental' | 'Mixed'` (RE) plus the PF set. This is the **only axis the engine actually reads.**

### 2. What differs per subtype?

**Underwriting logic:** Nothing. `annualEngine.runEngine` does not read `Project Sub-type` at all (`Grep subtype|Residential|Commercial|Retail|Villas|Mixed-Use` against `annualEngine.js` → no matches except the literal `_residential` default-key strings on L173/176/178).

**Assumptions stored:** Identical for every RE subtype. The INSERT payload at L255-274 of NewProjectModal is one branch — no `if (subtype === ...)` fork. The only sub-typing that *does* drive payload shape is `re_revenue_model === 'Mixed'`, which adds a `Sale Split %` row (L262). That's a revenue-model fork, not a subtype fork.

**Benchmark pack:** No subtype-aware benchmark switching anywhere. The engine hardcodes residential-suffixed default keys regardless of subtype:
- `construction_cost_per_sqm_residential` (L173)
- `sale_price_per_sqm_residential` (L176)
- `rental_yield_residential` (L178)

There exist `_commercial` label entries in the assumption display-name map (`FeasibilityProject.jsx` L2066-2073) — but those keys are **never read by `runEngine`**. They are display-only labels for benchmark rows that the engine itself ignores. A Retail project and a Villas project hit the **same residential** per-sqm cost and the **same residential** sale price.

**Engine branching:** The only engine-selection branch in the entire codebase is `isPPPAvailabilityPayment(project, assumptions)` at `FeasibilityProject.jsx` L579-580 and L1601. That gate routes to `runPPPEngine` vs `runEngine`. There is **no second branch** for RE subtypes, and no branch inside `runEngine` itself.

**Recommendation engine:** `recommend.js` accepts a single boolean `isPPP` (L66) and never sees subtype. DSCR bands and IRR hurdles differ PPP vs non-PPP only.

**UI grouping:** The Assumptions tab swaps between `ASSUMPTION_GROUPS` and `PPP_ASSUMPTION_GROUPS` (L1806) — again, PPP/non-PPP only. No subtype-driven grouping.

### 3. Classification

| Subtype | Support Level | Reason |
|---|---|---|
| Residential | A. Fully supported | The engine's residential-suffixed defaults (`construction_cost_per_sqm_residential`, `sale_price_per_sqm_residential`, `rental_yield_residential`) are tuned for this case; saleable-GFA → absorption → sale revenue path is the canonical flow exercised by tests |
| Mixed-Use | B. Partially supported | NOT via subtype — via the orthogonal `re_revenue_model = 'Mixed'` revenue dropdown, which forks the payload (adds `Sale Split %`, L262) and forks the engine (sale GFA / rental GFA split, `annualEngine.js` ~L153). The subtype label "Mixed-Use" itself is decorative; what actually drives mixed behavior is the Revenue Model dropdown |
| Commercial | C. Label only | The engine reads `_residential` benchmark keys regardless. `sale_price_per_sqm_commercial`, `rental_yield_commercial`, `construction_cost_per_sqm_commercial` exist in the **label map** (FeasibilityProject L2066-2073) but are never read by `runEngine`. A "Commercial" project is underwritten with residential cost/price/yield benchmarks |
| Retail | C. Label only | No engine path, no benchmark pack, no recommendation tuning. String stored as the `unit` field on a sizing assumption row and otherwise inert |
| Villas | C. Label only | Same as Retail. Engine and benchmark treatment is byte-identical to Residential. The label appears once in the dropdown and once stored as an assumption-row unit string |
| Infrastructure (PF) | B. Partially supported | Triggers PPP engine **only** when paired with `Availability Payment` revenue model (`getLegacyProjectType` L29, `isPPPAvailabilityPayment` gate). Other revenue choices on this sector show the "planned for a later phase" inline notice (L455-466) and create a project with zero financial assumptions (`financialRows = isAP ? [...] : []`, L238-252) |
| Energy (PF) | C. Label only | All four revenue options (PPA, AP, Demand-based) fall outside `isAPEngine`, so no engine runs. Project is creatable but inert |
| Healthcare (PF) | B. Partially supported | Same as Infrastructure: only the `Availability Payment` path activates `runPPPEngine`; Demand-based is inert. The PPP engine itself doesn't read `Project Sector` — Healthcare-AP and Infrastructure-AP produce identical math |
| Industrial (PF) | C. Label only | Explicitly tagged "(Coming Soon)" in the dropdown (L371). No engine path, no benchmark pack |

**Label-only subtypes:** Commercial, Retail, Villas, Energy, Industrial. These exist purely as strings in a dropdown and as the `unit` value on an assumption row. They do not change a single line of underwriting math, do not select a different benchmark, do not alter the recommendation, and do not change UI grouping. A user creating a "Villas" project and a user creating a "Commercial" project will receive financial output identical to a "Residential" project with the same GFA, capital stack, and revenue model — because the engine hardcodes `_residential`-suffixed defaults at `annualEngine.js` L173/176/178 and never reads the subtype string at all. Mixed-Use is on the fence: the label is decorative, but the **separate** Revenue Model = Mixed switch does fork engine behavior, so a user choosing "Mixed-Use" subtype + Sale revenue gets a single-stream engine run, while "Residential" subtype + Mixed revenue gets the dual-stream run. The subtype label is wholly disconnected from the engine fork.

---

Confirmed: `project_subtype` is captured in the wizard but is never consumed by either engine. The engine reads only `Revenue Model` + a single `construction_cost_per_sqm_residential` / `sale_price_per_sqm_residential` / `rental_yield_residential` set. There is no asset-type-specific cost, price, yield, or KPI logic anywhere. I have what I need.

| Asset Type | Works Today? | Confidence | Limitation |
|---|---|---|---|
| Single office building | Partial | High | No NOI build, no per-tenant rent roll, no lease schedule, no TI/LC capex — engine forces revenue as `gfa × salePrice × absorption` (Sale) or `gfa × (salePrice × rentalYield)` flat occupancy ramp (Rental). Same residential cost/price/yield defaults are read regardless. |
| Retail center | Partial | High | No anchor/inline tenant mix, no percentage rent, no recoveries (CAM/tax/insurance pass-throughs), no vacancy build — uses the single residential rental-yield curve. No DSRA, no terminal cap-rate exit in `runEngine`. |
| Logistics warehouse | Partial | Med | No long-lease modeling, no triple-net structure, no land-lease, no clear-height / cube-driven cost basis. Will compute but with residential defaults. Functions only as a degenerate single-tenant flat-rental proxy. |
| Industrial facility | No | High | UI shows "Industrial (Coming Soon)" under PF sector; even if forced through RE path, there is no industrial cost/yield benchmark, no take-or-pay/contracted-revenue logic, no merchant pricing curve. |
| Hotel | No | High | No RevPAR/ADR/OccupancyKPI logic, no segment mix (room/F&B/MICE), no GOP→NOI build, no FF&E reserve, no management fee waterfall. Engine has no concept of nightly inventory; would collapse to flat rental annuity. |
| Hospital PPP | Yes | High | `runPPPEngine` exists and is the most-tested non-dev path (Availability Payment, bankability gates, DSCR solver). But it has only ONE revenue line (annualPayment) — no service-fee splits, no usage-based component, no deductions regime, no DSRA construction, no MRA, no handback reserve. Hospital-specific drivers (bed-days, clinical vs non-clinical opex) are absent. |
| Archiving facility | No | High | Not in taxonomy. No long-term storage lease modeling, no per-shelf/per-box revenue unit, no climate-control opex profile. Would have to be force-fit as a Commercial rental — degenerate proxy only. |
| Apartment building | Yes | Med | This is the closest fit to what the engines actually model — `Residential` sub-type with Sale / Rental / Mixed revenue. Numbers are credible at portfolio level but there is no unit-mix (1BR/2BR/3BR), no per-unit pricing, no lease-up curve, no churn, and rental occupancy ramps via a hard-coded `0.55 + 0.15×(op−1)` capped at `maxOcc`. |
| Villa compound | Partial | Med | Same engine as apartment with no differentiation. Villas selection in UI does not flow to a different cost/sale benchmark — same `construction_cost_per_sqm_residential` and `sale_price_per_sqm_residential` defaults are read. Absorption is one uniform `0.35/yr` rate; no plotting/phasing, no per-villa price tier. The dev engine (`cashflowEngine.js`) does provide a credible monthly cash flow with phaseWeights/paymentSchedule, which is the strongest fit for villa sales — but still no per-unit. |
| Mixed-use development | Partial | High | The `Revenue Model = "Mixed"` path exists and splits saleable GFA into `saleGfa` + `rentalGfa` with a `Sale Split %` knob. But there is no separate residential-vs-commercial component sizing, no separate cost bases per component, no separate exit treatment, no stacked-asset waterfall. It's one blended GFA × one cost × one sale-price + one rental-yield, partitioned by a single percentage. |

## Engine Capability Verdict

**What the engines genuinely do well today:** `runEngine` produces a defensible annual P&L → cash flow → IRR/NPV/EM/DSCR for the residential-development archetype with Sale / Rental / Mixed revenue split, validated capital stack (post-F08), and proper grace-period amortization on rental debt. `runPPPEngine` produces a credible Availability-Payment cash flow with construction phase, level-annuity senior debt over `(loanTenor − grace)`, tax shield, and a structured DSCR-floor / IRR-hurdle / NPV bankability gate (`computePPPBankability`) plus a working payment-sizing solver (`computeRequiredPayment`). `cashflowEngine.js` is genuinely the strongest piece in the codebase: a real monthly schedule with S-curve construction draws, three-phase sales timing (pre/during/post), waterfall equity-first funding with capitalized interest, GDV or cap-rate exit, and dual leveraged/unleveraged IRR. Test coverage on `cashflowEngine` is substantial (sections A–D plus engine.test.js).

**Structural gaps that prevent multi-asset credibility:** There is no asset-type dispatch anywhere — `project_subtype` is stored on the project but no engine reads it; every project hits the same `*_residential` benchmark keys regardless of whether it is a hotel, warehouse, or hospital. There is no rent-roll, no per-unit model, no unit-mix, no tenant/lease schedule, no recoveries, no percentage rent, no segment-revenue build (rooms/F&B for hotels, bed-days for hospitals, throughput for logistics). There is no operating-asset NOI/cap-rate terminal value in `runEngine` (only `cashflowEngine` has `cap_rate` exit, and that is the dev engine, not the annual feasibility one). There is no DSRA / Maintenance Reserve / Handback Reserve construction on the PPP side, no MRA cash trap mechanic beyond the binary DSCR-floor liquidity warning, no separate sub-debt or shareholder-loan amortization despite the capital stack validating four tranches. The rental occupancy ramp is a hard-coded `0.55 → 0.88` straight-line — no stabilization curve per asset class. Mixed-use is one blended GFA, not stacked components. Net: the platform models *one* asset class (residential development, Sale/Rental/Mixed) plus *one* PPP contract shape (single-payment AP) credibly; everything else listed in the UI taxonomy is decorative — it accepts the input, runs the residential math, and returns numbers that are arithmetically internally-consistent but economically wrong for the chosen asset.

---

Important finding: the worktree HEAD is `62d2da1` (E-0.3a), NOT `0c1acae` (E-0.6). So E-0.6 has NOT been applied to this worktree yet — `equity_pct/senior_debt_pct/shareholder_loan_pct` are STILL currently in the 'Financing Structure' benchmark group, and the group name is still 'Financing Structure'. I'll audit what's actually live in the codebase.

Now I have everything I need to produce the audit.

## Part 3 — Benchmark Pack Audit

**State of the codebase at this worktree HEAD (`62d2da1`)**: The benchmark pack is a single hardcoded array `BENCH_GROUPS` defined inline inside the JSX render of `FeasibilityProject.jsx` (L1944–2040), with a parallel `LABEL_MAP` (L2050–2139) and a `HINT_MAP` (L2142–2145) containing exactly one entry. Defaults themselves live in a separate `defaults` array fetched from Supabase (a `benchmarks_default` / project-level defaults table) — the `BENCH_GROUPS` array is purely a grouping/labeling overlay. There is no `defaults.js`, no JSON pack, no per-jurisdiction structure: the same eleven groups are applied to every project regardless of Model Type, Sub-type, Sector, or Revenue Model. Note: commit `0c1acae` (E-0.6) which renames 'Financing Structure' → 'Debt Terms' and removes the three capital-stack keys has NOT landed on this worktree (HEAD is `62d2da1`), so the audit below reflects what users actually see today.

| Assumption | Current Location | Correct Classification | Recommendation |
|---|---|---|---|
| inflation_rate | Market Dynamics | Market Conditions | KEEP |
| price_escalation_pa | Market Dynamics | Market Conditions | KEEP |
| demand_growth_pa | Market Dynamics | Market Conditions | KEEP |
| rent_escalation_pct_per_year | Market Dynamics | Market Conditions | KEEP |
| salary_escalation_pa | Market Dynamics | Market Conditions | KEEP |
| gdp_growth_rate | Market Dynamics | Market Conditions | KEEP |
| population_growth_rate | Market Dynamics | Market Conditions | KEEP |
| utilisation_year1 | Operational Drivers | Operational Settings (PF-specific) | MOVE TO OPERATIONAL SETTINGS |
| utilisation_year2 | Operational Drivers | Operational Settings (PF-specific) | MOVE TO OPERATIONAL SETTINGS |
| utilisation_steady_state | Operational Drivers | Operational Settings (PF-specific) | MOVE TO OPERATIONAL SETTINGS |
| occupancy_rate_stabilized | Operational Drivers | Market Conditions (market-observed) | KEEP |
| downtime_pct | Operational Drivers | Operational Settings | MOVE TO OPERATIONAL SETTINGS |
| sale_price_per_sqm_residential | Revenue Drivers | Market Conditions | KEEP |
| sale_price_per_sqm_commercial | Revenue Drivers | Market Conditions | KEEP |
| rental_yield_residential | Revenue Drivers | Market Conditions | KEEP |
| rental_yield_commercial | Revenue Drivers | Market Conditions | KEEP |
| sales_absorption_rate_pct_per_year | Revenue Drivers | Market Conditions | KEEP |
| construction_cost_per_sqm_residential | Cost Drivers & OPEX | Market Conditions | KEEP |
| construction_cost_per_sqm_commercial | Cost Drivers & OPEX | Market Conditions | KEEP |
| capex_contingency | Cost Drivers & OPEX | Investor Policy | MOVE TO INVESTOR POLICY |
| revenue_contingency_pct | Cost Drivers & OPEX | Investor Policy | MOVE TO INVESTOR POLICY |
| property_management_fee_pct | Cost Drivers & OPEX | Operational Settings | MOVE TO OPERATIONAL SETTINGS |
| maintenance_cost_pct_of_value | Cost Drivers & OPEX | Operational Settings | MOVE TO OPERATIONAL SETTINGS |
| maintenance_capex_pct | Cost Drivers & OPEX | Operational Settings | MOVE TO OPERATIONAL SETTINGS |
| insurance_pct_of_value | Cost Drivers & OPEX | Operational Settings | MOVE TO OPERATIONAL SETTINGS |
| land_cost_pct_of_tdc | Cost Drivers & OPEX | Project-level (deal-specific) | MOVE TO PROJECT-LEVEL |
| hard_cost_pct_of_tdc | CapEx & Development | Project-level (deal-specific) | MOVE TO PROJECT-LEVEL |
| soft_cost_pct_of_tdc | CapEx & Development | Project-level (deal-specific) | MOVE TO PROJECT-LEVEL |
| infrastructure_cost_pct | CapEx & Development | Project-level (deal-specific) | MOVE TO PROJECT-LEVEL |
| construction_period_months | CapEx & Development | Project-level (deal-specific) | MOVE TO PROJECT-LEVEL |
| pre_sales_pct_required | CapEx & Development | Investor Policy (lender covenant) | MOVE TO INVESTOR POLICY |
| equity_pct | Financing Structure | Project-level (capital stack) | MOVE TO PROJECT-LEVEL (E-0.6 already does this) |
| senior_debt_pct | Financing Structure | Project-level (capital stack) | MOVE TO PROJECT-LEVEL (E-0.6 already does this) |
| shareholder_loan_pct | Financing Structure | Project-level (capital stack) | MOVE TO PROJECT-LEVEL (E-0.6 already does this) |
| senior_debt_interest_rate | Financing Structure | Market Conditions | KEEP |
| loan_tenor_years | Financing Structure | Market Conditions (typical bank term) | KEEP |
| grace_period_years | Financing Structure | Market Conditions (typical bank term) | KEEP |
| dsra_months | Financing Structure | Investor Policy / lender covenant | MOVE TO INVESTOR POLICY |
| debt_arrangement_fee_pct | Financing Structure | Market Conditions | KEEP |
| corporate_tax_rate | Taxes & Fees | Accounting Policy (statutory) | KEEP (statutory market data) |
| corporate_income_tax_rate | Taxes & Fees | Accounting Policy (statutory) | REMOVE (duplicate of corporate_tax_rate) |
| vat_rate | Taxes & Fees | Accounting Policy (statutory) | KEEP |
| withholding_tax_pct | Taxes & Fees | Accounting Policy (statutory) | KEEP |
| land_registration_fee_pct | Taxes & Fees | Market Conditions (statutory) | KEEP |
| transfer_tax_pct | Taxes & Fees | Market Conditions (statutory) | KEEP |
| receivables_days | Working Capital | Operational Settings | MOVE TO OPERATIONAL SETTINGS |
| receivable_days | Working Capital | Operational Settings | REMOVE (duplicate of receivables_days) |
| payables_days | Working Capital | Operational Settings | MOVE TO OPERATIONAL SETTINGS |
| payable_days | Working Capital | Operational Settings | REMOVE (duplicate of payables_days) |
| inventory_months | Working Capital | Operational Settings | MOVE TO OPERATIONAL SETTINGS |
| inventory_days | Working Capital | Operational Settings | REMOVE (duplicate / unit clash with inventory_months) |
| retention_pct | Working Capital | Operational Settings (contract term) | MOVE TO OPERATIONAL SETTINGS |
| retention_receivable_pct | Working Capital | Operational Settings | REMOVE (duplicate of retention_pct) |
| mobilisation_advance_pct | Working Capital | Operational Settings (contract term) | MOVE TO OPERATIONAL SETTINGS |
| discount_rate_wacc | Exit & Valuation | Investor Policy | MOVE TO INVESTOR POLICY |
| risk_free_rate | Exit & Valuation | Market Conditions | KEEP |
| irr_hurdle_equity_min | Exit & Valuation | Investor Policy | MOVE TO INVESTOR POLICY |
| irr_hurdle_equity_max | Exit & Valuation | Investor Policy | MOVE TO INVESTOR POLICY |
| exit_cap_rate | Exit & Valuation | Market Conditions | KEEP |
| terminal_cap_rate | Exit & Valuation | Market Conditions | KEEP |
| terminal_growth_rate | Exit & Valuation | Investor Policy / DCF assumption | MOVE TO INVESTOR POLICY |
| exit_year | Exit & Valuation | Investor Policy / hold-period policy | MOVE TO INVESTOR POLICY |
| exit_costs_pct | Exit & Valuation | Market Conditions (broker/legal norm) | KEEP |
| depreciation_rate_buildings | Accounting & Depreciation | Accounting Policy | MOVE TO ACCOUNTING POLICY |
| depreciation_rate_fitout | Accounting & Depreciation | Accounting Policy | MOVE TO ACCOUNTING POLICY |
| useful_life_years | Accounting & Depreciation | Accounting Policy | MOVE TO ACCOUNTING POLICY |
| useful_life_civil_works | Accounting & Depreciation | Accounting Policy | MOVE TO ACCOUNTING POLICY |
| useful_life_equipment | Accounting & Depreciation | Accounting Policy | MOVE TO ACCOUNTING POLICY |
| useful_life_intangibles | Accounting & Depreciation | Accounting Policy | MOVE TO ACCOUNTING POLICY |
| salvage_value_pct | Accounting & Depreciation | Accounting Policy | MOVE TO ACCOUNTING POLICY |
| dscr_floor | Risk & Thresholds | Investor Policy / lender covenant | MOVE TO INVESTOR POLICY |
| loan_to_cost_max | Risk & Thresholds | Investor Policy / lender covenant | MOVE TO INVESTOR POLICY |
| loan_to_value_max | Risk & Thresholds | Investor Policy / lender covenant | MOVE TO INVESTOR POLICY |
| stress_vacancy_pct | Risk & Thresholds | Investor Policy (stress-test assumption) | MOVE TO INVESTOR POLICY |
| sensitivity_range_pct | Risk & Thresholds | Investor Policy (analysis convention) | MOVE TO INVESTOR POLICY |
| variance_threshold_amber | Risk & Thresholds | Investor Policy (governance threshold) | MOVE TO INVESTOR POLICY |
| variance_threshold_red | Risk & Thresholds | Investor Policy (governance threshold) | MOVE TO INVESTOR POLICY |

## Benchmark Contamination Findings

The benchmark pack today behaves like a single bucket labelled "Jordan RE Benchmarks" that mixes four distinct conceptual layers. Contamination falls into five clusters:

**1. Capital stack inside benchmarks (deal-specific, not a market norm).**
- `equity_pct`, `senior_debt_pct`, `shareholder_loan_pct` — these are **project-level deal-structuring decisions**, not Jordan market data. The wizard already collects them as `capital_structure` rows in `NewProjectModal.jsx` (L256–259), so the benchmark entries are duplicative and confusing. E-0.6 (`0c1acae`) removes them and renames the group to 'Debt Terms', but that commit has not been merged to this worktree HEAD yet.
- `pre_sales_pct_required` — this is a lender covenant for the specific facility, not a market average.

**2. Investor Policy masquerading as market benchmarks.**
- `irr_hurdle_equity_min`, `irr_hurdle_equity_max`, `discount_rate_wacc`, `terminal_growth_rate`, `exit_year` — these encode the investor's mandate and hold-period preference, not Jordan market truth.
- `dscr_floor`, `loan_to_cost_max`, `loan_to_value_max`, `dsra_months` — lender covenants, not benchmarks. `dscr_floor` already has a documented falsy-fallback bug (MEMORY.md "F04 RESOLVED") that exists precisely because it is shoehorned into a benchmark-style default rather than a policy-tier setting.
- `capex_contingency`, `revenue_contingency_pct` — these are conservatism dials owned by the sponsor / investment committee.
- `stress_vacancy_pct`, `sensitivity_range_pct`, `variance_threshold_amber`, `variance_threshold_red` — analyst / IC conventions for sensitivity work, not market observation.

**3. Accounting Policy masquerading as market benchmarks.**
- The entire 'Accounting & Depreciation' group (`depreciation_rate_buildings`, `depreciation_rate_fitout`, `useful_life_years`, `useful_life_civil_works`, `useful_life_equipment`, `useful_life_intangibles`, `salvage_value_pct`) is firm-level IFRS/GAAP accounting policy. Phase E-0.3a just added `accounting_standard` to the wizard but the depreciation tables it implies were not moved out of the benchmark pack.

**4. Operational Settings masquerading as market benchmarks.**
- `property_management_fee_pct`, `maintenance_cost_pct_of_value`, `maintenance_capex_pct`, `insurance_pct_of_value` — these are operator/contract terms, sometimes market-influenced but properly an Operational Settings tier.
- The entire 'Working Capital' group (`receivables_days`, `payables_days`, `inventory_months`, `retention_pct`, `mobilisation_advance_pct`) is operational policy + contract structure.
- `utilisation_year1/2/steady_state`, `downtime_pct` — PF operational ramp assumptions, not RE market data, and they are surfaced for Real Estate projects too because there is no Model-Type filter on the pack.

**5. Outright duplicates / orphans (REMOVE).**
- `corporate_income_tax_rate` duplicates `corporate_tax_rate` (both map to the same display label "Corporate Tax Rate" in `LABEL_MAP`, L2097–2098).
- `receivable_days` duplicates `receivables_days` (L2104–2105, same label).
- `payable_days` duplicates `payables_days` (L2106–2107, same label).
- `inventory_days` overlaps with `inventory_months` (unit clash; only one should win).
- `retention_receivable_pct` duplicates `retention_pct` (same intent).
- The dedupe pass at L2042–2047 only dedupes across **group keys**, not across the `defaults` table — so if both `corporate_tax_rate` and `corporate_income_tax_rate` exist as rows in the DB, both render under "Taxes & Fees" with identical labels and the user has no way to tell them apart.

**6. Structural contamination (no taxonomy filter).**
- `BENCH_GROUPS` is identical for Real Estate and Project Finance, and for every sub-type / sector. A Healthcare PPP user sees `sale_price_per_sqm_residential`; a Residential RE user sees `utilisation_year1`. There is no `model_type` / `sector` filter applied to the pack.
- `HINT_MAP` has exactly one entry (`sale_price_per_sqm_residential`) — the helper-text concept exists but is decorative everywhere else.
- "Jurisdiction" (Jordan RE) is hardcoded in the UI label at L3398 ("benchmark rows") and L740 of `NewProjectModal.jsx` ("Jordan RE defaults") but the pack itself has no country dimension and no swap point; the platform cannot serve a second jurisdiction without forking this array.

Net: of the ~75 keys in the pack, **approximately 30 belong to a true Market Conditions tier**, ~20 belong to Investor Policy, ~7 to Accounting Policy, ~12 to Operational Settings, ~4 are deal-level project inputs that should never have been in benchmarks, and ~5 are pure duplicates. The current "Jordan RE Benchmarks" surface is misnamed: it is in fact the platform's only assumption-storage tier, doing four jobs at once.

---

The PDF (in Dev Engine supplementary section) **rederives** Equity % and Debt % from the dev engine's `equityDeployed` and `loanDrawn` — another implicit shadow source.

Now I have enough to write the audit. Let me emit the part.

## Part 4 — Capital Structure Audit

### Layer-by-layer trace (HEAD = 0c1acae)

| Layer | File / lines | What it holds | How it stores |
|---|---|---|---|
| Wizard form state | `NewProjectModal.jsx` L62-65, L77-78 | `equity_pct`, `senior_debt_pct`, `sub_debt_pct`, `shareholder_loan_pct` (RE); `ppp_equity_pct`, `ppp_debt_pct` (PPP) | React state, 100% sum-check at L131-132 (RE) / L138-139 (PPP) |
| Wizard INSERT | `NewProjectModal.jsx` L256-260 (RE) / L240-241 (PPP) | Same four fields written as four rows under `category='capital_structure'` (or two rows under `category='ppp_structure'` for PPP) | `assumptions` table, one row per field, snake_case display names `Equity %`, `Senior Debt %`, `Subordinated Debt %`, `Shareholder Loan %` |
| Assumptions tab — editor | `FeasibilityProject.jsx` L1806 → group `capital_structure` rendered via `ASSUMPTION_GROUPS` (L38-43) | Lists all four rows for inline edit (one number per row, no sum-check at edit time) | Each row saved independently to `assumptions` table on Save |
| Approve gate — base version | `FeasibilityProject.jsx` `handleApprove` L552-571 | Re-reads the four assumption rows; sums; alerts if `|sum-100| > 0.01` | Read-only check; never persists |
| Approve gate — scenario | `FeasibilityProject.jsx` `handleApproveScenario` L419-438 | Identical four-row sum check on `sc.assumptions ?? assumptions` | Read-only check |
| Annual engine (RE) | `annualEngine.js` `runEngine` L109-129 | `safeNum` reads of the four rows; throws `CAPITAL_STRUCTURE_INVALID` if `|sum-100| > 0.01`. Then only `equityPct` (L130) and `seniorDebtPct` (L131) are actually used in the math — **Sub Debt % and Shareholder Loan % are validated but never consumed**. | In-memory |
| Annual engine (PPP) | `annualEngine.js` `runPPPEngine` L297-298 | Reads `Debt %` and `Equity %` from `ppp_structure` rows via `safePct(…, default)`. No sum-check in engine (only at wizard). | In-memory |
| Dev Engine config derive | `DevEngineTab.jsx` `deriveConfig` L39-40, L76-77 | Reads `Equity %` and `Senior Debt %` with `(getVal(...) || 30) / 100` and `(... || 60) / 100`; computes `equityAmount = tpc * equityPct`, `loanAmount = tpc * debtPct` | Local `useState` `cfg`; user can then overwrite the JOD amounts directly in the UI (L533-538) |
| Dev cash flow engine | `cashflowEngine.js` `runCashFlowEngine` (signature L77 onward) | Consumes **absolute** `equityAmount` and `loanAmount` only; the engine itself has no concept of percentages | In-memory |
| Benchmark display (post-E-0.6) | `FeasibilityProject.jsx` L1988-1995 — group renamed to `'Debt Terms'`, equity/senior debt/SHL keys **removed** from `keys`. The `LABEL_MAP` entries at L2088-2090 are now orphaned (mapping exists, but no group references them). | Read-only benchmark default rows; nothing edits capital structure here | n/a |
| PDF — feasibility cover | `generatePDF` consumes engine output (`tdc`, `debt_amount`, `equity_amount`) which are derived from assumption rows | Indirect | n/a |
| PDF — dev engine supplement | `FeasibilityProject.jsx` L1215-1224 | **Re-derives** Equity % / Debt % from `equityDeployed` / `loanDrawn` produced by `cashflowEngine` — i.e. from whatever JOD the dev engine actually consumed (which the user may have overridden manually) | Shadow read; not persisted |

### Direct answers to the three numbered questions

**1. Is there still duplication of capital structure across components?**
Yes. After E-0.6 the *benchmark accordion* no longer renders the four capital-structure keys (those are project-level, not market defaults — correct fix). But the duplication that actually matters is unchanged:

- The four percentages are written **once** to `assumptions` (rows under `capital_structure` / `ppp_structure`).
- They are then **re-read in four different places** with three different default-handling policies and two different totals semantics:
  - Wizard: `Number(field)` only, strict 100% sum-check (`NewProjectModal.jsx` L131-132).
  - `handleApprove` / `handleApproveScenario`: `null → 0`, tolerance `0.01` pp (`FeasibilityProject.jsx` L425-430, L558-563).
  - `runEngine`: `safeNum(...,0)`, tolerance `0.01` pp, throws (`annualEngine.js` L109-129).
  - `DevEngineTab.deriveConfig`: legacy falsy-fallback `|| 30` / `|| 60`, **silently ignores Sub Debt % and Shareholder Loan %**, no sum-check, then the user can overwrite the JOD amounts in the UI (`DevEngineTab.jsx` L39-40, L533-538). This is the most dangerous duplication on the platform — Dev Engine output (and its PDF supplement) can drift arbitrarily from the approved feasibility baseline.
- Dead/orphan duplication: `LABEL_MAP` still maps `equity_pct`, `senior_debt_pct`, `shareholder_loan_pct` at `FeasibilityProject.jsx` L2088-2090 even though no benchmark group references those keys anymore. Harmless but cruft.

**2. Is there any conflicting source of truth?**
Yes, three conflicts:

- **Engine vs Dev Engine.** `runEngine` will throw `CAPITAL_STRUCTURE_INVALID` if Sub Debt + SHL ≠ 0 don't balance Equity + Senior Debt to exactly 100. `DevEngineTab.deriveConfig` ignores Sub Debt and SHL entirely — so a "30% Equity / 50% Senior Debt / 10% Sub Debt / 10% SHL" project that the annual engine treats as 30/50/10/10 (using only 30/50 for the math, validating the rest as funding-gap defense) will be sized in the dev engine as 30/50 of TPC — a 20% TPC funding gap silently absorbed nowhere.
- **DevEngineTab UI override.** Once the user types over `equityAmount` or `loanAmount` in the Dev Engine inputs panel, the dev engine output and its PDF supplement (rows at L1215-1224) reflect *those* numbers, while the Results tab / annual engine output still reflects the approved assumption rows. There is no reconciliation between the two.
- **Engine actually uses 2 of 4.** Even within `annualEngine.runEngine`, Sub Debt % and SHL % are *validated* but never consumed (L111-112 are read, L130-131 only use eq/sd in cash flows). So a project with 30/50/10/10 produces identical engine output to 30/50/20/0 or 30/50/0/20 — the sum check is decorative for those two rows.

**3. Which component should own Equity %, Senior Debt %, Sub Debt %, Shareholder Loan %?**
The `assumptions` table — specifically the four rows under `category='capital_structure'` (or two under `ppp_structure` for PPP) — is the only defensible source of truth. It is the artefact the user actually edits, it is the artefact the approve gate validates, it is the artefact persisted to the version history, and it is the artefact engines should consume read-only. The wizard owns *initial creation*; the Assumptions tab owns *ongoing edits*; every engine downstream is a pure consumer.

## Recommended Architecture

```
                ┌───────────────────────────────────────────────┐
                │  SOURCE OF TRUTH:                             │
                │  assumptions table, category='capital_struct- │
                │  ure' (RE) or 'ppp_structure' (PPP)           │
                │                                               │
                │  Rows: Equity %, Senior Debt %, Sub Debt %,   │
                │  Shareholder Loan %  (RE)                     │
                │  Rows: Equity %, Debt %                (PPP)  │
                └───────────────────────────────────────────────┘
                                  │
              ┌───────────────────┼───────────────────────┐
              │                   │                       │
   ┌──────────▼─────────┐ ┌───────▼────────┐ ┌────────────▼─────────┐
   │ Writer #1:         │ │ Writer #2:     │ │ Reader gate:          │
   │ NewProjectModal    │ │ Assumptions    │ │ handleApprove /       │
   │ INSERT on create   │ │ tab inline-edit│ │ handleApproveScenario │
   │ (NewProjectModal   │ │ (FeasibilityPr-│ │ (sum=100 ± 0.01 pp)   │
   │  .jsx L256-260)    │ │  oject.jsx     │ │                       │
   │                    │ │  L1806+)       │ │                       │
   └────────────────────┘ └────────────────┘ └───────────────────────┘
                                  │
              ┌───────────────────┼───────────────────────┐
              │ READ-ONLY CONSUMERS (must not override)   │
              │                                            │
   ┌──────────▼─────────┐ ┌───────▼────────┐ ┌────────────▼─────────┐
   │ annualEngine       │ │ cashflowEngine │ │ PDF generator        │
   │ runEngine /        │ │ via a thin     │ │ (reads engine output │
   │ runPPPEngine       │ │ adapter that   │ │  only — never re-    │
   │ (validates +       │ │ converts the   │ │  derives % from JOD) │
   │  consumes pct's)   │ │ four pct rows  │ │                      │
   │                    │ │ → JOD using    │ │                      │
   │                    │ │ TDC from same  │ │                      │
   │                    │ │ assumption set │ │                      │
   └────────────────────┘ └────────────────┘ └──────────────────────┘
```

**Concrete changes implied:**

- Remove the `|| 30` / `|| 60` falsy fallbacks in `DevEngineTab.deriveConfig` L39-40 and replace with `safeNum` (or fail loudly if the assumption rows are missing — they always exist post-creation). Adopt the same `safeNum(..., 0)` policy the annual engine uses.
- Stop letting Dev Engine UI overwrite `equityAmount` / `loanAmount` *as primary inputs* (`DevEngineTab.jsx` L533-538). Either (a) remove the editable inputs and show them read-only (derived from the four percentage rows × TDC), or (b) treat any user override as a scenario-level driver that round-trips through the `assumptions` table so the rest of the platform sees it. Today it is a free-floating local-state divergence.
- Fold Sub Debt % and SHL % into `annualEngine.runEngine`'s actual cash-flow math, or remove them from the engine's sum-validation (and from the wizard, and from the Assumptions tab) — pick one. Today they are validated as if they matter and consumed as if they don't.
- `DevEngineTab.deriveConfig` must read Sub Debt % and SHL %, or the dev engine should explicitly assert "Senior Debt only — Sub Debt and SHL not supported" and warn the user.
- Remove the orphan `LABEL_MAP` entries for `equity_pct`, `senior_debt_pct`, `shareholder_loan_pct` (`FeasibilityProject.jsx` L2088-2090) — post-E-0.6 they are unreferenced.
- The PDF supplement at `FeasibilityProject.jsx` L1215-1224 should clearly label its Equity % / Debt % as **"As-realised from dev cash flow"**, not as the project's capital structure. Today a reader cannot tell whether this section reflects the approved assumption rows or the dev engine's local override.

**Deprecate / consolidate:**

- The benchmark `LABEL_MAP` capital-structure entries (orphan post-E-0.6).
- Direct editable `equityAmount` / `loanAmount` inputs in `DevEngineTab` (or properly upgrade them to scenario drivers).
- The "validated-but-unconsumed" status of Sub Debt % and Shareholder Loan % in `runEngine`.

---

Confirmed. `fmtPct(30)` (from format.js) → "30.0%". So PPP assumptions are stored as 80, displayed as "80.0%", and engine converts via `safePct → /100`. RE assumptions same: stored 30, engine `/100` at L130. Benchmarks: stored 0.06, displayed via `*100` at L2153. Override path on the wizard `/100` (L270-272) — meaning wizard's user-typed "6" becomes 0.06 stored. I have everything I need.

## Part 5 — Percentage UX Audit

**HEADLINE FINDING: Storage is INCONSISTENTLY MIXED.** The codebase operates two distinct percentage conventions in parallel, split cleanly along a single seam: **assumptions are stored as `display-form integers` (30 means 30%); benchmark defaults are stored as `0-to-1 fractions` (0.06 means 6%)**. The wizard's "override" mechanism even bridges the two — it accepts a display-form integer from the user and divides by 100 before INSERTing, so the same conceptual value (e.g. rental yield 6%) lives as `6` in form state, `0.06` in `project_defaults`, and would be `6` if it were ever a regular assumption. This is not a bug per row — every read path is paired with the matching convention — but it is a structural inconsistency that creates a continuous cognitive tax and a recurring class of "off-by-100" defects.

### 1. The two conventions

| Convention | Where stored | Engine consumption | Display |
|---|---|---|---|
| **Display-form integer** (30 = 30%) | `assumptions` table (`unit: 'percent'`) | `safePct(v, default) → v / 100` | `fmtPct(n) → n.toFixed(1) + '%'` (no scaling) |
| **0-to-1 fraction** (0.30 = 30%) | `project_defaults` (benchmark pack) | Consumed raw, no division | `(raw * 100).toFixed(2) + '%'` (FeasibilityProject.jsx:2153) |
| **Display-form integer** (recommendation API) | n/a (transient) | `recommend.js` compares `irr >= hurdle` where both are display-form (15, not 0.15) | n/a |

### 2. Evidence by assumption — file:line

| Assumption | Stored as | Storage site | Engine read site |
|---|---|---|---|
| `Equity %` (RE) | **30** (display int) | NewProjectModal.jsx:62 (`equity_pct: 30`); INSERT NewProjectModal.jsx:256 (`Number(form.equity_pct)`, no `/100`) | annualEngine.js:109 → :130 (`var equityPct = eqNum / 100`) |
| `Senior Debt %` (RE) | **70** (display int) | NewProjectModal.jsx:63; insert :257 | annualEngine.js:110 → :131 (`/100`) |
| `Efficiency %` (RE) | **85** (display int) | NewProjectModal.jsx:60; insert :265 | annualEngine.js:140-141 (`efficiency / 100`) |
| `Sale Split %` (RE) | **50** (display int) | NewProjectModal.jsx:68; insert :262 | annualEngine.js:138 (`safePct(..., 50)` = `/100`) |
| `Debt %` (PPP) | **80** (display int) | NewProjectModal.jsx:77; insert :240 | annualEngine.js:297 (`safePct(..., 80)` = `/100`) |
| `Equity %` (PPP) | **20** (display int) | NewProjectModal.jsx:78; insert :241 | annualEngine.js:298 (`safePct`) |
| `Interest Rate` (PPP) | **7** (display int) | NewProjectModal.jsx:83; insert :246 | annualEngine.js:303 (`safePct(..., 7)`) |
| `OPEX % of Revenue` (PPP) | **5** (display int) | NewProjectModal.jsx:82; insert :245 | annualEngine.js:302 (`safePct`) |
| `Tax Rate` (PPP) | **20** (display int) | NewProjectModal.jsx:86; insert :249 | annualEngine.js:306 (`safePct`) |
| `WACC` (PPP) | **10** (display int) | NewProjectModal.jsx:87; insert :250 | annualEngine.js:307 (`safePct`) |
| `Target DSCR` (PPP) | **1.20** (ratio, not %) | NewProjectModal.jsx:88; insert :251 | annualEngine.js solver — consumed raw, not a percent |
| `rental_yield_residential` (benchmark) | **0.06** (fraction) | tests/feasibilityEngine.test.js:95 fixture; project_defaults seed | annualEngine.js:178 — consumed raw |
| `sales_absorption_rate_pct_per_year` (benchmark) | **0.35** (fraction) | tests/feasibilityEngine.test.js:94 | annualEngine.js:177 — raw |
| `land_cost_pct_of_tdc` (benchmark) | **0.20** (fraction) | engine default 0.20 | annualEngine.js:175 — raw |
| `senior_debt_interest_rate` (benchmark) | **0.085** (fraction) | annualEngine.js:185 fallback | annualEngine.js:185 — raw, fed to `annuity(r=…)` |
| `corporate_income_tax_rate` (benchmark) | **0.20** (fraction) | annualEngine.js:188 fallback | annualEngine.js:188 — raw |
| **OVERRIDE BRIDGE** — `rental_yield_residential` typed in wizard as `6` | wizard divides `/100` before insert → stored **0.06** | NewProjectModal.jsx:270 (`Number(form.rental_yield_override) / 100`) | Merged into defaults stream — raw |
| **OVERRIDE BRIDGE** — `sales_absorption_rate_pct_per_year` typed as `35` | `/100` → **0.35** stored | NewProjectModal.jsx:271 | raw |
| **OVERRIDE BRIDGE** — `land_cost_pct_of_tdc` typed as `20` | `/100` → **0.20** | NewProjectModal.jsx:272 | raw |
| Recommendation `irrHurdle` | **15** (display int) | FeasibilityProject.jsx:88 `const IRR_HURDLE = 15`; PPP_IRR_HURDLE imported similarly | recommend.js:82, :105 — compared display-form-to-display-form (engine output is `r2(rawIrr * 100)`, annualEngine.js:269) |
| Recommendation `pppDscrFloor` | **1.30** (ratio, not %) | recommend.js:83 default | recommend.js:89 — ratio compare |
| `Min. Equity IRR Hurdle` (benchmark `irr_hurdle_equity_min`) | likely **0.15** (fraction) per benchmark convention — but UI multiplies by 100 at FeasibilityProject.jsx:2153, so display is correct **only if stored as fraction** | project_defaults seed | Not currently engine-consumed; benchmark display only |

### 3. Decorative / accidental correctness

- **`fmtPPPAssumptionValue`** (FeasibilityProject.jsx:66) calls `fmtPct(n)` for any `unit === 'percent'`. Since `fmtPct` from `src/utils/format.js:50` does NOT multiply by 100, a stored `80` displays as `"80.0%"` — correct, because storage is display-form. If anyone "fixes" `fmtPct` to multiply, every assumption display silently breaks.
- **`fmtDefault` / `fmtOverride`** (FeasibilityProject.jsx:2153, :2164) DO multiply by 100, because benchmarks are fractions. The two formatters look almost identical but are encoding opposite conventions. There is no comment explaining the asymmetry.
- The recommendation engine works only because `runEngine` does `r2(rawIrr * 100)` (annualEngine.js:269) before returning, so `modelOutput.irr = 15.4` (not 0.154). Any future "let's normalise engine output to fractions" refactor silently breaks recommend.js verdict logic.

### 4. Migration impact if standardising

Standardising on **fractions everywhere** would require:
- A DB migration of `assumptions` rows where `unit = 'percent'`: `UPDATE … SET value = value / 100`. ~20 named percent assumptions across RE + PPP per project, multiplied by every version row.
- Removing `/100` from engine read sites (annualEngine.js:130-131, 138, 141, 297-307; engine.js parallel).
- Changing `fmtPPPAssumptionValue` to multiply.
- Removing `/100` from wizard override INSERTs (NewProjectModal.jsx:270-272) — but those rows already store fractions, so they'd stay fractions; only the form-state mental model changes.
- Removing display-form `IRR_HURDLE = 15` and `PPP_IRR_HURDLE` (currently display-form); engine output `irr` would also change to fraction; recommend.js comparisons would all flip.

Standardising on **display-form integers everywhere** would require:
- DB migration of `project_defaults` rows where unit ∈ {'percent','decimal'}: `value * 100`.
- Removing `*100` from `fmtDefault`/`fmtOverride` (FeasibilityProject.jsx:2153, 2164).
- Removing `/100` from wizard override INSERTs (NewProjectModal.jsx:270-272).
- Engine read sites (annualEngine.js:173-190) consume benchmarks raw — every one of those lines must wrap in `/100`, OR a single `pctDefault()` helper.
- Risk: `annuity(P, r, n)` and `npvCalc(rate, cfs)` expect fractional rates; the engine would need conversion at the boundary, not throughout the body.

Both migrations are reversible but each touches 30-60 lines of engine code plus a multi-row UPDATE and would invalidate every stored result and PDF until re-run.

### 5. Recommended approach (no implementation)

**Do not retroactively migrate the DB.** The risk-to-reward is poor: every stored assumption row would need rewriting, every version's `model_output` becomes inconsistent with its inputs at the schema level, and every legacy PDF references the old convention.

Instead, treat the seam as load-bearing and document it:

1. **Codify the rule** in `annualEngine.js` and `FeasibilityProject.jsx` headers: *"assumptions table = display-form integer (30 = 30%); project_defaults table = 0-to-1 fraction (0.30 = 30%); engine internal math always operates in fractions; engine output `irr` is display-form (annualEngine.js:269 — `r2(rawIrr * 100)`)."*
2. **Centralise the conversions** behind two helpers and ban inline `/100` / `*100` literals on percent values:
   - `pctAssumptionToFraction(v)` — wraps `safePct`, used for `assumptions` rows.
   - `pctFractionToDisplay(v)` — wraps `* 100`, used at every benchmark UI display site.
   The current `safePct` already serves the first role; add the symmetric helper and refactor lines 2153 and 2164 to call it.
3. **Add a `pctConvention` column** (or use `unit`) as the contract: `unit = 'percent'` ↔ display-form, `unit = 'decimal'` ↔ fraction. Today both display formatters treat them identically (`if (unit === 'decimal' || unit === 'percent')`), masking the convention split. Splitting them would surface every miscategorised row.
4. **Add a Jest invariant test** that loads one canonical project and asserts: stored Equity % == 30 → fmtPPPAssumptionValue renders "30.0%" → engine reads 0.30. This locks the seam against silent drift.
5. **Long-term**, only when there is appetite for a coordinated DB + code + PDF rerun, migrate to a single convention (fractions are more arithmetically natural and align with the engine internals).

---

I have enough information. The DevEngineTab has S-curve, phaseWeights (pre/during/post sales), payment schedule (deposit/installments/handover), and cap-rate exit — but no unit mix, no rent roll, no per-unit pricing, no floor/view premiums, no block release, no shared cost allocation. The annual engine is even more simplified — it's just GFA × salePrice × absorption fraction.

Now emitting the audit.

## Part 6 — Real Estate Gap Analysis

The platform's RE side is built around two engines: an **annual `runEngine`** (in `annualEngine.js`, simplistic — GFA × sale price × absorption fraction, no unit-level structure) and a **monthly `runCashFlowEngine`** (the Dev Engine, in `cashflowEngine.js` + `salesTiming.js` + `scurve.js` + `exitValuation.js`). The wizard collects exactly **one** sizing primitive (`gfa_sqm`) plus an `efficiency_pct` haircut, optional `sale_price_override` and `construction_cost_override` (both per-sqm scalars), and a `project_subtype` enum (Residential / Mixed-Use / Retail / Villas / Commercial) — but that enum is stored as a label only and **the engines never branch on it** (zero `if (subtype === ...)` references in `annualEngine.js` or `cashflowEngine.js`). A Villa Compound and an Apartment Tower and a Mixed-Use Block of identical GFA produce **identical** model outputs.

| Capability | Exists? | Required? | Future Phase |
|---|---|---|---|
| Unit mix (1BR/2BR/3BR, villa types) | No | Yes | P0 |
| Per-unit revenue build (count × price × mix) | No | Yes | P0 |
| Floor premiums (high-floor uplift) | No | Yes | P1 |
| View premiums (corner / sea / podium) | No | Yes | P1 |
| Release sequencing (Block A then B then C) | No | Yes | P0 |
| Absorption curves (S-curve / front-loaded / back-loaded) | Partial — DevEngine has `duringSalePattern: 'linear' \| 'backend'` only; annual engine uses a single flat `absRate` | Yes | P1 |
| Shared cost allocation (common area, parking, amenities) | No — `efficiency_pct` is a single GFA→NSA haircut, not a cost reallocation | Yes | P1 |
| Pre-sales (deposits + installments + handover) | Partial — DevEngine `paymentSchedule {deposit, installments, handover}` exists but is hard-coded to `{0.10, 0.70, 0.20}` in `deriveConfig`, not user-editable in the wizard; annual engine has none of this | Yes | P0 |
| Pre-sales discount (early-bird pricing) | No | Yes | P1 |
| Rent rolls (per-unit lease, term, anchor vs in-line) | No — single `rentYield × assetValue` scalar | Yes | P0 |
| Vacancy assumptions (per-asset or stabilised) | Partial — DevEngine cap-rate exit takes `vacancyRate` (default 5%); annual engine uses a hard-coded ramp `Math.min(maxOcc, 0.55 + 0.15 × (op-1))` not user-controlled | Yes | P1 |
| Lease-up curves (months to stabilisation) | Partial — annual engine has a fixed linear 3-year ramp from 55% to ~88%; not configurable, not curve-shaped | Yes | P1 |
| Concessions / free rent / TI allowances | No | Yes | P1 |
| Step-ups / market rent reviews | Partial — single `rent_escalation_pct_per_year` scalar applied uniformly | Yes | P2 |
| Operating expense ratios (OPEX / NOI build) | Partial — `mgmtFee × rev + maintPct × value + insrPct × value`; no property tax, no utilities, no reserves, no R&M opex line | Yes | P1 |
| Cap-rate-based exit valuation | Yes — `computeExitValuation` cap_rate method exists in `exitValuation.js` | Yes | (shipped) |
| Cap-rate exit wired to wizard | No — wizard never collects `exitCapRate`; DevEngineTab hard-codes `exitMethod: 'gdv'` in `deriveConfig` regardless of project type | Yes | P0 |
| IRR vs equity multiple split (levered + unlevered) | Yes — DevEngine returns both `unleveragedIRR` and `leveragedIRR` + `leverageLift`; annual engine returns single IRR + EM | Yes | (shipped, DevEngine only) |
| Construction phasing (multi-phase land releases) | No — single S-curve over single `T` months | Yes | P1 |
| Hard cost vs soft cost detail (separate schedules) | Yes — DevEngine has separate `hardCostSchedule` (S-curve) + `softCostSchedule` ('flat'/'front'/'proportional') + `upfrontSoftCosts`; annual engine collapses to one `constCost` figure | Yes | (shipped, DevEngine only) |
| Hard cost line-item detail (shell / fit-out / MEP / FF&E) | No — single `hardCostTotal` lump | Optional | P2 |
| Land cost as % of TDC | Yes — `land_cost_pct_of_tdc` default 0.20, overridable in wizard | Yes | (shipped) |
| Contingency (hard / soft / owner's) | Partial — single `contingency_pct` default 0.05 applied to hardCost only | Yes | P1 |
| Sales commissions / brokerage fees | Partial — only as `sellingCostRate` (default 2%) applied to **exit residual**, not to in-period sales receipts | Yes | P1 |
| Mixed-use cost-revenue split (resi / retail / office allocation) | No — wizard `project_subtype = 'Mixed-Use'` exists but no GFA split, no per-component pricing, no per-component cap rate. Even "Mixed (Sale + Rental)" only splits a single asset class | Yes | P0 |
| Multi-component cap rates (residential 7% vs retail 9% vs office 8%) | No | Yes | P0 |
| Parking revenue (sold or leased) | No | Yes | P1 |
| Retail anchor vs in-line tenant modeling | No | Yes | P1 |
| Common area maintenance (CAM) recovery | No | Yes | P2 |
| Property tax / municipal fees | No | Yes | P1 |
| Capex reserves (FF&E replacement / R&M) | No | Yes | P1 |
| Debt covenant testing (LTC / LTV / DY) | No — RE annual engine never computes LTV/LTC/DY (PPP side has DSCR but no covenant gates wired to RE) | Yes | P1 |
| Sensitivity / waterfall (promote, hurdles, GP/LP) | No | Optional | P2 |

## Top RE Gaps

1. **No unit-level revenue build → cannot model any of the three target asset types correctly.** An apartment tower with 40% 1BR / 35% 2BR / 25% 3BR at different price points reduces to one number `gfa × salePrice`. A villa compound with Type-A / Type-B / Type-C villas at 250sqm / 320sqm / 450sqm and different price-per-sqm collapses identically. This is the **single most material gap** — no real fund IC will accept a single-blended-PSF residential model.

2. **Mixed-use is a label only, not a model.** `project_subtype = 'Mixed-Use'` is stored as a string and never read by either engine. There is no GFA split between residential / retail / office, no per-component sale price or rental yield, no per-component cap rate, no per-component construction cost. A Mixed-Use tower with ground-floor retail at 9% cap and tower-residential for-sale is mathematically indistinguishable from a 100% residential building of the same total GFA.

3. **No rent roll / lease modeling for rental or mixed schemes.** Rental revenue is `rentalGFA × (assetValue/GFA) × rentYield × Math.pow(1+rentEsc, op-1) × occupancy`, where occupancy is a hard-coded linear ramp `Math.min(0.88, 0.55 + 0.15×(year-1))`. There are no per-unit leases, no lease terms, no break dates, no free-rent / TI concessions, no step-ups, no vacancy assumption override, no lease-up curve shape. Apartment-building underwriting at an institutional level is a unit-level rent-roll exercise — this is none of that.

4. **No release sequencing or phased construction.** The DevEngine takes a single `T` months and one S-curve; both sales (`phaseWeights pre/during/post`) and costs flow through that single window. A villa compound delivered in three blocks over 6 years cannot be modeled — there is no "Block A starts month 0, Block B starts month 18" primitive.

5. **Cap-rate exit exists but is unreachable from the UI.** `computeExitValuation({method:'cap_rate'})` is fully implemented (NOI / vacancy / opex / exit cap → gross value → selling costs → net proceeds, with `impliedMultiple` returned), but `DevEngineTab.deriveConfig` hard-codes `exitMethod: 'gdv'` and the wizard never collects `exitCapRate`, `grossRentalIncome`, or `operatingExpenses`. The most institutionally-important RE valuation method is dead code from the user's perspective. Lowest-effort high-value fix on the list.

Honourable mentions: sales commissions only apply to unsold residual at exit (not to in-period sales receipts, so the model under-counts brokerage cost by an order of magnitude on heavy-presale schemes); the wizard's `paymentSchedule {deposit:10, installments:70, handover:20}` is hard-coded inside `DevEngineTab.deriveConfig` and not surfaced as an input despite being one of the most-tuned numbers in any GCC residential pro-forma; and the annual engine's `efficiency_pct` haircut conflates "saleable / GFA" (a sales metric) with what should be separate gross-to-net-leasable, gross-to-net-saleable, and gross-to-common-area allocations.

## Part 7 — Pilot Readiness Scorecard

| Issue | Priority | Effort | Reason |
|---|---|---|---|
| Subtype is decorative — engines never branch on Commercial/Retail/Villas/Industrial/Energy | P0 | XL | Pilot users selecting any non-Residential subtype receive residentially-underwritten output silently; this is a credibility-killer for an institutional pilot |
| Mixed-Use stored as label only, no per-component GFA/price/cap rate split | P0 | XL | Mixed-use is a stated target asset class but is mathematically equivalent to residential; visible to any pilot reviewer comparing components |
| No unit-mix / per-unit revenue build for residential | P0 | XL | Single blended PSF is not an institutional model; no IC accepts a one-number-revenue residential underwrite |
| Dev Engine ignores Sub Debt % and SHL %, silently sizes equity+senior only | P0 | M | Funding gap can silently absorb 20%+ of TPC; engine vs DevEngine disagreement is a hard failure mode |
| DevEngineTab JOD overrides drift from approved feasibility baseline with no reconciliation | P0 | M | Two-source-of-truth scenario; PDF supplement shows different numbers from Results tab |
| Cap-rate exit fully built in exitValuation.js but unreachable from wizard (hard-coded to GDV) | P1 | S | Dead-code institutional feature; trivially wireable; significant UX uplift |
| Benchmark pack mixes Market / Investor Policy / Accounting / Operational / Project-level tiers | P1 | L | Conceptual contamination; ~30 of ~75 keys are true market data, others are mislocated |
| Duplicate benchmark keys render under identical labels (corporate_tax_rate vs corporate_income_tax_rate, receivables_days vs receivable_days, payables_days vs payable_days, inventory_months vs inventory_days, retention_pct vs retention_receivable_pct) | P1 | S | User-visible UX defect; same label twice in same group |
| No rent roll / lease modeling — occupancy is hard-coded 0.55 → 0.88 linear ramp | P1 | XL | Required for credible rental and mixed-use underwriting |
| No release sequencing or multi-phase construction | P1 | L | Required for villa compounds and phased developments |
| Capital structure has 4 duplicated read paths with 3 default-handling policies | P1 | M | Engine throws, Dev Engine falls back to 30/60, wizard strict, approve gate lenient |
| Sub Debt % and SHL % validated but never consumed in annualEngine | P1 | M | Decorative validation; users edit values that have no effect |
| Hard-coded paymentSchedule {10/70/20} inside DevEngineTab not user-editable | P1 | S | One of the most-tuned GCC residential numbers; trivially surfaceable |
| Sales commissions only applied to exit residual, not in-period sales receipts | P1 | S | Under-counts brokerage cost by ~10x on heavy-presale schemes |
| Percentage storage convention (display-int vs fraction) is undocumented and load-bearing | P1 | S | Recurring class of off-by-100 defects; one comment + one helper would prevent regressions |
| No DSRA / MRA / Handback Reserve construction in PPP engine | P1 | L | Real PPP underwriting requires reserve accounts; current binary DSCR-floor warning is insufficient |
| Hotel / hospitality has no segment build (RevPAR/ADR/GOP) | P1 | XL | Out of scope for first pilot unless hotel is a target asset |
| No DSRA / liquidity model wired to RE side | P1 | M | LTC/LTV/DY covenant tests never computed for RE projects |
| HINT_MAP has only 1 entry across ~75 benchmark keys | P2 | M | UX polish; helper-text concept exists but unused |
| No jurisdiction dimension on benchmark pack (Jordan hardcoded in label) | P2 | L | Pilot is likely Jordan-only; defer until second jurisdiction is in scope |
| Hard cost line-item detail (shell / MEP / FF&E) missing | P2 | M | Single hardCostTotal lump is acceptable for pilot |
| CAM recovery and percentage rent for retail | P2 | L | Out of scope unless retail is a P0 pilot asset |
| Sensitivity / waterfall (promote / GP-LP / hurdle splits) | P2 | XL | Institutional but not pilot-blocking |
| Orphan LABEL_MAP entries for equity_pct / senior_debt_pct / shareholder_loan_pct post-E-0.6 | P2 | S | Harmless cruft; one delete |
| accounting_standard collected in wizard but depreciation tables not yet tied to it | P2 | M | E-0.3a half-shipped; depreciation rates still live in benchmark pack |
| PDF dev-engine supplement re-derives Equity% / Debt% from JOD without labeling | P2 | S | Labeling fix; reader cannot tell which capital structure is shown |
| stress_vacancy_pct / sensitivity_range_pct in Risk & Thresholds group act as benchmarks rather than policy | P2 | M | Tied to broader benchmark re-tiering work |
| No reconciliation between Dev Engine output and Results-tab numbers | P2 | M | Symptom of the duplicated capital-structure read paths; partially fixed by the P0 capital-structure work |

## Final Deliverable

### Top 5 Issues to Fix Next

1. **Asset taxonomy is decorative — engines never branch on subtype.** Non-Residential RE subtypes (Commercial, Retail, Villas) and non-AP PF sectors (Energy, Industrial, demand-based Healthcare) silently route to the residential math path. A pilot reviewer who creates a Commercial project and sees residential PSF assumptions consumed has lost trust.
2. **Mixed-Use is a label, not a model — no per-component split.** Stated target asset class is mathematically indistinguishable from a single-class residential project of equal GFA. Pilot reviewers comparing notes to their own mixed-use comps will spot this immediately.
3. **No unit-mix / per-unit revenue build for residential.** Even the "fully-supported" Residential subtype is a single-blended-PSF model. No institutional IC accepts that for an apartment tower or villa compound.
4. **Dev Engine vs annual engine capital-structure divergence.** DevEngineTab ignores Sub Debt and Shareholder Loan, silently sizes from equity+senior only, accepts user JOD overrides that never round-trip to the assumptions table, and produces a PDF supplement showing capital-structure percentages that disagree with the Results tab. Two-source-of-truth defect with no reconciliation.
5. **Cap-rate exit is fully implemented but unreachable.** `computeExitValuation({method:'cap_rate'})` exists complete with NOI build, vacancy, opex deduction, exit cap, selling costs, and implied multiple — but DevEngineTab hard-codes `exitMethod: 'gdv'`. This is the highest impact-to-effort fix on the platform: institutional users expect cap-rate exits, and the code is already written.

### Recommended Order

Sequence by dependency and impact-to-effort:

1. **Issue #5 first (Cap-rate exit wire-up).** Lowest effort, highest visible institutional credibility uplift, no dependencies. Days of work, not weeks. Ship this before any of the bigger items.
2. **Issue #4 second (Capital-structure consolidation).** Medium effort, unblocks PDF and PMO trust. Must precede #1, #2, #3 because all three asset-modeling reworks will repeatedly touch the same capital-structure read paths.
3. **Issue #3 third (Unit-mix / per-unit revenue).** Largest single piece of engine work. Required before #1 and #2 are meaningful — a multi-subtype branch is useless if every branch is still a blended-PSF formula.
4. **Issue #2 fourth (Mixed-Use component split).** Builds directly on the unit-mix primitive from #3 plus a new per-component cost/yield/cap-rate vector. Most natural to land immediately after #3.
5. **Issue #1 last (Subtype-aware engine dispatch).** With unit-mix and mixed-use components in place, taxonomy branching becomes the natural last step — wire each subtype to its appropriate benchmark pack, opex profile, exit method, and KPI surface.

### Estimated Effort

Assumptions: one senior engineer with platform familiarity; QA and PDF/UI work scoped together with engine work; no DB migrations beyond additive columns; existing test infrastructure reused. Pilot date assumed 8–12 weeks out.

- **#5 Cap-rate exit wire-up:** 3–5 days. Wizard inputs (`exitCapRate`, `grossRentalIncome`, `operatingExpenses`), DevEngineTab `deriveConfig` switch, PDF section, one Jest test. Pure plumbing.
- **#4 Capital-structure consolidation:** 1.5–2 weeks. Remove `|| 30` / `|| 60` falsy fallbacks in DevEngineTab; either remove editable JOD inputs or round-trip them to assumptions; decide Sub Debt + SHL fate (consume or remove from validation); label the PDF supplement clearly; clean orphan LABEL_MAP entries. Mostly safe refactor; small risk on existing dev-engine projects.
- **#3 Unit-mix / per-unit revenue build:** 4–6 weeks. New `unit_types` schema (count, type, area, price), wizard editor surface, annual engine + dev engine rework, PDF revenue section rework, regression tests. The single largest item; on the critical path.
- **#2 Mixed-Use component split:** 2–3 weeks, contingent on #3. New component dimension (residential / retail / office / parking), per-component price/yield/cap rate/cost, stacked-cash-flow generation. Builds on #3's per-unit primitive.
- **#1 Subtype-aware engine dispatch:** 2–3 weeks. Per-subtype benchmark packs, per-subtype default opex profile, per-subtype exit method preference, per-subtype recommendation tuning, per-subtype UI grouping. Cannot land before #2 or #3 because the branches need real differentiation to ship into.

Total critical-path: ~10–14 weeks for all five. For a pilot in 8 weeks, recommend shipping #5 + #4 + a stripped-down version of #3 (unit-mix without all asset classes, perhaps residential-only) and deferring #1 and #2 to a fast-follow release with explicit "Commercial / Retail / Mixed-Use are not yet supported — use Residential" guardrails added to the wizard.

### Issue Classification

**Taxonomy problems:**
- Asset taxonomy is decorative — engines never branch on subtype (Top-5 #1)
- Mixed-Use is a label, not a model (Top-5 #2)

**Underwriting-engine problems:**
- No unit-mix / per-unit revenue build (Top-5 #3)
- Cap-rate exit fully implemented but unreachable (Top-5 #5)

**Governance problems:**
- Dev Engine vs annual engine capital-structure divergence with no reconciliation (Top-5 #4)

## Closing Verdict

The platform is **primarily constrained by taxonomy** — and crucially, by the fact that the taxonomy presented to users is decorative rather than functional. The wizard advertises five RE subtypes and four PF sectors, but the underwriting engines branch on exactly one boolean (`isPPP`) and consume residentially-suffixed benchmark keys regardless of what the user selected. This single architectural choice silently invalidates output for Commercial, Retail, Villas, Energy, Industrial, and non-AP Healthcare projects, and reduces Mixed-Use to a relabel of single-class residential. Engine capability is a close second constraint: the residential engine genuinely lacks unit-mix, rent rolls, release sequencing, and a wired cap-rate exit — these are not taxonomy issues, they are missing primitives even within the supported asset class. Benchmark architecture is a real but narrower problem: ~30 of 75 keys are correctly classified as market conditions, the rest mix four other tiers, and visible duplicates render under identical labels — institutionally embarrassing but mechanically fixable in weeks. UX defects (percentage-storage seam, hard-coded payment schedules, dead helper-text concept) are real but not pilot-blocking on their own. Fix the taxonomy first by either making it functional or by trimming the dropdowns to what the engines can defensibly underwrite; everything else is downstream.
