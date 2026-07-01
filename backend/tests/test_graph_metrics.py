"""Phase 4 — Tier-5 gaps. New centralities (PageRank, closeness) on the graph metrics, and the
extra link-prediction indices (Jaccard, resource-allocation) alongside Adamic-Adar. PageRank is
a pure-Python power iteration so the air-gapped build needs no SciPy."""
from __future__ import annotations

import unittest
from datetime import datetime

import networkx as nx
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord  # noqa: F401
from app.models.tower import Tower  # noqa: F401
from app.models.analytics import AnalyticsCache  # noqa: F401  (cached_layout uses it)
from app.services.graph_service import get_graph_metrics, _pagerank_py
from app.services.inference_service import network_structure


class PageRankTests(unittest.TestCase):
    def test_distribution_and_ranking(self):
        g = nx.Graph()
        g.add_edge("a", "b"); g.add_edge("b", "c"); g.add_edge("c", "a"); g.add_edge("c", "d")
        pr = _pagerank_py(g)
        self.assertAlmostEqual(sum(pr.values()), 1.0, places=5)
        self.assertEqual(max(pr, key=pr.get), "c")           # the hub ranks highest
        self.assertLess(pr["d"], pr["a"])                    # pendant ranks below a triangle node

    def test_weighted_and_empty(self):
        g = nx.Graph(); g.add_edge("x", "y", weight=10); g.add_edge("y", "z", weight=1)
        self.assertEqual(max(_pagerank_py(g), key=_pagerank_py(g).get), "y")
        self.assertEqual(_pagerank_py(nx.Graph()), {})


class GraphMetricsTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        db = self.Session()
        # star-ish CDR graph: 900000000 calls four peers, two of whom also call each other
        edges = [("900000000", "900000001"), ("900000000", "900000002"),
                 ("900000000", "900000003"), ("900000000", "900000004"),
                 ("900000001", "900000002")]
        for i, (a, b) in enumerate(edges):
            db.add(CDRRecord(case_id="A", a_party_number=a, b_party_number=b, call_type="Voice",
                             start_time=datetime(2026, 1, 1, 10, i)))
        db.commit()
        self.db = db

    def tearDown(self):
        self.db.close()

    def test_new_centralities_present(self):
        m = get_graph_metrics(self.db, case_id="A")
        for key in ("degree_centrality", "betweenness_centrality", "pagerank", "closeness_centrality"):
            self.assertIn(key, m)
            self.assertTrue(m[key], f"{key} should be non-empty")
        self.assertFalse(m["closeness_skipped"])
        # the hub is the most central by pagerank
        self.assertEqual(max(m["pagerank"], key=m["pagerank"].get), "900000000")

    def test_empty_graph_returns_new_keys(self):
        empty = self.Session()
        m = get_graph_metrics(empty, case_id="NOPE")
        self.assertEqual(m["pagerank"], {})
        self.assertEqual(m["closeness_centrality"], {})
        empty.close()


class LinkPredictionTests(unittest.TestCase):
    def test_predicted_links_carry_three_indices(self):
        # 900..1 and 900..2 don't call each other but share contact 900..0 → a predicted link.
        recs = []
        for i, (a, b) in enumerate([("900000000", "900000001"), ("900000000", "900000002"),
                                    ("900000000", "900000005"), ("900000001", "900000009"),
                                    ("900000002", "900000008")]):
            recs.append(CDRRecord(case_id="A", a_party_number=a, b_party_number=b,
                                  call_type="Voice", start_time=datetime(2026, 1, 1, 10, i)))
        out = network_structure(recs)
        self.assertTrue(out["predicted_links"], "expected at least one predicted link")
        link = out["predicted_links"][0]
        for field in ("subject_a", "subject_b", "score", "jaccard", "resource_allocation", "common_contacts"):
            self.assertIn(field, link)
        self.assertGreaterEqual(link["common_contacts"], 1)


class ServerLayoutTests(unittest.TestCase):
    def test_compute_layout_covers_all_nodes_in_bounds_and_deterministic(self):
        from app.services.graph_service import compute_layout
        ids = [f"n{i}" for i in range(60)]
        edges = [(f"n{i}", f"n{(i + 1) % 60}") for i in range(60)]
        pos = compute_layout(ids, edges, iterations=30)
        self.assertEqual(set(pos), set(ids))
        for x, y in pos.values():
            self.assertTrue(0 <= x <= 1000 and 0 <= y <= 1000)
        # seeded → deterministic
        self.assertEqual(pos, compute_layout(ids, edges, iterations=30))

    def test_cached_layout_reuses_then_recomputes_on_new_nodes(self):
        from app.services.graph_service import cached_layout
        db = self.Session()
        ids = ["a", "b", "c"]
        edges = [("a", "b"), ("b", "c")]
        p1 = cached_layout(db, "CASE", None, 300, ids, edges)
        self.assertEqual(set(p1), set(ids))
        # same node set → served from cache (identical)
        p2 = cached_layout(db, "CASE", None, 300, ids, edges)
        self.assertEqual(p1, p2)
        # a new node not covered by the cache → recomputed to include it
        p3 = cached_layout(db, "CASE", None, 300, ids + ["d"], edges + [("c", "d")])
        self.assertIn("d", p3)
        db.close()

    def setUp(self):
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from app.core.database import Base
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)


if __name__ == "__main__":
    unittest.main()
