# ARGUS packaging (installer)

Turns ARGUS into a one-click **`ARGUS_Setup.exe`** for Windows — install, run, done — instead of
clone → Python → Postgres → Redis. It bundles the FastAPI app + Python + the frontend and runs
**zero-config against SQLite**, so a packaged install is fully self-contained and air-gapped.

## What's here
| File | Purpose |
|------|---------|
| `launch.py` | Frozen entry point — starts the server and opens the browser. |
| `argus.spec` | PyInstaller spec — bundles the app, static frontend, and data files. |
| `build.ps1` | Builds `dist/ARGUS/ARGUS.exe` from the spec. |
| `argus_installer.iss` | Inno Setup script — wraps the bundle into `ARGUS_Setup.exe` with shortcuts. |

## Build (on a Windows build machine with internet for the toolchain)
```powershell
cd packaging
./build.ps1                     # → dist/ARGUS/ARGUS.exe  (PyInstaller one-dir bundle)
# install Inno Setup (https://jrsoftware.org/isinfo.php), then:
iscc argus_installer.iss        # → Output/ARGUS_Setup.exe
```
`ARGUS.exe` alone is already a runnable, self-contained folder; the Inno step just adds the
installer wrapper + shortcuts.

## Database
- **Default (bundled):** SQLite — no setup, no external services. Data lives in `cdrdb.sqlite3`
  next to the executable. This is the true one-click / air-gapped path.
- **PostgreSQL (optional):** drop a `.env` next to `ARGUS.exe` with `DATABASE_URL=postgresql://…`.
  The capability layer auto-detects it (and `pg_trgm`, Redis, etc.) and falls back to SQLite if it
  can't connect. Bundling a Postgres server into the installer is intentionally **out of scope** —
  ship it as an optional prerequisite for the large-scale deployments that need partitioning.

## Notes / gotchas
- The spec excludes `scipy`/`numpy.testing`/`matplotlib` — ARGUS is deliberately SciPy-free
  (PageRank and the graph layout are pure-Python), which keeps the bundle small.
- **The fine-tuned local LLM is excluded from the installer.** The optional `/ai/chat` feature
  (`app/ai/inference.py`) needs a multi-GB GPU stack (torch / transformers / peft / bitsandbytes /
  accelerate / datasets / …) plus a 7 GB base model + LoRA adapter — out of scope for a one-click,
  air-gapped SQLite install, the same way a Postgres *server* is. The spec excludes that whole stack
  (`ML_EXCLUDES`), and `inference.py` imports it lazily so the app starts fine without it; the
  endpoint just reports the model as unavailable. To enable it, install
  `torch`/`transformers`/`peft`/`bitsandbytes` into the runtime alongside ARGUS and supply the model.
  The rest of the AI panel (Ollama-backed) is unaffected — it talks to a local Ollama over HTTP.
- `pandas`/`numpy` stay bundled — the CSV importer depends on them.
- `console=True` in the spec keeps a terminal window so the operator sees the URL and can stop the
  server; set an `.ico` and flip to `console=False` for a windowed launch once you're happy.
- First launch on a big existing DB will build the search indexes / materialise analytics once —
  expected, and cached thereafter.
- This toolchain is provided as the packaging path; run the two build commands on your target
  Windows build box to produce and smoke-test the actual installer.
