"""Suspect groups: entries carry a group_name, kind is auto-detected (phone/ip/imei), groups list
with counts, group filtering, and dedupe within a group."""
from __future__ import annotations

import types
import unittest

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app
from app.models.watchlist import WatchlistEntry  # noqa: F401
from app.services.auth_service import get_current_user


class WatchlistGroupTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

        def _override_db():
            db = self.Session()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = _override_db
        app.dependency_overrides[get_current_user] = lambda: types.SimpleNamespace(username="t", role="admin")
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()

    def test_add_with_group_and_kind_detection(self):
        r = self.client.post("/watchlist", json={"value": "9876543210", "group_name": "Gang A"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["group_name"], "Gang A")
        self.assertEqual(r.json()["kind"], "phone")
        # 15-digit -> imei
        r2 = self.client.post("/watchlist", json={"value": "356789012345678", "group_name": "Gang A"})
        self.assertEqual(r2.json()["kind"], "imei")
        # explicit kind override (cell-id)
        r3 = self.client.post("/watchlist", json={"value": "404-45-1234-5678", "kind": "cell", "group_name": "Gang A"})
        self.assertEqual(r3.json()["kind"], "cell")

    def test_groups_list_and_filter(self):
        self.client.post("/watchlist", json={"value": "111", "group_name": "Gang A"})
        self.client.post("/watchlist", json={"value": "222", "group_name": "Gang B"})
        self.client.post("/watchlist", json={"value": "333"})  # -> Default
        groups = {g["group_name"]: g["count"] for g in self.client.get("/watchlist/groups").json()}
        self.assertEqual(groups.get("Gang A"), 1)
        self.assertEqual(groups.get("Gang B"), 1)
        self.assertEqual(groups.get("Default"), 1)
        only_a = self.client.get("/watchlist", params={"group": "Gang A"}).json()
        self.assertEqual([e["value"] for e in only_a], ["111"])

    def test_dedupe_within_group(self):
        a = self.client.post("/watchlist", json={"value": "555", "group_name": "G"}).json()
        b = self.client.post("/watchlist", json={"value": "555", "group_name": "G"}).json()
        self.assertEqual(a["id"], b["id"])  # same row returned, no duplicate
        # same value in a different group is allowed
        c = self.client.post("/watchlist", json={"value": "555", "group_name": "H"}).json()
        self.assertNotEqual(a["id"], c["id"])

    def test_values_endpoint(self):
        self.client.post("/watchlist", json={"value": "111", "group_name": "Gang A"})
        vals = self.client.get("/watchlist/values").json()
        self.assertTrue(any(v["value"] == "111" and v["group_name"] == "Gang A" for v in vals))


if __name__ == "__main__":
    unittest.main()
