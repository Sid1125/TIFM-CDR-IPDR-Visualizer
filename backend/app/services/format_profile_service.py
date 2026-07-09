"""Ingest format profiles: recognise a CSV's column-header *format* before any data row is read.

A profile records one operator/ISP export format per record kind — the exact header set (as a
hash signature) plus the canonical->header mapping an investigator confirmed for it. Matching is
headers-only and cheap: hash the sorted normalized headers, one indexed lookup; if that misses,
a Jaccard overlap scan over the (few dozen at most) stored profiles catches formats that gained
or lost a column or two. Profiles stack on top of the static alias table in ingest_service:
aliases are the generic safety net, a matched profile is format-specific confirmed truth, and a
manual override from the UI still beats both."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.models.format_profile import IngestFormatProfile
from app.services.ingest_service import _norm

# Below this header-set overlap a stored profile is more likely a different format than a tweaked
# revision of the same one — suggesting it would mislead more than help.
PARTIAL_MATCH_THRESHOLD = 0.75


def _normalized_header_set(headers) -> set[str]:
    return {_norm(h) for h in headers if _norm(h)}


def compute_signature(headers) -> str:
    """Order-insensitive, normalization-tolerant fingerprint of a header row. Reordered columns or
    case/punctuation changes produce the same signature, so an ISP shuffling its export layout
    doesn't register as a brand-new format."""
    canon = "\n".join(sorted(_normalized_header_set(headers)))
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def match_profile(db: Session, kind: str, headers) -> Optional[dict]:
    """Find the stored format matching this file's headers. Exact signature hit first; otherwise
    the best Jaccard-overlap profile above PARTIAL_MATCH_THRESHOLD (an ISP adding/dropping a column
    shouldn't unlearn the whole format). Returns {profile, match, overlap, total} or None."""
    kind = kind.lower()
    sig = compute_signature(headers)
    exact = (db.query(IngestFormatProfile)
             .filter(IngestFormatProfile.kind == kind, IngestFormatProfile.signature == sig)
             .first())
    file_set = _normalized_header_set(headers)
    if exact:
        return {"profile": exact, "match": "exact", "overlap": len(file_set), "total": len(file_set)}

    best, best_score = None, 0.0
    for prof in db.query(IngestFormatProfile).filter(IngestFormatProfile.kind == kind).all():
        try:
            prof_set = _normalized_header_set(json.loads(prof.headers_json))
        except Exception:
            continue
        union = file_set | prof_set
        if not union:
            continue
        score = len(file_set & prof_set) / len(union)
        if score > best_score:
            best, best_score = prof, score
    if best and best_score >= PARTIAL_MATCH_THRESHOLD:
        best_set = _normalized_header_set(json.loads(best.headers_json))
        return {"profile": best, "match": "partial",
                "overlap": len(file_set & best_set), "total": len(best_set)}
    return None


def profile_mapping_for(profile: IngestFormatProfile, headers) -> dict:
    """The profile's stored mapping restricted to headers actually present in this file (matched
    after normalization, so cosmetic header changes don't drop the mapping). Values are rewritten
    to the file's own spelling of each header. Partial matches thus apply only what still fits."""
    by_norm = {_norm(h): h for h in headers}
    out = {}
    try:
        stored = json.loads(profile.mapping_json)
    except Exception:
        return out
    for canon, actual in stored.items():
        hit = by_norm.get(_norm(actual))
        if hit is not None:
            out[canon] = hit
    return out


def save_profile(db: Session, kind: str, name: str, headers, mapping: dict,
                 created_by: Optional[str] = None) -> IngestFormatProfile:
    """Create or update (upsert on (kind, signature)) the profile for this header set. Re-confirming
    a corrected mapping for a known format overwrites it rather than duplicating."""
    kind = kind.lower()
    sig = compute_signature(headers)
    prof = (db.query(IngestFormatProfile)
            .filter(IngestFormatProfile.kind == kind, IngestFormatProfile.signature == sig)
            .first())
    if prof is None:
        prof = IngestFormatProfile(kind=kind, signature=sig, name=name, times_used=0,
                                   created_by=created_by,
                                   headers_json=json.dumps(list(headers)),
                                   mapping_json=json.dumps(mapping))
        db.add(prof)
    else:
        prof.name = name or prof.name
        prof.headers_json = json.dumps(list(headers))
        prof.mapping_json = json.dumps(mapping)
        if created_by:
            prof.created_by = created_by
    db.commit()
    db.refresh(prof)
    return prof


def touch_profile(db: Session, profile_id: int) -> None:
    """Bump usage stats after a committed upload actually used the profile (not on mere preview)."""
    prof = db.query(IngestFormatProfile).filter(IngestFormatProfile.id == profile_id).first()
    if prof is not None:
        prof.times_used = (prof.times_used or 0) + 1
        prof.last_used = datetime.now(timezone.utc)
        db.commit()


# Formats known at ship time. Each entry seeds one profile on startup if its signature isn't
# already stored (investigator edits to a seeded profile are therefore never clobbered).
_SEED_PROFILES = [
    {
        "kind": "ipdr",
        "name": "DoT IPDR Standard (Indian ISP)",
        "headers": [
            "Landline/MSISDN/MDN/Leased Circuit ID for Internet Access",
            "User Id for internet Access based on authentication",
            "Source IP Address", "Source Port", "Translated IP Address", "Translated Port",
            "Destination IP Address", "Destination Port", "Static/Dynamic IP Address Allocation",
            "IST Start Time of Public IP address allocation (hh:mm:ss)",
            "IST End Time of Public IP address allocation (hh:mm:ss)",
            "Start Date of Public IP Address allocation (dd/mm/yyyy)",
            "End Date of Public IP address allocation (dd/mm/yyyy)",
            "Source MAC-ID Address/Other device Identification number",
            "IMSI", "PGW IP address", "Access Point Name", "First CELL ID", "Last CELL ID",
            "TIME1 (dd/MM/yyyy HH:mm:ss)", "Session Duration (Seconds)",
            "Data Volume Up Link", "Data Volume Down Link",
            "Roaming Circle Indicator", "Roaming Circle", "SIM Type",
        ],
        "mapping": {
            "msisdn": "Landline/MSISDN/MDN/Leased Circuit ID for Internet Access",
            "imsi": "IMSI",
            "imei": "Source MAC-ID Address/Other device Identification number",
            "source_ip": "Source IP Address",
            "source_port": "Source Port",
            "destination_ip": "Destination IP Address",
            "destination_port": "Destination Port",
            "start_time": "TIME1 (dd/MM/yyyy HH:mm:ss)",
            "duration_seconds": "Session Duration (Seconds)",
            "bytes_uploaded": "Data Volume Up Link",
            "bytes_downloaded": "Data Volume Down Link",
            "cell_id": "First CELL ID",
            "apn": "Access Point Name",
        },
    },
]


def seed_default_profiles(db: Session) -> int:
    """Insert ship-time known formats that aren't stored yet. Idempotent; returns how many were added."""
    added = 0
    for spec in _SEED_PROFILES:
        sig = compute_signature(spec["headers"])
        exists = (db.query(IngestFormatProfile.id)
                  .filter(IngestFormatProfile.kind == spec["kind"],
                          IngestFormatProfile.signature == sig)
                  .first())
        if exists:
            continue
        db.add(IngestFormatProfile(kind=spec["kind"], name=spec["name"], signature=sig,
                                   times_used=0, created_by="seed",
                                   headers_json=json.dumps(spec["headers"]),
                                   mapping_json=json.dumps(spec["mapping"])))
        added += 1
    if added:
        db.commit()
    return added
