"""Regression tests: the stats / graph / investigation / tower services must scope to a
case when given one, and never leak records from other cases. (QA report finding #1.)"""
from __future__ import annotations

import unittest
from datetime import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord  # noqa: F401  (registers the table)
from app.models.tower import Tower  # noqa: F401
from app.services.graph_service import build_graph
from app.services.stats_service import get_cdr_stats, get_top_contacts
from app.services.tower_service import find_colocation_candidates, list_tower_activity


class CaseIsolationTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        db = self.Session()
        db.add_all([
            Tower(tower_id="T1", latitude=13.0, longitude=80.0, city="Chennai", state="TN"),
            Tower(tower_id="T2", latitude=28.0, longitude=77.0, city="Delhi", state="DL"),
            CDRRecord(case_id="A", a_party_number="900", b_party_number="901", tower_id="T1",
                      start_time=datetime(2026, 1, 1, 10, 0), duration_seconds=60),
            CDRRecord(case_id="A", a_party_number="900", b_party_number="901", tower_id="T1",
                      start_time=datetime(2026, 1, 1, 10, 5), duration_seconds=60),
            CDRRecord(case_id="B", a_party_number="800", b_party_number="801", tower_id="T2",
                      start_time=datetime(2026, 1, 1, 11, 0), duration_seconds=60),
        ])
        db.commit()
        db.close()

    def _db(self):
        return self.Session()

    def test_cdr_stats_scoped(self):
        db = self._db()
        self.assertEqual(get_cdr_stats(db, case_id="A")["total_records"], 2)
        self.assertEqual(get_cdr_stats(db, case_id="B")["total_records"], 1)
        self.assertEqual(get_cdr_stats(db)["total_records"], 3)  # unscoped = all cases
        db.close()

    def test_top_contacts_scoped(self):
        db = self._db()
        contacts = {c["contact"] for c in get_top_contacts(db, case_id="A")}
        self.assertIn("900", contacts)
        self.assertNotIn("800", contacts)  # other case must not leak
        db.close()

    def test_graph_scoped(self):
        db = self._db()
        nodes = {nd["id"] for nd in build_graph(db, case_id="A")["nodes"]}
        self.assertEqual(nodes, {"900", "901"})
        db.close()

    def test_colocation_and_tower_activity_scoped(self):
        db = self._db()
        coloc = find_colocation_candidates(db, case_id="A")
        self.assertEqual({c["tower_id"] for c in coloc}, {"T1"})  # not T2 (case B)
        acts = {t["tower_id"]: t["cdr_events"] for t in list_tower_activity(db, case_id="A")}
        self.assertEqual(acts.get("T1"), 2)
        self.assertEqual(acts.get("T2"), 0)  # case B activity excluded
        db.close()


if __name__ == "__main__":
    unittest.main()
