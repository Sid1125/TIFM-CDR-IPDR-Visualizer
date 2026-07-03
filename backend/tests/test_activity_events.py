"""Activity-event synthesis tests: sessions must come out investigation-shaped —
a human title, participants, fused/explainable confidence, readable evidence —
and the session-level fingerprint must see what per-record classification can't
(a call spread over many small records)."""
from __future__ import annotations

import types
import unittest
from datetime import datetime, timedelta

from app.services.activity_event_service import build_activity_events, synthesize_event
from app.services.investigation_service import reconstruct_ipdr_sessions


def rec(i, base_time, offset_s, **kw):
    defaults = dict(
        case_id="t", msisdn="9998887777", imsi=None, imei=None,
        start_time=base_time + timedelta(seconds=offset_s),
        end_time=base_time + timedelta(seconds=offset_s + kw.pop("span", 50)),
        duration_seconds=None,
        source_ip="100.70.1.9", destination_ip="157.240.1.1",
        source_port=50000 + i, destination_port=3478,
        protocol="UDP", bytes_uploaded=150_000, bytes_downloaded=170_000,
        tower_id="TWR1",
    )
    defaults.update(kw)
    return types.SimpleNamespace(**defaults)


BASE = datetime(2026, 3, 1, 21, 31)


class ActivityEvents(unittest.TestCase):
    def _whatsapp_call_session(self):
        # 27 minutes of steady symmetric UDP/3478 to a Meta IP, 27 records — no single
        # record looks like a call; the session does.
        records = [rec(i, BASE, i * 60) for i in range(27)]
        sessions = reconstruct_ipdr_sessions(records)
        self.assertEqual(len(sessions), 1)
        return sessions[0]

    def test_whatsapp_voice_call_event(self):
        event = synthesize_event(self._whatsapp_call_session())
        self.assertEqual(event["title"], "Probable WhatsApp Voice Call")
        self.assertEqual(event["participants"]["subject"], "9998887777")
        self.assertIn("Meta", event["participants"]["peer_label"] or "")
        self.assertGreaterEqual(event["confidence"], 80)
        self.assertLessEqual(event["confidence"], 96)
        self.assertIn("behavior", event["confidence_parts"])
        joined = " | ".join(event["evidence"])
        self.assertIn("min session", joined)
        self.assertIn("bidirectional", joined)
        self.assertIn("STUN", joined)
        self.assertIn("AS32934", joined)

    def test_session_level_fingerprint_sees_what_records_cannot(self):
        # Each record is ~50s and ~320KB — below the voice-call volume floor individually,
        # so the fingerprint must be firing on the aggregated session, not any single row.
        session = self._whatsapp_call_session()
        self.assertGreater(session["duration_seconds"], 1500)
        event = synthesize_event(session)
        self.assertTrue(any("Behavioral fingerprint" in e for e in event["evidence"]))

    def test_bulk_download_event(self):
        records = [rec(i, BASE, i * 30, destination_ip="45.10.20.30", destination_port=443,
                       protocol="TCP", bytes_uploaded=50_000, bytes_downloaded=40_000_000,
                       span=25) for i in range(8)]
        event = build_activity_events(reconstruct_ipdr_sessions(records))[0]
        self.assertEqual(event["title"], "Probable Large Download")
        self.assertIn("download-heavy", " | ".join(event["evidence"]))

    def test_tiny_session_never_claims_an_app(self):
        # 2 seconds / 300 bytes to an unknown IP on an unmapped port: a keepalive-ish
        # read is honest; a named app (WhatsApp, Zoom, ...) would not be.
        records = [rec(0, BASE, 0, destination_ip="45.10.20.30", destination_port=4999,
                       protocol="TCP", bytes_uploaded=100, bytes_downloaded=200, span=2)]
        event = build_activity_events(reconstruct_ipdr_sessions(records))[0]
        self.assertTrue(event["title"].startswith(("Probable", "Unclassified")))
        for app in ("WhatsApp", "Zoom", "Teams", "Telegram"):
            self.assertNotIn(app, event["title"])
        self.assertLessEqual(event["confidence"], 96)

    def test_access_network_title(self):
        records = [rec(0, BASE, 0, destination_ip="49.40.1.2", destination_port=443,
                       protocol="TCP", span=30)]
        event = build_activity_events(reconstruct_ipdr_sessions(records))[0]
        self.assertIn("Mobile data session", event["title"])

    def test_event_shape(self):
        event = synthesize_event(self._whatsapp_call_session())
        for key in ("kind", "title", "activity", "start", "end", "duration_seconds",
                    "participants", "confidence", "confidence_parts", "evidence",
                    "service", "family", "category", "record_count", "tower_id"):
            self.assertIn(key, event)
        self.assertLessEqual(len(event["evidence"]), 7)


if __name__ == "__main__":
    unittest.main()
