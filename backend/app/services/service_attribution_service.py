from __future__ import annotations

import csv
import ipaddress
import json
import os
from collections import Counter
from datetime import date, datetime

from app.models.ipdr import IPDRRecord
from app.services.app_fingerprint_service import extract_features, fingerprint

# --- Shared attribution knowledge base (single source of truth) ---
# backend/app/data/attribution_data.json is the canonical provider/port/constant data,
# consumed here and (via scripts/gen_attribution_js.py) by the frontend engine. Edit the
# JSON, not these structures, and regenerate the frontend copy.
_DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "attribution_data.json")


def _load_attribution_data():
    try:
        with open(_DATA_PATH, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {"providers": [], "port_svc": {}, "port_families": {}, "family_gaps": {}, "constants": {}}


_ATTR = _load_attribution_data()
_CONST = _ATTR.get("constants", {})

EPHEMERAL_MIN = _CONST.get("ephemeral_min", 49152)
_CGNAT_NET = ipaddress.ip_network(_CONST.get("cgnat", "100.64.0.0/10"))
_HOSTING_PROVIDERS = set(_CONST.get("hosting_providers", []))
# Generic web families carry no real service detail, so they don't outrank a carrier match.
_GENERIC_PORT_FAMILIES = set(_CONST.get("generic_families", ["Web", "Encrypted Web/App"]))
# Port -> coarse activity family, and family -> session idle gap (seconds), shared with the
# timeline reconstruction in investigation_service.py.
PORT_FAMILY_MAP = {int(k): v for k, v in _ATTR.get("port_families", {}).items()}
FAMILY_GAP_MAP = dict(_ATTR.get("family_gaps", {}))

# --- Port classification layer (shared knowledge base) ---
# PORT_MAP: port -> (label, confidence, reason, service_family, default_subtype).
# PORT_RANGES: (start, end, label, confidence, reason, service_family, default_subtype) bands for
# apps without exact entries. Both live in attribution_data.json ("port_map"/"port_ranges") so the
# frontend engine consumes the identical 250-port table — edit the JSON, then re-run
# scripts/gen_attribution_js.py. (Historical note: as hardcoded dict literals, duplicate keys
# 27018/27019 in the Database and Gaming sections silently resolved to Gaming; the JSON keeps the
# Database entries, and the Steam PORT_RANGES band still covers gaming use of those ports.)
PORT_MAP = {int(k): tuple(v) for k, v in _ATTR.get("port_map", {}).items()}
PORT_RANGES = [tuple(r) for r in _ATTR.get("port_ranges", [])]


def _check_port_ranges(port: int):
    for start, end, label, confidence, reason, service_family, default_subtype in PORT_RANGES:
        if start <= port <= end:
            return (label, confidence, reason, service_family, default_subtype)
    return None


def _classify_whatsapp(protocol: str, port: int, bytes_transferred: int | None):
    if port == 3478 and protocol == "UDP":
        return "Call initialization", 96, ["UDP STUN / NAT traversal"]
    if port in {5222, 5223}:
        return "Session setup / keepalive", 90, ["Messaging session port"]
    if port == 5228:
        return "Session keepalive", 91, ["Push / background messaging port"]
    if bytes_transferred is not None:
        if bytes_transferred < 25_000:
            return "Call teardown / keepalive", 72, ["Low transfer volume"]
        if bytes_transferred < 250_000:
            return "Call signaling", 82, ["Medium transfer volume"]
        if bytes_transferred < 1_500_000:
            return "Call duration / active session", 88, ["Sustained media exchange"]
        return "Call duration / media session", 92, ["High transfer volume"]
    return "Call session", 80, ["Port mapped to WhatsApp"]


def _classify_generic(service: str, port: int, bytes_transferred: int | None, protocol: str):
    if service == "DNS":
        return "Lookup / resolution", 92, ["DNS family port"]
    if service in {"Web", "Encrypted Web/App", "Hosting / Web", "Casting / Streaming"}:
        if bytes_transferred is not None and bytes_transferred > 500_000:
            return "Content transfer / session", 80, ["Large payload"]
        if protocol == "TLS" or port in {443, 8443, 2083, 2096}:
            return "Encrypted session", 82, ["Encrypted transport"]
        return "Page fetch / browsing", 76, ["Web family port"]
    if service == "Mail":
        if port in {25, 465, 587, 2525}:
            return "Submission", 84, ["Mail submission port"]
        return "Retrieval", 84, ["Mailbox retrieval port"]
    if service == "VPN / Tunnel":
        if bytes_transferred is not None and bytes_transferred > 250_000:
            return "Tunnel traffic", 84, ["Sustained tunnel traffic"]
        if bytes_transferred is not None and bytes_transferred < 5000:
            return "Keepalive / handshake", 78, ["Minimal tunnel traffic"]
        return "Tunnel setup", 86, ["Tunnel negotiation port"]
    if service == "VoIP / SIP":
        return "Call signaling", 90, ["SIP family port"]
    if service == "Remote Desktop":
        if bytes_transferred is not None and bytes_transferred > 250_000:
            return "Interactive session", 86, ["Active remote session"]
        return "Session setup", 82, ["Remote access port"]
    if service == "Database":
        if bytes_transferred is not None and bytes_transferred > 1_000_000:
            return "Bulk data / query", 80, ["Large database transfer"]
        return "Query / transaction", 78, ["Database family port"]
    if service == "Streaming":
        if bytes_transferred is not None and bytes_transferred > 5_000_000:
            return "Active media stream", 86, ["High-volume streaming"]
        return "Media session", 80, ["Streaming family port"]
    if service == "IoT / MQTT":
        return "Broker session", 78, ["MQTT broker port"]
    if service == "File Transfer":
        if bytes_transferred is not None and bytes_transferred > 5_000_000:
            return "Large file transfer", 84, ["High-volume transfer"]
        return "Transfer session", 78, ["File transfer port"]
    if service == "Remote Access":
        if bytes_transferred is not None and bytes_transferred > 100_000:
            return "Active session", 76, ["Sustained remote access"]
        return "Remote login", 74, ["Remote access port"]
    if service == "Device Discovery":
        return "Discovery", 70, ["Discovery port"]
    if service == "Video Conf / Streaming":
        if bytes_transferred is not None and bytes_transferred > 500_000:
            return "Active video call", 86, ["Sustained media exchange"]
        if bytes_transferred is not None and bytes_transferred > 50_000:
            return "Audio call / screen share", 80, ["Medium media exchange"]
        if bytes_transferred is not None and bytes_transferred < 5000:
            return "Keepalive / STUN", 72, ["Minimal media keepalive"]
        return "Media session", 78, ["Conferencing family port"]
    if service == "Messaging / Social":
        if bytes_transferred is not None and bytes_transferred < 10_000:
            return "Instant message / ping", 74, ["Minimal transfer volume"]
        return "Messaging session", 72, ["Messaging platform port"]
    if service == "Gaming":
        if bytes_transferred is not None and bytes_transferred > 5_000_000:
            return "Active gameplay", 82, ["High-volume game traffic"]
        if bytes_transferred is not None and bytes_transferred > 100_000:
            return "Multiplayer session", 78, ["Sustained game traffic"]
        return "Client / lobby", 72, ["Game family port"]
    if service == "P2P / File Sharing":
        if bytes_transferred is not None and bytes_transferred > 10_000_000:
            return "Active download / upload", 86, ["High-volume P2P transfer"]
        return "P2P session", 76, ["P2P family port"]
    if service == "Proxy / Tor":
        if bytes_transferred is not None and bytes_transferred > 1_000_000:
            return "Relayed traffic", 76, ["High-volume proxy tunnel"]
        return "Proxy session", 72, ["Proxy family port"]
    if service == "Cache / Backend":
        return "Backend session", 70, ["Cache / backend port"]
    if service == "Queue / Backend":
        return "Message broker session", 72, ["Queue/backend port"]
    if service == "File / Print":
        return "File / print service", 68, ["File/print family port"]
    if service == "Directory / LDAP":
        return "Directory lookup", 72, ["Directory family port"]
    if service == "Authentication":
        return "Auth session", 68, ["Authentication protocol port"]
    if service == "Infrastructure":
        return "Network service", 68, ["Infrastructure port"]
    if service == "Remote Management":
        return "Admin session", 66, ["Management port"]
    if service == "Multimedia / Home":
        return "Media sharing session", 62, ["Home entertainment port"]
    if service == "Development":
        return "Dev tool session", 62, ["Development port"]
    if service == "Crypto / Blockchain":
        if bytes_transferred is not None and bytes_transferred > 100_000_000:
            return "Blockchain sync", 80, ["High-volume blockchain traffic"]
        return "Crypto node session", 68, ["Blockchain port"]
    if service == "Security":
        return "Suspicious activity", 44, ["Common RAT port"]
    return "Session", 60, ["Generic service family"]


def _fallback_classify(protocol: str, bytes_transferred: int | None, port: int | None):
    candidates = []

    if protocol == "UDP":
        base_confidence = 42
        if bytes_transferred is not None and bytes_transferred > 5_000_000:
            candidates.append({
                "service": "Likely Streaming / Media",
                "subtype": "High-volume stream",
                "confidence": 60,
                "evidence": [f"UDP high traffic ({_human_bytes(bytes_transferred)})", "Unrecognized port"],
            })
        if bytes_transferred is not None and bytes_transferred > 1_000_000:
            candidates.append({
                "service": "Likely Video Conf / Streaming",
                "subtype": "Media stream",
                "confidence": 56,
                "evidence": [f"UDP sustained traffic ({_human_bytes(bytes_transferred)})", "Unrecognized port"],
            })
        candidates.append({
            "service": "Likely Messaging / VoIP",
            "subtype": "Media / signalling session",
            "confidence": base_confidence,
            "evidence": ["Protocol UDP", "Generic media or signalling session"],
        })

    elif protocol == "TCP":
        base_confidence = 26
        if bytes_transferred is not None and bytes_transferred > 10_000_000:
            candidates.append({
                "service": "Likely Content Transfer",
                "subtype": "Large download / upload",
                "confidence": 58,
                "evidence": [f"TCP high traffic ({_human_bytes(bytes_transferred)})", "Unrecognized port"],
            })
        if bytes_transferred is not None and bytes_transferred > 500_000:
            candidates.append({
                "service": "Likely File Transfer",
                "subtype": "Medium file transfer",
                "confidence": 44,
                "evidence": [f"TCP sustained traffic ({_human_bytes(bytes_transferred)})", "Unrecognized port"],
            })
        candidates.append({
            "service": "Likely Encrypted Web/App",
            "subtype": "Generic TCP session",
            "confidence": base_confidence,
            "evidence": ["Protocol TCP", "Generic TCP session"],
        })

    else:
        candidates.append({
            "service": "Likely Custom Protocol",
            "subtype": f"Protocol {protocol} session",
            "confidence": 18,
            "evidence": [f"Unknown protocol {protocol}", "No known port match"],
        })

    if bytes_transferred is not None and bytes_transferred == 0 and port:
        candidates.append({
            "service": "Likely Keepalive / Probe",
            "subtype": "Zero-byte session",
            "confidence": 36,
            "evidence": ["Zero data transferred", "Port connection attempt"],
        })

    if port is not None and 49152 <= port <= 65535:
        for c in candidates:
            c["evidence"].append("Ephemeral source port (no service info)")

    return max(candidates, key=lambda x: x["confidence"]) if candidates else None


def _human_bytes(b):
    if b >= 1_000_000_000:
        return f"{b/1_000_000_000:.1f}GB"
    if b >= 1_000_000:
        return f"{b/1_000_000:.1f}MB"
    if b >= 1_000:
        return f"{b/1_000:.1f}KB"
    return f"{b}B"


# --- IP-range / provider attribution (Level 1: infrastructure) ---
# Sourced from the shared attribution_data.json. `is_isp` entries identify the access
# network/carrier and never override a real content match. Matching is longest-prefix,
# so broad blocks defer to more specific ones. Each provider carries ASN metadata
# (asn / country / type) that flows into attribution results.
# `range_history` entries are TIME-SCOPED owners: IP blocks change hands (3.0.0.0/8 was
# General Electric until 2018, then AWS), so a record's TIMESTAMP decides which owner
# applies — a 2016 session to 3.x.x.x was talking to GE infrastructure, not Amazon.


def _parse_date(value):
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _provider_type(p):
    if p.get("type"):
        return p["type"]
    if p.get("isp"):
        return "ISP / Residential"
    if p.get("hosting"):
        return "Hosting / Cloud"
    return "Content Provider"


# Each net entry: (network, meta) where meta carries everything a match should report.
_PROVIDER_NETS = []
for _p in _ATTR.get("providers", []):
    for _cidr in _p.get("ranges", []) or []:
        try:
            _net = ipaddress.ip_network(_cidr)
        except ValueError:
            continue
        _PROVIDER_NETS.append((_net, {
            "provider": _p["pr"], "is_isp": bool(_p.get("isp")),
            "asn": _p.get("asn"), "country": _p.get("country"),
            "type": _provider_type(_p), "valid_from": None, "valid_to": None,
            "note": None,
        }))

# Historical owners: only apply to records timestamped inside their validity window.
for _h in _ATTR.get("range_history", []):
    try:
        _net = ipaddress.ip_network(_h["cidr"])
    except (ValueError, KeyError):
        continue
    _PROVIDER_NETS.append((_net, {
        "provider": _h["provider"], "is_isp": bool(_h.get("isp")),
        "asn": _h.get("asn"), "country": _h.get("country"),
        "type": _h.get("type", "Historical owner"),
        "valid_from": _parse_date(_h.get("from")), "valid_to": _parse_date(_h.get("to")),
        "note": _h.get("note"),
    }))


# Curated per-provider network metadata, for backfilling external-feed rows that carry only
# a name (the live-feed CSV has network/provider/is_isp columns and nothing else). Keyed by
# the exact provider name, which the feed generator shares with the curated table.
_PROVIDER_META = {
    p["pr"]: {"asn": p.get("asn"), "country": p.get("country"), "type": _provider_type(p)}
    for p in _ATTR.get("providers", [])
}


def _load_external_ranges(path):
    """Optionally extend coverage from an external CSV (e.g. derived from MaxMind
    GeoLite2-ASN or IPinfo). Columns: network/cidr, provider/org, [is_isp, asn, country,
    type, valid_from, valid_to]. Missing file is fine — the curated table is the default.
    Because matching is longest-prefix, external entries simply add/override by
    specificity; valid_from/valid_to make an entry time-scoped (historical ownership)."""
    nets = []
    if not path or not os.path.isfile(path):
        return nets
    try:
        with open(path, newline="", encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                cidr = (row.get("network") or row.get("cidr") or "").strip()
                provider = (row.get("provider") or row.get("org") or "").strip()
                if not cidr or not provider:
                    continue
                is_isp = str(row.get("is_isp", "")).strip().lower() in ("1", "true", "yes", "isp")
                try:
                    net = ipaddress.ip_network(cidr)
                except ValueError:
                    continue
                asn_raw = (row.get("asn") or "").strip().lstrip("ASas")
                curated = _PROVIDER_META.get(provider, {})
                nets.append((net, {
                    "provider": provider, "is_isp": is_isp,
                    "asn": (int(asn_raw) if asn_raw.isdigit() else None) or curated.get("asn"),
                    "country": (row.get("country") or "").strip() or curated.get("country"),
                    "type": (row.get("type") or "").strip() or curated.get("type"),
                    "valid_from": _parse_date(row.get("valid_from")),
                    "valid_to": _parse_date(row.get("valid_to")),
                    "note": None,
                }))
    except OSError:
        return []
    return nets


# Drop a CSV at backend/data/asn_ranges.csv (or point ASN_RANGES_CSV at one) to extend
# coverage to every ASN without code changes. External entries are checked first so a
# same-specificity external row wins the tie.
_EXTERNAL_RANGES_PATH = os.environ.get(
    "ASN_RANGES_CSV",
    os.path.join(os.path.dirname(__file__), "..", "..", "data", "asn_ranges.csv"),
)
_PROVIDER_NETS = _load_external_ranges(_EXTERNAL_RANGES_PATH) + _PROVIDER_NETS


# --- Fast longest-prefix index ---
# A linear scan over every CIDR per IP is fine for a curated table but melts down once
# the live provider feeds add thousands of ranges (~2k AWS/Google/... prefixes). Index
# IPv4 nets by their first octet: any prefix /8 or longer lives entirely inside one /8,
# so a query only checks its own bucket plus the rare <\8 "broad" nets. Each entry is
# precomputed integer (lo, hi) bounds so matching is integer comparison, not object
# containment. This turns ~2000 checks/IP into a few dozen.
_V4_BUCKETS: dict = {}   # first octet -> [(lo, hi, prefixlen, meta)]
_V4_BROAD: list = []     # IPv4 nets with prefixlen < 8 (span multiple /8s)
_V6_NETS: list = []      # IPv6 (rare here) -> linear fallback


def _index_provider_nets(nets):
    for net, meta in nets:
        if net.version == 6:
            _V6_NETS.append((net, meta))
            continue
        entry = (int(net.network_address), int(net.broadcast_address), net.prefixlen,
                 dict(meta, cidr=str(net)))
        if net.prefixlen < 8:
            _V4_BROAD.append(entry)
        else:
            _V4_BUCKETS.setdefault(entry[0] >> 24, []).append(entry)


_index_provider_nets(_PROVIDER_NETS)


def _entry_applies(meta, when):
    """Validity-window check. `when` is the record's date (or None for undated queries).
    A time-scoped entry (historical owner) only applies when the record is dated inside
    its window; the CURRENT table (no window) always applies. An undated record resolves
    against current ownership only — never a window that has already closed."""
    vf, vt = meta["valid_from"], meta["valid_to"]
    if vf is None and vt is None:
        return True
    if when is None:
        return False
    if vf is not None and when < vf:
        return False
    if vt is not None and when >= vt:
        return False
    return True


def _better(candidate_plen, candidate_scoped, best):
    """A TIME-SCOPED (historical) entry that applies to the query date beats ANY
    open-ended current-table entry, regardless of prefix length: the current table
    answers "who owns this today", and today's more-specific sub-allocations simply did
    not exist when the block still belonged to the historical owner. Within the same
    class (both scoped, or both current), longest prefix wins as usual."""
    if best is None:
        return True
    if candidate_scoped != best["scoped"]:
        return candidate_scoped
    return candidate_plen > best["prefixlen"]


def _match_ip(ip, when=None):
    """Longest-prefix match with time-aware ownership: among all CIDRs containing the
    address AND valid at `when` (a date/datetime; None = today's table), return the most
    specific. Result dict: provider, is_isp, cidr, prefixlen, asn, country, type,
    historical, note."""
    if not ip:
        return None
    try:
        addr = ipaddress.ip_address(str(ip).strip())
    except (ValueError, AttributeError):
        return None
    if isinstance(when, datetime):
        when = when.date()

    def _result(meta, plen, scoped):
        return {"provider": meta["provider"], "is_isp": meta["is_isp"], "cidr": meta["cidr"],
                "prefixlen": plen, "asn": meta["asn"], "country": meta["country"],
                "type": meta["type"], "historical": scoped, "note": meta["note"],
                "scoped": scoped}

    best = None
    if addr.version == 6:
        for net, meta in _V6_NETS:
            if addr in net and _entry_applies(meta, when):
                scoped = meta["valid_from"] is not None or meta["valid_to"] is not None
                if _better(net.prefixlen, scoped, best):
                    best = _result(dict(meta, cidr=str(net)), net.prefixlen, scoped)
        return best

    ip_int = int(addr)
    bucket = _V4_BUCKETS.get(ip_int >> 24, ())
    for source in (bucket, _V4_BROAD):
        for lo, hi, plen, meta in source:
            if lo <= ip_int <= hi and _entry_applies(meta, when):
                scoped = meta["valid_from"] is not None or meta["valid_to"] is not None
                if _better(plen, scoped, best):
                    best = _result(meta, plen, scoped)
    return best


def _ip_kind(ip):
    """Classify a non-public address: CGNAT, private, loopback, or link-local."""
    try:
        addr = ipaddress.ip_address(str(ip).strip())
    except (ValueError, AttributeError):
        return None
    if addr in _CGNAT_NET:
        return "cgnat"
    if addr.is_loopback:
        return "loopback"
    if addr.is_link_local:
        return "link_local"
    if addr.is_private:
        return "private"
    return None


def _record_when(record):
    """The record's own timestamp, for time-aware ownership resolution."""
    return getattr(record, "start_time", None) or getattr(record, "end_time", None)


def _classify_by_ip(record: IPDRRecord):
    """Resolve the provider for the SERVICE the subject contacted — which is the
    DESTINATION. The source IP is the subject's own endpoint (carrier/CGNAT, or for a
    server-side record the host itself); using it to name the contacted service would
    mislabel any session merely *originating* from an AWS/Meta IP as that service.
    The source is therefore only consulted to identify the subject's access network
    (ISP) when the destination matches nothing — never as a content-provider label.
    Ownership is resolved AT THE RECORD'S TIMESTAMP: IP blocks change hands, so an old
    record resolves against the owner at that time, not today's WHOIS."""
    when = _record_when(record)
    dest = _match_ip(getattr(record, "destination_ip", None), when)
    if dest:
        return dest
    src = _match_ip(getattr(record, "source_ip", None), when)
    if src and src["is_isp"]:  # source identifies the subject's carrier (ISP) only
        return src
    return None


def _category_for(family):
    if family == "VPN / Tunnel":
        return "vpn"
    if family == "Proxy / Tor":
        return "anonymization"
    return "service"


def _asn_evidence(match):
    """One evidence line summarising the network owner: ASN, classification, country."""
    bits = []
    if match.get("asn"):
        bits.append(f"AS{match['asn']}")
    if match.get("type"):
        bits.append(match["type"])
    if match.get("country"):
        bits.append(match["country"])
    return " · ".join(bits) if bits else None


def _enrich(result, match):
    """Attach network-owner metadata (ASN / country / type) and, for a historical match,
    the ownership-at-record-time note, to any attribution result built from an IP match."""
    result["asn"] = match.get("asn")
    result["country"] = match.get("country")
    result["ip_type"] = match.get("type")
    asn_line = _asn_evidence(match)
    if asn_line and asn_line not in result["evidence"]:
        result["evidence"].append(asn_line)
    if match.get("historical"):
        note = f"IP ownership at record time: {match['provider']}"
        if match.get("note"):
            note += f" — {match['note']}"
        result["evidence"].append(note)
    return result


def _merge_provider(match, port_result):
    # An IP-range (infrastructure) match is a strong signal; scale confidence with CIDR specificity.
    provider, raw, prefixlen = match["provider"], match["cidr"], match["prefixlen"]
    confidence = 90 if prefixlen >= 20 else 85 if prefixlen >= 16 else 78
    subtype = port_result["subtype"] if port_result["service"] != "Unknown" else "Network session"
    hosting = provider in _HOSTING_PROVIDERS
    evidence = [f"{provider} IP range ({raw})"]
    if hosting:
        evidence.append("Cloud/VPS host — possible VPN, proxy, or self-hosted endpoint")
    if port_result.get("port"):
        evidence.append(f"Port {port_result['port']}")
    for item in port_result.get("evidence", []):
        if item not in evidence:
            evidence.append(item)
        if len(evidence) >= 5:
            break
    return _enrich({
        "service": f"Likely {provider}",
        "subtype": subtype,
        "confidence": confidence,
        "family": provider,
        "port": port_result.get("port"),
        "category": "hosting" if hosting else "content",
        "evidence": evidence,
    }, match)


_PRIVATE_LABEL = {
    "cgnat": "Carrier NAT (CGNAT)",
    "private": "Private / Internal Network",
    "loopback": "Loopback",
    "link_local": "Link-Local",
}


def _access_network_result(match, protocol):
    provider, raw = match["provider"], match["cidr"]
    return _enrich({
        "service": f"{provider} (Access Network)",
        "subtype": "Carrier / ISP traffic",
        "confidence": 30,
        "family": "Access Network",
        "port": None,
        "category": "access_network",
        "evidence": [f"{provider} access network ({raw})",
                     f"Protocol {protocol}" if protocol else "Protocol unknown"],
    }, match)


def _private_result(kind, port_result, protocol):
    label = _PRIVATE_LABEL.get(kind, "Private")
    # Keep a specific port-mapped service if one was found; otherwise label the internal traffic.
    if port_result.get("port") is not None and port_result.get("family") not in _GENERIC_PORT_FAMILIES:
        out = dict(port_result)
        out["category"] = "internal"
        out["evidence"] = list(out["evidence"]) + [f"{label} destination"]
        return out
    return {
        "service": label,
        "subtype": "Internal / non-routable",
        "confidence": 70,
        "family": "Private",
        "port": None,
        "category": "internal",
        "evidence": [f"{label} destination IP",
                     f"Protocol {protocol}" if protocol else "Protocol unknown"],
    }


def _fingerprint_refine(record, result, provider):
    """Overlay the behavioral fingerprint (protocol + duration + volume + ratio + ports +
    provider) on a port/IP-derived classification. Only runs when the record actually has
    a duration — behavior without time is meaningless, and undated fixtures/records keep
    their exact pre-fingerprint output. Conservative by design:
      - same family: refine the subtype to the behavioral one and nudge confidence (+4);
      - result was generic/unknown and the fingerprint is strong (>=80): adopt the app;
      - otherwise: evidence only (the analyst sees the behavioral read either way)."""
    features = extract_features(record)
    if not features.get("dur"):
        return result
    matches = fingerprint(features, provider)
    if not matches or matches[0]["score"] < 70:
        return result
    top = matches[0]
    result = dict(result)
    result["evidence"] = list(result["evidence"])
    result["evidence"].append(f"Behavioral fingerprint: {top['app']} ({top['score']}% — {', '.join(top['matched'])})")
    if top["family"] == result.get("family"):
        result["subtype"] = top["subtype"]
        result["confidence"] = min(96, result["confidence"] + 4)
    elif top["score"] >= 80 and (result.get("category") == "unknown"
                                 or result.get("family") in _GENERIC_PORT_FAMILIES):
        result["service"] = f"Likely {top['app']}"
        result["subtype"] = top["subtype"]
        result["family"] = top["family"]
        result["category"] = top["category"]
        result["confidence"] = max(result["confidence"], min(88, top["score"]))
    return result


def attribute_service(record: IPDRRecord):
    protocol = (record.protocol or "").upper()
    bytes_transferred = _record_bytes(record)

    port_result = _classify_by_port(record, protocol, bytes_transferred)

    # Deterministic: a private/CGNAT/loopback destination is internal, not an internet service.
    dest_kind = _ip_kind(getattr(record, "destination_ip", None))
    if dest_kind:
        return _private_result(dest_kind, port_result, protocol)

    ip_result = _classify_by_ip(record)

    if ip_result:
        if not ip_result["is_isp"]:
            # Content-provider IP match is the strongest signal — it names the actual service.
            return _fingerprint_refine(record, _merge_provider(ip_result, port_result), ip_result["provider"])
        # Access network/ISP: keep a *specific* port-mapped service (DNS, mail, VPN, ...) and
        # annotate the carrier; but a generic web / behavioural guess shouldn't outrank the
        # one thing we actually know — the carrier — so fall back to the access-network label.
        specific_port = port_result.get("port") is not None and port_result.get("family") not in _GENERIC_PORT_FAMILIES
        if specific_port:
            annotated = dict(port_result)
            annotated["evidence"] = list(port_result["evidence"]) + [f"{ip_result['provider']} access network ({ip_result['cidr']})"]
            return _fingerprint_refine(record, _enrich(annotated, ip_result), None)
        return _access_network_result(ip_result, protocol)

    return _fingerprint_refine(record, port_result, None)


def _classify_by_port(record: IPDRRecord, protocol: str, bytes_transferred: int):
    candidates = []
    seen_services = set()

    # Inspect the destination port first: for an outbound IP session the destination
    # is the well-known service port, while the source is typically ephemeral. This
    # ordering means the meaningful match is recorded before any ephemeral one.
    for raw_port, is_source in ((record.destination_port, False), (record.source_port, True)):
        if raw_port is None:
            continue
        try:
            port = int(raw_port)
        except (TypeError, ValueError):
            continue

        base = PORT_MAP.get(port)

        if not base:
            base = _check_port_ranges(port)

        if not base:
            continue

        label, confidence, reason, service_family, default_subtype = base

        if service_family in seen_services:
            continue
        seen_services.add(service_family)

        # A match on the source port inside the ephemeral range is almost always the
        # connection's own short-lived port coinciding with a service band (e.g. a
        # source port of 50005 looking like MS Teams/Discord), not the real service.
        # Flag it so it can be demoted once we know a stronger match exists.
        suspect_ephemeral = is_source and port >= EPHEMERAL_MIN

        subtype = default_subtype
        evidence = [f"Port {port}", reason]

        if service_family == "WhatsApp":
            subtype, confidence, sub_evidence = _classify_whatsapp(protocol, port, bytes_transferred)
            evidence.extend(sub_evidence)
        else:
            subtype, confidence, sub_evidence = _classify_generic(service_family, port, bytes_transferred, protocol)
            evidence.extend(sub_evidence)

        if protocol == "UDP" and port in {53, 3478, 500, 4500, 1194, 1701, 51820, 3544, 19302}:
            confidence = min(96, confidence + 3)
            evidence.append("UDP aligned")
        elif protocol == "UDP" and port in {443, 8443}:
            # UDP on a TLS port is QUIC (HTTP/3) — modern encrypted web/app traffic, not an anomaly.
            confidence = min(96, confidence + 2)
            subtype = "QUIC (HTTP/3) session"
            evidence.append("QUIC (HTTP/3): UDP on TLS port")
        elif protocol == "TCP" and port in {80, 443, 5222, 5223, 5228, 5060, 5061, 3389, 5900, 3306, 5432, 8443, 25, 110, 143, 993, 995}:
            confidence = min(96, confidence + 2)
            evidence.append("TCP aligned")

        candidates.append(
            {
                "service": label,
                "subtype": subtype,
                "confidence": confidence,
                "evidence": evidence,
                "family": service_family,
                "port": port,
                "suspect_ephemeral": suspect_ephemeral,
            }
        )

    if candidates:
        strong = [c for c in candidates if not c["suspect_ephemeral"]]
        if strong:
            # Drop coincidental ephemeral source-port matches when a real port exists.
            candidates = strong
        else:
            # Only ephemeral source-port guesses survive — keep them but mark low-trust.
            for c in candidates:
                c["confidence"] = max(10, c["confidence"] - 25)
                c["evidence"].append("Ephemeral source-port match (low confidence)")

        # Best = highest confidence; tie-break toward the more well-known (lower) port.
        best = max(candidates, key=lambda item: (item["confidence"], -item["port"]))
        return _public(best)

    fallback = _fallback_classify(protocol, bytes_transferred, record.destination_port or record.source_port)
    if fallback:
        fallback.setdefault("family", fallback["service"])
        fallback["category"] = "unknown"
        return fallback

    return {
        "service": "Unknown",
        "subtype": "Unclassified",
        "confidence": 10,
        "family": "Unknown",
        "port": None,
        "category": "unknown",
        "evidence": [f"Protocol {protocol}" if protocol else "Protocol unknown", "No classification possible"],
    }


def _public(candidate: dict) -> dict:
    """Strip internal bookkeeping keys before returning a classification."""
    family = candidate.get("family", candidate["service"])
    return {
        "service": candidate["service"],
        "subtype": candidate["subtype"],
        "confidence": candidate["confidence"],
        "family": family,
        "port": candidate.get("port"),
        "category": _category_for(family),
        "evidence": candidate["evidence"],
    }


def _record_bytes(record) -> int:
    total = 0
    for attr in ("bytes_uploaded", "bytes_downloaded"):
        value = getattr(record, attr, None)
        if value is None:
            continue
        try:
            total += int(value)
        except (TypeError, ValueError):
            continue
    return total


def summarize_services(records):
    counts = Counter()
    best_example = {}
    total_bytes = Counter()

    for record in records:
        attribution = attribute_service(record)
        service = attribution["service"]
        counts[service] += 1
        total_bytes[service] += _record_bytes(record)

        # Keep the most-confident classification as the representative example,
        # rather than whichever record happened to be processed first.
        current = best_example.get(service)
        if current is None or attribution["confidence"] > current["confidence"]:
            best_example[service] = attribution

    return [
        {
            "service": service,
            "count": count,
            "confidence": best_example[service]["confidence"],
            "evidence": best_example[service]["evidence"],
            "subtype": best_example[service]["subtype"],
            "family": best_example[service].get("family", service),
            "total_bytes": total_bytes[service],
        }
        for service, count in counts.most_common()
    ]
