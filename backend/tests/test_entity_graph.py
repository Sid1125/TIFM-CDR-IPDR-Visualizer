"""Entity intelligence graph — the persistent layer: sync/materialisation, durable merge
decisions (rejected stays rejected; confirmed survives the hub guard), deterministic entity
confidence, ego-graph generation, identifier search, entity-level cross-case matching, and
the review lifecycle with chain-of-custody logging. Locations never merge entities."""
from __future__ import annotations

import unittest
from datetime import datetime
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.audit_log import AuditLog
from app.models.entity import (Entity, EntityIdentifier, EntityMergeDecision,
                               EntityRelationship)
from app.services.entity_service import build_entities, pair_key
from app.services.entity_graph_service import (ego_graph, entity_confidence,
                                               entity_cross_case, search_entities,
                                               sync_entities)
from app.api.entities import EntityReview, review_entity

USER = SimpleNamespace(username="det", role="admin")


def cdr(**kw):
    base = dict(case_id="A", start_time=datetime(2026, 3, 1, 10, 0))
    base.update(kw)
    return CDRRecord(**base)


class DbCase(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()

    def tearDown(self):
        self.db.close()

    def seed(self, *rows):
        for r in rows:
            self.db.add(r)
        self.db.commit()


class SyncTests(DbCase):
    def test_sync_persists_entities_and_identifiers(self):
        self.seed(cdr(msisdn="111", imsi="SIM1", imei="DEV1"))
        res = sync_entities(self.db, case_id=None)
        self.assertTrue(res["synced"])
        row = self.db.query(Entity).filter(Entity.case_scope == "").one()
        self.assertEqual(row.classification, "individual")
        self.assertEqual(row.entity_type, "UNKNOWN_PERSON")
        types = {(i.identifier_type, i.value) for i in self.db.query(EntityIdentifier).all()}
        self.assertIn(("MSISDN", "111"), types)
        self.assertIn(("IMSI", "SIM1"), types)
        self.assertIn(("IMEI", "DEV1"), types)
        # rerun without changes: freshness check skips the rebuild
        self.assertFalse(sync_entities(self.db, case_id=None)["synced"])

    def test_same_imei_links_two_numbers_into_one_entity(self):
        self.seed(cdr(msisdn="111", imsi="SIM1", imei="DEVX"),
                  cdr(msisdn="222", imsi="SIM2", imei="DEVX"))
        sync_entities(self.db, case_id=None)
        rows = self.db.query(Entity).all()
        self.assertEqual(len(rows), 1)
        phones = {i.value for i in self.db.query(EntityIdentifier)
                  .filter(EntityIdentifier.identifier_type == "MSISDN").all()}
        self.assertEqual(phones, {"111", "222"})

    def test_sim_swap_scenario_persists_flag(self):
        self.seed(cdr(msisdn="111", imsi="SIM1", imei="DEV1"),
                  cdr(msisdn="111", imsi="SIM2", imei="DEV1",
                      start_time=datetime(2026, 3, 5, 10, 0)))
        sync_entities(self.db, case_id=None)
        row = self.db.query(Entity).one()
        self.assertIn("sim_swap", row.flags)

    def test_same_tower_only_never_merges(self):
        # Two unrelated subjects on the same two towers: CO_LOCATED relationship, TWO entities.
        self.seed(cdr(msisdn="111", imsi="SIM1", tower_id="TWR1"),
                  cdr(msisdn="111", imsi="SIM1", tower_id="TWR2"),
                  cdr(msisdn="222", imsi="SIM9", tower_id="TWR1"),
                  cdr(msisdn="222", imsi="SIM9", tower_id="TWR2"))
        sync_entities(self.db, case_id=None)
        self.assertEqual(self.db.query(Entity).count(), 2)
        rel = (self.db.query(EntityRelationship)
               .filter(EntityRelationship.relationship_type == "CO_LOCATED").one())
        self.assertEqual(rel.evidence_count, 2)
        self.assertIn("never used to merge", rel.explanation)

    def test_co_location_plus_contact_becomes_possible_association(self):
        self.seed(cdr(msisdn="111", imsi="SIM1", tower_id="TWR1",
                      a_party_number="111", b_party_number="222"),
                  cdr(msisdn="111", imsi="SIM1", tower_id="TWR2"),
                  cdr(msisdn="222", imsi="SIM9", tower_id="TWR1",
                      a_party_number="222", b_party_number="111"),
                  cdr(msisdn="222", imsi="SIM9", tower_id="TWR2"))
        sync_entities(self.db, case_id=None)
        self.assertEqual(self.db.query(Entity).count(), 2)  # still no merge
        rel = (self.db.query(EntityRelationship)
               .filter(EntityRelationship.relationship_type == "POSSIBLE_ASSOCIATION").one())
        self.assertIn("not proof of identity", rel.explanation)

    def test_contacted_relationship_row(self):
        self.seed(cdr(msisdn="111", imsi="SIM1", a_party_number="111", b_party_number="222"),
                  cdr(msisdn="222", imsi="SIM9", a_party_number="222", b_party_number="111"))
        sync_entities(self.db, case_id=None)
        rel = (self.db.query(EntityRelationship)
               .filter(EntityRelationship.relationship_type == "CONTACTED").one())
        self.assertEqual(rel.evidence_count, 2)


class MergeDecisionTests(DbCase):
    def test_rejected_merge_stays_rejected(self):
        self.seed(cdr(msisdn="111", imei="DEV1"))
        sync_entities(self.db, case_id=None)
        self.assertEqual(self.db.query(Entity).count(), 1)  # auto-merged via co-occurrence
        uid = self.db.query(Entity).one().entity_uid
        pk = pair_key(("phone", "111"), ("imei", "DEV1"))
        out = review_entity(uid, EntityReview(action="reject_merge", pair_key=pk,
                                              note="placeholder IMEI"),
                            None, db=self.db, user=USER, case_id="")
        self.assertEqual(out["decision"], "rejected")
        # The rejection split the entity, and the split is durable across forced rebuilds.
        self.assertEqual(self.db.query(Entity).count(), 2)
        sync_entities(self.db, case_id=None, force=True)
        self.assertEqual(self.db.query(Entity).count(), 2)
        dec = self.db.query(EntityMergeDecision).one()
        self.assertEqual(dec.decision, "rejected")
        self.assertEqual(dec.decided_by, "det")
        # Verdict is in the chain of custody.
        self.assertTrue(self.db.query(AuditLog)
                        .filter(AuditLog.action == "entity.merge_rejected").count())

    def test_confirm_reverses_a_rejection(self):
        self.seed(cdr(msisdn="111", imei="DEV1"))
        sync_entities(self.db, case_id=None)
        uid = self.db.query(Entity).one().entity_uid
        pk = pair_key(("phone", "111"), ("imei", "DEV1"))
        review_entity(uid, EntityReview(action="reject_merge", pair_key=pk),
                      None, db=self.db, user=USER, case_id="")
        self.assertEqual(self.db.query(Entity).count(), 2)
        uid2 = self.db.query(Entity).first().entity_uid
        review_entity(uid2, EntityReview(action="confirm_merge", pair_key=pk),
                      None, db=self.db, user=USER, case_id="")
        self.assertEqual(self.db.query(Entity).count(), 1)

    def test_confirmed_pair_survives_hub_guard_in_engine(self):
        # A placeholder IMEI on 40 numbers is hub-blocked, but the investigator confirms ONE
        # pairing as genuine: that pair merges; the other 39 stay separate.
        from types import SimpleNamespace as NS
        recs = [NS(case_id="A", msisdn=f"90000{i:03d}", imsi=f"SIM{i}", imei="0",
                   a_party_number=None, b_party_number=None,
                   start_time=datetime(2026, 3, 1, 10, 0), tower_id=None) for i in range(40)]
        pk = pair_key(("phone", "90000007"), ("imei", "0"))
        r = build_entities(recs, [], forced_pairs={pk})
        ent7 = next(e for e in r["entities"] if "90000007" in e["phones"])
        self.assertIn("0", ent7["imeis"])
        link = next(l for l in ent7["links"] if l["pair_key"] == pk)
        self.assertTrue(link["reviewed"])
        self.assertIn("investigator reviewed and confirmed", link["explanation"])
        # nobody else was merged into the hub
        others = [e for e in r["entities"] if e is not ent7 and e["phones"]]
        self.assertTrue(all("0" not in e["imeis"] for e in others))

    def test_suggested_merge_generated_for_hub_blocked_pairs(self):
        from types import SimpleNamespace as NS
        recs = [NS(case_id="A", msisdn=f"90000{i:03d}", imsi=f"SIM{i}", imei="0",
                   a_party_number=None, b_party_number=None,
                   start_time=datetime(2026, 3, 1, 10, 0), tower_id=None) for i in range(40)]
        r = build_entities(recs, [])
        self.assertTrue(r["suggestions"])
        s = r["suggestions"][0]
        self.assertIn("did not merge", s["reason"])
        self.assertIn("pair_key", s)
        self.assertNotEqual(s["a_entity"], s["b_entity"])


class ConfidenceTests(unittest.TestCase):
    def test_single_identifier_is_trivially_certain(self):
        self.assertEqual(entity_confidence({"links": [], "flags": []}), 100)

    def test_weakest_link_defines_cluster_confidence(self):
        high = {"links": [{"confidence": "HIGH", "records": 100}], "flags": []}
        mixed = {"links": [{"confidence": "HIGH", "records": 100},
                           {"confidence": "LOW", "records": 2}], "flags": []}
        self.assertGreater(entity_confidence(high), entity_confidence(mixed))
        self.assertGreaterEqual(entity_confidence(high), 90)

    def test_device_reuse_penalty_and_review_bonus(self):
        base = {"links": [{"confidence": "MEDIUM", "records": 30}], "flags": []}
        reused = {"links": [{"confidence": "MEDIUM", "records": 30}], "flags": ["device_reuse"]}
        reviewed = {"links": [{"confidence": "MEDIUM", "records": 30, "reviewed": True}], "flags": []}
        self.assertGreater(entity_confidence(base), entity_confidence(reused))
        self.assertGreater(entity_confidence(reviewed), entity_confidence(base))

    def test_bounds(self):
        many = {"links": [{"confidence": "HIGH", "records": 10000}], "flags": []}
        weak = {"links": [{"confidence": "LOW", "records": 1}], "flags": ["device_reuse"]}
        self.assertLessEqual(entity_confidence(many), 99)
        self.assertGreaterEqual(entity_confidence(weak), 5)


class GraphTests(DbCase):
    def test_ego_graph_generation(self):
        self.seed(cdr(msisdn="111", imsi="SIM1", imei="DEV1", tower_id="TWR1",
                      a_party_number="111", b_party_number="222"),
                  cdr(msisdn="222", imsi="SIM9", a_party_number="222", b_party_number="111"))
        sync_entities(self.db, case_id=None)
        uid = next(r.entity_uid for r in self.db.query(Entity).all()
                   if '"111"' in (r.payload or ""))
        g = ego_graph(self.db, "", uid)
        self.assertEqual(g["center"], uid)
        types = {(n["type"], n["label"]) for n in g["nodes"]}
        self.assertIn(("phone", "111"), types)
        self.assertIn(("sim", "SIM1"), types)
        self.assertIn(("device", "DEV1"), types)
        self.assertIn(("tower", "TWR1"), types)
        self.assertIn(("case", "A"), types)
        edge_types = {e["type"] for e in g["edges"]}
        self.assertLessEqual({"USES_NUMBER", "OWNS_SIM", "USES_DEVICE", "SEEN_AT",
                              "APPEARS_IN_CASE", "CONTACTED"}, edge_types)
        # the neighbouring entity rides in via the CONTACTED relationship
        self.assertTrue(any(n["type"] == "entity" and not n.get("center") for n in g["nodes"]))
        # every identifier edge to a merge-key identifier carries its explanation
        num_edge = next(e for e in g["edges"] if e["type"] == "USES_NUMBER")
        self.assertTrue(num_edge["explanation"])

    def test_ego_graph_respects_node_cap(self):
        rows = [cdr(msisdn="111", imsi=f"S{i}", imei="DEVX",
                    start_time=datetime(2026, 3, 1 + i % 27, 9, 0)) for i in range(30)]
        self.seed(*rows)
        sync_entities(self.db, case_id=None)
        uid = self.db.query(Entity).order_by(Entity.record_count.desc()).first().entity_uid
        g = ego_graph(self.db, "", uid, limit=20)
        self.assertLessEqual(g["node_count"], 20)
        self.assertTrue(g["truncated"])  # something was held back for lazy expansion

    def test_missing_entity_returns_none(self):
        self.assertIsNone(ego_graph(self.db, "", "ent_nope"))


class SearchTests(DbCase):
    def test_search_by_any_identifier(self):
        self.seed(cdr(msisdn="9820012345", imsi="405871111", imei="35123456"),
                  cdr(msisdn="7000000001", imsi="405879999"))
        sync_entities(self.db, case_id=None)
        hits = search_entities(self.db, "", "820012")
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["matched"][0]["value"], "9820012345")
        hits = search_entities(self.db, "", "40587")
        self.assertEqual(len(hits), 2)
        self.assertEqual(search_entities(self.db, "", "zzz"), [])


class CrossCaseEntityTests(DbCase):
    def test_cross_case_entity_match_same_device_different_numbers(self):
        # Case A: number 111 on IMEI X. Case B: DIFFERENT number 222 on the same IMEI X.
        # Identifier-level matching sees two unrelated numbers; entity-level sees ONE device.
        self.seed(cdr(case_id="A", msisdn="111", imsi="SIM1", imei="IMEIX"),
                  cdr(case_id="B", msisdn="222", imsi="SIM2", imei="IMEIX",
                      start_time=datetime(2026, 4, 2, 10, 0)))
        out = entity_cross_case(self.db)
        self.assertEqual(out["total"], 1)
        hit = out["hits"][0]
        self.assertEqual(sorted(hit["cases"]), ["A", "B"])
        self.assertIn("IMEIX", hit["finding"])
        self.assertIn("same physical device", hit["finding"])
        # per-case breakdown shows WHICH identifiers place the entity in each case
        self.assertTrue(any(x["value"] == "111" for x in hit["per_case"]["A"]))
        self.assertTrue(any(x["value"] == "222" for x in hit["per_case"]["B"]))
        self.assertTrue(any(x["value"] == "IMEIX" for x in hit["per_case"]["A"]))
        self.assertTrue(any(x["value"] == "IMEIX" for x in hit["per_case"]["B"]))

    def test_single_case_entities_are_not_cross_case_hits(self):
        self.seed(cdr(case_id="A", msisdn="111", imsi="SIM1"))
        self.assertEqual(entity_cross_case(self.db)["total"], 0)


class ReviewLifecycleTests(DbCase):
    def test_entity_confirm_survives_rebuild(self):
        self.seed(cdr(msisdn="111", imsi="SIM1", imei="DEV1"))
        sync_entities(self.db, case_id=None)
        uid = self.db.query(Entity).one().entity_uid
        review_entity(uid, EntityReview(action="confirm", note="verified with KYC"),
                      None, db=self.db, user=USER, case_id="")
        # new data arrives -> rebuild; review state carries over by uid
        self.seed(cdr(msisdn="111", imsi="SIM1", imei="DEV1",
                      start_time=datetime(2026, 3, 9, 10, 0)))
        sync_entities(self.db, case_id=None)
        row = self.db.query(Entity).one()
        self.assertEqual(row.reviewed_status, "confirmed")
        self.assertEqual(row.review_note, "verified with KYC")
        self.assertTrue(self.db.query(AuditLog)
                        .filter(AuditLog.action == "entity.review_confirm").count())

    def test_unknown_action_rejected(self):
        from fastapi import HTTPException
        self.seed(cdr(msisdn="111"))
        sync_entities(self.db, case_id=None)
        uid = self.db.query(Entity).one().entity_uid
        with self.assertRaises(HTTPException):
            review_entity(uid, EntityReview(action="delete_everything"),
                          None, db=self.db, user=USER, case_id="")


if __name__ == "__main__":
    unittest.main()
