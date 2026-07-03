"""Frozen-app entry point (Phase #5 installer).

Starts the ARGUS server and opens its UI in a standalone window — this is what the bundled
ARGUS.exe runs. It imports the FastAPI `app` object directly (rather than the "app.main:app"
import string) so it works inside a PyInstaller bundle, where re-importing by string is unreliable.

By default it runs against the zero-config SQLite database (fully self-contained / air-gapped). To
point a packaged install at PostgreSQL, ship a `.env` next to the executable with `DATABASE_URL=…`.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
import time
import webbrowser

HOST = os.environ.get("ARGUS_HOST", "127.0.0.1")
PORT = int(os.environ.get("ARGUS_PORT", "8000"))

# Chromium "app mode" (--app=URL) opens a chromeless window — no tabs, address bar, or bookmark
# bar — so ARGUS reads as a standalone desktop app rather than a browser tab, with no extra
# runtime dependency (a real embedded webview needs pywebview + pythonnet/WebView2 bindings,
# which would meaningfully grow the installer for a mostly cosmetic gain). Edge ships on every
# Windows 10/11 box, so this works with zero prerequisites; falls back to a normal browser tab
# if neither Edge nor Chrome can be found (non-Windows dev runs, stripped-down images, …).
_APP_MODE_BROWSER_PATHS = [
    r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
    r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
    r"%LocalAppData%\Microsoft\Edge\Application\msedge.exe",
    r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
    r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
    r"%LocalAppData%\Google\Chrome\Application\chrome.exe",
]


def _find_app_mode_browser() -> str | None:
    for name in ("msedge", "chrome", "google-chrome", "chromium"):
        found = shutil.which(name)
        if found:
            return found
    for template in _APP_MODE_BROWSER_PATHS:
        candidate = os.path.expandvars(template)
        if os.path.isfile(candidate):
            return candidate
    return None


def _open_browser() -> None:
    time.sleep(2.5)
    url = f"http://{HOST}:{PORT}"
    browser = _find_app_mode_browser()
    if browser:
        try:
            # A dedicated profile dir means the app window's state (size/position) doesn't fight
            # with the operator's own everyday browser profile, and a closed ARGUS window never
            # lingers as a stray "restore session" prompt in their regular browser.
            profile_dir = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "ARGUS", "browser-profile")
            subprocess.Popen([
                browser,
                f"--app={url}",
                "--window-size=1440,900",
                f"--user-data-dir={profile_dir}",
                "--no-first-run",
            ])
            return
        except Exception:
            pass
    try:
        webbrowser.open(url)
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
