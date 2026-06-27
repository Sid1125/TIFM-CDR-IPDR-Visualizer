"""Offline telecom reference lookups: ISD country detection, domestic series -> operator/circle,
IMEI TAC -> make/model, and the meta endpoint the client caches."""
from __future__ import annotations

import types
import unittest

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app
from app.services import reference_service as ref
from app.services.auth_service import get_current_user


class ReferenceServiceTests(unittest.TestCase):
    def test_isd_longest_prefix(self):
        self.assertEqual(ref.lookup_isd("+12421234567")["country"], "Bahamas")  # 1242 beats 1
        self.assertEqual(ref.lookup_isd("0097150123")["country"], "United Arab Emirates")
        self.assertEqual(ref.lookup_isd("+14155550123")["country"], "United States / Canada")

    def test_domestic_number_not_isd(self):
        out = ref.lookup_number("9810012345")
        self.assertFalse(out["is_isd"])
        self.assertEqual(out["national"], "9810012345")
        # seed maps 9810 -> Delhi
        self.assertEqual(out["circle"], "Delhi")

    def test_country_code_91_stripped(self):
        out = ref.lookup_number("+919820011223")
        self.assertFalse(out["is_isd"])
        self.assertEqual(out["national"], "9820011223")

    def test_international_number(self):
        out = ref.lookup_number("+9715012345678")
        self.assertTrue(out["is_isd"])
        self.assertEqual(out["country"], "United Arab Emirates")

    def test_unknown_series_graceful(self):
        out = ref.lookup_number("9809000000")  # 9809 is unallocated in the numbering plan
        self.assertIsNone(out["circle"])  # not in table -> Unknown, no crash

    def test_imei_tac(self):
        out = ref.lookup_imei("35508675123456")  # verified iPhone 14 Pro Max TAC
        self.assertEqual(out["tac"], "35508675")
        self.assertEqual(out["make"], "Apple")
        out2 = ref.lookup_imei("99999999000000")
        self.assertIsNone(out2["make"])


class ReferenceApiTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        app.dependency_overrides[get_db] = lambda: (s for s in [self.Session()])
        app.dependency_overrides[get_current_user] = lambda: types.SimpleNamespace(username="t", role="admin")
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()

    def test_meta_endpoint(self):
        r = self.client.get("/reference/meta")
        self.assertEqual(r.status_code, 200)
        self.assertIn("isd", r.json())
        self.assertGreater(r.json()["counts"]["isd"], 100)

    def test_number_endpoint(self):
        r = self.client.get("/reference/number/+9715012345678")
        self.assertTrue(r.json()["is_isd"])


if __name__ == "__main__":
    unittest.main()
