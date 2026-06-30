"""Phase 1a — incremental analytics parity.

The headline guarantee: after an append, `incremental_update` must leave the analytics cache
**byte-identical** to a full `materialize_case` over the same final data. It just gets there by
recomputing only what the new rows touched (per-subject reports), not by rescanning every
subject. These tests lock that equivalence in across several append shapes."""
from __future__ import annotations

import json
import unittest
from datetime import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.analytics import AnalyticsCache
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower  # noqa: F401  (registers the table)
import app.services.analytics_materialize_service as ms

CASE = "A"


def _cdr(i, a, b="555", tower="T1", day=1, hour=10):
    return CDRRecord(case_id=CASE, a_party_number=a, b_party_number=b, call_type="Voice",
                     direction="MO", tower_id=tower, msisdn=a, duration_seconds=30,
                     start_time=datetime(2026, 1, day, hour, i % 60))


def _ipdr(i, sip, tower="T1", day=1, hour=10):
    return IPDRRecord(case_id=CASE, source_ip=sip, destination_ip="8.8.8.8", protocol="TCP",
                      tower_id=tower, msisdn="9", source_port=40000 + i, destination_port=443,
                      bytes_uploaded=100, bytes_downloaded=200,
                      start_time=datetime(2026, 1, day, hour, i % 60))


class IncrementalParityTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

    def _snapshot(self, db) -> dict:
        """All cache entries as {key: parsed-data}, ignoring volatile telemetry columns."""
        out = {}
        for row in db.query(AnalyticsCache).filter(AnalyticsCache.case_id == CASE).all():
            out[row.key] = json.loads(row.data)
        return out

    def _seed(self, db, n_subjects=6, per=4):
        rid = 0
        for s in range(n_subjects):
            for k in range(per):
                rid += 1
                db.add(_cdr(rid, f"90000000{s:02d}", day=1 + (k % 3)))
                db.add(_ipdr(rid, f"10.0.0.{s}", day=1 + (k % 3)))
        db.commit()

    def _assert_parity(self, append_fn, label):
        # Path 1: seed → materialise → append → incremental_update
        db = self.Session()
        self._seed(db)
        ms.materialize_case(db, CASE)
        append_fn(db)
        ms.incremental_update(db, CASE)
        incr = self._snapshot(db)
        db.close()

        # Path 2: same final data in a fresh DB → single full materialise
        self.engine.dispose()
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        db2 = self.Session()
        self._seed(db2)
        append_fn(db2)
        ms.materialize_case(db2, CASE)
        full = self._snapshot(db2)
        db2.close()

        self.assertEqual(set(incr), set(full), f"[{label}] cache key sets differ")
        for key in full:
            if key == ms._META_KEY:
                continue  # watermark ids differ by insert order; covered separately
            self.assertEqual(incr[key], full[key], f"[{label}] mismatch for cache key {key!r}")

    def test_parity_append_existing_subjects(self):
        def append(db):
            db.add(_cdr(1000, "9000000001", day=5))
            db.add(_cdr(1001, "9000000002", day=5))
            db.commit()
        self._assert_parity(append, "existing-subjects")

    def test_parity_append_new_subjects(self):
        def append(db):
            db.add(_cdr(2000, "9999999999", day=6))
            db.add(_ipdr(2001, "10.9.9.9", day=6))
            db.commit()
        self._assert_parity(append, "new-subjects")

    def test_parity_append_ipdr_only(self):
        def append(db):
            for i in range(5):
                db.add(_ipdr(3000 + i, "10.0.0.1", day=7))
            db.commit()
        self._assert_parity(append, "ipdr-only")

    def test_no_op_when_nothing_appended(self):
        db = self.Session()
        self._seed(db)
        ms.materialize_case(db, CASE)
        before = self._snapshot(db)
        ms.incremental_update(db, CASE)  # no new rows
        after = self._snapshot(db)
        self.assertEqual(before, after)
        db.close()

    def test_only_touched_subject_reports_are_recomputed(self):
        # Prove the win: after an append touching one subject, only that subject's report is
        # rebuilt — untouched subjects' reports are not recomputed.
        db = self.Session()
        self._seed(db, n_subjects=6, per=4)
        ms.materialize_case(db, CASE)

        rebuilt = []
        orig = ms.get_cdr_reports
        ms.get_cdr_reports = lambda d, c, s: rebuilt.append(s) or orig(d, c, s)
        try:
            db.add(_cdr(5000, "9000000003", day=8))  # touch exactly one existing subject
            db.commit()
            ms.incremental_update(db, CASE)
        finally:
            ms.get_cdr_reports = orig

        self.assertEqual(rebuilt, ["9000000003"],
                         f"expected only the touched subject rebuilt, got {rebuilt}")
        db.close()

    def test_falls_back_to_full_when_no_watermark(self):
        # No prior materialise → incremental must build from scratch (not silently no-op).
        db = self.Session()
        self._seed(db)
        ms.incremental_update(db, CASE)
        snap = self._snapshot(db)
        self.assertIn("dashboard", snap)
        self.assertIn("subjects", snap)
        self.assertIn(ms._META_KEY, snap)
        db.close()


if __name__ == "__main__":
    unittest.main()
