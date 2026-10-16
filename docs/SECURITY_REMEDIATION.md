# Security remediation — B1, I1, I2 (SEC-01..04)

**Status:** implemented and tested **locally** on `rc/ppp-v1`. Not applied to staging or production; not pushed.

**Scope:** database authorization only. The financial engine, the formulas, debt sizing and tax are unchanged.

## 1. What changes

| Migration | Contents | Safe with the currently deployed app? |
|---|---|---|
| `sec01_helpers_audit` | `users.active`, `versions.approved_by/archived_*`; private schema `app_private` (not exposed by the API); identity helpers `app_tenant_id()` / `app_role()` / `app_has_role()`; `current_tenant_id()` hardened; append-only `audit_events` | Yes (additive) |
| `sec02_identity_lockdown` | `users`/`tenants` read-only for members (only `users.name` editable); no anonymous table access; identity triggers (they also apply to the service role, the SQL editor and cascades); same-tenant colleague profiles | Yes (the app never writes these tables) |
| `sec03_lifecycle_functions` | `approve_version`, `archive_version`, `delete_draft_version/scenario/project`, `admin_set_member_role/active`, `admin_rename_tenant`, `operator_create_tenant/add_member/move_member/set_member_role/purge_project` | Yes (unused until the new app) |
| `sec04_record_protection` | No direct writes to results; approval-state machine; approved/archived records immutable and undeletable, including via cascades and by the service role; restrictive role and active-member policies; same-tenant read of results | **No — needs the new app** (cutover, §5) |

**Every `SECURITY DEFINER` function:**
- owner `postgres`;
- `search_path = ''`, with all names schema-qualified;
- EXECUTE revoked from PUBLIC and anon. Supabase's default privileges would otherwise grant it.
- Identity comes only from `auth.uid()`.
- Tenant and role are checked on the server.
- Other tenants' IDs return `NOT_FOUND`.
- Each runs in one transaction and writes an audit record.

**Privileged-change context:**
- Privileged changes are allowed only inside these functions, through a transaction-local marker (`xcepta.ctx`).
- The REST API can't set that marker, and `app_private` isn't exposed.

**Role matrix:**
- viewer: read-only.
- analyst: create and edit; may delete **own** draft-only items.
- manager: approve and archive.
- admin: manage members of their own tenant.
- Platform operator (service role): create tenants, add, move and set members, and **purge**. Purge is the only way to permanently delete approved records, and needs `PURGE <project_id>`, a reason of at least 10 characters, and an audit record written first.

### 1a. S0 follow-up (C1–C3)

- **C1 (SEC-02).** TRUNCATE, TRIGGER and REFERENCES are revoked on every public table from `authenticated` and `service_role`; anon loses everything. Row-level security never applies to TRUNCATE, so only the table owner keeps it. The truncate guards remain as a second layer, for the owner.
- **C2 (SEC-01).** Default privileges for objects `postgres` creates later:
  - no EXECUTE for PUBLIC, anon or authenticated on new functions. This is set for the role `postgres` across the whole database, because PostgreSQL's built-in PUBLIC EXECUTE can't be removed per schema;
  - no anon access to new tables or sequences;
  - no default TRUNCATE, TRIGGER or REFERENCES.

  New objects must be granted explicitly. Existing objects are unchanged.
- **C3.** Every migration and rollback runs in **one explicit transaction**. The Supabase SQL editor sends a script as one request, which is atomic anyway, but `psql -f` sends statements one by one; the explicit `begin … commit` makes both atomic. Test S10.5 runs the files statement by statement.
- **Supabase ownership.** An owner's REVOKE removes only grants the owner made. Grants made by another role (e.g. `supabase_admin`), and objects that role creates under its own defaults, are not covered. The catalog verification therefore checks **effective** privileges and **who granted them**, and flags any exposure (test S10.4).
  - Remediation, as owner: `revoke <privilege> on <table> from <other grantor> cascade`.
  - `supabase_admin` defaults can't be changed by the project login.

## 2. Workflows that change

1. **Approving needs manager or admin** (`users.role` defaults to `analyst`). Production roles must be assigned before cutover (§5, P1).
2. **Viewers are read-only:** they can't create projects, edit assumptions or submit FP&A actuals.
3. **Deleting a project or scenario that has approved or archived versions is refused** (`RECORD_PROTECTED`); archive instead. Analysts delete only their own draft-only items.
4. **Archiving or restoring a project** (the list flag) needs manager or admin.
5. **New:** colleagues in the same tenant see each other's approved results (Results, FP&A, PDF).
6. **Real-estate approval is now atomic.** Previously the status flipped first and the result was inserted afterwards.
7. **Ownership (`created_by`) of new projects and drafts is set by the server.**
8. **Deactivated members lose access immediately.**
9. **Staging scripts:** lifecycle cleanup removes only draft-only projects (approved ones need an operator purge). The legacy-row check uses `approve_version`.
10. **Not yet in the UI:** member administration, version archiving and "approved by". The functions exist and are tested; until the UI exists they're used through the SQL editor or operator scripts.

## 3. Policy review

- **Recursion:** the new `users` policies use the definer helpers (they bypass RLS), so there's no self-reference. Existing policies' `users` subquery resolves under the `users` policies without recursion (test S0.4).
- **Missing privileges:** members have EXECUTE on the identity helpers, which policies need. The catalog check confirms the full grant set.
- **Escalation:**
  - no client-supplied identity fields are trusted (S2.3);
  - definer functions build no dynamic SQL from inputs;
  - `app_private` is unreachable;
  - members can't create objects in `public`.
- **Exposure:**
  - other tenants' rows are invisible in all 9 tenant tables, including audit (S5.2);
  - audit events are visible to the tenant's admins only;
  - colleague profiles (name, e-mail, role) are visible within the tenant (intended).

## 4. Staging order (needs your approval at each step)

Run `db/security/verify_security_catalog.sql` (read-only) after every step. Rows for later steps show `false` until applied.

| # | Step | Verify |
|---|---|---|
| S0 | Read-only pre-checks: role distribution; `model_outputs.tenant_id` = its project's tenant; approved versions without a result | Report to you; nothing is fixed automatically |
| S1 | Apply `sec01` | Catalog: the 7 SEC-01 rows and 4 cross-cutting rows pass (later steps false). Excluding `audit_events`, the policy and grant fingerprints are unchanged (`af4487…` / `27a4fc…`); including it, policies 27, md5 `c7d6525c…`, grants md5 `6f9e0f73…` |
| S2 | Apply `sec02` | SEC-02 rows pass; `verify:staging:isolation` |
| S3 | Apply `sec03`; create the 6 synthetic `.test` users through `operator_add_member` (approved) | SEC-03 row passes; `verify:staging` (it now approves through `approve_version`) |
| S4 | Push `rc/ppp-v1` → Preview (staging) | Browser check |
| S5 | `maintenance_on.sql` → apply `sec04` → catalog: **all rows pass** → `verify:staging`, isolation, security API checks (6 users) → `maintenance_off.sql` | Every check passes |
| S6 | Browser check on Preview: approve as manager, refused as analyst, delete/archive, colleague visibility | Your check |

## 5. Production cutover (later, separate approval) — no inconsistent external window

| # | Step | Purpose |
|---|---|---|
| P0 | Disable public sign-ups (dashboard). Verified backup. Run the S0 read-only pre-checks | Closes the outsider path at once; recovery point |
| P1 | Apply P-022, `sec01`, `sec02`, `sec03` (all safe with the old app). Assign roles with `operator_set_member_role` (reason required) | B1 closed; approvers ready |
| P2 | **Window:** `maintenance_on.sql`. Only tenant admins can read or write, so the old app can't make partial changes | Freeze |
| P3 | Apply `sec04`; catalog check passes for all rows | Protection live |
| P4 | Merge PR #3 (deploys the new app); confirm the commit; admin smoke test | App and database consistent |
| P5 | `maintenance_off.sql` | Re-open |

At no point is the database less protected than before, and while the app and database are being switched, no member except admins can act. Anonymous access is already closed in P1.

## 6. Rollback and recovery

- **In the window (P2–P5):** keep maintenance on, then either fix forward, or run `rollback/sec04_rollback.sql`, revert the merge commit (Vercel redeploys the old app) and turn maintenance off. Result: the post-SEC-03 state (B1 still fixed).
- **After the window:** maintenance on → the same sequence → maintenance off.
- **Scripts:** `db/migrations/rollback/2026-10-16_sec0{4,3,2,1}_rollback.sql`, applied in that order. They restore the baseline policies and privileges exactly (test S9.5).
  - SEC-02 rollback re-opens B1 and the I1 gaps: **emergency only**.
  - **Kept on purpose:** `audit_events` (still append-only) and the additive columns.
- **Data:** no migration changes or deletes data, so no data rollback is needed. Backup restore is reserved for catastrophic failure.

## 7. Remaining risks

1. **Results are computed in the approver's browser.** The database guarantees who approved, when, and immutability, not that the figures are genuine. The saved inputs and engine version allow re-verification, and a server-side check job can be added.
2. **The database owner and service-role key holders** can set `xcepta.ctx` in the SQL editor and bypass the guards (inherent to administrator access). Mitigate with dashboard MFA and few holders. Such changes aren't audited unless made through the functions.
3. **FP&A actuals and variances:** any analyst in the tenant can still edit or delete colleagues' entries (existing `tenant_access` policy). They're not approved records; harden later if needed.
4. **The repository is public.** These files describe the weaknesses they fix. **Do not push before P0** (sign-ups disabled), and consider making the repository private.
5. **Supabase-specific behaviour is simulated locally** (roles, `auth.uid()`, PostgREST). It must be confirmed on staging (S5 API checks).
6. **Functions added by future migrations** are anon-executable by Supabase default unless revoked. The catalog check detects this; run it after every migration.
7. **Approved versions without a saved result** (left by the old non-atomic approval) are protected, but can only be corrected by an operator.
