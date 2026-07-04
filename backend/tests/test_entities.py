"""Entity resolution: same-record identifier co-occurrence merges (transitively — SIM swaps
and device changes stay ONE entity, flagged); IPs and counterpart numbers never merge;
communication becomes inter-entity edges with external endpoints preserved."""
from __future__ import annotations

import unittest
from datetime import datetime
from types import SimpleNamespace

from app.services.entity_service import build_entities


def cdr(**kw):
    base = dict(case_id="A", msisdn=None, imsi=None, imei=None,
                a_party_number=None, b_party_number=None,
                start_time=datetime(2026, 3, 1, 10, 0), tower_id=None)
    base.update(kw)
    return SimpleNamespace(**base)


def ipdr(**kw):
    base = dict(case_id="A", msisdn=None, imsi=None, imei=None,
                start_time=datetime(2026, 3, 1, 12, 0), tower_id=None,
                source_ip=None, destination_ip=None)
    base.update(kw)
    return SimpleNamespace(**base)


class EntityResolution(unittest.TestCase):
    def test_same_record_binding_merges_identifiers(self):
        r = build_entities([cdr(msisdn="111", imsi="SIM1", imei="DEV1")], [])
        self.assertEqual(len(r["entities"]), 1)
        e = r["entities"][0]
        self.assertEqual(e["phones"], ["111"])
        self.assertEqual(e["imsis"], ["SIM1"])
        self.assertEqual(e["imeis"], ["DEV1"])
        self.assertTrue(any(l["records"] >= 1 for l in e["links"]))

    def test_sim_swap_stays_one_entity_and_is_flagged(self):
        # Same device (IMEI), SIM changes: one person, flagged sim_swap.
        recs = [cdr(msisdn="111", imsi="SIM1", imei="DEV1"),
                cdr(msisdn="111", imsi="SIM2", imei="DEV1",
                    start_time=datetime(2026, 3, 5, 10, 0))]
        r = build_entities(recs, [])
        self.assertEqual(len(r["entities"]), 1)
        self.assertIn("sim_swap", r["entities"][0]["flags"])
        self.assertEqual(r["entities"][0]["imsis"], ["SIM1", "SIM2"])

    def test_device_change_stays_one_entity_and_is_flagged(self):
        recs = [cdr(msisdn="111", imsi="SIM1", imei="DEV1"),
                cdr(msisdn="111", imsi="SIM1", imei="DEV2",
                    start_time=datetime(2026, 3, 6, 10, 0))]
        r = build_entities(recs, [])
        self.assertEqual(len(r["entities"]), 1)
        self.assertIn("device_change", r["entities"][0]["flags"])

    def test_unrelated_subjects_stay_separate(self):
        recs = [cdr(msisdn="111", imsi="SIM1", imei="DEV1"),
                cdr(msisdn="222", imsi="SIM9", imei="DEV9")]
        r = build_entities(recs, [])
        self.assertEqual(len(r["entities"]), 2)

    def test_shared_cgnat_ip_never_merges(self):
        # Two subscribers behind the same carrier NAT address must remain two entities;
        # the IP shows up on both as an attribute, marked cgnat.
        recs = [ipdr(msisdn="111", source_ip="100.70.1.9"),
                ipdr(msisdn="222", source_ip="100.70.1.9")]
        r = build_entities([], recs)
        self.assertEqual(len(r["entities"]), 2)
        for e in r["entities"]:
            self.assertEqual(e["ips"][0]["ip"], "100.70.1.9")
            self.assertEqual(e["ips"][0]["kind"], "cgnat")

    def test_counterpart_number_is_edge_not_member(self):
        # 111 calls 999: 999 is not merged into 111's entity; it becomes an external edge.
        recs = [cdr(msisdn="111", imsi="SIM1", a_party_number="111", b_party_number="999")]
        r = build_entities(recs, [])
        self.assertEqual(len(r["entities"]), 1)
        self.assertNotIn("999", r["entities"][0]["phones"])
        self.assertEqual(len(r["edges"]), 1)
        self.assertTrue(r["edges"][0]["a"].startswith("ent_") or r["edges"][0]["b"].startswith("ent_"))
        self.assertTrue(any(x == "ext_999" for x in (r["edges"][0]["a"], r["edges"][0]["b"])))

    def test_calls_between_resolved_entities_become_edges(self):
        recs = [cdr(msisdn="111", imsi="SIM1", a_party_number="111", b_party_number="222"),
                cdr(msisdn="111", imsi="SIM1", a_party_number="111", b_party_number="222"),
                cdr(msisdn="222", imsi="SIM9", a_party_number="222", b_party_number="111")]
        r = build_entities(recs, [])
        self.assertEqual(len(r["entities"]), 2)
        self.assertEqual(len(r["edges"]), 1)
        self.assertEqual(r["edges"][0]["calls"], 3)
        self.assertTrue(r["edges"][0]["a"].startswith("ent_") and r["edges"][0]["b"].startswith("ent_"))

    def test_multi_case_flag_and_windows(self):
        recs = [cdr(msisdn="111", imsi="SIM1", case_id="A",
                    start_time=datetime(2026, 1, 1, 8, 0)),
                cdr(msisdn="111", imsi="SIM1", case_id="B",
                    start_time=datetime(2026, 4, 1, 8, 0))]
        r = build_entities(recs, [])
        e = r["entities"][0]
        self.assertIn("multi_case", e["flags"])
        self.assertEqual(e["cases"], ["A", "B"])
        self.assertTrue(e["first_seen"].startswith("2026-01-01"))
        self.assertTrue(e["last_seen"].startswith("2026-04-01"))

    def test_placeholder_identifier_does_not_over_merge(self):
        # One shared/placeholder IMEI ("0") stamped on 40 otherwise-unrelated phones must
        # NOT fuse them into a single entity (the union-find over-merge hazard). Each phone
        # stays its own entity; the hub identifier doesn't bridge them.
        recs = [cdr(msisdn=f"90000{i:03d}", imsi=f"SIM{i}", imei="0",
                    a_party_number=f"90000{i:03d}") for i in range(40)]
        r = build_entities(recs, [])
        self.assertGreaterEqual(len(r["entities"]), 40)
        biggest = max(r["entities"], key=lambda e: len(e["phones"]))
        self.assertEqual(len(biggest["phones"]), 1)

    def test_legit_small_cluster_still_merges_under_the_cap(self):
        # A real multi-SIM/multi-device person (a few identifiers) must still resolve to ONE
        # entity — the guard only trips on high fan-out, not on normal multiplicity.
        recs = [cdr(msisdn="111", imsi="SIM1", imei="DEV1"),
                cdr(msisdn="111", imsi="SIM2", imei="DEV1"),
                cdr(msisdn="111", imsi="SIM2", imei="DEV2"),
                cdr(msisdn="222", imsi="SIM2", imei="DEV2")]  # 222 shares SIM2/DEV2 -> same person
        r = build_entities(recs, [])
        self.assertEqual(len(r["entities"]), 1)

    def test_stable_ids(self):
        recs = [cdr(msisdn="111", imsi="SIM1", imei="DEV1")]
        a = build_entities(recs, [])["entities"][0]["id"]
        b = build_entities(list(reversed(recs * 3)), [])["entities"][0]["id"]
        self.assertEqual(a, b)

    def test_link_carries_typed_confidence_evidence(self):
        # Repeated tight co-occurrence -> HIGH confidence, typed, with a time window.
        recs = [cdr(msisdn="111", imsi="SIM1", imei="DEV1",
                    start_time=datetime(2026, 3, d, 10, 0)) for d in range(1, 15)]
        e = build_entities(recs, [])["entities"][0]
        by_type = {l["type"]: l for l in e["links"]}
        self.assertIn("Number ↔ SIM", by_type)
        self.assertIn("Number ↔ Device", by_type)
        self.assertIn("SIM ↔ Device", by_type)
        link = by_type["Number ↔ SIM"]
        self.assertEqual(link["confidence"], "HIGH")
        self.assertGreaterEqual(link["records"], 14)
        self.assertTrue(link["first_seen"].startswith("2026-03-01"))
        self.assertTrue(link["last_seen"].startswith("2026-03-14"))

    def test_individual_vs_cluster_classification(self):
        indiv = build_entities([cdr(msisdn="111", imsi="SIM1", imei="DEV1")], [])["entities"][0]
        self.assertEqual(indiv["entity_type"], "individual")
        self.assertEqual(indiv["entity_type_label"], "Individual (probable)")
        # A device carrying many SIMs (high internal reuse, under the hub cap) is a cluster,
        # never "person" — flagged device_reuse.
        recs = []
        for i in range(6):
            recs.append(cdr(msisdn="111", imsi=f"S{i}", imei="DEVX",
                            start_time=datetime(2026, 3, 1 + i, 9, 0)))
        cluster = build_entities(recs, [])["entities"][0]
        self.assertEqual(cluster["entity_type"], "identity_cluster")
        self.assertIn("device_reuse", cluster["flags"])

    def test_adaptive_threshold_learns_from_distribution(self):
        # A SIM-box case: many devices each carrying ~15 SIMs is NORMAL here, so the learned
        # threshold rises and those devices are not treated as placeholder hubs. A blank "0"
        # IMEI stamped on everything still fans out far beyond the case's 99th percentile and
        # is still caught. Threshold is surfaced in meta.
        recs = []
        for dev in range(30):
            for sim in range(15):  # 15 SIMs per device — the case's normal reuse level
                recs.append(cdr(msisdn=f"n{dev}_{sim}", imsi=f"S{dev}_{sim}", imei=f"DEV{dev}",
                                start_time=datetime(2026, 3, 1 + (sim % 27), 9, 0)))
        # one placeholder IMEI on 200 unrelated numbers
        for i in range(200):
            recs.append(cdr(msisdn=f"z{i}", imsi=f"ZS{i}", imei="0"))
        r = build_entities(recs, [])
        thr = r["meta"]["hub_fanout_threshold"]
        self.assertGreaterEqual(thr, 15)          # learned the SIM-box normal, not the fixed 12
        self.assertLess(thr, 150)
        # placeholder didn't create a mega-blob: no entity swallowed the 200 z-numbers
        biggest = max(r["entities"], key=lambda e: len(e["phones"]))
        self.assertLess(len(biggest["phones"]), 200)
        # a genuine device's 15 SIMs DID resolve into one cluster (threshold respected the norm)
        clusters = [e for e in r["entities"] if len(e["imsis"]) >= 15]
        self.assertTrue(clusters)

    def test_low_reuse_case_keeps_a_sane_floor(self):
        # A quiet case (everyone fanout 1) must not learn a threshold so low it flags normal
        # multiplicity — the floor protects legit multi-SIM/device people.
        recs = [cdr(msisdn=f"n{i}", imsi=f"S{i}", imei=f"D{i}") for i in range(40)]
        # one legit 3-SIM person
        recs += [cdr(msisdn="star", imsi="SA", imei="DX"),
                 cdr(msisdn="star", imsi="SB", imei="DX"),
                 cdr(msisdn="star", imsi="SC", imei="DX")]
        r = build_entities(recs, [])
        self.assertGreaterEqual(r["meta"]["hub_fanout_threshold"], 8)
        star = next(e for e in r["entities"] if "star" in e["phones"])
        self.assertEqual(len(star["imsis"]), 3)   # still one person, not split

    def test_link_explanation_is_deterministic_prose(self):
        recs = [cdr(msisdn="111", imsi="SIM1", imei="DEV1",
                    start_time=datetime(2026, 6, d, 10, 0)) for d in range(1, 16)]
        e = build_entities(recs, [])["entities"][0]
        link = next(l for l in e["links"] if l["type"] == "Number ↔ SIM")
        exp = link["explanation"]
        self.assertIn("appeared together", exp)
        self.assertIn("phone number", exp)
        self.assertIn("SIM", exp)
        self.assertIn("15 telecom records", exp)
        self.assertIn("Jun 2026", exp)
        self.assertIn("strong identity relationship", exp)
        # exact same inputs -> exact same sentence (no randomness)
        e2 = build_entities(list(recs), [])["entities"][0]
        self.assertEqual(exp, next(l for l in e2["links"] if l["type"] == "Number ↔ SIM")["explanation"])

    def test_weak_link_through_shared_identifier_is_low(self):
        # SIM shared across several devices (fanout>6) -> its links are LOW as identity.
        recs = [cdr(msisdn=f"n{i}", imsi="SHARED", imei=f"D{i}") for i in range(8)]
        r = build_entities(recs, [])
        # hub guard keeps them separate; any surviving link touching SHARED is not HIGH
        for e in r["entities"]:
            for l in e["links"]:
                if "imsi:SHARED" in (l["a"], l["b"]):
                    self.assertNotEqual(l["confidence"], "HIGH")


if __name__ == "__main__":
    unittest.main()
