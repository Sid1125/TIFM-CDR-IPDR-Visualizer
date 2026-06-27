"""SDR / subscriber import: global-by-MSISDN upsert (latest wins), aliased headers map, and
lookup/search return the identity."""
from __future__ import annotations

import types
import unittest

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app
from app.models.subscriber import Subscriber  # noqa: F401
from app.services.auth_service import get_current_user

_CSV = (
    "Mobile Number,Subscriber Name,Address,Alternate Number,Operator\n"
    "9810012345,Ramesh Kumar,12 MG Road Delhi,9811099887,Airtel\n"
    "9820011223,Sita Devi,5 Linking Road Mumbai,,Vodafone Idea\n"
)


class SubscriberTests(unittest.TestCase):
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

    def test_import_and_lookup(self):
        r = self.client.post("/upload/sdr", files={"file": ("sdr.csv", _CSV, "text/csv")},
                             data={"case_id": "1"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["records_imported"], 2)

        s = self.client.get("/subscribers/9810012345").json()
        self.assertTrue(s["found"])
        self.assertEqual(s["name"], "Ramesh Kumar")
        self.assertEqual(s["alt_number"], "9811099887")
        self.assertEqual(s["operator"], "Airtel")

        miss = self.client.get("/subscribers/0000000000").json()
        self.assertFalse(miss["found"])

    def test_global_upsert_latest_wins(self):
        self.client.post("/upload/sdr", files={"file": ("sdr.csv", _CSV, "text/csv")}, data={"case_id": "1"})
        # Re-import same MSISDN in another case with a new name -> updates, no duplicate row.
        csv2 = "Mobile Number,Subscriber Name\n9810012345,Ramesh K (updated)\n"
        self.client.post("/upload/sdr", files={"file": ("sdr2.csv", csv2, "text/csv")}, data={"case_id": "2"})
        db = self.Session()
        try:
            self.assertEqual(db.query(Subscriber).filter(Subscriber.msisdn == "9810012345").count(), 1)
        finally:
            db.close()
        s = self.client.get("/subscribers/9810012345").json()
        self.assertEqual(s["name"], "Ramesh K (updated)")
        # address preserved from first import (not blanked by the partial second file)
        self.assertEqual(s["address"], "12 MG Road Delhi")

    def test_search(self):
        self.client.post("/upload/sdr", files={"file": ("sdr.csv", _CSV, "text/csv")}, data={"case_id": "1"})
        res = self.client.get("/subscribers/", params={"q": "Sita"}).json()
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["msisdn"], "9820011223")

    def test_missing_msisdn_column_422(self):
        bad = "Name,Address\nFoo,Bar\n"
        r = self.client.post("/upload/sdr", files={"file": ("x.csv", bad, "text/csv")}, data={"case_id": "1"})
        self.assertEqual(r.status_code, 422)


if __name__ == "__main__":
    unittest.main()
