"""Capability detection — the spine of ARGUS's optional-accelerator architecture.

ARGUS must run **fully self-contained** (FastAPI + PostgreSQL, or the SQLite fallback) with
NO external services. When optional accelerators (Redis, a Celery/RQ broker, Postgres
`pg_trgm`, SQLite FTS5) are configured *and reachable*, the capability layer flips them on so
caches, job queues and search transparently speed up. If a configured service is missing or
unreachable, detection silently degrades to the offline path — it never raises.

`detect(engine)` is called once at startup and populates the module-level `CAPS` singleton.
`GET /health` reports `CAPS.summary()` so an operator can confirm "pure offline" vs "accelerated".
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from app.core.config import settings

log = logging.getLogger(__name__)


@dataclass
class Capabilities:
    backend: str = "sqlite"          # "postgresql" | "sqlite"
    redis: bool = False              # Redis reachable (cache + pub/sub)
    job_queue: str = "thread"        # "celery" | "rq" | "thread" (self-contained default)
    pg_trgm: bool = False            # Postgres pg_trgm extension available (fast ILIKE)
    sqlite_fts5: bool = False        # SQLite built with FTS5 (trigram tokenizer search)
    redis_url: str = ""

    @property
    def pg(self) -> bool:
        return self.backend == "postgresql"

    @property
    def search_mode(self) -> str:
        if self.pg_trgm:
            return "pg_trgm"
        if self.sqlite_fts5:
            return "sqlite_fts5"
        return "ilike"

    @property
    def self_contained(self) -> bool:
        """True when nothing external is in use — the air-gapped guarantee holds."""
        return not self.redis and self.job_queue == "thread"

    def summary(self) -> dict:
        return {
            "db_backend": self.backend,
            "cache": "redis" if self.redis else "database",
            "job_queue": self.job_queue,
            "search": self.search_mode,
            "self_contained_offline": self.self_contained,
        }


CAPS = Capabilities()


def _probe_redis(url: str) -> bool:
    if not url:
        return False
    try:
        import redis  # optional dependency
    except Exception:
        log.info("capabilities: REDIS_URL set but the 'redis' package isn't installed — staying offline")
        return False
    try:
        client = redis.Redis.from_url(url, socket_connect_timeout=0.5, socket_timeout=0.5)
        client.ping()
        log.info("capabilities: Redis reachable at %s", url)
        return True
    except Exception as exc:  # noqa: BLE001 — any failure means "fall back to offline"
        log.info("capabilities: Redis configured but unreachable (%s) — staying offline", exc)
        return False


def _probe_job_queue() -> str:
    """A broker URL + an installed worker lib enables a real queue; otherwise the thread queue."""
    if not settings.CELERY_BROKER_URL:
        return "thread"
    try:
        import celery  # noqa: F401
        return "celery"
    except Exception:
        pass
    try:
        import rq  # noqa: F401
        return "rq"
    except Exception:
        pass
    log.info("capabilities: CELERY_BROKER_URL set but no celery/rq installed — using thread queue")
    return "thread"


def _probe_pg_trgm(engine) -> bool:
    from sqlalchemy import text
    try:
        with engine.begin() as conn:
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        return True
    except Exception as exc:  # noqa: BLE001
        log.info("capabilities: pg_trgm unavailable (%s) — ILIKE search will not be index-accelerated", exc)
        return False


def _probe_sqlite_fts5(engine) -> bool:
    from sqlalchemy import text
    try:
        with engine.begin() as conn:
            conn.execute(text("CREATE VIRTUAL TABLE IF NOT EXISTS _argus_fts5_probe USING fts5(x)"))
            conn.execute(text("DROP TABLE IF EXISTS _argus_fts5_probe"))
        return True
    except Exception:  # noqa: BLE001 — SQLite build without FTS5
        return False


def detect(engine) -> Capabilities:
    """Populate CAPS from config + live probes. Best-effort; never raises."""
    try:
        CAPS.backend = engine.url.get_backend_name()
    except Exception:  # noqa: BLE001
        CAPS.backend = "sqlite"
    CAPS.redis_url = settings.REDIS_URL
    CAPS.redis = _probe_redis(settings.REDIS_URL)
    CAPS.job_queue = _probe_job_queue()
    if CAPS.pg:
        CAPS.pg_trgm = _probe_pg_trgm(engine)
    else:
        CAPS.sqlite_fts5 = _probe_sqlite_fts5(engine)
    log.info("capabilities detected: %s", CAPS.summary())
    return CAPS
