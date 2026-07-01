"""Phase 3a — Redis cache tier. RedisCache is exercised against an injected redis-py-compatible
fake (no redis install needed), and read_through is verified to (a) leave the offline DB-cache path
unchanged when Redis is off, and (b) front the DB cache and skip recompute when Redis is on."""
from __future__ import annotations

import fnmatch
import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.core.cache import RedisCache
from app.core.capabilities import CAPS
import app.core.cache as cache_mod
from app.models.analytics import AnalyticsCache  # noqa: F401
from app.models.cdr import CDRRecord  # noqa: F401
from app.models.ipdr import IPDRRecord  # noqa: F401
import app.services.analytics_materialize_service as ms


class FakeRedis:
    """Minimal redis-py surface used by RedisCache (decode_responses semantics: str in/out)."""
    def __init__(self):
        self.store = {}
    def get(self, k):
        return self.store.get(k)
    def set(self, k, v):
        self.store[k] = v
    def setex(self, k, ttl, v):
        self.store[k] = v
    def delete(self, *ks):
        for k in ks:
            self.store.pop(k, None)
    def scan_iter(self, match=None, count=None):
        return [k for k in list(self.store) if not match or fnmatch.fnmatch(k, match)]


class RedisCacheTests(unittest.TestCase):
    def _rc(self):
        return RedisCache("", client=FakeRedis())

    def test_set_get_roundtrip(self):
        rc = self._rc()
        rc.set("A", "dashboard", {"x": 1})
        self.assertEqual(rc.get("A", "dashboard"), {"x": 1})
        self.assertIsNone(rc.get("A", "missing"))

    def test_invalidate_drops_case_and_global(self):
        rc = self._rc()
        rc.set("A", "dashboard", {"x": 1})
        rc.set("", "dashboard", {"g": 1})      # global aggregate
        rc.set("B", "dashboard", {"y": 1})
        rc.invalidate("A")
        self.assertIsNone(rc.get("A", "dashboard"))
        self.assertIsNone(rc.get("", "dashboard"))   # per-case change clears the global too
        self.assertEqual(rc.get("B", "dashboard"), {"y": 1})

    def test_invalidate_all(self):
        rc = self._rc()
        rc.set("A", "k", 1); rc.set("B", "k", 2)
        rc.invalidate_all()
        self.assertIsNone(rc.get("A", "k"))
        self.assertIsNone(rc.get("B", "k"))


class ReadThroughTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self._redis_was = CAPS.redis
        self._get_cache_was = cache_mod.get_cache

    def tearDown(self):
        CAPS.redis = self._redis_was
        cache_mod.get_cache = self._get_cache_was

    def test_offline_uses_db_cache_and_computes_once(self):
        CAPS.redis = False
        db = self.Session()
        calls = []
        val = ms.read_through(db, "A", "dashboard", lambda: (calls.append(1), {"n": 1})[1])
        self.assertEqual(val, {"n": 1})
        # second call hits the DB cache — no recompute
        val2 = ms.read_through(db, "A", "dashboard", lambda: (calls.append(1), {"n": 2})[1])
        self.assertEqual(val2, {"n": 1})
        self.assertEqual(len(calls), 1)
        db.close()

    def test_redis_fronts_db_and_skips_recompute(self):
        CAPS.redis = True
        rc = RedisCache("", client=FakeRedis())
        cache_mod.get_cache = lambda: rc
        db = self.Session()
        calls = []
        v1 = ms.read_through(db, "A", "dashboard", lambda: (calls.append(1), {"n": 1})[1])
        self.assertEqual(v1, {"n": 1})
        self.assertEqual(rc.get("A", "dashboard"), {"n": 1})   # written through to Redis
        # a fresh session with an EMPTY db cache still returns from Redis (fronting works)
        db2 = self.Session()
        v2 = ms.read_through(db2, "A", "dashboard", lambda: (calls.append(1), {"n": 99})[1])
        self.assertEqual(v2, {"n": 1})
        self.assertEqual(len(calls), 1)  # computed once, served from Redis after
        db.close(); db2.close()


if __name__ == "__main__":
    unittest.main()
