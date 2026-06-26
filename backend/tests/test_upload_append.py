"""Upload append vs replace: a case with files already uploaded can receive MORE files without
losing the existing records (mode=append), while the default (mode=replace) clears first."""
from __future__ import annotations

import unittest

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app
from app.models.cdr import CDRRecord
from app.models.tower import Tower  # noqa: F401
from app.services.auth_service import get_current_user

_CSV_A = (
    "a_party_number,b_party_number,start_time,end_time,duration_seconds\n"
    "111,222,2026-01-01 10:00:00,2026-01-01 10:05:00,300\n"
)
_CSV_B = (
    "a_party_number,b_party_number,start_time,end_time,duration_seconds\n"
    "333,444,2026-01-02 10:00:00,2026-01-02 10:05:00,300\n"
    "555,666,2026-01-02 11:00:00,2026-01-02 11:05:00,120\n"
)


class UploadAppendTests(unittest.TestCase):
    def setUp(self):
        # StaticPool keeps a single shared connection so every session sees the same in-memory DB.
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

        def _override_db():
            db = self.Session()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = _override_db
        app.dependency_overrides[get_current_user] = lambda: object()
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()

    def _count(self, case_id="1"):
        db = self.Session()
        n = db.query(CDRRecord).filter(CDRRecord.case_id == case_id).count()
        db.close()
        return n

    def _upload(self, csv, mode):
        return self.client.post(
            "/upload/cdr",
            files={"file": ("cdr.csv", csv, "text/csv")},
            data={"case_id": "1", "mode": mode},
        )

    def test_append_keeps_existing(self):
        self.assertEqual(self._upload(_CSV_A, "replace").status_code, 200)
        self.assertEqual(self._count(), 1)
        # append the second file -> existing kept, new added (1 + 2 = 3)
        self.assertEqual(self._upload(_CSV_B, "append").status_code, 200)
        self.assertEqual(self._count(), 3)

    def test_replace_clears_existing(self):
        self._upload(_CSV_A, "replace")
        self._upload(_CSV_B, "append")
        self.assertEqual(self._count(), 3)
        # replace with a single-row file -> back to just that row
        self.assertEqual(self._upload(_CSV_A, "replace").status_code, 200)
        self.assertEqual(self._count(), 1)

    def test_default_mode_is_replace(self):
        self._upload(_CSV_A, "replace")
        self._upload(_CSV_B, "append")
        # no mode field -> defaults to replace (backward compatible)
        r = self.client.post(
            "/upload/cdr",
            files={"file": ("cdr.csv", _CSV_A, "text/csv")},
            data={"case_id": "1"},
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self._count(), 1)


if __name__ == "__main__":
    unittest.main()
