"""Cache adapter — uniform key/value analytics cache over an optional Redis layer.

Default (`DBCache`) is the existing `analytics_cache` table — durable, offline, already
invalidated by the event bus. When Redis is reachable, `RedisCache` adds an in-memory TTL tier
(faster case reopen; a path to sharing across investigators later). Call sites only ever see the
`Cache` interface, so wiring analytics through it (Phase 3a) is a drop-in.

Keys are scoped by `(case_id, key)`. `invalidate(case_id)` drops every entry for a case.
"""
from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)

_NS = "argus:analytics"


class Cache:
    """Adapter interface. case_id is normalised to "" for the global/all-cases scope."""

    def get(self, case_id: str | None, key: str) -> Any | None:
        raise NotImplementedError

    def set(self, case_id: str | None, key: str, data: Any, ttl: int = 0) -> None:
        raise NotImplementedError

    def delete(self, case_id: str | None, key: str) -> None:
        raise NotImplementedError

    def invalidate(self, case_id: str | None) -> None:
        raise NotImplementedError


class DBCache(Cache):
    """Delegates to the analytics_cache table via the materialize service (lazy-imported to
    avoid an import cycle, since that service will later read this adapter)."""

    def get(self, case_id: str | None, key: str) -> Any | None:
        from app.core.database import SessionLocal
        from app.services.analytics_materialize_service import get_cached
        with SessionLocal() as db:
            return get_cached(db, case_id, key)

    def set(self, case_id: str | None, key: str, data: Any, ttl: int = 0) -> None:
        from app.core.database import SessionLocal
        from app.services.analytics_materialize_service import _upsert
        with SessionLocal() as db:
            _upsert(db, case_id or "", key, data)
            db.commit()

    def delete(self, case_id: str | None, key: str) -> None:
        from app.core.database import SessionLocal
        from app.models.analytics import AnalyticsCache
        with SessionLocal() as db:
            db.query(AnalyticsCache).filter(
                AnalyticsCache.case_id == (case_id or ""), AnalyticsCache.key == key
            ).delete(synchronize_session=False)
            db.commit()

    def invalidate(self, case_id: str | None) -> None:
        from app.core.database import SessionLocal
        from app.services.analytics_materialize_service import invalidate
        with SessionLocal() as db:
            invalidate(db, case_id)
            db.commit()


class RedisCache(Cache):
    """TTL cache in front of nothing — a miss simply recomputes. Redis being volatile is fine:
    it is an accelerator, not the source of truth (the DB cache remains authoritative)."""

    def __init__(self, url: str) -> None:
        import json
        import redis
        self._json = json
        self._r = redis.Redis.from_url(url, decode_responses=True)

    def _k(self, case_id: str | None, key: str) -> str:
        return f"{_NS}:{case_id or ''}:{key}"

    def get(self, case_id: str | None, key: str) -> Any | None:
        try:
            raw = self._r.get(self._k(case_id, key))
            return self._json.loads(raw) if raw is not None else None
        except Exception as exc:  # noqa: BLE001 — never let cache failures break a request
            log.warning("RedisCache.get failed (%s)", exc)
            return None

    def set(self, case_id: str | None, key: str, data: Any, ttl: int = 0) -> None:
        try:
            payload = self._json.dumps(data, default=str)
            k = self._k(case_id, key)
            if ttl > 0:
                self._r.setex(k, ttl, payload)
            else:
                self._r.set(k, payload)
        except Exception as exc:  # noqa: BLE001
            log.warning("RedisCache.set failed (%s)", exc)

    def delete(self, case_id: str | None, key: str) -> None:
        try:
            self._r.delete(self._k(case_id, key))
        except Exception as exc:  # noqa: BLE001
            log.warning("RedisCache.delete failed (%s)", exc)

    def invalidate(self, case_id: str | None) -> None:
        try:
            pattern = f"{_NS}:{case_id or ''}:*"
            keys = list(self._r.scan_iter(match=pattern, count=500))
            if keys:
                self._r.delete(*keys)
        except Exception as exc:  # noqa: BLE001
            log.warning("RedisCache.invalidate failed (%s)", exc)


_cache: Cache | None = None


def get_cache() -> Cache:
    """Return the process-wide cache, built lazily from detected capabilities."""
    global _cache
    if _cache is not None:
        return _cache
    from app.core.capabilities import CAPS
    if CAPS.redis and CAPS.redis_url:
        try:
            _cache = RedisCache(CAPS.redis_url)
            log.info("cache: using RedisCache")
            return _cache
        except Exception as exc:  # noqa: BLE001 — fall back to DB cache on any wiring failure
            log.warning("cache: RedisCache init failed (%s) — using DBCache", exc)
    _cache = DBCache()
    return _cache
