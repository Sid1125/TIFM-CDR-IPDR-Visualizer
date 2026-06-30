"""Materialised analytics must not outlive the records they summarise.

Regression for the staleness bug: resetting a case's records (or deleting the
case) used to leave the analytics_cache rows in place, so the dashboard / reports
kept serving pre-reset data until the next upload re-materialised. invalidate()
and invalidate_all() are the fix; these tests lock the behaviour in."""
from __future__ import annotations

import unittest
from datetime import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.analytics import AnalyticsCache
from app.models.cdr import CDRRecord  # noqa: F401  (registers the table)
from app.models.ipdr import IPDRRecord  # noqa: F401
from app.models.tower import Tower  # noqa: F401
from app.services.analytics_materialize_service import (
    _upsert,
    get_cached,
    invalidate,
    invalidate_all,
)


class AnalyticsInvalidationTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        db = self.Session()
        # Seed cache rows: case "A", case "B", and the global "" aggregate.
        _upsert(db, "A", "dashboard", {"charts": 1})
        _upsert(db, "A", "cdr_report:999", {"total_records": 3})
        _upsert(db, "B", "dashboard", {"charts": 2})
        _upsert(db, "", "dashboard", {"charts": 0})
        db.commit()
        db.close()

    def _db(self):
        return self.Session()

    def test_invalidate_drops_case_and_global(self):
        db = self._db()
        invalidate(db, "A")
        db.commit()
        # case A's rows are gone, and the global "" aggregate too (a per-case change
        # invalidates the all-cases view)
        self.assertIsNone(get_cached(db, "A", "dashboard"))
        self.assertIsNone(get_cached(db, "A", "cdr_report:999"))
        self.assertIsNone(get_cached(db, None, "dashboard"))  # cid -> ""
        # case B is untouched
        self.assertIsNotNone(get_cached(db, "B", "dashboard"))
        db.close()

    def test_invalidate_none_targets_global_only(self):
        db = self._db()
        invalidate(db, None)  # reset of the global/no-case scope
        db.commit()
        self.assertIsNone(get_cached(db, None, "dashboard"))
        self.assertIsNotNone(get_cached(db, "A", "dashboard"))
        self.assertIsNotNone(get_cached(db, "B", "dashboard"))
        db.close()

    def test_invalidate_all_wipes_everything(self):
        db = self._db()
        invalidate_all(db)
        db.commit()
        self.assertEqual(db.query(AnalyticsCache).count(), 0)
        db.close()


if __name__ == "__main__":
    unittest.main()
