<#
  build-staging.ps1 - build / inspect / resume / seed the XCEPTA STAGING database.
  Production is only ever READ (structure-only pg_dump in Build mode).

    npm run staging:inspect   Read-only comparison of staging with the production
                              structure (154 objects: tables, constraints, indexes,
                              functions, RLS, policies, grants) + status report.
    npm run staging:resume    Finish a partially applied import: only if the
                              inspection finds NOTHING missing. Applies the
                              postgres default privileges (idempotent), the
                              reference data (only if that table is empty) and
                              db/migrations (idempotent), in one transaction.
    npm run staging:build     Fresh build: export production structure (read-only),
                              import into an EMPTY staging in ONE transaction
                              (all-or-nothing), then reference data + migrations.
      add -ResetStaging       Staging refresh: first drops ONLY the application's
                              own tables/functions on staging (typed confirmation
                              naming the staging project), then imports.
    npm run staging:seed      Link existing staging auth users (created in the
                              dashboard) to synthetic tenants. Idempotent.

  Connection strings and passwords are typed into THIS terminal only. Passwords
  are hidden, used for this process, then cleared. The staging target must be
  project $StagingRef; the production source must be project $ProdRef.
#>
param(
  [ValidateSet('Build', 'Inspect', 'Resume', 'SeedUsers', 'SetTestPassword')][string]$Mode = 'Build',
  [switch]$ResetStaging,
  [string]$StagingRef = 'ldhsckzvfuwpxywqloag'
)
$ErrorActionPreference = 'Stop'
$ProdRef = 'acaqynigacgpswobiasb'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

# -- helpers --
foreach ($v in 17, 16, 15) {
  $bin = "C:\Program Files\PostgreSQL\$v\bin"
  if ((Test-Path "$bin\pg_dump.exe") -and -not (Get-Command pg_dump -ErrorAction SilentlyContinue)) { $env:Path = "$bin;$env:Path"; break }
}
foreach ($c in 'pg_dump', 'psql', 'node') {
  if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { throw "$c not found. Install the PostgreSQL 17 client tools / Node.js first." }
}
function StripPassword($uri) { return ($uri.Trim() -replace '^(postgres(ql)?://[^:/@]+):[^@]*@', '$1@') }
function RefOf($uri) {
  if ($uri -match '^postgres(ql)?://postgres\.([a-z0-9]{20})@[^/]+\.pooler\.supabase\.com:5432/') { return $Matches[2] }   # session pooler only
  if ($uri -match '^postgres(ql)?://postgres@db\.([a-z0-9]{20})\.supabase\.co:5432/') { return $Matches[2] }
  return $null
}
function ReadSecret($prompt) {
  $s = Read-Host -AsSecureString $prompt
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Run($exe, [string[]]$argList) {
  & $exe @argList
  if ($LASTEXITCODE -ne 0) { throw "$exe failed (exit $LASTEXITCODE). Steps run with --single-transaction are fully rolled back on failure." }
}
function HostOf($u) { return ($u -replace '^[^@]+@', '' -replace '/.*$', '') }
function ReadStaging() {
  $u = StripPassword (Read-Host 'STAGING session pooler URI (port 5432)')
  $r = RefOf $u
  if ($u -match $ProdRef -or $r -eq $ProdRef) { throw 'REFUSED: the STAGING URI points at the production project.' }
  if ($r -ne $StagingRef) { throw "The STAGING URI is not for project $StagingRef (found '$r')." }
  return $u
}
function PsqlStaging([string[]]$argList) { Run psql (@($script:stg, '-v', 'ON_ERROR_STOP=1') + $argList) }
function PrepareFromLocalDump() {
  if (-not (Test-Path db/schema/production_baseline.sql)) { throw 'No local production structure export found (db/schema/production_baseline.sql). Run npm run staging:build first.' }
  Run node @('scripts/staging/prepare-dump.mjs', 'db/schema/production_baseline.sql', 'db/schema/production_baseline.supabase.sql', 'db/schema/default_privileges_postgres.sql')
  Run node @('scripts/staging/schema-inventory.mjs', 'db/schema/production_baseline.supabase.sql', 'db/schema/inventory_check.sql', 'db/schema/reset_app_objects.sql')
}
function Inventory() {
  $out = & psql $script:stg -v ON_ERROR_STOP=1 -At -f db/schema/inventory_check.sql
  if ($LASTEXITCODE -ne 0) { throw 'Inventory query failed.' }
  $rows = @($out | Where-Object { $_ -match '^[a-z_]+\|' } | ForEach-Object { $p = $_ -split '\|'; [pscustomobject]@{ Kind = $p[0]; Name = $p[1]; Detail = $p[2]; Present = ($p[3] -eq 'true') } })
  $summary = $rows | Group-Object Kind | ForEach-Object { [pscustomobject]@{ Kind = $_.Name; Expected = $_.Count; Present = @($_.Group | Where-Object Present).Count } }
  $missing = @($rows | Where-Object { -not $_.Present })
  $report = @('Staging inventory vs production structure (' + (Get-Date -Format s) + ')', ($summary | Format-Table -AutoSize | Out-String))
  if ($missing.Count) { $report += 'MISSING:'; $report += ($missing | ForEach-Object { '  ' + $_.Kind + ' ' + $_.Name + ' ' + $_.Detail }) } else { $report += 'MISSING: none' }
  $report | Tee-Object -FilePath db/staging/inspect_report.txt | Write-Host
  return @{ Total = $rows.Count; Missing = $missing.Count }
}
function StagingCounts() {
  & psql $script:stg -v ON_ERROR_STOP=1 -At -c "select 'projects='||(select count(*) from public.projects)||' versions='||(select count(*) from public.versions)||' model_outputs='||(select count(*) from public.model_outputs)||' users='||(select count(*) from public.users)||' tenants='||(select count(*) from public.tenants)||' static_defaults='||(select count(*) from public.static_defaults)"
}
function ApplyRemaining() {
  # Reference data only if the table is empty; default privileges + migrations are idempotent.
  $n = & psql $script:stg -At -c 'select count(*) from public.static_defaults'
  if ($LASTEXITCODE -ne 0) { throw 'Could not read public.static_defaults.' }
  $files = @('db/schema/default_privileges_postgres.sql')
  if ([int]$n -eq 0) { $files += 'db/staging/reference_static_defaults.sql' } else { Write-Host "static_defaults already has $n rows - reference data not reloaded." }
  $files += (Get-ChildItem db/migrations -Filter *.sql | Sort-Object Name | ForEach-Object { $_.FullName })
  $argList = @('--single-transaction', '-q'); foreach ($f in $files) { $argList += @('-f', $f) }
  Write-Host ('Applying in ONE transaction: ' + (($files | ForEach-Object { Split-Path $_ -Leaf }) -join ', '))
  PsqlStaging $argList
}

Write-Host ('Using ' + (& pg_dump --version) + '; mode ' + $Mode + $(if ($ResetStaging) { ' -ResetStaging' } else { '' })) -ForegroundColor Cyan
New-Item -ItemType Directory -Force db/schema, db/staging | Out-Null

# -- modes that never touch production --
if ($Mode -ne 'Build') {
  $script:stg = ReadStaging
  Write-Host ('  STAGING : project ' + $StagingRef + ' at ' + (HostOf $script:stg)) -ForegroundColor Yellow
  $env:PGPASSWORD = ReadSecret 'STAGING database password (hidden)'
  try {
    if ($Mode -eq 'Inspect') {
      PrepareFromLocalDump
      $r = Inventory
      Write-Host ('Rows in staging: ' + (StagingCounts))
      & psql $script:stg -v ON_ERROR_STOP=1 -f db/staging/verify_staging.sql | Tee-Object -FilePath db/staging/verify_report.txt | Out-Null
      Write-Host ''
      if ($r.Missing -eq 0) { Write-Host "INSPECTION: all $($r.Total) expected objects present. Safe to run: npm run staging:resume" -ForegroundColor Green }
      else { Write-Host "INSPECTION: $($r.Missing) of $($r.Total) expected objects MISSING. Do not resume; see db/staging/inspect_report.txt" -ForegroundColor Red }
    }
    elseif ($Mode -eq 'Resume') {
      PrepareFromLocalDump
      $r = Inventory
      if ($r.Missing -ne 0) { throw "Resume refused: $($r.Missing) expected object(s) missing in staging. Nothing was changed." }
      if ((Read-Host 'All objects present. Type YES to apply the remaining steps to STAGING') -ne 'YES') { throw 'Cancelled. Nothing was changed.' }
      ApplyRemaining
      $r2 = Inventory
      & psql $script:stg -v ON_ERROR_STOP=1 -f db/staging/verify_staging.sql | Tee-Object -FilePath db/staging/verify_report.txt
      if ($r2.Missing -ne 0) { throw 'Post-resume inventory reports missing objects.' }
      Write-Host 'RESUME COMPLETE: staging matches the production structure and P-022 is applied.' -ForegroundColor Green
    }
    elseif ($Mode -eq 'SeedUsers') {
      $emails = @((Read-Host 'Staging test user email (must already exist in staging Authentication -> Users)'))
      $second = Read-Host 'Optional second staging user email on a DIFFERENT tenant (press Enter to skip)'
      if ($second) { $emails += $second }
      $i = 0
      foreach ($e in $emails) {
        $i++
        PsqlStaging @('-q', '-v', ('email=' + $e), '-v', ('tenant_name=SYNTHETIC - Staging Tenant ' + [char](64 + $i)), '-f', 'db/staging/seed_staging_users.sql')
      }
      & psql $script:stg -At -c "select u.email || ' -> tenant ' || t.name || ' (' || u.role || ')' from public.users u join public.tenants t using (tenant_id) order by t.name"
      Write-Host 'Staging test users linked to synthetic tenants.' -ForegroundColor Green
    }
    elseif ($Mode -eq 'SetTestPassword') {
      # One synthetic .test user; id, email and tenant link unchanged. The new
      # password goes to psql via a process-only environment variable.
      $email = Read-Host 'Staging test user email to update (must end in .test)'
      if ($email -notmatch '@[^@]+\.test$') { throw 'Only synthetic .test staging users can be changed.' }
      $p1 = ReadSecret 'New password (hidden, min 12 characters)'
      $p2 = ReadSecret 'Repeat new password (hidden)'
      if ($p1 -ne $p2) { throw 'Passwords do not match. Nothing was changed.' }
      if ($p1.Length -lt 12) { throw 'Password must be at least 12 characters. Nothing was changed.' }
      $env:XCEPTA_NEW_TEST_PASSWORD = $p1
      try { PsqlStaging @('-q', '-At', '-v', ('email=' + $email), '-f', 'db/staging/set_test_user_password.sql') }
      finally { Remove-Item Env:XCEPTA_NEW_TEST_PASSWORD -ErrorAction SilentlyContinue; $p1 = $null; $p2 = $null }
      Write-Host 'Done. Update STAGING_TEST_PASSWORD_2 (or _PASSWORD) in .env.local, then run: npm run staging:check-env' -ForegroundColor Green
    }
  } finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
  return
}

# -- Build: read production structure, import into staging --
Write-Host 'Supabase dashboard -> project -> Connect -> Session pooler (port 5432). The password part is removed automatically.' -ForegroundColor Cyan
$prod = StripPassword (Read-Host 'PRODUCTION session pooler URI (port 5432)')
if ((RefOf $prod) -ne $ProdRef) { throw "The PRODUCTION URI is not for project $ProdRef." }
$script:stg = ReadStaging
Write-Host ''
Write-Host ('  READ  (structure-only export) : project ' + $ProdRef + ' at ' + (HostOf $prod)) -ForegroundColor Yellow
Write-Host ('  WRITE (all changes)           : project ' + $StagingRef + ' at ' + (HostOf $script:stg)) -ForegroundColor Yellow
if ((Read-Host 'Type YES to continue') -ne 'YES') { throw 'Cancelled. Nothing was read or written.' }

$env:PGPASSWORD = ReadSecret 'PRODUCTION database password (hidden; read-only export)'
try {
  Run pg_dump @($prod, '--schema-only', '--schema=public', '--no-owner', '--file', 'db/schema/production_baseline.sql')
  Run pg_dump @($prod, '--data-only', '--table=public.static_defaults', '--no-owner', '--file', 'db/staging/reference_static_defaults.sql')
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
PrepareFromLocalDump

$env:PGPASSWORD = ReadSecret 'STAGING database password (hidden)'
try {
  $existing = & psql $script:stg -At -c "select count(*) from information_schema.tables where table_schema='public' and table_name in ('projects','versions','model_outputs','tenants','users')"
  if ($LASTEXITCODE -ne 0) { throw 'Could not connect to staging.' }
  if ([int]$existing -gt 0) {
    if (-not $ResetStaging) { throw 'Staging already contains XCEPTA tables. Use npm run staging:inspect (and staging:resume), or re-run with -ResetStaging to refresh staging.' }
    Write-Host ('Staging currently holds: ' + (StagingCounts)) -ForegroundColor Yellow
    Write-Host 'Reset will DROP ONLY these application objects on STAGING (see db/schema/reset_app_objects.sql); auth, storage and Supabase schemas are untouched.' -ForegroundColor Yellow
    if ((Read-Host "Type RESET $StagingRef to confirm") -ne "RESET $StagingRef") { throw 'Reset not confirmed. Nothing was changed.' }
    PsqlStaging @('-q', '-f', 'db/schema/reset_app_objects.sql')
  }
  Write-Host 'Importing production structure into STAGING in ONE transaction...'
  PsqlStaging @('--single-transaction', '-q', '-f', 'db/schema/production_baseline.supabase.sql')
  ApplyRemaining
  $r = Inventory
  & psql $script:stg -v ON_ERROR_STOP=1 -f db/staging/verify_staging.sql | Tee-Object -FilePath db/staging/verify_report.txt
  if ($r.Missing -ne 0) { throw 'Post-build inventory reports missing objects.' }
  Write-Host 'STAGING BUILT: structure matches production; P-022 applied.' -ForegroundColor Green
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
