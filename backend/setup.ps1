# Fresh-project setup for the Project ARGUS (Advanced Records & Geospatial Unified Surveillance) (Windows / PowerShell).
# Run from the backend/ directory:   .\setup.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host '== 1/4  Virtual environment ==' -ForegroundColor Cyan
if (-not (Test-Path .venv)) { python -m venv .venv }
& .\.venv\Scripts\Activate.ps1

Write-Host '== 2/4  Dependencies ==' -ForegroundColor Cyan
python -m pip install --upgrade pip
pip install -r requirements.txt

Write-Host '== 3/4  Environment file ==' -ForegroundColor Cyan
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host 'Created backend\.env from .env.example.' -ForegroundColor Yellow
  Write-Host 'EDIT backend\.env now: set DATABASE_URL (Postgres user/password/host) and AUTH_BOOTSTRAP_PASSWORD.' -ForegroundColor Yellow
  Write-Host 'Tip: for the simplest start with no Postgres, set  DATABASE_URL=sqlite:///./cdrdb.sqlite3' -ForegroundColor Yellow
} else {
  Write-Host 'backend\.env already exists — leaving it untouched.'
}

Write-Host '== 4/4  Database ==' -ForegroundColor Cyan
python scripts\init_db.py

Write-Host ''
Write-Host 'Setup complete.' -ForegroundColor Green
Write-Host 'Start the app:' -ForegroundColor Green
Write-Host '  .\.venv\Scripts\Activate.ps1'
Write-Host '  uvicorn app.main:app --reload'
Write-Host 'Open http://127.0.0.1:8000  (login: admin / the password set in backend\.env)'
