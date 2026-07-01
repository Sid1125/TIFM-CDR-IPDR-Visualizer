"""Frozen-app entry point (Phase #5 installer).

Starts the ARGUS server and opens the browser — this is what the bundled ARGUS.exe runs. It imports
the FastAPI `app` object directly (rather than the "app.main:app" import string) so it works inside
a PyInstaller bundle, where re-importing by string is unreliable.

By default it runs against the zero-config SQLite database (fully self-contained / air-gapped). To
point a packaged install at PostgreSQL, ship a `.env` next to the executable with `DATABASE_URL=…`.
"""
from __future__ import annotations

import os
import sys
import threading
import time
import webbrowser

HOST = os.environ.get("ARGUS_HOST", "127.0.0.1")
PORT = int(os.environ.get("ARGUS_PORT", "8000"))


def _open_browser() -> None:
    time.sleep(2.5)
    try:
        webbrowser.open(f"http://{HOST}:{PORT}")
    except Exception:
        pass


def main() -> None:
    # When frozen, the backend package sits next to this file; make sure it's importable.
    here = os.path.dirname(os.path.abspath(__file__))
    backend = os.path.join(here, "backend")
    for p in (backend, here):
        if os.path.isdir(p) and p not in sys.path:
            sys.path.insert(0, p)

    import uvicorn
    from app.main import app  # noqa: WPS433 — imported after sys.path is set

    threading.Thread(target=_open_browser, daemon=True).start()
    print(f"ARGUS running at http://{HOST}:{PORT}  (close this window to stop)")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
