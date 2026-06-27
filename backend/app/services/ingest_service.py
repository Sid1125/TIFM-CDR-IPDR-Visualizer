"""Flexible ingest: map messy operator CSV headers (Airtel/Jio/VI and generic exports) onto the
canonical CDR/IPDR field names, parse mixed date formats, and produce a validation report of what
was coerced or dropped — so real dumps don't silently misparse. CDR/IPDR separation is preserved:
each kind has its own canonical schema and alias set."""
from __future__ import annotations

import re
from typing import Optional

import pandas as pd

# Canonical columns the record-builders consume (must match CDRRecord / IPDRRecord fields).
CANONICAL = {
    "cdr": [
        "msisdn", "imsi", "imei", "a_party_number", "b_party_number", "call_type", "direction",
        "start_time", "end_time", "duration_seconds", "tower_id", "cell_id", "lac",
        "latitude", "longitude", "technology",
    ],
    "ipdr": [
        "msisdn", "imsi", "imei", "start_time", "end_time", "duration_seconds",
        "source_ip", "destination_ip", "source_port", "destination_port", "protocol",
        "bytes_uploaded", "bytes_downloaded", "tower_id", "cell_id", "lac",
        "latitude", "longitude", "apn", "rat",
    ],
    "dump": [
        "msisdn", "imsi", "imei", "other_party", "start_time", "end_time", "call_type",
        "tower_id", "cell_id", "lac", "latitude", "longitude",
    ],
}

REQUIRED = {
    "cdr": ["a_party_number", "b_party_number", "start_time", "end_time", "duration_seconds"],
    "ipdr": ["start_time", "end_time", "source_ip", "destination_ip"],
    "dump": ["msisdn", "start_time"],
}

# canonical -> known header aliases (matched after normalization). The canonical name itself is
# always accepted; these cover common operator variations.
ALIASES = {
    "cdr": {
        "a_party_number": ["aparty", "a_party", "caller", "calling_number", "calling_party",
                           "callingnumber", "originating_number", "from_number", "msisdn_a", "a_no", "anumber"],
        "b_party_number": ["bparty", "b_party", "called", "called_number", "called_party",
                           "callednumber", "terminating_number", "to_number", "msisdn_b", "b_no", "bnumber"],
        "start_time": ["starttime", "call_date", "call_datetime", "datetime", "date_time", "start",
                       "start_date", "call_start", "event_time", "timestamp", "date"],
        "end_time": ["endtime", "end", "call_end", "stop_time", "disconnect_time"],
        "duration_seconds": ["duration", "call_duration", "dur", "duration_sec", "durationsecs",
                             "duration_secs", "call_dur"],
        "msisdn": ["mobile_number", "subscriber", "subscriber_number"],
        "imei": ["imei_number", "handset", "device_id", "imei_no"],
        "imsi": ["imsi_number", "sim", "imsi_no"],
        "call_type": ["calltype", "type", "event_type", "service_type"],
        "direction": ["call_direction", "in_out", "io"],
        "tower_id": ["towerid", "cgi", "site_id", "first_cgi", "cell_global_id", "tower"],
        "cell_id": ["cellid", "ci", "cell"],
        "lac": ["location_area_code", "tac"],
        "latitude": ["lat", "tower_lat", "latitude_deg"],
        "longitude": ["long", "lng", "lon", "tower_long", "tower_lng", "longitude_deg"],
        "technology": ["tech", "rat", "network_type", "bearer"],
    },
    "ipdr": {
        "start_time": ["starttime", "session_start", "datetime", "date_time", "start",
                       "start_date", "event_time", "timestamp", "date"],
        "end_time": ["endtime", "session_end", "end", "stop_time"],
        "source_ip": ["sourceip", "src_ip", "source_ip_address", "private_ip", "src", "source_address"],
        "destination_ip": ["destinationip", "dest_ip", "dst_ip", "destination_ip_address",
                           "public_ip", "dst", "destination_address"],
        "source_port": ["sourceport", "src_port", "private_port", "sport"],
        "destination_port": ["destinationport", "dest_port", "dst_port", "public_port", "dport"],
        "duration_seconds": ["duration", "session_duration", "dur", "duration_sec"],
        "protocol": ["proto", "ip_protocol", "l4_protocol"],
        "bytes_uploaded": ["bytes_up", "uplink_bytes", "ul_bytes", "upload_bytes", "data_up", "uplink_volume"],
        "bytes_downloaded": ["bytes_down", "downlink_bytes", "dl_bytes", "download_bytes", "data_down", "downlink_volume"],
        "msisdn": ["mobile_number", "subscriber", "subscriber_number"],
        "imei": ["imei_number", "handset", "device_id"],
        "imsi": ["imsi_number", "sim"],
        "tower_id": ["towerid", "cgi", "site_id", "cell_global_id", "tower"],
        "cell_id": ["cellid", "ci", "cell"],
        "lac": ["location_area_code", "tac"],
        "latitude": ["lat", "tower_lat"],
        "longitude": ["long", "lng", "lon", "tower_long", "tower_lng"],
        "apn": ["access_point_name", "apn_name"],
        "rat": ["radio_access_technology", "network_type", "technology", "bearer"],
    },
    "dump": {
        "msisdn": ["mobile_number", "number", "msisdn", "a_party", "aparty", "calling_number",
                   "party", "subscriber", "subscriber_number", "caller", "msisdn_a", "a_no"],
        "other_party": ["b_party", "bparty", "called", "called_number", "other_party", "b_no",
                        "called_party", "to_number"],
        "start_time": ["starttime", "call_date", "datetime", "date_time", "start", "start_date",
                       "event_time", "timestamp", "date", "first_seen"],
        "end_time": ["endtime", "end", "stop_time", "last_seen"],
        "call_type": ["calltype", "type", "event_type", "service_type"],
        "imei": ["imei_number", "handset", "device_id", "imei_no"],
        "imsi": ["imsi_number", "sim", "imsi_no"],
        "tower_id": ["towerid", "cgi", "site_id", "cell_global_id", "tower", "first_cgi"],
        "cell_id": ["cellid", "ci", "cell"],
        "lac": ["location_area_code", "tac"],
        "latitude": ["lat", "tower_lat"],
        "longitude": ["long", "lng", "lon", "tower_long", "tower_lng"],
    },
}

# Date formats tried in order; the one parsing the most values wins, with a dayfirst fallback.
_DATE_FORMATS = [
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y/%m/%d %H:%M:%S",
    "%d/%m/%Y %H:%M:%S", "%d-%m-%Y %H:%M:%S", "%m/%d/%Y %H:%M:%S",
    "%d-%b-%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%Y-%m-%d %H:%M", "%d-%m-%Y %H:%M",
]


def _norm(name: str) -> str:
    """Normalize a header for matching: lowercase, collapse non-alphanumerics to single underscores."""
    s = re.sub(r"[^a-z0-9]+", "_", str(name).strip().lower())
    return s.strip("_")


def _build_lookup(kind: str) -> dict[str, str]:
    """normalized-alias -> canonical, including each canonical name mapping to itself."""
    lut: dict[str, str] = {}
    for canon in CANONICAL[kind]:
        lut[_norm(canon)] = canon
    for canon, aliases in ALIASES.get(kind, {}).items():
        for a in aliases:
            lut.setdefault(_norm(a), canon)
    return lut


def detect_operator(columns) -> Optional[str]:
    """Best-effort operator hint from the header signature. Returns a label or None."""
    blob = " ".join(_norm(c) for c in columns)
    for op, needles in (
        ("Airtel", ("airtel",)),
        ("Jio", ("jio", "ril")),
        ("Vi", ("vodafone", "vodafone_idea", "vi_")),
        ("BSNL", ("bsnl",)),
    ):
        if any(n in blob for n in needles):
            return op
    return None


def resolve_columns(df_columns, kind: str, override: Optional[dict] = None) -> dict:
    """Map this file's headers onto canonical fields. `override` (canonical -> actual header) wins
    when the actual header exists in the file. Returns mapping + any unmapped required fields +
    a detected-operator hint."""
    kind = kind.lower()
    cols = list(df_columns)
    lut = _build_lookup(kind)
    mapping: dict[str, str] = {}
    for actual in cols:
        canon = lut.get(_norm(actual))
        if canon and canon not in mapping:
            mapping[canon] = actual
    if override:
        for canon, actual in override.items():
            if canon in CANONICAL.get(kind, []) and actual in cols:
                mapping[canon] = actual
    unmapped_required = [c for c in REQUIRED[kind] if c not in mapping]
    return {
        "mapping": mapping,
        "unmapped_required": unmapped_required,
        "detected_operator": detect_operator(cols),
        "canonical": CANONICAL[kind],
        "required": REQUIRED[kind],
    }


def _parse_datetimes(series: pd.Series) -> pd.Series:
    """Parse a column of timestamps that may MIX several formats row-to-row (operators are
    inconsistent). Tries each candidate format in turn, filling only the still-unparsed cells, so a
    file with both ISO and dd/mm/yyyy rows resolves both. A dayfirst-aware generic parse mops up
    anything the explicit formats missed."""
    result = pd.Series(pd.NaT, index=series.index, dtype="datetime64[ns]")
    remaining = series.notna()
    for fmt in _DATE_FORMATS:
        if not remaining.any():
            break
        parsed = pd.to_datetime(series.where(remaining), format=fmt, errors="coerce")
        fill = parsed.notna()
        result = result.where(~fill, parsed)
        remaining = remaining & ~fill
    if remaining.any():
        generic = pd.to_datetime(series.where(remaining), errors="coerce", dayfirst=True)
        fill = generic.notna()
        result = result.where(~fill, generic)
    return result


def coerce_frame(df: pd.DataFrame, kind: str, mapping: dict) -> tuple[pd.DataFrame, dict]:
    """Rename mapped headers to canonical, parse timestamps, drop rows with no usable start time,
    and return the canonical frame plus a validation report."""
    kind = kind.lower()
    rows_total = int(len(df))
    # Build a canonical-only frame.
    out = pd.DataFrame(index=df.index)
    for canon, actual in mapping.items():
        out[canon] = df[actual]

    coerced: dict[str, int] = {}
    date_failures = 0
    for col in ("start_time", "end_time"):
        if col in out.columns:
            raw = out[col]
            parsed = _parse_datetimes(raw)
            failed = int((raw.notna() & parsed.isna()).sum())
            if failed:
                coerced[col] = failed
                date_failures += failed
            out[col] = parsed

    # Drop policy: a row with no parseable start_time has no temporal anchor and is useless for
    # analysis — drop it; keep everything else (nulls in non-required fields are fine).
    dropped_examples = []
    rows_dropped = 0
    if "start_time" in out.columns:
        bad_mask = out["start_time"].isna()
        rows_dropped = int(bad_mask.sum())
        if rows_dropped:
            for _, row in df[bad_mask].head(5).iterrows():
                dropped_examples.append({k: (None if pd.isna(v) else str(v)) for k, v in row.items()})
            out = out[~bad_mask]

    report = {
        "kind": kind,
        "rows_total": rows_total,
        "rows_imported": int(len(out)),
        "rows_dropped": rows_dropped,
        "date_failures": date_failures,
        "coerced": coerced,
        "mapping": mapping,
        "dropped_examples": dropped_examples,
    }
    return out, report
