# Database

| Path | Purpose |
|---|---|
| `migrations/` | Ordered, forward-only migration files (`YYYY-MM-DD_<topic>.sql`). Apply to **staging first**, then production (see `docs/STAGING_AND_RELEASE.md` §5). Never edit an applied migration. |
| `schema/` | Local-only schema-only export of production (`production_baseline.sql`), used to build staging. Git-ignored while the repository is public. |
| `staging/` | Staging-only helpers: `seed_staging_users.sql` (synthetic tenants/users, via `npm run staging:seed`), `verify_staging.sql`; reference-data dumps and reports (git-ignored). |

Applied migrations:

| File | Staging | Production |
|---|---|---|
| `2026-10-10_p022_versioned_model_outputs.sql` | pending (runbook step 4) | pending (release §5) |

P-028 (tax depreciation) requires no database migration (engine-only).
