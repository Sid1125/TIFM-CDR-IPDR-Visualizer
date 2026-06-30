"""Phase 1b — cache versioning. A cached analytics row whose schema_version differs from the
running SCHEMA_VERSION must be treated as a miss, so a code update that changes an analytic's
shape can never serve stale data. Telemetry (record_count / build_ms) is surfaced via get_status."""
from __future__ import annotations

import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.analytics import AnalyticsCache
import app.services.analytics_materialize_service as ms


class CacheVersioningTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

    def test_upsert_stamps_current_version_and_get_cached_hits(self):
        db = self.Session()
        ms._upsert(db, "A", "dashboard", {"x": 1}, record_count=42, build_ms=7)
        db.commit()
        self.assertEqual(ms.get_cached(db, "A", "dashboard"), {"x": 1})
        row = db.query(AnalyticsCache).one()
        self.assertEqual(row.schema_version, ms.SCHEMA_VERSION)
        self.assertEqual(row.record_count, 42)
        db.close()

    def test_stale_schema_version_is_a_miss(self):
        db = self.Session()
        ms._upsert(db, "A", "dashboard", {"x": 1})
        db.commit()
        # Simulate a row written by an older analytics shape.
        db.query(AnalyticsCache).update({AnalyticsCache.schema_version: ms.SCHEMA_VERSION - 1})
        db.commit()
        self.assertIsNone(ms.get_cached(db, "A", "dashboard"))  # ignored → recompute
        self.assertFalse(ms.get_status(db, "A")["ready"])
        db.close()

    def test_get_status_reports_telemetry(self):
        db = self.Session()
        ms._upsert(db, "A", "dashboard", {"x": 1}, record_count=1000, build_ms=250)
        db.commit()
        st = ms.get_status(db, "A")
        self.assertTrue(st["ready"])
        self.assertEqual(st["record_count"], 1000)
        self.assertEqual(st["build_ms"], 250)
        self.assertEqual(st["schema_version"], ms.SCHEMA_VERSION)
        db.close()


if __name__ == "__main__":
    unittest.main()
