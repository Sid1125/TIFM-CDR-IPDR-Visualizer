"""Generate the attribution engine parity fixtures.

Runs a synthetic-record corpus through the BACKEND engine (attribute_service) and dumps
input + expected-output pairs to scripts/attribution_parity_fixtures.json. The Node harness
(scripts/test_attribution_parity.mjs) then replays the same inputs through the FRONTEND engine
(static/services/attribution.js matchService) and asserts the two agree — the frontend port-
classification layer is a deliberate 1:1 mirror of the backend's, and this is what keeps it one.

Regenerate whenever the backend engine or attribution_data.json changes:
    cd backend && .venv/Scripts/python.exe -m scripts.gen_attribution_parity
then re-run the Node side:
    node scripts/test_attribution_parity.mjs

Compare modes per fixture:
  exact    — service label, subtype, confidence, and category must all match (the port layer).
  access   — carrier/access-network results: label + confidence + category.
  provider — content-IP results: provider identity + category only. The frontend deliberately
             does DEEPER per-service scoring (WhatsApp vs Instagram inside Meta, behavioral
             fingerprints) than the backend's flat "Likely <provider>", so exact labels differ
             by design; what must agree is WHO was contacted and how it's categorised.
"""
from __future__ import annotations

import ipaddress
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.service_attribution_service import attribute_service, _ATTR  # noqa: E402


class _Rec:
    def __init__(self, **kw):
        self.source_ip = kw.get("source_ip")
        self.destination_ip = kw.get("destination_ip")
        self.source_port = kw.get("source_port")
        self.destination_port = kw.get("destination_port")
        self.protocol = kw.get("protocol")
        self.bytes_uploaded = kw.get("bytes_uploaded", 0)
        self.bytes_downloaded = kw.get("bytes_downloaded", 0)


def _sample_ip(provider_name: str) -> str:
    """First usable host inside the provider's first CIDR."""
    for p in _ATTR["providers"]:
        if p["pr"] == provider_name and p.get("ranges"):
            net = ipaddress.ip_network(p["ranges"][0])
            return str(net.network_address + 1)
    raise SystemExit(f"provider {provider_name!r} not found in attribution_data.json")


META = _sample_ip("Meta")
JIO = _sample_ip("Reliance Jio")
DO = _sample_ip("DigitalOcean")
NEUTRAL = "45.10.20.30"  # matches no provider range

# (name, mode, record kwargs)
CASES = [
    # ── Port layer, no IP match (exact parity required) ──
    ("dns_udp_53",          "exact", dict(destination_ip=NEUTRAL, destination_port=53, protocol="UDP")),
    ("wireguard_udp",       "exact", dict(destination_ip=NEUTRAL, destination_port=51820, protocol="UDP")),
    ("tor_socks",           "exact", dict(destination_ip=NEUTRAL, destination_port=9050, protocol="TCP")),
    ("rdp_idle",            "exact", dict(destination_ip=NEUTRAL, destination_port=3389, protocol="TCP", bytes_downloaded=1000)),
    ("rdp_active",          "exact", dict(destination_ip=NEUTRAL, destination_port=3389, protocol="TCP", bytes_downloaded=500_000)),
    ("mongodb_bulk",        "exact", dict(destination_ip=NEUTRAL, destination_port=27018, protocol="TCP", bytes_downloaded=2_000_000)),
    ("mail_submission",     "exact", dict(destination_ip=NEUTRAL, destination_port=587, protocol="TCP")),
    ("whatsapp_stun",       "exact", dict(destination_ip=NEUTRAL, destination_port=3478, protocol="UDP")),
    ("whatsapp_xmpp",       "exact", dict(destination_ip=NEUTRAL, destination_port=5222, protocol="TCP")),
    # Port 3479 (STUN media) reaches the transfer-volume tiers of the WhatsApp classifier
    # (3478/5222/5223/5228 all return early on the port alone, so they never see bytes).
    ("whatsapp_teardown",   "exact", dict(destination_ip=NEUTRAL, destination_port=3479, protocol="UDP", bytes_downloaded=10_000)),
    ("whatsapp_signaling",  "exact", dict(destination_ip=NEUTRAL, destination_port=3479, protocol="UDP", bytes_downloaded=100_000)),
    ("whatsapp_active",     "exact", dict(destination_ip=NEUTRAL, destination_port=3479, protocol="UDP", bytes_downloaded=1_000_000)),
    ("whatsapp_media",      "exact", dict(destination_ip=NEUTRAL, destination_port=3479, protocol="UDP", bytes_downloaded=5_000_000)),
    ("quic_443",            "exact", dict(destination_ip=NEUTRAL, destination_port=443, protocol="UDP")),
    ("quic_8443",           "exact", dict(destination_ip=NEUTRAL, destination_port=8443, protocol="UDP")),
    ("https_plain",         "exact", dict(destination_ip=NEUTRAL, destination_port=443, protocol="TCP")),
    ("http_small",          "exact", dict(destination_ip=NEUTRAL, destination_port=80, protocol="TCP", bytes_downloaded=10_000)),
    ("http_large",          "exact", dict(destination_ip=NEUTRAL, destination_port=80, protocol="TCP", bytes_downloaded=2_000_000)),
    ("sip_tls",             "exact", dict(destination_ip=NEUTRAL, destination_port=5061, protocol="TCP")),
    # Ephemeral handling
    ("ephemeral_only_src",  "exact", dict(destination_ip=NEUTRAL, source_port=50005, protocol="TCP")),
    ("ephemeral_vs_dest",   "exact", dict(destination_ip=NEUTRAL, source_port=50005, destination_port=53, protocol="UDP")),
    # Behavioural fallback (no recognizable port)
    ("udp_stream_heavy",    "exact", dict(destination_ip=NEUTRAL, protocol="UDP", bytes_downloaded=6_000_000)),
    ("udp_media_medium",    "exact", dict(destination_ip=NEUTRAL, protocol="UDP", bytes_downloaded=2_000_000)),
    ("udp_light",           "exact", dict(destination_ip=NEUTRAL, protocol="UDP", bytes_downloaded=1_000)),
    ("tcp_bulk",            "exact", dict(destination_ip=NEUTRAL, protocol="TCP", bytes_downloaded=20_000_000)),
    ("tcp_medium",          "exact", dict(destination_ip=NEUTRAL, protocol="TCP", bytes_downloaded=600_000)),
    ("tcp_light",           "exact", dict(destination_ip=NEUTRAL, protocol="TCP", bytes_downloaded=1_000)),
    ("unknown_protocol",    "exact", dict(destination_ip=NEUTRAL, protocol="ICMP", bytes_downloaded=100)),
    # ── Private / internal destinations ──
    ("private_rdp",         "exact", dict(destination_ip="192.168.1.50", destination_port=3389, protocol="TCP")),
    ("private_generic",     "exact", dict(destination_ip="192.168.1.50", destination_port=443, protocol="TCP")),
    ("cgnat_dest",          "exact", dict(destination_ip="100.70.1.1", destination_port=443, protocol="TCP")),
    ("loopback_dest",       "exact", dict(destination_ip="127.0.0.1", destination_port=8080, protocol="TCP")),
    # ── Carrier (ISP) destinations ──
    ("isp_dns",             "exact",  dict(destination_ip=JIO, destination_port=53, protocol="UDP")),
    ("isp_https",           "access", dict(destination_ip=JIO, destination_port=443, protocol="TCP")),
    ("isp_no_port",         "access", dict(destination_ip=JIO, protocol="TCP")),
    ("isp_source_only",     "access", dict(source_ip=JIO, destination_ip=NEUTRAL, protocol="TCP")),
    # ── Content-provider destinations (frontend goes deeper by design) ──
    ("meta_https",          "provider", dict(destination_ip=META, destination_port=443, protocol="TCP")),
    ("hosting_digitalocean","provider", dict(destination_ip=DO, destination_port=443, protocol="TCP", bytes_downloaded=50_000)),
    # Content IP as SOURCE must not name the service (policy fixture).
    ("meta_src_not_service","exact",  dict(source_ip=META, destination_ip=NEUTRAL, destination_port=9050, protocol="TCP")),
]


def main():
    fixtures = []
    for name, mode, kw in CASES:
        result = attribute_service(_Rec(**kw))
        fixtures.append({
            "name": name,
            "mode": mode,
            "input": {
                "sub": kw.get("source_ip"),
                "cnt": kw.get("destination_ip"),
                "sport": kw.get("source_port"),
                "dport": kw.get("destination_port"),
                "prot": kw.get("protocol"),
                "bytesUp": kw.get("bytes_uploaded", 0),
                "bytesDn": kw.get("bytes_downloaded", 0),
            },
            "expected": {
                "service": result["service"],
                "subtype": result["subtype"],
                "confidence": result["confidence"],
                "family": result["family"],
                "category": result["category"],
            },
        })
    out = os.path.join(os.path.dirname(__file__), "attribution_parity_fixtures.json")
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(fixtures, handle, indent=1)
    print(f"wrote {len(fixtures)} parity fixtures -> {out}")


if __name__ == "__main__":
    main()
