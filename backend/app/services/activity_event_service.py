"""Activity-event synthesis — the layer between sessions and the investigation timeline.

    IPDR rows -> session reconstruction -> ACTIVITY EVENTS -> investigation timeline

A session is still network-shaped (IPs, ports, byte counters). An activity event is
investigation-shaped: what probably happened, between whom, when, with the supporting
evidence and a fused confidence — "21:31-21:58 · Probable WhatsApp Voice Call ·
9998887777 <-> WhatsApp (Meta) · 86%" instead of 27 rows of UDP 3478.

Synthesis per session:
  1. Behavioral fingerprint over the WHOLE session's features (duration, total volume,
     up/down ratio, every port touched, dominant protocol, resolved provider) — this is
     where a call spread across many small records finally looks like a call.
  2. Title: the fingerprinted app when the behavior is confident, else a family-level
     activity phrase, always "Probable ..." because these are inferences, not captures.
  3. Participants: the subject's phone number (msisdn) when the IPDR carries one, else
     the source IP; the peer as "<service> (<provider>)" when attribution named one.
  4. Confidence fusion: attribution confidence and behavioral score corroborate or not —
     mean of the two plus an agreement bonus when they point at the same family, capped
     below hard-capture certainty. Both inputs are surfaced in confidence_parts so the
     number is explainable in court, not an oracle.
  5. Evidence: human sentences (duration, flow shape, ASN line, distinctive-port reasons,
     record count) — deduplicated, capped, readable aloud.
"""
from __future__ import annotations

from app.services.app_fingerprint_service import fingerprint
from app.services.service_attribution_service import EPHEMERAL_MIN, PORT_MAP, _GENERIC_PORT_FAMILIES

_MAX_EVIDENCE = 7


def _human_bytes(b):
    if b >= 1_000_000_000:
        return f"{b/1_000_000_000:.1f}GB"
    if b >= 1_000_000:
        return f"{b/1_000_000:.1f}MB"
    if b >= 1_000:
        return f"{b/1_000:.1f}KB"
    return f"{b}B"


def _human_duration(seconds):
    if seconds is None:
        return None
    if seconds >= 3600:
        return f"{seconds/3600:.1f} h"
    if seconds >= 60:
        return f"{round(seconds/60)} min"
    return f"{seconds} s"


def _session_features(session):
    up = session.get("bytes_uploaded") or 0
    dn = session.get("bytes_downloaded") or 0
    return {
        "proto": session.get("protocol"),
        "dur": session.get("duration_seconds"),
        "bytes": up + dn,
        "ratio": (up / dn) if dn > 0 else (999.0 if up > 0 else None),
        "ports": set(session.get("ports") or []),
    }


def _provider_of(session):
    """The content/hosting provider the session talked to, when attribution named one.
    Access-network and internal results identify the subject's side, not a peer service."""
    if session.get("category") in ("content", "hosting"):
        return session.get("family")
    return None


def _fuse_confidence(attr_conf, fp, session):
    parts = {"attribution": attr_conf}
    if not fp:
        return min(96, attr_conf or 10), parts
    parts["behavior"] = fp["score"]
    agree = fp["family"] == session.get("family")
    parts["agreement"] = agree
    fused = round(((attr_conf or 10) + fp["score"]) / 2) + (6 if agree else 0)
    return max(min(96, fused), min(attr_conf or 10, fp["score"])), parts


def _title_and_activity(session, fp):
    """Human title. The fingerprint names the app when the behavior is confident enough;
    otherwise fall back to what the attribution layer knew."""
    if fp and fp["score"] >= 70:
        return f"Probable {fp['app']}", fp["subtype"]
    category = session.get("category")
    service = session.get("service") or "Unknown"
    subtype = session.get("subtype") or ""
    if category == "access_network":
        return f"Mobile data session ({session.get('family', 'carrier')})", "Carrier / ISP traffic"
    if category == "internal":
        return f"Internal network activity ({service})", subtype
    if category in ("content", "hosting"):
        return f"Probable {service.replace('Likely ', '')} session", subtype
    if service != "Unknown":
        return f"Probable {service.replace('Likely ', '')}", subtype
    return "Unclassified data session", subtype or "Unknown activity"


def _flow_evidence(session, features):
    up = session.get("bytes_uploaded") or 0
    dn = session.get("bytes_downloaded") or 0
    total = up + dn
    if not total:
        return "No payload (signalling only)"
    ratio = features["ratio"]
    if ratio is not None and 0.3 <= ratio <= 3.0:
        shape = "stable bidirectional flow"
    elif ratio is not None and ratio > 5:
        shape = "upload-heavy flow"
    elif ratio is not None and ratio < 0.2:
        shape = "download-heavy flow"
    else:
        shape = "mixed flow"
    return f"{_human_bytes(up)} up / {_human_bytes(dn)} down — {shape}"


def _port_evidence(ports):
    """Reasons for the distinctive (non-generic-web) ports the session touched. Ephemeral
    ports are the connections' own source ports — a table hit there (e.g. 50000 landing in
    a media range) is coincidence, not evidence."""
    lines = []
    for port in ports:
        if port >= EPHEMERAL_MIN:
            continue
        entry = PORT_MAP.get(port)
        if not entry:
            continue
        _label, _conf, reason, family, _subtype = entry
        if family in _GENERIC_PORT_FAMILIES:
            continue
        lines.append(f"{reason} (port {port})")
        if len(lines) >= 2:
            break
    return lines


def synthesize_event(session):
    """Session dict (from reconstruct_ipdr_sessions) -> activity event dict."""
    features = _session_features(session)
    provider = _provider_of(session)
    matches = fingerprint(features, provider) if features["dur"] else []
    fp = matches[0] if matches and matches[0]["score"] >= 70 else None

    title, activity = _title_and_activity(session, fp)
    confidence, parts = _fuse_confidence(session.get("confidence"), fp, session)

    evidence = []
    dur_h = _human_duration(session.get("duration_seconds"))
    if dur_h:
        evidence.append(f"{dur_h} session, {session.get('record_count', 1)} record(s)")
    evidence.append(_flow_evidence(session, features))
    if fp:
        evidence.append(f"Behavioral fingerprint: {fp['app']} ({fp['score']}% — {', '.join(fp['matched'])})")
    evidence.extend(_port_evidence(features["ports"]))
    # Carry attribution evidence, strongest first: the network-owner line (ASN · type ·
    # country), IP range, and any ownership-at-record-time note must survive the cap;
    # bare "Port N" lines are already covered by the distinctive-port reasons above.
    carried = [l for l in (session.get("evidence") or []) if not l.startswith("Port ")]
    key = [l for l in carried
           if "·" in l or l.startswith("AS") or "IP range" in l
           or "access network" in l or "ownership" in l.lower()]
    for line in key + [l for l in carried if l not in key]:
        if line not in evidence:
            evidence.append(line)
        if len(evidence) >= _MAX_EVIDENCE:
            break

    peer_label = None
    if provider:
        peer_label = session.get("service", "").replace("Likely ", "") or provider
        if provider not in (peer_label or ""):
            peer_label = f"{peer_label} ({provider})"

    return {
        "kind": "activity_event",
        "title": title,
        "activity": activity,
        "start": session.get("start"),
        "end": session.get("end"),
        "duration_seconds": session.get("duration_seconds"),
        "participants": {
            "subject": session.get("msisdn") or session.get("subject"),
            "subject_ip": session.get("subject"),
            "peer": session.get("peer"),
            "peer_label": peer_label,
        },
        "confidence": confidence,
        "confidence_parts": parts,
        "evidence": evidence[:_MAX_EVIDENCE],
        "service": session.get("service"),
        "family": session.get("family"),
        "category": session.get("category"),
        "asn": session.get("asn"),
        "country": session.get("country"),
        "record_count": session.get("record_count"),
        "bytes_uploaded": session.get("bytes_uploaded"),
        "bytes_downloaded": session.get("bytes_downloaded"),
        "tower_id": session.get("tower_id"),
    }


def build_activity_events(sessions):
    return [synthesize_event(s) for s in sessions]
