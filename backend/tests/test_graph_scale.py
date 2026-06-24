"""Scalability of the call graph (Phase 2): build_graph must bound the displayed edges to the
top-N heaviest, keep node weights exact over ALL edges, focus on a subject, and report honest
totals; betweenness in get_graph_metrics must fall back to sampling on large graphs."""
from __future__ import annotations

import unittest
from datetime import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord  # noqa: F401 (registers table)
from app.models.tower import Tower  # noqa: F401
from app.services.graph_service import build_graph, get_graph_metrics


class GraphScaleTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        db = self.Session()
        # hub "900" calls 901..905; 901 also calls 902 a few times (so 901 has weight beyond hub)
        rows = []
        for j in range(1, 6):
            for _ in range(j):  # edge weights 1..5 to the hub
                rows.append(CDRRecord(case_id="A", a_party_number="900",
                                      b_party_number=f"90{j}", start_time=datetime(2026, 1, 1, 10, j)))
        for _ in range(3):
            rows.append(CDRRecord(case_id="A", a_party_number="901",
                                  b_party_number="902", start_time=datetime(2026, 1, 1, 11, 0)))
        rows.append(CDRRecord(case_id="B", a_party_number="700", b_party_number="701",
                              start_time=datetime(2026, 1, 1, 9, 0)))
        db.add_all(rows)
        db.commit()
        db.close()

    def _db(self):
        return self.Session()

    def test_limit_bounds_edges_but_totals_honest(self):
        db = self._db()
        g = build_graph(db, case_id="A", limit=2)
        self.assertEqual(g["shown_edges"], 2)
        self.assertEqual(len(g["edges"]), 2)
        self.assertEqual(g["total_edges"], 6)            # 5 hub edges + 901-902
        # heaviest first: 900-905 (w5) and 900-904 (w4)
        weights = sorted((e["weight"] for e in g["edges"]), reverse=True)
        self.assertEqual(weights, [5, 4])
        db.close()

    def test_node_weight_is_full_coverage(self):
        db = self._db()
        g = build_graph(db, case_id="A", limit=2)
        nodes = {n["id"]: n["weight"] for n in g["nodes"]}
        # 901 only appears via the trimmed-away edges, but if shown its weight must be its TRUE
        # total. Easier check: the hub 900's weight equals sum of all its edge weights (1+2+3+4+5)
        gfull = build_graph(db, case_id="A", limit=0)
        wfull = {n["id"]: n["weight"] for n in gfull["nodes"]}
        self.assertEqual(wfull["900"], 15)
        # in the trimmed view, 900 still reports 15 (full), not just the shown edges' 9
        self.assertEqual(nodes.get("900"), 15)
        db.close()

    def test_subject_focus_and_case_scope(self):
        db = self._db()
        g = build_graph(db, case_id="A", subject="901")
        self.assertTrue(all("901" in (e["source"], e["target"]) for e in g["edges"]))
        # case B must not leak
        self.assertEqual(build_graph(db, case_id="A", subject="700")["edges"], [])
        db.close()

    def test_metrics_full_and_sampling_flag(self):
        db = self._db()
        m = get_graph_metrics(db, case_id="A")
        self.assertIn("betweenness_centrality", m)
        self.assertFalse(m["betweenness_sampled"])       # small graph → exact
        self.assertGreater(len(m["degree_centrality"]), 0)
        db.close()


if __name__ == "__main__":
    unittest.main()
