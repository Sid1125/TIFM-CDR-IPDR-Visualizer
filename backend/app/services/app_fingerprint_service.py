"""Behavioral app-fingerprint layer (Level: session behavior, not ports or IPs).

Classifies a record/session by HOW it behaved — protocol, duration, transfer volume,
upload/download ratio, ports, and the network owner — against curated app profiles in
attribution_data.json ("fingerprints"). Deterministic scoring, no ML runtime: each profile
declares bounds per feature; the score is the weighted share of declared-AND-observable
features that match, so missing data narrows the denominator instead of penalising.

Example: UDP, 400s, 4MB total, symmetric up/down, port 3478, Meta ASN → whatsapp_voice_call.

The frontend engine mirrors this scorer 1:1 (services/attribution.js fingerprintSession)
from the same JSON; the parity harness pins agreement. Profiles are data — tune them in
attribution_data.json, regenerate the frontend copy, re-pin parity fixtures.
"""
from __future__ import annotations

import json
import os

_DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "attribution_data.json")

try:
    with open(_DATA_PATH, encoding="utf-8") as _handle:
        FINGERPRINTS = json.load(_handle).get("fingerprints", [])
except (OSError, ValueError):
    FINGERPRINTS = []

# Feature weights. Protocol and duration carry the most signal for behavioral separation
# (voice vs streaming vs keepalive); ports and provider are corroboration here because the
# port/IP layers already scored them directly.
_W_PROTO, _W_DUR, _W_BYTES, _W_RATIO, _W_PORTS, _W_PROVIDER = 25, 20, 20, 15, 10, 10
# A profile must be judged on at least this much declared-and-observable weight, or the
# match is meaningless (e.g. only the protocol was comparable). 40 keeps duration+volume-only
# profiles (keepalive_probe) scoreable while still rejecting single-feature matches.
_MIN_POSSIBLE = 40


def extract_features(record) -> dict:
    """Feature vector from an IPDR record (or anything with the same attributes)."""
    dur = getattr(record, "duration_seconds", None)
    if dur is None:
        start, end = getattr(record, "start_time", None), getattr(record, "end_time", None)
        if start and end:
            dur = max(0, int((end - start).total_seconds()))
    up = getattr(record, "bytes_uploaded", None) or 0
    dn = getattr(record, "bytes_downloaded", None) or 0
    ports = set()
    for attr in ("destination_port", "source_port"):
        value = getattr(record, attr, None)
        if value is not None:
            try:
                ports.add(int(value))
            except (TypeError, ValueError):
                pass
    return {
        "proto": (getattr(record, "protocol", None) or "").upper() or None,
        "dur": dur,
        "bytes": up + dn,
        "ratio": (up / dn) if dn > 0 else (999.0 if up > 0 else None),
        "ports": ports,
    }


def _in_range(value, bounds):
    return bounds[0] <= value <= bounds[1]


def fingerprint(features: dict, provider: str | None = None) -> list[dict]:
    """Score every profile against the feature vector; return matches sorted by score
    (0-100). Profiles that DECLARE a provider list only apply when the observed provider
    IS in that list: claiming a provider-specific app (WhatsApp, Zoom) requires actually
    seeing that provider's network — behavior alone (short TCP burst, symmetric UDP) is
    shared by dozens of apps, so without the provider it must fall to the provider-less
    generic profiles (voip_generic, file_download, ...)."""
    results = []
    for fp in FINGERPRINTS:
        if fp.get("providers") and (not provider or provider not in fp["providers"]):
            continue
        earned = possible = 0
        matched = []
        if fp.get("proto") and features.get("proto"):
            possible += _W_PROTO
            if features["proto"] == fp["proto"]:
                earned += _W_PROTO
                matched.append(f"protocol {fp['proto']}")
        if fp.get("dur") and features.get("dur") is not None:
            possible += _W_DUR
            if _in_range(features["dur"], fp["dur"]):
                earned += _W_DUR
                matched.append(f"duration {features['dur']}s")
        if fp.get("bytes") and features.get("bytes") is not None:
            possible += _W_BYTES
            if _in_range(features["bytes"], fp["bytes"]):
                earned += _W_BYTES
                matched.append("transfer volume")
        if fp.get("ratio") and features.get("ratio") is not None:
            possible += _W_RATIO
            if _in_range(features["ratio"], fp["ratio"]):
                earned += _W_RATIO
                matched.append("up/down ratio")
        if fp.get("ports") and features.get("ports"):
            possible += _W_PORTS
            if features["ports"] & set(fp["ports"]):
                earned += _W_PORTS
                matched.append("port profile")
        if fp.get("providers"):
            # Reaching here means the provider gate above passed.
            possible += _W_PROVIDER
            earned += _W_PROVIDER
            matched.append(f"{provider} network")
        if possible < _MIN_POSSIBLE:
            continue
        score = int(100 * earned / possible + 0.5)
        if score > 0:
            results.append({
                "name": fp["name"], "app": fp["app"], "family": fp["family"],
                "subtype": fp["subtype"], "category": fp.get("category", "service"),
                "score": score, "matched": matched,
            })
    results.sort(key=lambda r: -r["score"])
    return results
