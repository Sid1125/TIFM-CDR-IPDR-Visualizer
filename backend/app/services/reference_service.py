from __future__ import annotations

import json
import os
import re
from typing import Optional

# Offline telecom reference data (no external API — air-gapped friendly):
#   isd_codes.json    : international dialing code -> country (longest-prefix match)
#   mobile_series.json: India number series (first 4-5 digits) -> {operator, circle}  [seed]
#   imei_tac.json     : IMEI TAC (first 8 digits) -> {make, model}                    [seed]
# Each loader degrades gracefully (missing file / unknown key -> Unknown/None) so the
# feature is honest about coverage rather than fabricating intelligence.
_DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")


def _load(name: str, default):
    try:
        with open(os.path.join(_DATA_DIR, name), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


_ISD = _load("isd_codes.json", {}).get("codes", {})
# Built-in datasets, optionally extended by a user-supplied *_full.json drop-in (e.g. the full DoT
# numbering plan or the Osmocom TAC DB). The full file's entries win on conflict.
_SERIES = {**_load("mobile_series.json", {}).get("by_prefix", {}),
           **_load("mobile_series_full.json", {}).get("by_prefix", {})}
_TAC = {**_load("imei_tac.json", {}).get("by_tac", {}),
        **_load("imei_tac_full.json", {}).get("by_tac", {})}


def _digits(value: str) -> str:
    return re.sub(r"\D", "", value or "")


def normalize_indian(value: str):
    """Reduce a number to its bare form and decide whether it is international.
    Returns (national_10digit_or_None, is_isd, raw_digits, had_plus)."""
    raw = (value or "").strip()
    had_plus = raw.startswith("+") or raw.startswith("00")
    d = _digits(raw)
    # Strip a leading international 00 / + then country code 91 for domestic numbers.
    if d.startswith("00"):
        d = d[2:]
    if d.startswith("91") and len(d) > 10:
        national = d[-10:]
        return national, False, d, had_plus
    if len(d) == 10 and d[0] in "6789":
        return d, False, d, had_plus
    if len(d) == 11 and d[0] == "0":
        return d[1:], False, d, had_plus
    # Not a recognisable Indian 10-digit MSISDN.
    return None, (had_plus or (len(d) > 10)), d, had_plus


def lookup_isd(value: str) -> Optional[dict]:
    """Longest-prefix match against the ISD code table. Returns {code, country} or None."""
    d = _digits(value)
    if d.startswith("00"):
        d = d[2:]
    if not d:
        return None
    for ln in range(min(4, len(d)), 0, -1):
        pref = d[:ln]
        if pref in _ISD:
            return {"code": pref, "country": _ISD[pref]}
    return None


def lookup_number(value: str) -> dict:
    """Resolve a phone number to operator/circle (domestic) or country (international)."""
    national, is_isd, d, had_plus = normalize_indian(value)
    out = {"input": value, "national": national, "is_isd": False,
           "country": None, "operator": None, "circle": None}
    if national:
        # Domestic Indian number: series -> operator + circle of allocation.
        for ln in (5, 4):
            pref = national[:ln]
            if pref in _SERIES:
                out["operator"] = _SERIES[pref].get("operator")
                out["circle"] = _SERIES[pref].get("circle")
                break
        return out
    # Not domestic: treat as international if it looks like one.
    isd = lookup_isd(d if not had_plus else value)
    if isd and isd["code"] != "91":
        out["is_isd"] = True
        out["country"] = isd["country"]
    return out


def lookup_imei(value: str) -> dict:
    """TAC (first 8 digits of the IMEI) -> make/model. Returns make/model None if unknown."""
    d = _digits(value)
    tac = d[:8]
    info = _TAC.get(tac)
    return {"input": value, "tac": tac if len(d) >= 8 else None,
            "make": (info or {}).get("make"), "model": (info or {}).get("model")}


def reference_meta() -> dict:
    """The small maps the client caches to enrich displays locally (series + isd).
    TAC stays server-side (potentially large)."""
    return {"series": _SERIES, "isd": _ISD, "tac": _TAC,
            "series_seed": _load("mobile_series.json", {}).get("seed", False),
            "counts": {"series": len(_SERIES), "isd": len(_ISD), "tac": len(_TAC)}}
