"""Job queue adapter — uniform `enqueue` / `status` over an optional external worker.

Default (`ThreadJobQueue`) is fully self-contained: jobs run on a single background thread off
the request path, with an in-memory id→status map so `/jobs/{id}` works even offline. When a
broker is configured and a worker lib is installed, the capability layer can swap in a
Celery/RQ adapter (Phase 3b) without touching call sites — they only ever see `enqueue()`.

Jobs are plain callables that manage their own DB session (matching the existing
`_bg_materialize` convention), so the queue never owns a Session.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

log = logging.getLogger(__name__)

_MAX_HISTORY = 200  # cap the status map so a long-running server doesn't leak memory


class JobQueue:
    """Adapter interface."""

    def enqueue(self, func: Callable[..., Any], *args: Any, name: str = "", **kwargs: Any) -> str:
        raise NotImplementedError

    def status(self, job_id: str) -> dict | None:
        raise NotImplementedError

    def recent(self, limit: int = 50) -> list[dict]:
        raise NotImplementedError


class ThreadJobQueue(JobQueue):
    def __init__(self) -> None:
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="argus-job")
        self._jobs: dict[str, dict] = {}
        self._order: list[str] = []
        self._lock = threading.Lock()

    def _record(self, job_id: str, **fields: Any) -> None:
        with self._lock:
            self._jobs.setdefault(job_id, {}).update(fields)

    def _evict_if_needed(self) -> None:
        with self._lock:
            while len(self._order) > _MAX_HISTORY:
                old = self._order.pop(0)
                self._jobs.pop(old, None)

    def enqueue(self, func: Callable[..., Any], *args: Any, name: str = "", **kwargs: Any) -> str:
        job_id = uuid.uuid4().hex
        with self._lock:
            self._jobs[job_id] = {
                "id": job_id, "name": name or getattr(func, "__name__", "job"),
                "state": "queued", "queued_at": time.time(), "error": None,
            }
            self._order.append(job_id)
        self._evict_if_needed()

        def _run() -> None:
            self._record(job_id, state="running", started_at=time.time())
            try:
                func(*args, **kwargs)
                self._record(job_id, state="done", finished_at=time.time())
            except Exception as exc:  # noqa: BLE001 — surface but never crash the worker thread
                log.exception("job %s (%s) failed", job_id, name)
                self._record(job_id, state="error", finished_at=time.time(), error=str(exc))

        self._pool.submit(_run)
        return job_id

    def status(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None

    def recent(self, limit: int = 50) -> list[dict]:
        """Most-recently-enqueued jobs first (for a status/progress view)."""
        with self._lock:
            ids = self._order[-limit:][::-1]
            return [dict(self._jobs[i]) for i in ids if i in self._jobs]


_queue: JobQueue | None = None


def get_job_queue() -> JobQueue:
    """Return the process-wide job queue, building it lazily from detected capabilities."""
    global _queue
    if _queue is not None:
        return _queue
    from app.core.capabilities import CAPS
    if CAPS.job_queue in ("celery", "rq"):
        # External worker adapters land in Phase 3b; until then the thread queue is correct
        # and keeps the offline guarantee. Logged so the operator knows it's not yet wired.
        log.info("capabilities: %s broker detected; external worker adapter not yet wired — using thread queue", CAPS.job_queue)
    _queue = ThreadJobQueue()
    return _queue
