"""Phase 5 — tamper-evident audit log. Each row hashes the previous one, so the chain verifies
intact for an untouched log and breaks (pointing at the first bad row) if any row is altered,
removed, or inserted out of band."""
from __future__ import annotations

import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.audit_log import AuditLog
from app.services.audit_service import log_action, verify_audit_chain


class AuditChainTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

    def _seed(self, db, n=5):
        for i in range(n):
            log_action(db, username=f"user{i}", role="investigator", action="view_case",
                       case_id=f"C{i}", target=f"sub{i}")

    def test_intact_chain_verifies(self):
        db = self.Session()
        self._seed(db)
        res = verify_audit_chain(db)
        self.assertTrue(res["ok"])
        self.assertEqual(res["count"], 5)
        # genesis row chains from ""
        first = db.query(AuditLog).order_by(AuditLog.id.asc()).first()
        self.assertEqual(first.prev_hash, "")
        self.assertTrue(first.entry_hash)
        db.close()

    def test_altered_content_is_detected(self):
        db = self.Session()
        self._seed(db)
        victim = db.query(AuditLog).order_by(AuditLog.id.asc()).offset(2).first()
        victim.target = "TAMPERED"          # change content without fixing the hash
        db.commit()
        res = verify_audit_chain(db)
        self.assertFalse(res["ok"])
        self.assertEqual(res["broken_at"], victim.id)
        self.assertIn("altered", res["reason"])
        db.close()

    def test_deleted_row_is_detected(self):
        db = self.Session()
        self._seed(db)
        rows = db.query(AuditLog).order_by(AuditLog.id.asc()).all()
        db.delete(rows[2])                  # remove a middle row → next row's prev_hash dangles
        db.commit()
        res = verify_audit_chain(db)
        self.assertFalse(res["ok"])
        self.assertEqual(res["broken_at"], rows[3].id)
        self.assertIn("inserted or removed", res["reason"])
        db.close()

    def test_each_row_links_to_previous(self):
        db = self.Session()
        self._seed(db, 4)
        rows = db.query(AuditLog).order_by(AuditLog.id.asc()).all()
        for prev, cur in zip(rows, rows[1:]):
            self.assertEqual(cur.prev_hash, prev.entry_hash)
        db.close()

    def test_empty_log_is_trivially_ok(self):
        db = self.Session()
        self.assertEqual(verify_audit_chain(db), {"ok": True, "count": 0})
        db.close()


if __name__ == "__main__":
    unittest.main()
