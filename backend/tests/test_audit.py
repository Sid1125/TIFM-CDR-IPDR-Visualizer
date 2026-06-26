"""Audit trail / chain-of-custody: actions write append-only AuditLog rows, the viewer is
admin-gated and filterable, and the view-beacon records reads."""
from __future__ import annotations

import types
import unittest

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app
from app.models.audit_log import AuditLog
from app.models.tower import Tower  # noqa: F401
from app.services.audit_service import list_audit, log_action
from app.services.auth_service import get_current_user

_CSV = (
    "a_party_number,b_party_number,start_time,end_time,duration_seconds\n"
    "111,222,2026-01-01 10:00:00,2026-01-01 10:05:00,300\n"
)


def _user(username="alice", role="investigator"):
    return types.SimpleNamespace(username=username, role=role, id=1, is_active=True)


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.current = _user()

        def _override_db():
            db = self.Session()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = _override_db
        app.dependency_overrides[get_current_user] = lambda: self.current
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()

    def _rows(self, **filters):
        db = self.Session()
        try:
            return list_audit(db, **filters)
        finally:
            db.close()

    def test_log_action_writes_row(self):
        db = self.Session()
        try:
            log_action(db, _user("bob", "admin"), None, "test_action",
                       case_id="7", case_name="Op X", target="123", detail={"k": "v"})
        finally:
            db.close()
        rows = self._rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["username"], "bob")
        self.assertEqual(rows[0]["role"], "admin")
        self.assertEqual(rows[0]["action"], "test_action")
        self.assertEqual(rows[0]["case_id"], "7")
        self.assertEqual(rows[0]["detail"], {"k": "v"})

    def test_upload_produces_audit_row(self):
        r = self.client.post(
            "/upload/cdr",
            files={"file": ("cdr.csv", _CSV, "text/csv")},
            data={"case_id": "1", "mode": "replace"},
        )
        self.assertEqual(r.status_code, 200)
        rows = self._rows(action="upload")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["username"], "alice")
        self.assertEqual(rows[0]["detail"]["kind"], "cdr")
        self.assertEqual(rows[0]["detail"]["rows_imported"], 1)

    def test_view_beacon_records_read(self):
        r = self.client.post("/audit/view", json={
            "action": "view_subject", "case_id": "1", "case_name": "Op X", "target": "999",
        })
        self.assertEqual(r.status_code, 200)
        rows = self._rows(action="view_subject")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["target"], "999")

    def test_log_viewer_admin_only(self):
        # investigator -> 403
        self.current = _user("alice", "investigator")
        self.assertEqual(self.client.get("/audit/log").status_code, 403)
        # admin -> 200
        self.current = _user("admin", "admin")
        self.assertEqual(self.client.get("/audit/log").status_code, 200)

    def test_log_viewer_filters(self):
        db = self.Session()
        try:
            log_action(db, _user("a", "admin"), None, "upload", case_id="1")
            log_action(db, _user("b", "admin"), None, "export", case_id="2")
        finally:
            db.close()
        self.current = _user("admin", "admin")
        r = self.client.get("/audit/log", params={"action": "export"})
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["action"], "export")


if __name__ == "__main__":
    unittest.main()
