"""Subject intel tags: global-by-identifier upsert, blank clears, GET returns the map, auth gated,
and every edit lands on the audit trail."""
from __future__ import annotations

import types
import unittest

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app
from app.models.subject_tag import SubjectTag  # noqa: F401
from app.services.audit_service import list_audit
from app.services.auth_service import get_current_user


def _user(username="alice", role="investigator"):
    return types.SimpleNamespace(username=username, role=role, id=1, is_active=True)


class SubjectTagTests(unittest.TestCase):
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

    def test_upsert_creates_and_updates(self):
        r = self.client.put("/subject-tags/", json={"subject": "9876543210", "tag": "financier"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["tag"], "financier")

        # GET returns the map
        rows = self.client.get("/subject-tags/").json()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["subject"], "9876543210")
        self.assertEqual(rows[0]["tag"], "financier")
        self.assertEqual(rows[0]["updated_by"], "alice")

        # update replaces in place (no duplicate row)
        self.client.put("/subject-tags/", json={"subject": "9876543210", "tag": "kingpin"})
        rows = self.client.get("/subject-tags/").json()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["tag"], "kingpin")

    def test_blank_tag_deletes(self):
        self.client.put("/subject-tags/", json={"subject": "111", "tag": "suspect"})
        self.assertEqual(len(self.client.get("/subject-tags/").json()), 1)
        r = self.client.put("/subject-tags/", json={"subject": "111", "tag": "   "})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(self.client.get("/subject-tags/").json()), 0)

    def test_edit_is_audited(self):
        self.client.put("/subject-tags/", json={"subject": "5.5.5.5", "tag": "tor exit"})
        db = self.Session()
        try:
            rows = list_audit(db, action="tag_subject")
        finally:
            db.close()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["target"], "5.5.5.5")
        self.assertEqual(rows[0]["detail"]["tag"], "tor exit")

    def test_subject_trimmed_and_required(self):
        r = self.client.put("/subject-tags/", json={"subject": "  ", "tag": "x"})
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["success"])
        self.assertEqual(len(self.client.get("/subject-tags/").json()), 0)


if __name__ == "__main__":
    unittest.main()
