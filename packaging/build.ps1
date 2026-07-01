# Build ARGUS.exe (Phase #5 installer). Run from the packaging/ directory in PowerShell:
#     ./build.ps1
# Produces packaging/dist/ARGUS/ARGUS.exe (a self-contained one-dir bundle). Then run
# argus_installer.iss through Inno Setup to wrap it into ARGUS_Setup.exe.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$venvPy = Join-Path $here "..\backend\.venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) { $venvPy = "python" }

Write-Host "Installing PyInstaller into the build environment..."
& $venvPy -m pip install --quiet pyinstaller

Write-Host "Building the bundle (this can take a few minutes)..."
& $venvPy -m PyInstaller --noconfirm --clean argus.spec

$exe = Join-Path $here "dist\ARGUS\ARGUS.exe"
if (Test-Path $exe) {
    Write-Host "`nBuilt: $exe"
    Write-Host "Smoke-test it, then run argus_installer.iss through Inno Setup to make ARGUS_Setup.exe."
} else {
    Write-Error "Build finished but ARGUS.exe was not found — check the PyInstaller output above."
}
