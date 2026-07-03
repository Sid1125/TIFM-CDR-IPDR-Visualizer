"""Evidence board + review lifecycle: pin (upsert by case+sig, never clobbering a review),
confirm/reject with reviewer identity recorded, notes, case scoping, delete."""
from __future__ import annotations

import unittest
from datetime import datetime
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.evidence_item import EvidenceItem  # noqa: F401
from app.api.workspace import (
    EvidenceWrite, EvidenceReview,
    list_evidence, pin_evidence, review_evidence, delete_evidence,
)

USER = SimpleNamespace(username="det", role="admin")
USER2 = SimpleNamespace(username="insp", role="analyst")


class EvidenceBoardTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

    def _pin(self, db, **kw):
        base = dict(case_id="A", sig="meeting|123|Co-located with X", kind="meeting",
                    label="Co-located with X", detail="tower T1 · 4m gap",
                    subject="9820000001", ts=datetime(2026, 3, 1, 22, 10))
        base.update(kw)
        return pin_evidence(EvidenceWrite(**base), None, db=db, user=USER)

    def test_pin_lifecycle_confirm_with_note(self):
        db = self.Session()
        item = self._pin(db)
        self.assertEqual(item["status"], "system")
        self.assertIsNone(item["reviewed_by"])
        # Investigator confirms + notes
        up = review_evidence(item["id"], EvidenceReview(status="confirmed", note="Verified against tower dump"),
                             None, db=db, user=USER2)
        self.assertEqual(up["status"], "confirmed")
        self.assertEqual(up["note"], "Verified against tower dump")
        self.assertEqual(up["reviewed_by"], "insp")
        self.assertIsNotNone(up["reviewed_at"])
        db.close()

    def test_reject_and_undo(self):
        db = self.Session()
        item = self._pin(db)
        rej = review_evidence(item["id"], EvidenceReview(status="rejected"), None, db=db, user=USER)
        self.assertEqual(rej["status"], "rejected")
        back = review_evidence(item["id"], EvidenceReview(status="system"), None, db=db, user=USER)
        self.assertEqual(back["status"], "system")
        db.close()

    def test_invalid_status_rejected(self):
        from fastapi import HTTPException
        db = self.Session()
        item = self._pin(db)
        with self.assertRaises(HTTPException):
            review_evidence(item["id"], EvidenceReview(status="maybe"), None, db=db, user=USER)
        db.close()

    def test_repin_upserts_and_preserves_review(self):
        db = self.Session()
        item = self._pin(db)
        review_evidence(item["id"], EvidenceReview(status="confirmed", note="checked"), None, db=db, user=USER)
        # Same case+sig pinned again (e.g. from another browser) — refreshes content,
        # does NOT duplicate, does NOT clobber the review.
        again = self._pin(db, detail="tower T1 · 4m gap · refreshed")
        self.assertEqual(again["id"], item["id"])
        self.assertEqual(db.query(EvidenceItem).count(), 1)
        self.assertEqual(again["status"], "confirmed")
        self.assertEqual(again["note"], "checked")
        self.assertEqual(again["detail"], "tower T1 · 4m gap · refreshed")
        db.close()

    def test_case_scoping_and_status_filter(self):
        db = self.Session()
        self._pin(db, case_id="A", sig="s1")
        self._pin(db, case_id="A", sig="s2")
        self._pin(db, case_id="B", sig="s1")  # same sig, other case — distinct row
        self.assertEqual(db.query(EvidenceItem).count(), 3)
        a = list_evidence(db=db, _user=USER, case_id="A", status="")
        self.assertEqual(len(a), 2)
        first = a[-1]
        review_evidence(first["id"], EvidenceReview(status="confirmed"), None, db=db, user=USER)
        confirmed = list_evidence(db=db, _user=USER, case_id="A", status="confirmed")
        self.assertEqual(len(confirmed), 1)
        db.close()

    def test_delete(self):
        db = self.Session()
        item = self._pin(db)
        delete_evidence(item["id"], None, db=db, user=USER)
        self.assertEqual(db.query(EvidenceItem).count(), 0)
        # deleting a missing id is a no-op success
        self.assertEqual(delete_evidence(999, None, db=db, user=USER), {"success": True})
        db.close()


if __name__ == "__main__":
    unittest.main()
