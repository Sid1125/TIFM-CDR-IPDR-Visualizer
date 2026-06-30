"""Phase 0 — the capability layer must (a) detect the offline self-contained mode correctly,
(b) report it on /health, and (c) provide a working thread job queue with status tracking.
These guard the air-gapped guarantee: with nothing external configured, ARGUS stays fully
self-contained."""
from __future__ import annotations

import time
import unittest

from sqlalchemy import create_engine

from app.core.capabilities import detect, Capabilities
from app.core.jobs import ThreadJobQueue
from app.core.cache import DBCache, get_cache


class CapabilityDetectionTests(unittest.TestCase):
    def test_sqlite_offline_is_self_contained(self):
        engine = create_engine("sqlite:///:memory:")
        caps = detect(engine)
        self.assertEqual(caps.backend, "sqlite")
        self.assertFalse(caps.redis)
        self.assertEqual(caps.job_queue, "thread")
        self.assertTrue(caps.self_contained)
        s = caps.summary()
        self.assertTrue(s["self_contained_offline"])
        self.assertIn(s["search"], ("sqlite_fts5", "ilike"))  # depends on the SQLite build
        self.assertEqual(s["cache"], "database")

    def test_search_mode_precedence(self):
        c = Capabilities(backend="postgresql", pg_trgm=True)
        self.assertEqual(c.search_mode, "pg_trgm")
        c = Capabilities(backend="sqlite", sqlite_fts5=True)
        self.assertEqual(c.search_mode, "sqlite_fts5")
        self.assertEqual(Capabilities().search_mode, "ilike")


class ThreadJobQueueTests(unittest.TestCase):
    def _await(self, q, jid, timeout=2.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            st = q.status(jid)
            if st and st["state"] in ("done", "error"):
                return st
            time.sleep(0.01)
        return q.status(jid)

    def test_job_runs_and_reports_done(self):
        q = ThreadJobQueue()
        seen = {}
        jid = q.enqueue(lambda: seen.setdefault("ran", True), name="ok")
        st = self._await(q, jid)
        self.assertEqual(st["state"], "done")
        self.assertTrue(seen.get("ran"))

    def test_job_failure_is_captured_not_raised(self):
        q = ThreadJobQueue()

        def boom():
            raise ValueError("kaboom")

        jid = q.enqueue(boom, name="boom")
        st = self._await(q, jid)
        self.assertEqual(st["state"], "error")
        self.assertIn("kaboom", st["error"])

    def test_unknown_job_id_is_none(self):
        self.assertIsNone(ThreadJobQueue().status("does-not-exist"))


class CacheFactoryTests(unittest.TestCase):
    def test_default_cache_is_db_backed(self):
        # With no Redis configured, the factory must return the offline DB cache.
        self.assertIsInstance(get_cache(), DBCache)


if __name__ == "__main__":
    unittest.main()
