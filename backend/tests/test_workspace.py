"""Investigation workspace — relationship (edge) labels + hypotheses. Labels are global by
subject pair and order-independent; hypotheses are case-scoped CRUD with a constrained status."""
from __future__ import annotations

import unittest
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.relationship_label import RelationshipLabel  # noqa: F401
from app.models.hypothesis import Hypothesis  # noqa: F401
from app.api.workspace import (
    RelationshipWrite, HypothesisWrite, HypothesisUpdate,
    list_relationships, upsert_relationship,
    list_hypotheses, create_hypothesis, update_hypothesis, delete_hypothesis,
)

USER = SimpleNamespace(username="det", role="admin")


class RelationshipLabelTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

    def test_upsert_is_order_independent(self):
        db = self.Session()
        upsert_relationship(RelationshipWrite(subject_a="9820000002", subject_b="9820000001",
                                              label="brothers"), None, db=db, user=USER)
        # querying with the reversed order still finds the one row
        rows = list_relationships(db=db, _user=USER, subject="9820000001")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["label"], "brothers")
        self.assertEqual(rows[0]["subject_a"], "9820000001")  # normalised a<=b
        # upsert the reversed pair updates in place, not a duplicate
        upsert_relationship(RelationshipWrite(subject_a="9820000001", subject_b="9820000002",
                                              label="cousins"), None, db=db, user=USER)
        self.assertEqual(db.query(RelationshipLabel).count(), 1)
        self.assertEqual(list_relationships(db=db, _user=USER, subject="")[0]["label"], "cousins")
        db.close()

    def test_blank_label_deletes(self):
        db = self.Session()
        upsert_relationship(RelationshipWrite(subject_a="a", subject_b="b", label="x"), None, db=db, user=USER)
        upsert_relationship(RelationshipWrite(subject_a="a", subject_b="b", label=""), None, db=db, user=USER)
        self.assertEqual(db.query(RelationshipLabel).count(), 0)
        db.close()

    def test_list_filters_by_subject(self):
        db = self.Session()
        upsert_relationship(RelationshipWrite(subject_a="a", subject_b="b", label="1"), None, db=db, user=USER)
        upsert_relationship(RelationshipWrite(subject_a="c", subject_b="d", label="2"), None, db=db, user=USER)
        self.assertEqual(len(list_relationships(db=db, _user=USER, subject="")), 2)
        self.assertEqual(len(list_relationships(db=db, _user=USER, subject="a")), 1)
        self.assertEqual(len(list_relationships(db=db, _user=USER, subject="zzz")), 0)
        db.close()


class HypothesisTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

    def test_create_list_update_delete(self):
        db = self.Session()
        h = create_hypothesis(HypothesisWrite(case_id="A", title="Ring led by X",
                                              body="X coordinates the drops", subjects=["9820000001"]),
                              None, db=db, user=USER)
        self.assertEqual(h["status"], "open")
        self.assertEqual(h["subjects"], ["9820000001"])
        # case-scoped list
        self.assertEqual(len(list_hypotheses(db=db, _user=USER, case_id="A")), 1)
        self.assertEqual(len(list_hypotheses(db=db, _user=USER, case_id="B")), 0)
        # update status (constrained)
        up = update_hypothesis(h["id"], HypothesisUpdate(status="supported"), None, db=db, user=USER)
        self.assertEqual(up["status"], "supported")
        update_hypothesis(h["id"], HypothesisUpdate(status="bogus"), None, db=db, user=USER)
        self.assertEqual(db.get(Hypothesis, h["id"]).status, "supported")  # invalid ignored
        # delete
        delete_hypothesis(h["id"], None, db=db, user=USER)
        self.assertEqual(len(list_hypotheses(db=db, _user=USER, case_id="A")), 0)
        db.close()

    def test_title_required(self):
        from fastapi import HTTPException
        db = self.Session()
        with self.assertRaises(HTTPException):
            create_hypothesis(HypothesisWrite(case_id="A", title="  "), None, db=db, user=USER)
        db.close()


if __name__ == "__main__":
    unittest.main()
