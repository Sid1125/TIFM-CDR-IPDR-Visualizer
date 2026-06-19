"""Ground-truth metrics + regression tests for the service-attribution engine.

Run as a test:      python -m unittest tests.test_attribution
Run as a report:    python -m tests.test_attribution   (prints accuracy by category)

The labeled fixtures below are deliberately small and hand-verified. They turn
"is attribution better?" into a measured number (overall accuracy + per-category
breakdown) instead of an assertion, and they lock in the bug fixes (duplicate port
keys, ephemeral-source-port guard, LPM, carrier/CGNAT handling).
"""
from __future__ import annotations

import types
import unittest

from app.services.service_attribution_service import attribute_service, summarize_services


def rec(**kw):
    base = dict(
        source_ip=None, destination_ip=None, source_port=None, destination_port=None,
        protocol=None, bytes_uploaded=None, bytes_downloaded=None,
    )
    base.update(kw)
    return types.SimpleNamespace(**base)


# (label, record, check) where check(result) -> bool
FIXTURES = [
    # --- IP / provider layer ---
    ("meta_ip",        rec(destination_ip="157.240.1.1", destination_port=443, protocol="TCP"),
        lambda r: r["family"] == "Meta"),
    ("google_dns_ip",  rec(destination_ip="8.8.8.8", destination_port=53, protocol="UDP"),
        lambda r: r["family"] == "Google"),
    ("yandex_ip",      rec(destination_ip="77.88.5.5", destination_port=443, protocol="TCP"),
        lambda r: r["family"] == "Yandex"),
    ("hosting_vultr",  rec(destination_ip="108.61.1.1", destination_port=443, protocol="TCP"),
        lambda r: r["category"] == "hosting"),
    # --- carrier / access network ---
    ("jio_access",     rec(destination_ip="49.40.1.2", destination_port=443, protocol="TCP"),
        lambda r: r["category"] == "access_network" and "Jio" in r["service"]),
    ("meta_beats_jio", rec(source_ip="49.40.1.2", destination_ip="157.240.1.1", destination_port=443, protocol="TCP"),
        lambda r: r["family"] == "Meta"),
    ("bsnl_keeps_dns", rec(source_ip="117.200.1.1", destination_ip="9.9.9.9", destination_port=53, protocol="UDP"),
        lambda r: r["family"] == "DNS"),
    # --- private / CGNAT ---
    ("cgnat_dst",      rec(destination_ip="100.70.1.1", destination_port=443, protocol="TCP"),
        lambda r: r["category"] == "internal" and "CGNAT" in r["service"]),
    ("private_dst",    rec(destination_ip="192.168.1.5", destination_port=445, protocol="TCP"),
        lambda r: r["category"] == "internal"),
    # --- port layer ---
    ("dns_port",       rec(destination_port=53, protocol="UDP"),
        lambda r: r["family"] == "DNS"),
    ("whatsapp_stun",  rec(destination_port=3478, protocol="UDP"),
        lambda r: r["family"] == "WhatsApp"),
    ("vpn_port",       rec(destination_ip="45.10.20.30", destination_port=51820, protocol="UDP"),
        lambda r: r["category"] == "vpn"),
    ("tor_port",       rec(destination_ip="45.10.20.30", destination_port=9050, protocol="TCP"),
        lambda r: r["category"] == "anonymization"),
    ("smtp_port",      rec(destination_port=587, protocol="TCP"),
        lambda r: r["family"] == "Mail"),
    # --- regression: duplicate keys resolved correctly ---
    ("mongodb_27017",  rec(destination_port=27017, protocol="TCP"),
        lambda r: r["family"] == "Database"),
    ("git_9418",       rec(destination_port=9418, protocol="TCP"),
        lambda r: r["family"] == "Development"),
    # --- regression: ephemeral source port must not masquerade as Teams/Discord ---
    ("ephemeral_src",  rec(source_port=50005, destination_ip="45.10.20.30", destination_port=443, protocol="TCP"),
        lambda r: "Teams" not in r["service"] and "Discord" not in r["service"]),
]


def evaluate():
    """Return (overall_accuracy, per_category_dict, failures)."""
    correct = 0
    failures = []
    by_cat = {}
    for label, record, check in FIXTURES:
        result = attribute_service(record)
        ok = bool(check(result))
        cat = result.get("category", "?")
        bucket = by_cat.setdefault(cat, [0, 0])
        bucket[1] += 1
        if ok:
            correct += 1
            bucket[0] += 1
        else:
            failures.append((label, result["service"], result.get("category")))
    return correct / len(FIXTURES), by_cat, failures


class AttributionMetrics(unittest.TestCase):
    def test_overall_accuracy(self):
        accuracy, _by_cat, failures = evaluate()
        self.assertGreaterEqual(accuracy, 0.95, f"accuracy {accuracy:.0%}; failures: {failures}")

    def test_every_result_has_required_keys(self):
        for label, record, _check in FIXTURES:
            r = attribute_service(record)
            for key in ("service", "subtype", "confidence", "family", "category", "evidence"):
                self.assertIn(key, r, f"{label} missing {key}")

    def test_summary_aggregates_keys_and_bytes(self):
        recs = [
            rec(destination_ip="157.240.1.1", destination_port=443, protocol="TCP", bytes_downloaded=50000),
            rec(destination_port=53, protocol="UDP", bytes_downloaded=900),
            rec(destination_port=53, protocol="UDP", bytes_downloaded=1100),
        ]
        summary = summarize_services(recs)
        dns = next(s for s in summary if s["service"] == "Likely DNS")
        self.assertEqual(dns["count"], 2)
        self.assertEqual(dns["total_bytes"], 2000)
        self.assertIn("family", dns)


if __name__ == "__main__":
    acc, by_cat, fails = evaluate()
    print(f"Service-attribution accuracy: {acc:.0%} ({len(FIXTURES)} labeled cases)")
    print("By category:")
    for cat, (ok, total) in sorted(by_cat.items()):
        print(f"  {cat:<14} {ok}/{total}")
    if fails:
        print("Failures:")
        for label, svc, cat in fails:
            print(f"  {label}: got {svc} [{cat}]")
