"""In-process event bus — decouples "records changed" from the work it triggers.

Upload publishes `CASE_IMPORTED` (replace) / `RECORDS_APPENDED` (append); reset/delete publish
`CASE_RESET` / `CASE_DELETED`. Subscribers (analytics (re)materialisation today; search-index
refresh and Redis pub/sub later) react without the uploader knowing about them.

`publish()` runs handlers synchronously but isolates failures — one bad handler never breaks the
request or the others. Handlers that do heavy work enqueue onto the JobQueue rather than blocking.
When Redis is available (Phase 3a/3b) this can bridge to cross-process pub/sub; the in-process
default keeps the air-gapped path dependency-free.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from typing import Callable

log = logging.getLogger(__name__)

# Event names
CASE_IMPORTED = "case_imported"        # replace-mode upload → full (re)materialise
RECORDS_APPENDED = "records_appended"  # append-mode upload → incremental update
CASE_RESET = "case_reset"              # a case's (or all) records were wiped
CASE_DELETED = "case_deleted"          # a case was removed

_subscribers: dict[str, list[Callable]] = defaultdict(list)


def subscribe(event: str, handler: Callable) -> None:
    if handler not in _subscribers[event]:
        _subscribers[event].append(handler)


def publish(event: str, **data) -> None:
    handlers = list(_subscribers.get(event, ()))
    log.debug("event %s → %d handler(s)", event, len(handlers))
    for h in handlers:
        try:
            h(**data)
        except Exception:  # noqa: BLE001 — a handler failure must not break the publisher
            log.exception("event handler %r for %s failed", getattr(h, "__name__", h), event)


def clear() -> None:
    """Test helper — drop all subscriptions."""
    _subscribers.clear()
    global _registered
    _registered = False


# ── default handlers ──────────────────────────────────────────────────────────

def _enqueue(func_name: str, case_id: str | None) -> None:
    """Enqueue a materialisation job (`materialize_case` or `incremental_update`) onto the
    JobQueue, each in its own session."""
    from app.core.database import SessionLocal
    from app.core.jobs import get_job_queue
    import app.services.analytics_materialize_service as ms

    fn = getattr(ms, func_name)

    def job() -> None:
        with SessionLocal() as db:
            fn(db, case_id)

    label = "materialize" if func_name == "materialize_case" else "incremental"
    get_job_queue().enqueue(job, name=f"{label}:{case_id or 'global'}")


def _on_case_imported(case_id: str | None = None, **_) -> None:
    _enqueue("materialize_case", case_id)  # replace-mode upload → full (re)build


def _on_records_appended(case_id: str | None = None, **_) -> None:
    _enqueue("incremental_update", case_id)  # append → O(touched) update


_registered = False


def register_default_handlers() -> None:
    """Wire the built-in analytics handlers. Idempotent; called once at startup."""
    global _registered
    if _registered:
        return
    subscribe(CASE_IMPORTED, _on_case_imported)
    subscribe(RECORDS_APPENDED, _on_records_appended)
    _registered = True
