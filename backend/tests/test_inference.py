"""Tests for the spatiotemporal inference engine.

Synthetic, deterministic records exercise each inference group end-to-end without a DB.
"""
from __future__ import annotations

import types
import unittest
from datetime import datetime, timedelta

from app.services import inference_service as inf
from app.services.geo import classify_speed, haversine_km

# Tower coordinates reused across cases.
CHENNAI = (13.0827, 80.2707)
DELHI = (28.6139, 77.2090)
MUMBAI_T = (19.1333, 72.7993)


def cdr(msisdn, b, when, tower, lat, lon, imei="111", imsi="404AAA", dur=120, ctype="Voice"):
    return types.SimpleNamespace(
        msisdn=msisdn, imsi=imsi, imei=imei, a_party_number=msisdn, b_party_number=b,
        call_type=ctype, direction="MO", start_time=when, end_time=when + timedelta(seconds=dur),
        duration_seconds=dur, tower_id=tower, latitude=lat, longitude=lon)


def ipdr(msisdn, dst, when, tower, lat, lon, port=443, proto="TCP", up=1000, down=2000,
         imei="111", imsi="404AAA"):
    return types.SimpleNamespace(
        msisdn=msisdn, imsi=imsi, imei=imei, start_time=when, end_time=when + timedelta(minutes=2),
        source_ip="100.64.1.1", destination_ip=dst, source_port=50000, destination_port=port,
        protocol=proto, bytes_uploaded=up, bytes_downloaded=down,
        tower_id=tower, latitude=lat, longitude=lon)


class GeoTests(unittest.TestCase):
    def test_haversine_known_distance(self):
        # Chennai -> Delhi is ~1750 km.
        d = haversine_km(*CHENNAI, *DELHI)
        self.assertTrue(1700 < d < 1800, d)

    def test_haversine_missing_coord(self):
        self.assertIsNone(haversine_km(1.0, None, 2.0, 3.0))

    def test_speed_bands(self):
        self.assertEqual(classify_speed(1), "stationary")
        self.assertEqual(classify_speed(80), "road / highway")
        self.assertEqual(classify_speed(5000), "impossible")


class MovementTests(unittest.TestCase):
    def test_impossible_travel_flagged(self):
        base = datetime(2026, 2, 6, 14, 0)
        recs = [
            cdr("900", "x", base, "T_CHN", *CHENNAI, imei="A"),
            cdr("900", "x", base + timedelta(minutes=18), "T_DEL", *DELHI, imei="B"),
        ]
        streams = inf.build_subject_streams(recs)
        legs = inf.impossible_travel(streams["900"])
        self.assertEqual(len(legs), 1)
        self.assertGreater(legs[0]["speed_kmh"], 900)

    def test_same_minute_two_places_is_impossible(self):
        # Same (minute-resolution) timestamp at two far towers: speed undefined but
        # physically impossible — must still be flagged, not dropped by a dt>0 guard.
        t = datetime(2026, 2, 6, 14, 0)
        recs = [
            cdr("950", "x", t, "T_CHN", *CHENNAI, imei="A"),
            cdr("950", "x", t, "T_DEL", *DELHI, imei="B"),
        ]
        streams = inf.build_subject_streams(recs)
        legs = inf.impossible_travel(streams["950"])
        self.assertEqual(len(legs), 1)
        self.assertIsNone(legs[0]["speed_kmh"])

    def test_normal_travel_not_flagged(self):
        base = datetime(2026, 2, 6, 14, 0)
        # ~2 km in 10 minutes = ~12 km/h, clearly fine.
        recs = [
            cdr("901", "x", base, "T1", 13.0000, 80.2000),
            cdr("901", "x", base + timedelta(minutes=10), "T2", 13.0180, 80.2000),
        ]
        streams = inf.build_subject_streams(recs)
        self.assertEqual(inf.impossible_travel(streams["901"]), [])

    def test_anchors_home_and_work(self):
        recs = []
        # Nights at home tower, weekday daytime at work tower.
        for day in range(6, 13):
            recs.append(cdr("902", "x", datetime(2026, 1, day, 23, 0), "HOME", 13.0, 80.0))
        for day in (6, 7, 8):  # Tue-Thu daytime
            recs.append(cdr("902", "x", datetime(2026, 1, day, 11, 0), "WORK", 13.1, 80.1))
        streams = inf.build_subject_streams(recs)
        anchors = inf.infer_anchors(streams["902"])
        self.assertEqual(anchors["home"]["tower_id"], "HOME")
        self.assertEqual(anchors["work"]["tower_id"], "WORK")


class CoPresenceTests(unittest.TestCase):
    def test_convoy_and_hidden_link(self):
        recs = []
        # A & B co-located at same tower within minutes across 3 days; they DO call.
        for day in (10, 17, 24):
            recs.append(cdr("A", "B", datetime(2026, 1, day, 19, 0), "TWR", *MUMBAI_T))
            recs.append(cdr("B", "A", datetime(2026, 1, day, 19, 5), "TWR", *MUMBAI_T))
        # C & D co-located 3 days but NEVER call each other (call third parties).
        for day in (11, 18, 25):
            recs.append(cdr("C", "z", datetime(2026, 1, day, 20, 0), "TWR2", 13.0, 80.0))
            recs.append(cdr("D", "z", datetime(2026, 1, day, 20, 4), "TWR2", 13.0, 80.0))
        streams = inf.build_subject_streams(recs)
        out = inf.co_presence(streams, inf._call_pairs(recs))
        by_pair = {(c["subject_a"], c["subject_b"]): c for c in out}
        self.assertTrue(by_pair[("A", "B")]["convoy"])
        self.assertTrue(by_pair[("A", "B")]["ever_called"])
        self.assertTrue(by_pair[("C", "D")]["hidden_link"])
        self.assertFalse(by_pair[("C", "D")]["ever_called"])


class BehavioralTests(unittest.TestCase):
    def test_periodic_contact_detected(self):
        # Daily call at the same time = highly regular cadence.
        recs = [cdr("S", "P", datetime(2026, 1, d, 21, 0), "T", 13.0, 80.0) for d in range(1, 8)]
        out = inf.periodic_contacts(recs)
        self.assertTrue(any(p["subject"] == "S" and p["peer"] == "P" for p in out))

    def test_burst_not_mistaken_for_cadence(self):
        # Five calls within ~40 minutes: low gap-variance but a burst, not a cadence.
        base = datetime(2026, 1, 1, 21, 0)
        recs = [cdr("B", "P", base + timedelta(minutes=10 * i), "T", 13.0, 80.0) for i in range(5)]
        self.assertFalse(any(p["subject"] == "B" for p in inf.periodic_contacts(recs)))

    def test_odd_hours_share(self):
        recs = [cdr("O", "x", datetime(2026, 1, d, 3, 0), "T", 13.0, 80.0) for d in range(1, 6)]
        prof = inf.odd_hours_profile(inf.build_subject_streams(recs)["O"])
        self.assertTrue(prof["flag"])


class VpnProxyTests(unittest.TestCase):
    def _src(self, sessions, ip):
        # Force a known source IP onto the IPDR fixtures (which default to 100.64.1.1).
        for s in sessions:
            s.source_ip = ip
        return sessions

    def test_vpn_port_flagged_with_source_ip_subject(self):
        # The subject is the SOURCE IP, never a phone number; destination server is shown.
        sessions = self._src([
            ipdr("ignored-msisdn", "5.9.120.30", datetime(2026, 1, 1, 10), "T", 13.0, 80.0, port=1194, proto="UDP"),
            ipdr("ignored-msisdn", "5.9.50.10", datetime(2026, 1, 2, 10), "T", 13.0, 80.0, port=51820, proto="UDP"),
        ], "203.0.113.9")
        out = inf.vpn_proxy_use(sessions)
        self.assertEqual(out[0]["source_ip"], "203.0.113.9")
        self.assertEqual(out[0]["vpn_sessions"], 2)
        self.assertNotIn("subject", out[0])  # no phone-number attribution

    def test_normal_browsing_not_flagged(self):
        sessions = self._src([
            ipdr("x", "142.250.1.1", datetime(2026, 1, 1, 10), "T", 13.0, 80.0, port=443),
            ipdr("x", "157.240.1.1", datetime(2026, 1, 1, 11), "T", 13.0, 80.0, port=443),
        ], "203.0.113.9")
        self.assertEqual(inf.vpn_proxy_use(sessions), [])


class DeviceTests(unittest.TestCase):
    def test_sim_swap_and_burner(self):
        recs = [
            cdr("NUM1", "x", datetime(2026, 1, 1), "T", 13.0, 80.0, imei="DEV_A"),
            cdr("NUM1", "x", datetime(2026, 1, 2), "T", 13.0, 80.0, imei="DEV_B"),  # number on 2 handsets
            cdr("NUM2", "x", datetime(2026, 1, 3), "T", 13.0, 80.0, imei="DEV_C"),
            cdr("NUM3", "x", datetime(2026, 1, 4), "T", 13.0, 80.0, imei="DEV_C"),  # handset with 2 numbers
        ]
        dev = inf.device_anomalies(recs)
        self.assertEqual([s["msisdn"] for s in dev["sim_swaps"]], ["NUM1"])
        self.assertEqual([b["imei"] for b in dev["burner_handsets"]], ["DEV_C"])

    def test_clone_corroboration(self):
        base = datetime(2026, 2, 6, 14, 0)
        recs = [
            cdr("CL", "x", base, "T_CHN", *CHENNAI, imei="A"),
            cdr("CL", "x", base + timedelta(minutes=18), "T_DEL", *DELHI, imei="B"),
        ]
        streams = inf.build_subject_streams(recs)
        dev = inf.device_anomalies(recs)
        out = inf.clone_corroboration(streams, dev)
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0]["number_on_multiple_handsets"])
        self.assertEqual(out[0]["verdict"], "likely cloned SIM")


class OrchestrationTests(unittest.TestCase):
    def test_run_all_smoke(self):
        base = datetime(2026, 2, 6, 14, 0)
        recs = [
            cdr("CL", "HUB", base, "T_CHN", *CHENNAI, imei="A"),
            cdr("CL", "HUB", base + timedelta(minutes=18), "T_DEL", *DELHI, imei="B"),
        ]
        sessions = [ipdr("x", "5.9.1.1", base, "T", 13.0, 80.0, port=1194, proto="UDP")]
        sessions[0].source_ip = "203.0.113.5"
        rep = inf.run_all(recs, sessions)
        # CDR block: phone-number subjects
        self.assertEqual(rep["cdr"]["subjects"], 1)
        self.assertEqual(len(rep["cdr"]["impossible_travel"]), 1)
        self.assertEqual(len(rep["cdr"]["clone_corroboration"]), 1)
        # IPDR block: IP subjects, kept separate
        self.assertEqual(rep["ipdr"]["vpn_proxy"][0]["source_ip"], "203.0.113.5")


class RiskScoreTests(unittest.TestCase):
    def test_score_factors_cap_and_bands(self):
        self.assertEqual(inf._score_factors([{"weight": 80}, {"weight": 80}], 10), (100, "critical"))
        self.assertEqual(inf._score_factors([{"weight": 30}, {"weight": 25}], 10), (55, "high"))
        self.assertEqual(inf._score_factors([{"weight": 22}], 10), (22, "low"))
        # low-evidence: raw 55 but only 2 backing events -> capped to 49 ("elevated")
        self.assertEqual(inf._score_factors([{"weight": 30}, {"weight": 25}], 2), (49, "elevated"))

    def test_cloned_sim_dedup_and_breakdown(self):
        base = datetime(2026, 2, 6, 14, 0)
        recs = [
            cdr("900", "x", base, "T_CHN", *CHENNAI, imei="A"),
            cdr("900", "x", base + timedelta(minutes=18), "T_DEL", *DELHI, imei="B"),
            cdr("900", "x", base + timedelta(minutes=40), "T_DEL", *DELHI, imei="B"),
        ]
        top = inf.run_all(recs, [])["cdr"]["risk"][0]
        self.assertEqual(top["subject"], "900")
        names = [f["name"] for f in top["factors"]]
        # correlated identity signals collapse into ONE "Cloned SIM" factor (no double count)
        self.assertIn("Cloned SIM", names)
        self.assertNotIn("Impossible travel", names)
        self.assertNotIn("SIM on multiple handsets", names)
        self.assertTrue(all(f.get("detail") for f in top["factors"]))  # transparent breakdown

    def test_cdr_ipdr_leaderboards_disjoint(self):
        # Core invariant: a subject is never scored in both leaderboards.
        base = datetime(2026, 2, 6, 14, 0)
        recs = [
            cdr("900", "x", base, "T_CHN", *CHENNAI, imei="A"),
            cdr("900", "x", base + timedelta(minutes=18), "T_DEL", *DELHI, imei="B"),
        ]
        sessions = [ipdr("x", "5.9.1.1", base, "T", 13.0, 80.0, port=9050, proto="TCP")]
        sessions[0].source_ip = "198.51.100.7"
        rep = inf.run_all(recs, sessions)
        cdr_subs = {r["subject"] for r in rep["cdr"]["risk"]}
        ipdr_subs = {r["subject"] for r in rep["ipdr"]["risk"]}
        self.assertTrue(cdr_subs)
        self.assertIn("198.51.100.7", ipdr_subs)
        self.assertEqual(cdr_subs & ipdr_subs, set())


class NetworkStructureTests(unittest.TestCase):
    def _bridge(self):
        # Two triangles joined only through hub 'H' — H is the cut-vertex/broker.
        base = datetime(2026, 3, 1, 9, 0)
        c = lambda a, b: cdr(a, b, base, "T", 13.0, 80.0)
        return [c("A", "B"), c("B", "C"), c("A", "C"),
                c("D", "E"), c("E", "F"), c("D", "F"),
                c("C", "H"), c("H", "D")]

    def test_articulation_and_broker(self):
        net = inf.network_structure(self._bridge())
        self.assertIn("H", {a["subject"] for a in net["articulation_points"]})
        self.assertIn("H", {b["subject"] for b in net["brokers"]})

    def test_relay_chain_detected(self):
        base = datetime(2026, 3, 1, 9, 0)
        recs = [cdr("A", "B", base, "T", 13.0, 80.0),
                cdr("B", "C", base + timedelta(minutes=5), "T", 13.0, 80.0)]
        chains = {(c["a"], c["b"], c["c"]) for c in inf.network_structure(recs)["relay_chains"]}
        self.assertIn(("A", "B", "C"), chains)

    def test_reciprocity_one_way(self):
        base = datetime(2026, 3, 1, 9, 0)
        recs = [cdr("A", "B", base + timedelta(minutes=i), "T", 13.0, 80.0) for i in range(4)]
        ow = {(r["caller"], r["callee"]) for r in inf.network_structure(recs)["reciprocity"]}
        self.assertIn(("A", "B"), ow)

    def test_broker_becomes_risk_factor(self):
        rep = inf.run_all(self._bridge(), [])
        risk = {r["subject"]: r for r in rep["cdr"]["risk"]}
        self.assertIn("H", risk)
        names = [f["name"] for f in risk["H"]["factors"]]
        self.assertTrue("Network broker" in names or "Network cut-point" in names)


class TemporalTests(unittest.TestCase):
    def _events(self, daycounts, start=datetime(2026, 1, 1, 10, 0)):
        recs = []
        for day, count in enumerate(daycounts):
            for k in range(count):
                recs.append(cdr("S", "P", start + timedelta(days=day, minutes=k), "T", 13.0, 80.0))
        return inf.build_subject_streams(recs)["S"]

    def test_escalation_trend_not_single_spike(self):
        # rising trend: 1,1,2,2 -> 5,6,7,8  (recent half well above earlier half)
        self.assertIsNotNone(inf.escalation(self._events([1, 1, 2, 2, 5, 6, 7, 8])))
        # one isolated spike on otherwise-flat activity is NOT escalation
        self.assertIsNone(inf.escalation(self._events([1, 1, 1, 1, 1, 9])))
        # too little history
        self.assertIsNone(inf.escalation(self._events([5, 6])))

    def test_dormancy_reactivation(self):
        base = datetime(2026, 1, 1, 10, 0)
        recs = [cdr("S", "P", base, "T", 13.0, 80.0),
                cdr("S", "P", base + timedelta(hours=1), "T", 13.0, 80.0),
                cdr("S", "P", base + timedelta(days=30), "T", 13.0, 80.0),
                cdr("S", "P", base + timedelta(days=30, hours=1), "T", 13.0, 80.0)]
        d = inf.dormancy_reactivation(inf.build_subject_streams(recs)["S"])
        self.assertIsNotNone(d)
        self.assertGreaterEqual(d["dormant_days"], 14)

    def test_first_contacts_ranked_recent_first(self):
        base = datetime(2026, 1, 1, 10, 0)
        recs = [cdr("A", "B", base, "T", 13.0, 80.0),
                cdr("C", "D", base + timedelta(days=10), "T", 13.0, 80.0)]
        fc = inf.first_contacts(recs)
        self.assertEqual((fc[0]["subject_a"], fc[0]["subject_b"]), ("C", "D"))  # most recent first

    def test_escalation_feeds_risk(self):
        base = datetime(2026, 1, 1, 10, 0)
        recs = []
        for day, count in enumerate([1, 1, 2, 2, 6, 7, 8, 9]):
            for k in range(count):
                recs.append(cdr("S", "P", base + timedelta(days=day, minutes=k), "T", 13.0, 80.0))
        risk = {r["subject"]: r for r in inf.run_all(recs, [])["cdr"]["risk"]}
        self.assertIn("S", risk)
        self.assertIn("Escalating activity", [f["name"] for f in risk["S"]["factors"]])


class IpdrAnalyticsTests(unittest.TestCase):
    MB = 1024 * 1024

    def _ips(self, src, dst, when, port=443, up=1000, down=2000):
        r = ipdr("x", dst, when, "T", 13.0, 80.0, port=port, up=up, down=down)
        r.source_ip = src
        return r

    def test_volume_exfil_asymmetry(self):
        base = datetime(2026, 4, 1, 10, 0)
        recs = [self._ips("10.0.0.5", "8.8.8.8", base, up=80 * self.MB, down=1 * self.MB),   # exfil-shaped
                self._ips("10.0.0.6", "8.8.8.8", base, up=1 * self.MB, down=80 * self.MB)]   # download-heavy
        by = {s["source_ip"]: s for s in inf.ipdr_volume(recs)["subjects"]}
        self.assertTrue(by["10.0.0.5"]["exfil_suspected"])
        self.assertFalse(by["10.0.0.6"]["exfil_suspected"])
        self.assertEqual(inf.ipdr_volume(recs)["byte_coverage"], 1.0)

    def test_beaconing_regular_vs_irregular(self):
        base = datetime(2026, 4, 1, 0, 0)
        regular = [self._ips("10.0.0.9", "5.5.5.5", base + timedelta(hours=2 * i), port=4444) for i in range(6)]
        b = inf.beaconing(regular)
        self.assertTrue(any(x["source_ip"] == "10.0.0.9" and x["non_web_port"] for x in b))
        irregular = [self._ips("10.0.0.10", "6.6.6.6", base + timedelta(hours=h)) for h in (0, 0.1, 5, 5.05, 30)]
        self.assertFalse(any(x["source_ip"] == "10.0.0.10" for x in inf.beaconing(irregular)))

    def test_rare_destination(self):
        base = datetime(2026, 4, 1, 10, 0)
        recs = [self._ips("10.0.0.1", "8.8.8.8", base), self._ips("10.0.0.2", "8.8.8.8", base),
                self._ips("10.0.0.3", "8.8.8.8", base),   # 8.8.8.8 common (3 sources)
                # 5.5.5.5 unique to 10.0.0.1 AND visited repeatedly (>=3) -> a real lead
                self._ips("10.0.0.1", "5.5.5.5", base),
                self._ips("10.0.0.1", "5.5.5.5", base + timedelta(hours=1)),
                self._ips("10.0.0.1", "5.5.5.5", base + timedelta(hours=2)),
                # 9.9.9.9 unique but visited ONCE -> normal browsing, must NOT be flagged
                self._ips("10.0.0.1", "9.9.9.9", base)]
        by = {x["source_ip"]: x for x in inf.destination_profile(recs)}
        rare = {r["destination_ip"] for r in by["10.0.0.1"]["rare"]}
        self.assertIn("5.5.5.5", rare)
        self.assertNotIn("8.8.8.8", rare)   # common destination
        self.assertNotIn("9.9.9.9", rare)   # unique but one-off (would be a false positive)

    def test_web_port_beacon_not_in_risk(self):
        # A regular cadence to a web port (443) is usually benign app sync — detected for
        # review, but it must NOT inflate the risk score (false-positive guard).
        base = datetime(2026, 4, 1, 0, 0)
        recs = [self._ips("10.0.0.11", "9.9.9.9", base + timedelta(hours=2 * i), port=443) for i in range(6)]
        rep = inf.run_all([], recs)
        self.assertTrue(any(b["source_ip"] == "10.0.0.11" for b in rep["ipdr"]["beaconing"]))  # shown
        self.assertNotIn("10.0.0.11", {r["subject"] for r in rep["ipdr"]["risk"]})              # not scored

    def test_exfil_and_beacon_feed_ipdr_risk(self):
        base = datetime(2026, 4, 1, 0, 0)
        recs = [self._ips("10.0.0.5", "8.8.8.8", base + timedelta(minutes=1), up=80 * self.MB, down=1 * self.MB)]
        recs += [self._ips("10.0.0.9", "5.5.5.5", base + timedelta(hours=2 * i), port=4444) for i in range(6)]
        risk = {r["subject"]: r for r in inf.run_all([], recs)["ipdr"]["risk"]}
        self.assertIn("Possible exfiltration", [f["name"] for f in risk["10.0.0.5"]["factors"]])
        self.assertIn("Beaconing", [f["name"] for f in risk["10.0.0.9"]["factors"]])


class GeospatialTests(unittest.TestCase):
    def test_tower_dwell_and_mobility(self):
        base = datetime(2026, 5, 1, 8, 0)
        # 3h at T_CHN, then move to T_DEL
        recs = [cdr("S", "x", base, "T_CHN", *CHENNAI),
                cdr("S", "x", base + timedelta(hours=3), "T_CHN", *CHENNAI),
                cdr("S", "x", base + timedelta(hours=4), "T_DEL", *DELHI)]
        ev = inf.build_subject_streams(recs)["S"]
        dwell = inf.tower_dwell(ev)
        self.assertEqual(dwell[0]["tower_id"], "T_CHN")
        self.assertGreaterEqual(dwell[0]["dwell_hours"], 3.0)
        self.assertEqual(inf.mobility_class(ev)["class"], "highly mobile")  # Chennai->Delhi leg

    def test_stationary_classification(self):
        base = datetime(2026, 5, 1, 8, 0)
        recs = [cdr("S", "x", base + timedelta(hours=i), "T_ONE", *CHENNAI) for i in range(4)]
        self.assertEqual(inf.mobility_class(inf.build_subject_streams(recs)["S"])["class"], "stationary")

    def test_shared_routes_detected(self):
        base = datetime(2026, 5, 1, 8, 0)
        seq = ["T1", "T2", "T3", "T4", "T5"]  # 3 shared tower-triples (>= ROUTE_MIN_SHARED)
        coords = {"T1": CHENNAI, "T2": DELHI, "T3": MUMBAI_T, "T4": CHENNAI, "T5": DELHI}
        recs = []
        for who in ("A", "B"):
            for i, tw in enumerate(seq):
                recs.append(cdr(who, "x", base + timedelta(hours=i), tw, *coords[tw]))
        streams = inf.build_subject_streams(recs)
        routes = inf.shared_routes(streams)
        self.assertTrue(any({r["subject_a"], r["subject_b"]} == {"A", "B"} for r in routes))

    def test_shared_route_feeds_risk(self):
        base = datetime(2026, 5, 1, 8, 0)
        seq = ["T1", "T2", "T3", "T4", "T5"]  # 3 shared tower-triples (>= ROUTE_MIN_SHARED)
        coords = {"T1": CHENNAI, "T2": DELHI, "T3": MUMBAI_T, "T4": CHENNAI, "T5": DELHI}
        recs = []
        for who in ("A", "B"):
            for i, tw in enumerate(seq):
                recs.append(cdr(who, "x", base + timedelta(hours=i), tw, *coords[tw]))
        risk = {r["subject"]: r for r in inf.run_all(recs, [])["cdr"]["risk"]}
        self.assertIn("Shared travel route", [f["name"] for f in risk["A"]["factors"]])


class CrossCuttingTests(unittest.TestCase):
    def test_entity_resolution_transitive(self):
        base = datetime(2026, 6, 1, 9, 0)
        # A&B share IMEI1; B&C share IMEI2 -> one transitive actor {A,B,C}
        recs = [cdr("A", "x", base, "T", 13.0, 80.0, imei="IMEI1"),
                cdr("B", "x", base, "T", 13.0, 80.0, imei="IMEI1"),
                cdr("B", "x", base, "T", 13.0, 80.0, imei="IMEI2"),
                cdr("C", "x", base, "T", 13.0, 80.0, imei="IMEI2")]
        ents = inf.resolve_entities(recs)
        self.assertTrue(any(set(e["numbers"]) == {"A", "B", "C"} for e in ents))

    def test_apply_watchlist_forces_critical(self):
        report = {"cdr": {"risk": [{"subject": "900", "score": 20, "band": "low", "events": 5, "factors": []}]},
                  "ipdr": {"risk": [{"subject": "1.2.3.4", "score": 12, "band": "low", "events": 3, "factors": []}]}}
        hits = inf.apply_watchlist(report, phones=["900"], ips=["1.2.3.4"])
        self.assertEqual(len(hits), 2)
        top = report["cdr"]["risk"][0]
        self.assertEqual((top["band"], top["score"]), ("critical", 100))
        self.assertEqual(top["factors"][0]["name"], "Watchlist match")
        # CDR phone never matches the IP watchlist and vice-versa
        self.assertEqual(report["ipdr"]["risk"][0]["band"], "critical")

    def test_report_markdown_sections(self):
        rep = inf.run_all([cdr("900", "x", datetime(2026, 6, 1, 9, 0), "T", 13.0, 80.0)], [])
        md = inf.report_markdown(rep, case_name="Operation Falcon")
        for needle in ("# ARGUS", "Operation Falcon", "Persons of interest",
                       "Flagged IP addresses", "## CDR findings", "## IPDR findings"):
            self.assertIn(needle, md)


if __name__ == "__main__":
    unittest.main()
