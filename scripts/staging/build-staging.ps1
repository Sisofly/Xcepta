<#
  build-staging.ps1 — build the XCEPTA STAGING database from the production
  STRUCTURE (no customer data), apply migrations, and verify.

  Run from the repository root in PowerShell:
      powershell -ExecutionPolicy Bypass -File scripts/staging/build-staging.ps1

  What it does
    1. Exports the production schema (public schema: tables, constraints,
       RLS policies, functions, grants) with pg_dump --schema-only. READ-ONLY
       on production. No rows are exported, except step 2.
    2. Exports the non-personal benchmark reference table public.static_defaults.
    3. Checks the dump contains no data rows, and that staging is empty.
    4. Applies the schema, the reference data, and every file in
       db/migrations (in name order) to STAGING.
    5. Runs db/staging/verify_staging.sql against STAGING and saves the report
       to db/staging/verify_report.txt (git-ignored).

  Safety
    - Connection strings are typed into THIS terminal, never into chat.
    - Passwords are read as hidden input, used for this process only, then cleared.
    - Refuses to write to any database whose connection string contains the
      production project reference.
#>
param([switch]$Force, [string]$StagingRef = 'ldhsckzvfuwpxywqloag')
$ErrorActionPreference = 'Stop'
$ProdRef = 'acaqynigacgpswobiasb'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

function Need($cmd) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "$cmd not found. Install the PostgreSQL 17 client tools (winget install -e --id PostgreSQL.PostgreSQL.17), then open a NEW terminal and add 'C:\Program Files\PostgreSQL\17\bin' to PATH if needed."
  }
}
function StripPassword($uri) { return ($uri.Trim() -replace '^(postgres(ql)?://[^:/@]+):[^@]*@', '$1@') }
function ReadSecret($prompt) {
  $s = Read-Host -AsSecureString $prompt
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Run($exe, [string[]]$argList) {
  & $exe @argList
  if ($LASTEXITCODE -ne 0) { throw "$exe failed (exit $LASTEXITCODE)" }
}

# Use the standard PostgreSQL client install folder if it is not on PATH yet
foreach ($v in 17, 16, 15) {
  $bin = "C:\Program Files\PostgreSQL\$v\bin"
  if ((Test-Path "$bin\pg_dump.exe") -and -not (Get-Command pg_dump -ErrorAction SilentlyContinue)) { $env:Path = "$bin;$env:Path"; break }
}
Need pg_dump; Need psql
Write-Host ('Using ' + (& pg_dump --version))
New-Item -ItemType Directory -Force db/schema, db/staging | Out-Null

Write-Host ''
Write-Host 'Supabase dashboard -> project -> Connect -> "Session pooler" -> copy the URI.' -ForegroundColor Cyan
Write-Host 'The password part is removed automatically; you will be asked for it separately (hidden).' -ForegroundColor Cyan
$prod = StripPassword (Read-Host 'PRODUCTION session pooler URI')
$stg  = StripPassword (Read-Host 'STAGING session pooler URI')
# Each URI must name exactly its expected project (pooler user "postgres.<ref>"
# or direct host "db.<ref>.supabase.co").
function RefOf($uri) {
  if ($uri -match '^postgres(ql)?://postgres\.([a-z0-9]{20})@[^/]+\.pooler\.supabase\.com:\d+/') { return $Matches[2] }
  if ($uri -match '^postgres(ql)?://postgres@db\.([a-z0-9]{20})\.supabase\.co:\d+/') { return $Matches[2] }
  return $null
}
$prodRefSeen = RefOf $prod; $stgRefSeen = RefOf $stg
if ($stg -match $ProdRef -or $stgRefSeen -eq $ProdRef) { throw 'REFUSED: the STAGING URI points at the production project.' }
if ($prodRefSeen -ne $ProdRef)    { throw "The PRODUCTION URI is not for project $ProdRef (found '$prodRefSeen'). Copy it from the production project's Connect dialog." }
if ($stgRefSeen -ne $StagingRef)  { throw "The STAGING URI is not for project $StagingRef (found '$stgRefSeen'). Copy it from the xcepta-staging project's Connect dialog." }
$hostOf = { param($u) ($u -replace '^[^@]+@', '' -replace '/.*$', '') }
Write-Host ''
Write-Host ('  READ (schema-only export) : project ' + $prodRefSeen + ' at ' + (& $hostOf $prod)) -ForegroundColor Yellow
Write-Host ('  WRITE (all changes)       : project ' + $stgRefSeen + ' at ' + (& $hostOf $stg)) -ForegroundColor Yellow
if ((Read-Host 'Type YES to continue') -ne 'YES') { throw 'Cancelled by user. Nothing was read or written.' }

# ── 1-2. Export from production (read-only) ────────────────────────────────
$env:PGPASSWORD = ReadSecret 'PRODUCTION database password (hidden; used only for the read-only export)'
try {
  Write-Host 'Exporting production schema (structure only)...'
  Run pg_dump @($prod, '--schema-only', '--schema=public', '--no-owner', '--file', 'db/schema/production_baseline.sql')
  Write-Host 'Exporting reference table public.static_defaults...'
  Run pg_dump @($prod, '--data-only', '--table=public.static_defaults', '--no-owner', '--file', 'db/staging/reference_static_defaults.sql')
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }

# ── 3. Sanity: the baseline holds structure only; make it Supabase-compatible
$baseline = Get-Content db/schema/production_baseline.sql -Raw
if ($baseline -match '(?m)^COPY |(?m)^INSERT INTO ') { throw 'The schema dump unexpectedly contains data rows. Stopping.' }
$baseline = $baseline `
  -replace '(?m)^SET transaction_timeout = .*$', '-- (removed: pg_dump 17 setting unknown to the Supabase server)' `
  -replace '(?m)^CREATE SCHEMA public;$', '-- (removed: schema public already exists in Supabase)' `
  -replace '(?m)^ALTER SCHEMA public OWNER TO .*$', '-- (removed: owner)' `
  -replace '(?m)^COMMENT ON SCHEMA public IS .*$', '-- (removed: schema comment)'
Set-Content -Path db/schema/production_baseline.supabase.sql -Value $baseline -Encoding UTF8

# ── 4. Apply to staging ────────────────────────────────────────────────────
$env:PGPASSWORD = ReadSecret 'STAGING database password (hidden)'
try {
  $existing = & psql $stg -At -c "select count(*) from information_schema.tables where table_schema='public' and table_name in ('projects','versions','model_outputs')"
  if ($LASTEXITCODE -ne 0) { throw 'Could not connect to staging.' }
  if ([int]$existing -gt 0 -and -not $Force) {
    throw 'Staging already contains XCEPTA tables. Re-run with -Force only if you intend to apply on top (this script never drops anything).'
  }
  Write-Host 'Applying schema to STAGING...'
  Run psql @($stg, '-v', 'ON_ERROR_STOP=1', '-q', '-f', 'db/schema/production_baseline.supabase.sql')
  Write-Host 'Loading reference data to STAGING...'
  Run psql @($stg, '-v', 'ON_ERROR_STOP=1', '-q', '-f', 'db/staging/reference_static_defaults.sql')
  Get-ChildItem db/migrations -Filter *.sql | Sort-Object Name | ForEach-Object {
    Write-Host ('Applying migration ' + $_.Name + ' to STAGING...')
    Run psql @($stg, '-v', 'ON_ERROR_STOP=1', '-q', '-f', $_.FullName)
  }
  # ── 5. Verify ─────────────────────────────────────────────────────────────
  Write-Host 'Verifying STAGING...'
  & psql $stg -v ON_ERROR_STOP=1 -f db/staging/verify_staging.sql | Tee-Object -FilePath db/staging/verify_report.txt
  if ($LASTEXITCODE -ne 0) { throw 'Verification query failed.' }
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }

Write-Host ''
Write-Host 'Staging database built. Report saved to db/staging/verify_report.txt' -ForegroundColor Green
Write-Host 'Next: create the staging test user (runbook step 5).' -ForegroundColor Green
