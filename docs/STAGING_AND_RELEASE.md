# XCEPTA — Staging Environment & Controlled Release Runbook

**Created:** 2026-10-10 · **Applies to:** every change that touches the database or the financial engines.

## 1. Audit of the current configuration (no secret values shown)

| Area | Finding | Risk | Action |
|---|---|---|---|
| Database connection paths | **One:** `src/lib/supabase.js` (browser client, anon key). No service-role key, no serverless functions, no other client. Tables used: `projects, scenarios, versions, assumptions, model_outputs, users, variances, actuals, static_defaults, intake_state`, plus Supabase Auth (email + password). | — | Guarded (§3). |
| Environment variables | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (build-time, bundled; the anon key is public by design and protected by RLS). `BASE_URL` (local PDF harness only). | — | Scoped per environment in Vercel (§4, step 6). |
| Vercel | Project `xcepta` (git-linked; production = `master`, previews = PR branches). The repository cannot show how the env vars are scoped, but the PR #1/#3 previews ran against **production Supabase**. | **High** — every preview could read and write production data. | Preview scope → staging, enforced by the build guard. |
| Local development | `.env.local` points at production Supabase. | **High** — local testing wrote to production. | The guard now blocks this unless explicitly overridden. |
| `.env` in git | `.env` was tracked (since `be598e9`) with an `OPENAI_API_KEY` entry. **Checked 2026-10-10: the value is a 25-character placeholder, not an OpenAI key format.** A full-history scan for credential patterns (OpenAI/AWS/GitHub tokens, Supabase JWT / service-role / secret keys, DB URLs with passwords, hard-coded keys) found **none**. | Low (hygiene) | Untracked and ignored (`.env`, `.env.*`). No revocation needed. |
| Schema in repo | No DDL for the app's tables. `schema.sql` is stale (`re_projects`, `cf_engine_runs`, …). | Medium — staging cannot be rebuilt from the repo. | Schema-only baseline exported from production (§4, step 3). |
| Migrations | `db/migrations/2026-10-10_p022_versioned_model_outputs.sql` (additive). **P-028 (tax depreciation) needs no database change** — it is engine-only. A future engine-version bump marks earlier approvals "outdated" in the app, with no data change. | — | Apply to staging first, then production (§5). |

## 2. Target setup (simplest practical)

```
GitHub master ──► Vercel Production ──► Supabase PRODUCTION (acaqynigacgpswobiasb)
GitHub PR/branch ─► Vercel Preview ───► Supabase STAGING (xcepta-staging, synthetic data)
Local dev ────────────────────────────► Supabase STAGING (via .env.local)
```

- **Two Supabase projects:** production (existing) and `xcepta-staging` (new; the free tier is enough).
- **One Vercel project.** Environment variables are scoped: Production → production values; Preview + Development → staging values.
- **Staging contains synthetic data only:** a staging test user, `SYNTHETIC —` projects, and reference benchmarks (`static_defaults`). No production projects, approvals or users are copied.

## 3. Fail-closed guard (implemented)

`src/config/supabaseGuard.js` defines one rule set, enforced at **build time** (`vite.config.js`: a forbidden target means **no bundle is produced**, so the deployment fails) and again at **runtime** (`src/lib/supabase.js`: no client is created).

| Deployment (Vercel `VERCEL_ENV`) | Allowed database | Override |
|---|---|---|
| `production` | production **only** (a production build pointed at staging also fails) | none |
| `preview`, `development` | anything **except** production | **none** |
| local (not on Vercel) | anything except production | `XCEPTA_ALLOW_PRODUCTION_DB=1` in your shell only. Shows a red "LOCAL BUILD CONNECTED TO PRODUCTION" banner. Ignored on Vercel. |
| missing or invalid URL, unknown environment | — | blocked |

- Non-production sessions show an amber banner: **"STAGING (preview) — synthetic test data only. Not connected to production."**
- Tests: `tests/supabaseGuard.test.js`. All six build scenarios were exercised: local/prod blocked; local/prod with override allowed and flagged; preview/prod blocked even with the override; production/prod OK; production/staging blocked; preview/staging OK.

> **Effect on PR #3's preview:** until the Preview variables point at staging, its preview **build will fail by design**. That is the guard working.

## 4. Your steps (Supabase / Vercel / GitHub)

You use your own accounts throughout. Never paste passwords or keys into chat.

1. **Exposed-key check: done (no action needed).** The committed `OPENAI_API_KEY` was a placeholder; the history scan is clean. Still recommended:
   - Recommended: GitHub → Sisofly/Xcepta → Settings → General → *Change repository visibility* → **Private**. An institutional product's source and schema are better kept private.
2. **Create the staging Supabase project.**
   - Supabase dashboard → *New project* → name `xcepta-staging`, the same region as production, a strong database password saved in your password manager.
   - Note its **Project URL** and **anon public key** (Project Settings → API).
3–4. **Build staging from the production structure.**
   Install the PostgreSQL client tools once (`winget install -e --id PostgreSQL.PostgreSQL.17 --override "--mode unattended --disable-components server,pgAdmin,stackbuilder"`); the scripts find them without PATH changes.

   | Command | What it does | Touches production? |
   |---|---|---|
   | `npm run staging:build` | Exports the production **structure only** (pg_dump, read-only) plus the `static_defaults` reference table. Imports into an **empty** staging in **one transaction** (all-or-nothing), then applies reference data and migrations, then verifies. | Read-only export |
   | `npm run staging:build -- -ResetStaging` | Staging refresh. Drops **only** XCEPTA's 13 tables and 1 function on staging (typed `RESET <staging-ref>` confirmation), then imports as above. | Read-only export |
   | `npm run staging:inspect` | Read-only object-by-object comparison of staging with the exported structure: 154 checks covering tables, constraints, indexes, functions, RLS, policies, and table/function/schema grants. Writes `db/staging/inspect_report.txt`. | No |
   | `npm run staging:resume` | Finishes a partly applied import, **only if inspect finds nothing missing**. Applies the postgres default privileges (idempotent), reference data (only if empty) and migrations (idempotent), in one transaction. | No |

   - **Platform-managed SQL is excluded** (`scripts/staging/prepare-dump.mjs`): `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_*` (Supabase's own defaults, not changeable by the `postgres` login; the cause of the 2026-10-10 failure at line 1213) and the schema-level `public` statements. All application grants, RLS and policies are kept verbatim.
   - The staging URI must be the staging project, and the production URI the production project, both on the session pooler port 5432.
   - Exports and reports stay local (git-ignored).
5. **Create and link the synthetic staging test users.**
   - Staging dashboard → Authentication → Users → *Add user* (staging-only email, auto-confirm). Add a second user too if you want cross-tenant RLS checks.
   - Then run `npm run staging:seed`. It links each user to a new synthetic tenant (admin role); re-running it is harmless.
   - To change a test user's password later, run `npm run staging:set-test-password`. It uses the supported Supabase Auth Admin API (`updateUserById`), so the user id and tenant link are kept. The staging secret key is typed hidden at runtime and never stored. Only `.test` users can be changed, and the result is verified by signing in with the public key.
6. **Scope the Vercel environment variables.**
   - Vercel → project `xcepta` → Settings → Environment Variables. For **each** of `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`:
     - make sure the **existing production value is ticked for Production only**;
     - add a second entry with the **staging** value, ticked for **Preview** and **Development**.
   - Then: Deployments → the PR #3 preview → *Redeploy*. The build should pass and show the amber STAGING banner.
7. **Point local development at staging.** Copy `.env.example` to `.env.local` (replacing the production values) and fill in the staging URL, anon key and test-user credentials.
8. **Verify staging end to end:**
   - `npm run verify:staging:isolation`: authentication, anonymous access and tenant RLS. For cross-tenant checks, add a second staging user on a different tenant via `STAGING_TEST_EMAIL_2` / `STAGING_TEST_PASSWORD_2`.
   - `npm run verify:staging`: the financial lifecycle. Expect "All staging checks passed". Add `-- --cleanup` to remove the synthetic projects it created.
9. **Preview smoke test** (`docs/PPP_COMPLETION_REPORT_RC1.md` §8.4) on the redeployed PR #3 preview, now on staging.

## 5. Controlled production migration and rollback

The same procedure applies to every future migration file. **Staging first, always.**

**Preparation**
1. The migration file is merged into the release branch, applied to staging, and `npm run verify:staging` passes on staging.
2. The release PR has a green test suite and preview smoke test; the deploy window is agreed.

**Production (in this order)**
3. Production dashboard → Database → Backups: confirm a recent backup / point-in-time recovery.
4. Run the read-only pre-check (`docs/PPP_COMPLETION_REPORT_RC1.md` §8.1) and record the `model_outputs` row count and primary-key name.
5. Apply the migration in the production SQL editor (the P-022 file is additive and idempotent).
6. Run the post-check in the file: `legacy_rows` = the recorded count, `versioned_rows` = 0.
7. Merge the release PR (merge commit). Vercel builds Production; the guard requires the production database.
8. Confirm the deployed commit SHA = the merge commit. Spot-check one existing PPP project: it shows the "Historical result" banner and nothing is recalculated.

**Rollback**
- **Application:** revert the merge commit on `master`, and Vercel redeploys the previous version. The P-022 columns are nullable and ignored by older code, so **no database rollback is needed**.
- **Database (only if unavoidable):** the drop statements are at the top of the migration file. Dropping them **deletes the stored versioned results** written since deployment, so do it only if none must be kept, and only after a fresh backup.
- **Never** edit an applied migration; write a new forward migration instead.

## 6. Ongoing workflow
- New schema change → new file `db/migrations/YYYY-MM-DD_<topic>.sql` (additive where possible, idempotent, with a rollback note).
- PR → preview on **staging** → apply the migration to staging → `npm run verify:staging` → smoke test → product-owner approval → §5 for production.
- Engine changes that alter outputs → bump `PPP_ENGINE_VERSION` (Governance §13). Existing approvals then show as outdated and are never recalculated silently.

## 7. Why preview testing cannot affect production
1. **Separate database and keys:** previews receive only staging credentials (Vercel environment scoping).
2. **Build-time guard:** a preview build configured with the production project **fails**, so no deployment exists. There is no override for previews.
3. **Runtime guard:** even a mis-built bundle refuses to create a production client outside production.
4. **Data:** staging contains synthetic data and a staging-only user; production users, projects and approvals are not copied.
5. **Residual risk (by design, local only):** a developer can deliberately connect a *local* build to production with `XCEPTA_ALLOW_PRODUCTION_DB=1`. This is shown with a red banner and is impossible on Vercel.
