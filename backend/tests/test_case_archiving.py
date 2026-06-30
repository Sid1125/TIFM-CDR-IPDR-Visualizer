"""Phase 5 — case archiving. An archived case drops out of the active case list but is retained
(not deleted) and still reachable via include_archived. Archiving is a reversible flag toggle."""
from __future__ import annotations

import unittest
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.case import Case
from app.api.cases import list_cases, update_case
from app.schemas.case import CaseUpdate


class CaseArchivingTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        db = self.Session()
        db.add_all([Case(name="Active One"), Case(name="To Archive"), Case(name="Active Two")])
        db.commit()
        db.close()
        self.user = SimpleNamespace(username="admin", role="admin")

    def _names(self, cases):
        return {c.name for c in cases}

    def test_archived_case_hidden_from_active_list(self):
        db = self.Session()
        target = db.query(Case).filter(Case.name == "To Archive").one()
        update_case(target.id, CaseUpdate(archived=True), db=db, _user=self.user)

        active = list_cases(db=db, _user=self.user, include_archived=False)
        self.assertEqual(self._names(active), {"Active One", "Active Two"})

        allc = list_cases(db=db, _user=self.user, include_archived=True)
        self.assertEqual(len(allc), 3)
        archived = next(c for c in allc if c.name == "To Archive")
        self.assertTrue(archived.archived)
        db.close()

    def test_unarchive_restores_to_active_list(self):
        db = self.Session()
        target = db.query(Case).filter(Case.name == "To Archive").one()
        update_case(target.id, CaseUpdate(archived=True), db=db, _user=self.user)
        update_case(target.id, CaseUpdate(archived=False), db=db, _user=self.user)
        active = list_cases(db=db, _user=self.user, include_archived=False)
        self.assertIn("To Archive", self._names(active))
        db.close()

    def test_api_default_excludes_archived(self):
        # The endpoint's include_archived defaults to False, so the active list hides archived
        # cases unless explicitly asked. (Calling list_cases() directly can't resolve a FastAPI
        # default, so assert the declared default here, and the filter behaviour above.)
        import inspect
        default = inspect.signature(list_cases).parameters["include_archived"].default
        self.assertEqual(getattr(default, "default", default), False)


if __name__ == "__main__":
    unittest.main()
