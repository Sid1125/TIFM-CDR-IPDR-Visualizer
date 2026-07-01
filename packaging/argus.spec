# PyInstaller spec for ARGUS (Phase #5 installer).
#   Build:  cd packaging && pyinstaller argus.spec
#   Output: dist/ARGUS/ARGUS.exe  (one-dir bundle — faster start + easy to inspect)
#
# Bundles the FastAPI app, the static frontend, and the bundled data files. Runs zero-config
# against SQLite; drop a .env with DATABASE_URL next to ARGUS.exe to use PostgreSQL.
import os
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

BACKEND = os.path.join(os.getcwd(), "..", "backend")

# Ship the frontend and the bundled reference/attribution data as data files.
datas = [
    (os.path.join(BACKEND, "static"), "backend/static"),
    (os.path.join(BACKEND, "app", "data"), "backend/app/data"),
]
try:
    datas += collect_data_files("app", subdir="data")
except Exception:
    pass

# Uvicorn, SQLAlchemy dialects, and the app packages must be pulled in explicitly — they're
# imported dynamically and PyInstaller's static analysis misses some.
hiddenimports = (
    collect_submodules("uvicorn")
    + collect_submodules("app")
    + ["sqlalchemy.dialects.sqlite", "sqlalchemy.dialects.postgresql",
       "anyio", "click", "h11", "passlib.handlers.pbkdf2"]
)

a = Analysis(
    ["launch.py"],
    pathex=[BACKEND],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "scipy", "numpy.testing"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz, a.scripts, [], exclude_binaries=True,
    name="ARGUS",
    console=True,          # keep a console so the operator can see the URL / stop it
    icon=None,             # set to an .ico path if you have one
)
coll = COLLECT(exe, a.binaries, a.datas, name="ARGUS")
