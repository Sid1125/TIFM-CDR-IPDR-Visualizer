"""Tests for the Telecom Intelligence Copilot (TIFM) AI module."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.ai.dataset_generator import generate_synthetic_case
from app.ai.finetune_scaffold import export_to_jsonl, format_training_example, generate_peft_guide
from app.ai.agents import (
    ServiceAttributionAgent,
    IdentityAgent,
    MovementAgent,
    NetworkAgent,
    ReportAgent,
)
from app.ai.investigator import (
    PoliceInvestigator,
    SessionAnalyzer,
    CommunicationPatternAnalyzer,
    TemporalAnalyzer,
    LocationIntelligenceAnalyzer,
    SocialNetworkAnalyzer,
    IdentityDeepAnalyzer,
    AnomalyDetector,
    GapAnalyzer,
    CallDetailAnalyzer,
    HierarchicalAnalyzer,
    CorrelationAnalyzer,
    EvidenceAggregator,
)

# Knowledge base path used by agents
KB_PATH = Path(Path(__file__).parent.parent / "app" / "ai" / "knowledge_base.json")


class TestKnowledgeBase(unittest.TestCase):
    """Verify knowledge_base.json is valid and has expected structure."""

    def setUp(self):
        with open(KB_PATH, encoding="utf-8") as f:
            self.kb = json.load(f)

    def test_kb_is_dict(self):
        self.assertIsInstance(self.kb, dict)

    def test_kb_has_whatsapp(self):
        self.assertIn("whatsapp", self.kb)

    def test_kb_entries_have_required_fields(self):
        for key, entry in self.kb.items():
            with self.subTest(entry=key):
                self.assertIn("name", entry)
                self.assertIn("ports", entry)
                self.assertIn("protocols", entry)
                self.assertIn("base_confidence", entry)
                self.assertIsInstance(entry["ports"], list)
                self.assertIsInstance(entry["protocols"], list)

    def test_kb_base_confidence_in_range(self):
        for key, entry in self.kb.items():
            with self.subTest(entry=key):
                self.assertGreaterEqual(entry["base_confidence"], 0)
                self.assertLessEqual(entry["base_confidence"], 100)


class TestDatasetGenerator(unittest.TestCase):
    """Verify synthetic case generation produces valid data."""

    def test_generate_criminal_scenario(self):
        data = generate_synthetic_case(scenario="criminal")
        self.assertIn("cdr", data)
        self.assertIn("ipdr", data)
        self.assertIn("towers", data)
        self.assertGreater(len(data["cdr"]), 0)
        self.assertGreater(len(data["ipdr"]), 0)
        self.assertGreater(len(data["towers"]), 0)

    def test_generate_drug_scenario(self):
        data = generate_synthetic_case(scenario="drug")
        self.assertGreater(len(data["cdr"]), 0)
        self.assertGreater(len(data["ipdr"]), 0)

    def test_generate_scam_scenario(self):
        data = generate_synthetic_case(scenario="scam")
        self.assertGreater(len(data["cdr"]), 0)
        self.assertGreater(len(data["ipdr"]), 0)

    def test_generate_human_trafficking_scenario(self):
        data = generate_synthetic_case(scenario="human_trafficking")
        self.assertGreater(len(data["cdr"]), 0)
        self.assertGreater(len(data["ipdr"]), 0)
        # Trafficker should have device cycling
        subjects = set(r["subject"] for r in data["cdr"])
        self.assertIn("+916666666601", subjects)

    def test_generate_financial_fraud_scenario(self):
        data = generate_synthetic_case(scenario="financial_fraud")
        self.assertGreater(len(data["cdr"]), 0)
        self.assertGreater(len(data["ipdr"]), 0)
        # Kingpin + multiple operators
        kingpin_records = [r for r in data["cdr"] if r["subject"] == "+915555555501"]
        self.assertGreater(len(kingpin_records), 0)

    def test_generate_default_scenario(self):
        data = generate_synthetic_case(scenario="unknown")
        self.assertGreater(len(data["cdr"]), 0)

    def test_cdr_records_have_required_fields(self):
        data = generate_synthetic_case(scenario="criminal")
        for rec in data["cdr"]:
            with self.subTest(rec_id=rec.get("id")):
                self.assertIn("timestamp", rec)
                self.assertIn("subject", rec)
                self.assertIn("counterpart", rec)
                self.assertIn("duration", rec)
                self.assertIn("tower_id", rec)
                self.assertIn("imsi", rec)
                self.assertIn("imei", rec)

    def test_ipdr_records_have_required_fields(self):
        data = generate_synthetic_case(scenario="criminal")
        for rec in data["ipdr"]:
            with self.subTest(rec_id=rec.get("id")):
                self.assertIn("timestamp", rec)
                self.assertIn("subject", rec)
                self.assertIn("protocol", rec)
                self.assertIn("rat", rec)

    def test_towers_have_required_fields(self):
        data = generate_synthetic_case(scenario="criminal")
        for t in data["towers"]:
            with self.subTest(tower=t.get("tower_id")):
                self.assertIn("tower_id", t)
                self.assertIn("lat", t)
                self.assertIn("lng", t)


class TestServiceAttributionAgent(unittest.TestCase):
    """Verify the ServiceAttributionAgent correctly maps ports to apps."""

    def setUp(self):
        self.agent = ServiceAttributionAgent()

    def test_agent_loaded_knowledge_base(self):
        self.assertGreater(len(self.agent.kb), 0)

    def test_detect_whatsapp_by_port(self):
        records = [
            {"destination_port": 3478, "protocol": "UDP", "source_port": 45000},
        ]
        result = self.agent.analyze(records)
        self.assertIn("WhatsApp", result)

    def test_detect_telegram_by_port(self):
        records = [
            {"destination_port": 443, "protocol": "TCP", "source_port": 35000},
        ]
        result = self.agent.analyze(records)
        self.assertIn("Telegram", result)

    def test_empty_records(self):
        result = self.agent.analyze([])
        self.assertEqual(result, {})

    def test_no_match_returns_empty(self):
        records = [
            {"destination_port": 99999, "protocol": "UNKNOWN", "source_port": 11111},
        ]
        result = self.agent.analyze(records)
        self.assertEqual(result, {})


class TestIdentityAgent(unittest.TestCase):
    """Verify the IdentityAgent detects SIM/device changes."""

    def setUp(self):
        self.agent = IdentityAgent()

    def test_sim_swap_detection(self):
        records = [
            {"subject": "user1", "imsi": "IMSI_A", "imei": "IMEI_1", "timestamp": "2026-01-01T10:00:00"},
            {"subject": "user1", "imsi": "IMSI_B", "imei": "IMEI_1", "timestamp": "2026-01-02T10:00:00"},
        ]
        result = self.agent.analyze(records)
        self.assertIn("user1", result)
        self.assertEqual(len(result["user1"]["sim_swaps"]), 1)

    def test_device_change_detection(self):
        records = [
            {"subject": "user2", "imsi": "IMSI_X", "imei": "IMEI_1", "timestamp": "2026-01-01T10:00:00"},
            {"subject": "user2", "imsi": "IMSI_X", "imei": "IMEI_2", "timestamp": "2026-01-02T10:00:00"},
        ]
        result = self.agent.analyze(records)
        self.assertIn("user2", result)
        self.assertEqual(len(result["user2"]["device_changes"]), 1)

    def test_no_change_with_same_identity(self):
        records = [
            {"subject": "user3", "imsi": "IMSI_C", "imei": "IMEI_3", "timestamp": "2026-01-01T10:00:00"},
            {"subject": "user3", "imsi": "IMSI_C", "imei": "IMEI_3", "timestamp": "2026-01-02T10:00:00"},
        ]
        result = self.agent.analyze(records)
        self.assertEqual(len(result["user3"]["sim_swaps"]), 0)
        self.assertEqual(len(result["user3"]["device_changes"]), 0)

    def test_empty_records(self):
        result = self.agent.analyze([])
        self.assertEqual(result, {})

    def test_burner_score_high_with_many_pairs(self):
        records = [
            {"subject": "burner", "imsi": f"IMSI_{i}", "imei": f"IMEI_{i}", "timestamp": f"2026-01-{i+1:02d}T10:00:00"}
            for i in range(10)
        ]
        result = self.agent.analyze(records)
        self.assertGreater(result["burner"]["burner_score"], 30)


class TestMovementAgent(unittest.TestCase):
    """Verify the MovementAgent classifies towers and detects meetings."""

    def setUp(self):
        self.agent = MovementAgent()

    def test_home_tower_identified(self):
        records = [
            {"subject": "sub1", "tower_id": "TWR01", "timestamp": "2026-01-01T20:00:00"},
            {"subject": "sub1", "tower_id": "TWR01", "timestamp": "2026-01-02T21:00:00"},
            {"subject": "sub1", "tower_id": "TWR02", "timestamp": "2026-01-02T10:00:00"},
        ]
        result = self.agent.analyze(records)
        movement = result["subjects_movement"]["sub1"]
        self.assertEqual(movement["home_tower"], "TWR01")
        self.assertEqual(movement["work_tower"], "TWR02")

    def test_meeting_detection(self):
        records = [
            {"subject": "subA", "tower_id": "TWR01", "timestamp": "2026-01-01T10:00:00"},
            {"subject": "subB", "tower_id": "TWR01", "timestamp": "2026-01-01T10:30:00"},
        ]
        result = self.agent.analyze(records)
        meetings = result["detected_meetings"]
        self.assertEqual(len(meetings), 1)
        self.assertEqual(meetings[0]["subject_a"], "subA")
        self.assertEqual(meetings[0]["subject_b"], "subB")
        self.assertLessEqual(meetings[0]["gap_minutes"], 60)

    def test_no_meeting_when_different_towers(self):
        records = [
            {"subject": "subA", "tower_id": "TWR01", "timestamp": "2026-01-01T10:00:00"},
            {"subject": "subB", "tower_id": "TWR02", "timestamp": "2026-01-01T10:30:00"},
        ]
        result = self.agent.analyze(records)
        self.assertEqual(len(result["detected_meetings"]), 0)

    def test_no_meeting_when_same_subject(self):
        records = [
            {"subject": "subA", "tower_id": "TWR01", "timestamp": "2026-01-01T10:00:00"},
            {"subject": "subA", "tower_id": "TWR01", "timestamp": "2026-01-01T10:30:00"},
        ]
        result = self.agent.analyze(records)
        meetings = result["detected_meetings"]
        # Same subject shouldn't self-match
        self.assertEqual(len(meetings), 0)


class TestNetworkAgent(unittest.TestCase):
    """Verify the NetworkAgent computes centrality and communities."""

    def setUp(self):
        self.agent = NetworkAgent()

    def test_basic_graph_construction(self):
        records = [
            {"subject": "A", "counterpart": "B"},
            {"subject": "B", "counterpart": "C"},
            {"subject": "A", "counterpart": "C"},
        ]
        result = self.agent.analyze(records)
        self.assertEqual(result["nodes_count"], 3)
        self.assertEqual(result["edges_count"], 3)

    def test_kingpin_identification(self):
        # A is connected to everyone -> high degree centrality
        records = [{"subject": "A", "counterpart": x} for x in ["B", "C", "D", "E", "F"]]
        records += [{"subject": "B", "counterpart": "C"}, {"subject": "D", "counterpart": "E"}]
        result = self.agent.analyze(records)
        kingpin = result["centrality_metrics"].get("A", {})
        self.assertIn(kingpin.get("inferred_role", ""), ["Kingpin / Coordinator", "Hub Node / Lieutenant"])

    def test_empty_records(self):
        result = self.agent.analyze([])
        self.assertEqual(result["nodes_count"], 0)


class TestReportAgent(unittest.TestCase):
    """Verify the ReportAgent produces correct markdown formatting."""

    def setUp(self):
        self.agent = ReportAgent()

    def test_report_contains_sections(self):
        analytics = {
            "attribution": {"WhatsApp": {"count": 10, "confidence": 92, "evidence": ["Port match"]}},
            "identity": {"sub1": {"sim_swaps": [], "device_changes": [], "burner_score": 0, "is_suspected_burner": False}},
            "movement": {"subjects_movement": {}, "detected_meetings": []},
            "network": {"nodes_count": 5, "edges_count": 8, "network_density": 0.4, "centrality_metrics": {}, "communities": []},
        }
        report = self.agent.generate(analytics)
        self.assertIn("DIGITAL FORENSICS INVESTIGATION REPORT", report)
        self.assertIn("Executive Summary", report)
        self.assertIn("Application Usage", report)

    def test_report_with_empty_data(self):
        analytics = {
            "attribution": {},
            "identity": {},
            "movement": {"subjects_movement": {}, "detected_meetings": []},
            "network": {"nodes_count": 0, "edges_count": 0, "network_density": 0, "centrality_metrics": {}, "communities": []},
        }
        report = self.agent.generate(analytics)
        self.assertIn("No network metrics calculated", report)
        self.assertIn("No active SIM swaps", report)
        self.assertIn("No physical co-location meetings", report)
        self.assertIn("No application signatures mapped", report)


class TestFinetuneScaffold(unittest.TestCase):
    """Verify training data formatting utilities."""

    def test_format_training_example(self):
        summary = {
            "total_records": 50,
            "unique_contacts": 10,
            "unique_towers": 5,
            "sim_swaps": 2,
            "device_changes": 1,
            "night_activity_pct": 60,
            "top_contacts": ["user1", "user2"],
            "top_services": ["WhatsApp", "Telegram"],
        }
        example = format_training_example("test_subject", summary, "Analysis report text")
        self.assertIn("instruction", example)
        self.assertIn("input", example)
        self.assertIn("output", example)
        self.assertEqual(example["output"], "Analysis report text")

    def test_generate_peft_guide_contains_keywords(self):
        guide = generate_peft_guide()
        self.assertIn("QLoRA", guide)
        self.assertIn("LoraConfig", guide)
        self.assertIn("SFTTrainer", guide)

    def test_export_to_jsonl(self):
        records = [
            {"subject": "sub1", "counterpart": "cnt1", "tower_id": "TWR01", "timestamp": "2026-01-01T10:00:00", "service": "Voice"},
            {"subject": "sub1", "counterpart": "cnt2", "tower_id": "TWR02", "timestamp": "2026-01-01T23:00:00", "service": "WhatsApp"},
            {"subject": "sub2", "counterpart": "cnt1", "tower_id": "TWR01", "timestamp": "2026-01-01T15:00:00", "service": "Telegram"},
        ]
        output_path = Path(Path(__file__).parent / "_test_train.jsonl")
        count = export_to_jsonl(records, output_path)
        self.assertEqual(count, 2)  # 2 unique subjects
        self.assertTrue(output_path.exists())
        lines = output_path.read_text(encoding="utf-8").strip().split("\n")
        self.assertEqual(len(lines), 2)
        output_path.unlink()


class TestPoliceInvestigator(unittest.TestCase):
    """Tests for the comprehensive PoliceInvestigator module."""

    def setUp(self):
        self.inv = PoliceInvestigator()
        self.data = generate_synthetic_case(scenario="financial_fraud")
        self.cdr = self.data["cdr"]
        self.ipdr = self.data["ipdr"]
        self.all_records = self.cdr + self.ipdr
        # Build towers lookup
        self.towers = {}
        for r in self.all_records:
            tid = r.get("tower_id")
            if tid and tid not in self.towers:
                self.towers[tid] = {"tower_id": tid, "lat": r.get("lat"), "lng": r.get("lng")}

    def _result(self):
        return self.inv.investigate(self.cdr, self.ipdr, self.towers)

    # ── Individual Modules ──

    def test_session_analyzer(self):
        r = SessionAnalyzer().analyze(self.all_records, self.towers)
        self.assertGreater(r["total_sessions"], 0)
        self.assertGreater(r["subjects_analyzed"], 0)
        for sub, data in r["by_subject"].items():
            self.assertIn("total_sessions", data)
            self.assertIn("avg_calls_per_session", data)
            self.assertIsInstance(data["sessions"], list)

    def test_communication_pattern_analyzer(self):
        r = CommunicationPatternAnalyzer().analyze(self.all_records)
        self.assertGreater(r["total_pairs_analyzed"], 0)
        for sub, data in r["by_subject"].items():
            self.assertIn("total_calls", data)
            self.assertIn("in_out_ratio", data)
            self.assertIn("top_contacts", data)
            self.assertIsInstance(data["unique_contacts"], int)

    def test_calling_circles(self):
        r = CommunicationPatternAnalyzer().analyze(self.all_records)
        self.assertIsInstance(r["calling_circles"], list)

    def test_temporal_analyzer(self):
        r = TemporalAnalyzer().analyze(self.all_records)
        self.assertGreater(r["total_records"], 0)
        self.assertIn("hourly_distribution", r)
        self.assertIn("day_of_week", r)
        self.assertIn("night_activity_ratio", r)
        self.assertIn("subject_profiles", r)
        self.assertIn("activity_trend", r)

    def test_location_analyzer(self):
        r = LocationIntelligenceAnalyzer().analyze(self.all_records, self.towers)
        self.assertGreater(r["total_subjects_analyzed"], 0)
        self.assertIsInstance(r["geo_hotspots"], list)
        for sub, data in r["by_subject"].items():
            self.assertIn("total_locations", data)
            self.assertIn("frequent_locations", data)
            self.assertIn("location_entropy", data)

    def test_social_network_analyzer(self):
        r = SocialNetworkAnalyzer().analyze(self.all_records)
        self.assertGreater(r["nodes"], 0)
        self.assertGreater(r["edges"], 0)
        self.assertIn("density", r)
        self.assertIn("reciprocity", r)
        self.assertIn("structural_roles", r)
        self.assertIsInstance(r["critical_bridges"], list)

    def test_identity_deep_analyzer(self):
        r = IdentityDeepAnalyzer().analyze(self.all_records)
        self.assertGreater(r["total_subjects_analyzed"], 0)
        for sub, data in r["by_subject"].items():
            self.assertIn("unique_imei", data)
            self.assertIn("burner_score", data)
            self.assertIn("sim_swaps", data)
            self.assertIn("device_changes", data)
            self.assertIsInstance(data["findings"], list)

    def test_anomaly_detector(self):
        r = AnomalyDetector().analyze(self.all_records)
        self.assertIn("total_anomalies", r)
        self.assertIn("high_severity_count", r)
        self.assertIsInstance(r["anomalies"], list)

    def test_gap_analyzer(self):
        r = GapAnalyzer().analyze(self.all_records)
        self.assertIsInstance(r["by_subject"], dict)
        self.assertIn("subjects_with_gaps", r)

    def test_call_detail_analyzer(self):
        r = CallDetailAnalyzer().analyze(self.all_records)
        self.assertGreater(r["subjects_analyzed"], 0)
        for sub, data in r["by_subject"].items():
            self.assertIn("short_signal_calls", data)
            self.assertIn("odd_hour_calls", data)
            self.assertIn("call_bursts", data)

    def test_hierarchical_analyzer(self):
        r = HierarchicalAnalyzer().analyze(self.all_records)
        self.assertIn("dominance_scores", r)
        self.assertIn("hierarchy_levels", r)
        self.assertIn("command_chain_summary", r)
        self.assertIsInstance(r["checkin_patterns"], list)

    def test_correlation_analyzer(self):
        r = CorrelationAnalyzer().analyze(self.all_records, self.towers)
        self.assertIsInstance(r["shared_contacts"], list)
        self.assertIsInstance(r["co_locations"], list)

    def test_evidence_aggregator(self):
        ids = IdentityDeepAnalyzer().analyze(self.all_records)
        anoms = AnomalyDetector().analyze(self.all_records)
        gaps = GapAnalyzer().analyze(self.all_records)
        calls = CallDetailAnalyzer().analyze(self.all_records)
        hier = HierarchicalAnalyzer().analyze(self.all_records)
        net = SocialNetworkAnalyzer().analyze(self.all_records)
        loc = LocationIntelligenceAnalyzer().analyze(self.all_records, self.towers)
        corr = CorrelationAnalyzer().analyze(self.all_records, self.towers)
        temp = TemporalAnalyzer().analyze(self.all_records)
        sess = SessionAnalyzer().analyze(self.all_records, self.towers)
        modules = {
            "identity": ids, "anomalies": anoms, "gaps": gaps,
            "call_details": calls, "hierarchy": hier, "social_network": net,
            "location": loc, "correlation": corr, "temporal": temp, "sessions": sess,
        }
        r = EvidenceAggregator().aggregate(modules)
        self.assertGreater(r["total_findings"], 0)
        self.assertIn("by_severity", r)
        self.assertIn("by_category", r)
        self.assertIn("high_priority", r)
        self.assertIn("executive_summary", r)

    # ── Full Investigation Pipeline ──

    def test_full_investigation_pipeline(self):
        r = self._result()
        s = r["summary"]
        self.assertGreater(s["total_records_analyzed"], 0)
        self.assertGreater(s["total_subjects"], 0)
        self.assertGreater(s["total_findings"], 0)
        self.assertGreater(s["modules_executed"], 0)
        for key in ["sessions", "communication_patterns", "temporal_analysis",
                     "location_intelligence", "social_network", "identity_analysis",
                     "anomaly_detection", "gap_analysis", "call_detail_analysis",
                     "hierarchical_analysis", "correlation_analysis", "findings"]:
            self.assertIn(key, r)
        self.assertGreater(len(r["findings"]["high_priority"]), 0)

    def test_investigation_all_scenarios(self):
        for scenario in ["criminal", "drug", "scam", "human_trafficking", "financial_fraud"]:
            data = generate_synthetic_case(scenario=scenario)
            cdr = data["cdr"]
            ipdr = data["ipdr"]
            towers = {}
            for r in cdr + ipdr:
                tid = r.get("tower_id")
                if tid and tid not in towers:
                    towers[tid] = {"tower_id": tid, "lat": r.get("lat"), "lng": r.get("lng")}
            r = self.inv.investigate(cdr, ipdr, towers)
            self.assertGreater(r["summary"]["total_findings"], 0, f"{scenario} failed")
            self.assertGreater(r["social_network"]["nodes"], 0, f"{scenario} social network empty")
            self.assertGreater(r["sessions"]["total_sessions"], 0, f"{scenario} sessions empty")


if __name__ == "__main__":
    unittest.main()
