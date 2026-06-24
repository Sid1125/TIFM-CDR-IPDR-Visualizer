"""Server-side meeting (co-location) detection (Phase 2): exact, full-coverage, case-scoped,
subject-filterable, CDR-only — replacing the client-side O(n^2) detectMeetings."""
from __future__ import annotations

import unittest
from datetime import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower  # noqa: F401
from app.services.investigation_service import find_meetings


class MeetingsTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        db = self.Session()
        d = datetime(2026, 1, 1, 10, 0)
        rows = [
            # A & B at tower T1, 2 min apart -> a meeting (High)
            CDRRecord(case_id="X", a_party_number="A", tower_id="T1", latitude=1.0, longitude=2.0,
                      start_time=datetime(2026, 1, 1, 10, 0)),
            CDRRecord(case_id="X", a_party_number="B", tower_id="T1", latitude=1.0, longitude=2.0,
                      start_time=datetime(2026, 1, 1, 10, 2)),
            # C at T1 but 3 hours later -> NOT within window
            CDRRecord(case_id="X", a_party_number="C", tower_id="T1", latitude=1.0, longitude=2.0,
                      start_time=datetime(2026, 1, 1, 13, 0)),
            # A & D at different towers same time -> NOT a meeting
            CDRRecord(case_id="X", a_party_number="D", tower_id="T2", latitude=5.0, longitude=6.0,
                      start_time=datetime(2026, 1, 1, 10, 1)),
            # other case must not leak
            CDRRecord(case_id="Y", a_party_number="E", tower_id="T1", latitude=1.0, longitude=2.0,
                      start_time=datetime(2026, 1, 1, 10, 1)),
            # IPDR co-location must be ignored (CDR-only)
            IPDRRecord(case_id="X", source_ip="10.0.0.1", tower_id="T1", latitude=1.0, longitude=2.0,
                       start_time=datetime(2026, 1, 1, 10, 1)),
        ]
        db.add_all(rows)
        db.commit()
        db.close()

    def _db(self):
        return self.Session()

    def test_detects_only_same_tower_within_window(self):
        db = self._db()
        r = find_meetings(db, case_id="X")
        self.assertEqual(r["total"], 1)                  # only A&B
        self.assertEqual(r["distinct_pairs"], 1)
        m = r["meetings"][0]
        self.assertEqual(tuple(sorted((m["subject_a"], m["subject_b"]))), ("A", "B"))
        self.assertEqual(m["confidence"], "High")        # 2 min gap
        self.assertEqual(m["tower_id"], "T1")
        self.assertIsNotNone(m["latitude"])
        db.close()

    def test_case_scope_and_ipdr_excluded(self):
        db = self._db()
        # case Y has its own lone record -> no meetings; case X unaffected by Y/IPDR
        self.assertEqual(find_meetings(db, case_id="Y")["total"], 0)
        # the IPDR row at T1 must not pair with CDR -> still only 1 meeting in X
        self.assertEqual(find_meetings(db, case_id="X")["total"], 1)
        db.close()

    def test_subject_filter(self):
        db = self._db()
        self.assertEqual(find_meetings(db, case_id="X", subject="A")["total"], 1)
        self.assertEqual(find_meetings(db, case_id="X", subject="C")["total"], 0)
        db.close()

    def test_window_param(self):
        db = self._db()
        # widen to 4 hours: now C (13:00) co-locates with A and B at T1
        r = find_meetings(db, case_id="X", window_min=240)
        self.assertGreater(r["total"], 1)
        db.close()


if __name__ == "__main__":
    unittest.main()
