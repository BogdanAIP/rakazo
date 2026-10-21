# PAPER-only backup/restore QA on a new temporary PostgreSQL 17 cluster.
# Never connects to an existing database, uses live trading credentials, stops a
# user-owned process, or modifies an existing PAPER journal or position.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$port = 15549
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$bin = Join-Path $HOME 'RakazoRuntime/postgresql/bin'
$record = Join-Path $env:TEMP ('rakazo-paper-backup-rehearsal-' + [guid]::NewGuid().ToString('N'))
$pgData = Join-Path $record 'postgres'
$archive = Join-Path $record 'disposable-paper.dump'
$owner = 'qa_backup'
$restoreDb = 'paper_restored_disposable'
$started = $false
$originalDatabase = [Environment]::GetEnvironmentVariable('DATABASE_URL', 'Process')
$originalRealtime = [Environment]::GetEnvironmentVariable('REALTIME_DATABASE_URL', 'Process')
$originalPgPort = [Environment]::GetEnvironmentVariable('PGPORT', 'Process')

function Require([bool]$ok, [string]$message) {
  if (-not $ok) { throw ('Backup rehearsal refused: ' + $message) }
}
function Pass([string]$message) { Write-Output ('PASS ' + $message) }
function Query([string]$db, [string]$sql) {
  $lines = @(& (Join-Path $bin 'psql.exe') -X -h 127.0.0.1 -p $port -U $owner -d $db -t -A -v ON_ERROR_STOP=on -c $sql)
  Require ($LASTEXITCODE -eq 0) ('isolated SQL failed in ' + $db)
  return ($lines -join '').Trim()
}

# Nothing is created until both the environment and the dedicated test port
# are proven independent of the current user-owned PAPER runtime.
foreach ($name in @(
  'DATABASE_URL', 'REALTIME_DATABASE_URL', 'PGHOST', 'PGPORT', 'PGSERVICE', 'PGPASSWORD',
  'OKX_API_KEY', 'OKX_SECRET_KEY', 'OKX_PASSPHRASE',
  'RAKAZO_PAPER_RUNTIME_CONFIG', 'RAKAZO_LINKED_PAPER_URL',
  'RAKAZO_PAPER_JOURNAL_AUTOSTART', 'LOCAL_PAPER_GRANT'
)) {
  Require (-not [Environment]::GetEnvironmentVariable($name, 'Process')) ('external connection or trading credential set: ' + $name)
}
# PowerShell/.NET on Windows can leave an empty PG* variable present after a
# null assignment; libpq then tries to use an empty service name or port.
# Reject real PG settings and remove ALL empty PG* values from this child only.
foreach ($item in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'PG*' })) {
  Require ([string]::IsNullOrEmpty([string]$item.Value)) ('external PostgreSQL variable set: ' + $item.Name)
  Remove-Item -LiteralPath ('Env:' + $item.Name) -ErrorAction SilentlyContinue
}
Require (Test-Path (Join-Path $repo 'pnpm-lock.yaml')) 'candidate source checkout missing'
foreach ($exe in @('initdb.exe', 'pg_ctl.exe', 'psql.exe', 'pg_dump.exe', 'pg_restore.exe', 'createdb.exe')) {
  Require (Test-Path (Join-Path $bin $exe) -PathType Leaf) ('PostgreSQL native binary missing: ' + $exe)
}
$prisma = Join-Path $repo 'packages/db/node_modules/.bin/prisma.cmd'
Require (Test-Path $prisma -PathType Leaf) 'candidate dependency installation missing'
Require (@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -eq 0) 'test port 15549 occupied'
Require (-not (Test-Path $record)) 'temporary folder already exists'
New-Item -ItemType Directory -Path $record | Out-Null

# initdb's backend inherits PGPORT. Never leave it unset/empty on this Windows build.
# Pin it to the disposable port before any subprocess can parse postgres settings.
[Environment]::SetEnvironmentVariable('PGPORT', [string]$port, 'Process')
try {
  & (Join-Path $bin 'initdb.exe') -D $pgData -U $owner -E UTF8 '--auth=trust' '--no-instructions' *> (Join-Path $record 'initdb.log')
  Require ($LASTEXITCODE -eq 0) 'disposable PostgreSQL initialization failed'
  & (Join-Path $bin 'pg_ctl.exe') -D $pgData -o '-h 127.0.0.1 -p 15549' -l (Join-Path $record 'postgres.log') -w -t 30 start
  Require ($LASTEXITCODE -eq 0) 'disposable PostgreSQL startup failed'
  $started = $true
  Pass 'independent PostgreSQL cluster started on 127.0.0.1:15549'

  $qaUrl = 'postgresql://' + $owner + '@127.0.0.1:15549/postgres'
  [Environment]::SetEnvironmentVariable('DATABASE_URL', $qaUrl, 'Process')
  [Environment]::SetEnvironmentVariable('REALTIME_DATABASE_URL', $qaUrl, 'Process')
  Push-Location (Join-Path $repo 'packages/db')
  try {
    & $prisma migrate deploy *> (Join-Path $record 'migrations.log')
    Require ($LASTEXITCODE -eq 0) 'Prisma PAPER schema migration failed'
  } finally { Pop-Location }
  Pass 'real PAPER Prisma schema migrated'

  $seed = @'
CREATE TABLE public.paper_backup_rehearsal_probe (
 id integer PRIMARY KEY, mode text NOT NULL, evidence jsonb NOT NULL,
 CONSTRAINT paper_only_mode CHECK (mode = 'PAPER_ONLY')
);
INSERT INTO public.paper_backup_rehearsal_probe VALUES
 (1,'PAPER_ONLY','{"syntheticFills":false,"fundingVerified":false}'),
 (2,'PAPER_ONLY','{"stopExecutionVerified":false,"requiresReview":true}');
'@
  $seedFile = Join-Path $record 'seed.sql'
  [IO.File]::WriteAllText($seedFile, $seed, [Text.UTF8Encoding]::new($false))
  & (Join-Path $bin 'psql.exe') -X -h 127.0.0.1 -p $port -U $owner -d postgres -v ON_ERROR_STOP=on -f $seedFile *> (Join-Path $record 'seed.log')
  Require ($LASTEXITCODE -eq 0) 'synthetic PAPER evidence seed failed'

  $tablesSql = "SELECT COUNT(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public'"
  $migrationsSql = 'SELECT COUNT(*) FROM public."_prisma_migrations"'
  $evidenceSql = "SELECT md5(string_agg(id::text || ':' || mode || ':' || evidence::text, '|' ORDER BY id)) FROM public.paper_backup_rehearsal_probe"
  $beforeTables = Query postgres $tablesSql
  $beforeMigrations = Query postgres $migrationsSql
  $beforeEvidence = Query postgres $evidenceSql
  Require ([int]$beforeTables -gt 10 -and [int]$beforeMigrations -gt 0) 'real PAPER schema is absent or migration history empty'
  Pass ('source schema=' + $beforeTables + ' tables; Prisma migrations=' + $beforeMigrations)

  & (Join-Path $bin 'pg_dump.exe') -h 127.0.0.1 -p $port -U $owner -d postgres -Fc --no-owner --no-acl --file $archive
  Require ($LASTEXITCODE -eq 0 -and (Test-Path $archive -PathType Leaf)) 'native custom-format dump failed'
  Require ((Get-Item $archive).Length -gt 10000) 'archive implausibly small'
  & (Join-Path $bin 'pg_restore.exe') --list $archive *> (Join-Path $record 'archive-list.txt')
  Require ($LASTEXITCODE -eq 0) 'pg_restore cannot inspect the dump'
  $sha = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
  Pass ('native archive generated, inspectable, SHA256=' + $sha)

  Require ((Query postgres "SELECT COUNT(*) FROM pg_database WHERE datname = '$restoreDb'") -eq '0') 'restore DB already exists'
  & (Join-Path $bin 'createdb.exe') -h 127.0.0.1 -p $port -U $owner $restoreDb
  Require ($LASTEXITCODE -eq 0) 'new disposable restore DB creation failed'
  & (Join-Path $bin 'pg_restore.exe') --exit-on-error --no-owner --no-acl -h 127.0.0.1 -p $port -U $owner -d $restoreDb $archive *> (Join-Path $record 'restore.log')
  Require ($LASTEXITCODE -eq 0) 'restoring into new disposable DB failed'

  Require ((Query $restoreDb $tablesSql) -eq $beforeTables) 'restored schema count mismatch'
  Require ((Query $restoreDb $migrationsSql) -eq $beforeMigrations) 'Prisma migration history changed'
  Require ((Query $restoreDb $evidenceSql) -eq $beforeEvidence) 'PAPER evidence JSON content changed'
  Require ((Query $restoreDb 'SELECT COUNT(*) FROM public.paper_backup_rehearsal_probe') -eq '2') 'PAPER evidence row count changed'
  Pass 'fresh restore preserves full schema count, migration history and synthetic PAPER JSON rows'
  Pass 'native PAPER backup/restore rehearsal completed without any live service contact'
} finally {
  [Environment]::SetEnvironmentVariable('DATABASE_URL', $originalDatabase, 'Process')
  [Environment]::SetEnvironmentVariable('REALTIME_DATABASE_URL', $originalRealtime, 'Process')
  if ([string]::IsNullOrEmpty($originalPgPort)) {
    Remove-Item -LiteralPath 'Env:PGPORT' -ErrorAction SilentlyContinue
  } else {
    [Environment]::SetEnvironmentVariable('PGPORT', $originalPgPort, 'Process')
  }
  if ($started -and (Test-Path (Join-Path $pgData 'postmaster.pid'))) {
    & (Join-Path $bin 'pg_ctl.exe') -D $pgData -m fast -w -t 30 stop
    if ($LASTEXITCODE -eq 0) {
      Pass 'disposable PostgreSQL stopped; synthetic archive retained'
    } else {
      Write-Warning 'Disposable PostgreSQL not confirmed stopped; manual identity check required'
    }
  }
  if (Test-Path $record) { Write-Output ('EVIDENCE_FOLDER ' + $record) }
}
