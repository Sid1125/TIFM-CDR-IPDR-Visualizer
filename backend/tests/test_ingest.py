"""Flexible ingest: operator-aware column mapping resolves aliased headers onto canonical fields,
mixed date formats are parsed, undated rows are dropped, and the upload returns a validation
report."""
from __future__ import annotations

import unittest

import pandas as pd
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app
from app.models.cdr import CDRRecord
from app.models.tower import Tower  # noqa: F401
from app.services.auth_service import get_current_user
from app.services.ingest_service import coerce_frame, resolve_columns


class ResolveColumnsTests(unittest.TestCase):
    def test_maps_aliased_headers(self):
        cols = ["Caller", "Called", "Call Date", "End Time", "Duration"]
        r = resolve_columns(cols, "cdr")
        self.assertEqual(r["mapping"]["a_party_number"], "Caller")
        self.assertEqual(r["mapping"]["b_party_number"], "Called")
        self.assertEqual(r["mapping"]["start_time"], "Call Date")
        self.assertEqual(r["mapping"]["end_time"], "End Time")
        self.assertEqual(r["mapping"]["duration_seconds"], "Duration")
        self.assertEqual(r["unmapped_required"], [])

    def test_reports_unmapped_required(self):
        cols = ["Caller", "Call Date", "End Time", "Duration"]  # no called party
        r = resolve_columns(cols, "cdr")
        self.assertIn("b_party_number", r["unmapped_required"])

    def test_override_wins(self):
        cols = ["x", "y", "start_time", "end_time", "duration_seconds"]
        r = resolve_columns(cols, "cdr", override={"a_party_number": "x", "b_party_number": "y"})
        self.assertEqual(r["mapping"]["a_party_number"], "x")
        self.assertEqual(r["mapping"]["b_party_number"], "y")
        self.assertEqual(r["unmapped_required"], [])

    def test_ipdr_separate_schema(self):
        cols = ["src_ip", "dst_ip", "session_start", "session_end"]
        r = resolve_columns(cols, "ipdr")
        self.assertEqual(r["mapping"]["source_ip"], "src_ip")
        self.assertEqual(r["mapping"]["destination_ip"], "dst_ip")
        self.assertEqual(r["unmapped_required"], [])


class CoerceFrameTests(unittest.TestCase):
    def test_mixed_date_formats_and_drop(self):
        df = pd.DataFrame({
            "Caller": ["1", "2", "3"],
            "Called": ["9", "8", "7"],
            "Call Date": ["2026-01-01 10:00:00", "02/01/2026 11:00:00", "not a date"],
            "End Time": ["2026-01-01 10:05:00", "02/01/2026 11:05:00", "2026-01-03 09:00:00"],
            "Duration": [300, 300, 120],
        })
        mapping = resolve_columns(df.columns, "cdr")["mapping"]
        out, report = coerce_frame(df, "cdr", mapping)
        # third row has an unparseable start_time -> dropped
        self.assertEqual(report["rows_total"], 3)
        self.assertEqual(report["rows_imported"], 2)
        self.assertEqual(report["rows_dropped"], 1)
        self.assertGreaterEqual(report["date_failures"], 1)
        self.assertEqual(len(out), 2)
        # both date formats parsed to real timestamps
        self.assertTrue(out["start_time"].notna().all())


_ALIASED_CSV = (
    "Caller,Called,Call Date,End Time,Duration\n"
    "111,222,2026-01-01 10:00:00,2026-01-01 10:05:00,300\n"
    "333,444,02/01/2026 11:00:00,02/01/2026 11:05:00,120\n"
    "555,666,bad,2026-01-03 09:00:00,90\n"
)


class UploadFlexibleTests(unittest.TestCase):
    def setUp(self):
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
        import types
        app.dependency_overrides[get_current_user] = lambda: types.SimpleNamespace(username="t", role="admin")
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()

    def test_aliased_upload_imports_with_report(self):
        r = self.client.post(
            "/upload/cdr",
            files={"file": ("cdr.csv", _ALIASED_CSV, "text/csv")},
            data={"case_id": "1", "mode": "replace"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["records_imported"], 2)  # bad-date row dropped
        v = body["validation"]
        self.assertEqual(v["rows_total"], 3)
        self.assertEqual(v["rows_dropped"], 1)
        self.assertEqual(v["mapping"]["a_party_number"], "Caller")
        db = self.Session()
        try:
            self.assertEqual(db.query(CDRRecord).filter(CDRRecord.case_id == "1").count(), 2)
        finally:
            db.close()

    def test_missing_required_returns_422(self):
        bad = "Caller,Call Date,End Time,Duration\n111,2026-01-01 10:00:00,2026-01-01 10:05:00,300\n"
        r = self.client.post(
            "/upload/cdr",
            files={"file": ("cdr.csv", bad, "text/csv")},
            data={"case_id": "1"},
        )
        self.assertEqual(r.status_code, 422)
        self.assertIn("b_party_number", r.text)

    def test_preview_endpoint(self):
        r = self.client.post(
            "/upload/preview",
            files={"file": ("cdr.csv", _ALIASED_CSV, "text/csv")},
            data={"kind": "cdr"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["mapping"]["b_party_number"], "Called")
        self.assertEqual(body["unmapped_required"], [])


if __name__ == "__main__":
    unittest.main()
