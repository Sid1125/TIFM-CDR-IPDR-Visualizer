"""Server-side records pagination (Phase 1 of the scalability plan): page_records must page
a time-ordered, case-scoped union of CDR + IPDR with correct totals, search and CDR/IPDR
separation, and distinct_services must list a case's services."""
from __future__ import annotations

import unittest
from datetime import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower  # noqa: F401  (registers the table)
from app.services.records_service import page_records, distinct_services


class RecordsPaginationTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        db = self.Session()
        # case A: 6 CDR + 4 IPDR with interleaved timestamps; case B: noise that must not leak
        for i in range(6):
            db.add(CDRRecord(case_id="A", a_party_number=f"9{i:03d}", b_party_number="555",
                             call_type="Voice", tower_id="T1",
                             start_time=datetime(2026, 1, 1, 10, i)))
        for i in range(4):
            db.add(IPDRRecord(case_id="A", source_ip=f"10.0.0.{i}", destination_ip="8.8.8.8",
                              protocol="TCP", tower_id="T1",
                              start_time=datetime(2026, 1, 1, 10, 30 + i)))
        db.add(CDRRecord(case_id="B", a_party_number="700", b_party_number="701",
                         call_type="SMS", start_time=datetime(2026, 1, 1, 9, 0)))
        db.commit()
        db.close()

    def _db(self):
        return self.Session()

    def test_total_and_case_scope(self):
        db = self._db()
        res = page_records(db, case_id="A", rtype="all", limit=100, offset=0)
        self.assertEqual(res["total"], 10)                 # 6 CDR + 4 IPDR, case B excluded
        self.assertEqual(len(res["rows"]), 10)
        self.assertEqual(page_records(db, case_id="B", rtype="all")["total"], 1)
        db.close()

    def test_time_ordered_desc_and_pagination(self):
        db = self._db()
        p1 = page_records(db, case_id="A", rtype="all", limit=4, offset=0)
        p2 = page_records(db, case_id="A", rtype="all", limit=4, offset=4)
        self.assertEqual(len(p1["rows"]), 4)
        self.assertEqual(len(p2["rows"]), 4)
        # newest first: the 4 IPDR (10:30-10:33) lead, so page 1 is all IPDR
        self.assertEqual(p1["order"], ["IPDR", "IPDR", "IPDR", "IPDR"])
        # no overlap between pages (distinct rows)
        ids1 = {(o, r.id) for o, r in zip(p1["order"], p1["rows"])}
        ids2 = {(o, r.id) for o, r in zip(p2["order"], p2["rows"])}
        self.assertFalse(ids1 & ids2)

    def test_type_filter_keeps_separation(self):
        db = self._db()
        self.assertEqual(page_records(db, case_id="A", rtype="CDR")["total"], 6)
        self.assertEqual(page_records(db, case_id="A", rtype="IPDR")["total"], 4)
        cdr_only = page_records(db, case_id="A", rtype="CDR", limit=100)
        self.assertTrue(all(o == "CDR" for o in cdr_only["order"]))
        db.close()

    def test_search(self):
        db = self._db()
        # search a specific CDR a-party
        r = page_records(db, case_id="A", rtype="all", search="9003")
        self.assertEqual(r["total"], 1)
        self.assertEqual(r["order"], ["CDR"])
        # search an IPDR destination
        r2 = page_records(db, case_id="A", rtype="all", search="8.8.8.8")
        self.assertEqual(r2["total"], 4)
        db.close()

    def test_service_filter_and_distinct(self):
        db = self._db()
        self.assertEqual(page_records(db, case_id="A", rtype="all", service="TCP")["total"], 4)
        self.assertEqual(page_records(db, case_id="A", rtype="all", service="Voice")["total"], 6)
        self.assertEqual(distinct_services(db, case_id="A"), ["TCP", "Voice"])
        db.close()


if __name__ == "__main__":
    unittest.main()
