"""Cross-case subject/suspect linking: a subject (or its handset/SIM) appearing in OTHER cases.

Match rule: phone number + device identifiers (IMEI/IMSI) are high-confidence; IP matches are
low-confidence (dynamic reassignment). CDR/IPDR identity kinds never cross.
"""
from __future__ import annotations

import unittest
from datetime import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.case import Case
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower  # noqa: F401
from app.services.cross_case_service import case_cross_case_overview
from app.services.cross_case_service import subject_cross_case


class CrossCaseTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        db = self.Session()
        db.add_all([
            Case(id=1, name="Case Alpha"),
            Case(id=2, name="Case Bravo"),
            Case(id=3, name="Case Charlie"),
        ])
        t = lambda h: datetime(2026, 1, 1, h, 0)  # noqa: E731
        rows = [
            # --- Case 1 (the case we open) ---
            # P1 uses number A on handset IMEI-X / SIM IMSI-X
            CDRRecord(case_id="1", a_party_number="A", msisdn="A", imei="IMEI-X", imsi="IMSI-X",
                      call_type="Voice", start_time=t(9)),
            # P2 uses number B, isolated — appears in NO other case
            CDRRecord(case_id="1", a_party_number="B", msisdn="B", imei="IMEI-B", imsi="IMSI-B",
                      call_type="Voice", start_time=t(10)),
            # an IP subject in case 1
            IPDRRecord(case_id="1", source_ip="10.0.0.5", msisdn="A", start_time=t(9)),

            # --- Case 2: number A reappears directly ---
            CDRRecord(case_id="2", a_party_number="A", msisdn="A", imei="IMEI-X", imsi="IMSI-X",
                      call_type="Voice", start_time=t(11)),
            CDRRecord(case_id="2", a_party_number="A", msisdn="A", imei="IMEI-X", imsi="IMSI-X",
                      call_type="SMS", start_time=t(12)),

            # --- Case 3: SIM swap — DIFFERENT number C but SAME handset IMEI-X ---
            CDRRecord(case_id="3", a_party_number="C", msisdn="C", imei="IMEI-X", imsi="IMSI-C",
                      call_type="Voice", start_time=t(13)),
            # and the shared IP reappears in case 3 (dynamic IP -> low confidence)
            IPDRRecord(case_id="3", source_ip="10.0.0.5", start_time=t(14)),
        ]
        db.add_all(rows)
        db.commit()
        db.close()

    def _db(self):
        return self.Session()

    def test_phone_number_and_device_links(self):
        db = self._db()
        r = subject_cross_case(db, case_id="1", subject="A")
        self.assertEqual(r["kind"], "phone")
        by_case = {m["case_id"]: m for m in r["matches"]}
        # Case 2: same number -> number match, high, 2 records
        self.assertIn("2", by_case)
        self.assertIn("number", by_case["2"]["match_types"])
        self.assertEqual(by_case["2"]["confidence"], "high")
        self.assertEqual(by_case["2"]["record_count"], 2)
        # Case 3: SIM swap — linked by handset only (number C differs)
        self.assertIn("3", by_case)
        self.assertIn("imei", by_case["3"]["match_types"])
        self.assertNotIn("number", by_case["3"]["match_types"])
        self.assertEqual(by_case["3"]["confidence"], "high")
        db.close()

    def test_isolated_subject_has_no_links(self):
        db = self._db()
        r = subject_cross_case(db, case_id="1", subject="B")
        self.assertEqual(r["matches"], [])
        db.close()

    def test_ip_match_is_low_confidence(self):
        db = self._db()
        r = subject_cross_case(db, case_id="1", subject="10.0.0.5")
        self.assertEqual(r["kind"], "ip")
        self.assertTrue(r["matches"])
        m = r["matches"][0]
        self.assertEqual(m["case_id"], "3")
        self.assertEqual(m["match_type"], "ip")
        self.assertEqual(m["confidence"], "low")
        db.close()

    def test_cdr_ipdr_separation(self):
        db = self._db()
        # phone subject A must never return an ip-typed match...
        phone = subject_cross_case(db, case_id="1", subject="A")
        self.assertTrue(all(m["match_type"] != "ip" for m in phone["matches"]))
        # ...and the IP subject must never return a phone/number/device match
        ip = subject_cross_case(db, case_id="1", subject="10.0.0.5")
        self.assertTrue(all(m["match_type"] == "ip" for m in ip["matches"]))
        db.close()

    def test_overview_lists_only_recurring_subjects(self):
        db = self._db()
        ov = case_cross_case_overview(db, case_id="1")
        hits = {h["subject"]: h for h in ov["hits"]}
        # A recurs (cases 2 & 3 via number/handset); 10.0.0.5 recurs (case 3); B does not
        self.assertIn("A", hits)
        self.assertNotIn("B", hits)
        self.assertEqual(hits["A"]["kind"], "phone")
        self.assertEqual(hits["A"]["other_case_count"], 2)
        self.assertIn("10.0.0.5", hits)
        self.assertEqual(hits["10.0.0.5"]["confidence"], "low")
        db.close()

    def test_case_name_resolved(self):
        db = self._db()
        r = subject_cross_case(db, case_id="1", subject="A")
        names = {m["case_name"] for m in r["matches"]}
        self.assertIn("Case Bravo", names)
        self.assertIn("Case Charlie", names)
        db.close()


if __name__ == "__main__":
    unittest.main()
