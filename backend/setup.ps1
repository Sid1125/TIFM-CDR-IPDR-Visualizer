# Fresh-project setup for Project ARGUS (Advanced Records & Geospatial Unified Surveillance) — Windows / PowerShell.
# Run from the backend/ directory:   .\setup.ps1
#
# PostgreSQL is the primary database (SQLite is only an automatic fallback/backup).
# This script creates the venv, installs deps, writes backend\.env with your Postgres
# connection, and creates the database. Afterwards just run the dashboard.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host '== 1/4  Virtual environment ==' -ForegroundColor Cyan
if (-not (Test-Path .venv)) { python -m venv .venv }
& .\.venv\Scripts\Activate.ps1

Write-Host '== 2/4  Dependencies ==' -ForegroundColor Cyan
python -m pip install --upgrade pip
pip install -r requirements.txt

Write-Host '== 3/4  Database configuration ==' -ForegroundColor Cyan
if (Test-Path .env) {
  Write-Host 'backend\.env already exists - leaving it untouched.'
} else {
  Copy-Item .env.example .env
  Write-Host 'PostgreSQL is the primary database. Enter your connection details'
  Write-Host '(press Enter for the [default]; leave the password blank to use SQLite instead).'
  $PGHOST = Read-Host '  host [localhost]'; if (-not $PGHOST) { $PGHOST = 'localhost' }
  $PGPORT = Read-Host '  port [5432]';      if (-not $PGPORT) { $PGPORT = '5432' }
  $PGUSER = Read-Host '  user [postgres]';  if (-not $PGUSER) { $PGUSER = 'postgres' }
  $sec = Read-Host '  password' -AsSecureString
  $PGPASS = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  $PGDB = Read-Host '  database name [cdrdb]'; if (-not $PGDB) { $PGDB = 'cdrdb' }

  if ($PGPASS) {
    $u = [uri]::EscapeDataString($PGUSER)
    $p = [uri]::EscapeDataString($PGPASS)
    $url = "postgresql://${u}:${p}@${PGHOST}:${PGPORT}/${PGDB}"
  } else {
    $url = 'sqlite:///./cdrdb.sqlite3'
    Write-Host '  No password entered - configuring SQLite.' -ForegroundColor Yellow
  }
  $env_content = Get-Content .env -Raw
  if ($env_content -match '(?m)^DATABASE_URL=.*$') {
    $env_content = [regex]::Replace($env_content, '(?m)^DATABASE_URL=.*$', "DATABASE_URL=$url")
  } else {
    $env_content = "DATABASE_URL=$url`n" + $env_content
  }
  Set-Content -Path .env -Value $env_content -Encoding UTF8 -NoNewline
  Write-Host '  Wrote DATABASE_URL to backend\.env'
}

Write-Host '== 4/4  Creating database ==' -ForegroundColor Cyan
python scripts\init_db.py

Write-Host ''
Write-Host 'Setup complete. Run the dashboard:' -ForegroundColor Green
Write-Host '  .\.venv\Scripts\Activate.ps1'
Write-Host '  uvicorn app.main:app --reload'
Write-Host 'Open http://127.0.0.1:8000  (login admin / the password in backend\.env)'
