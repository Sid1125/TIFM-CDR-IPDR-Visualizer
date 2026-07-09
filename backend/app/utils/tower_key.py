"""Canonical tower/CGI key normalization.

Operator files and tower-master CSVs spell the same cell-global-identity many ways:
"404-10-1234-5678", "40410-1234-5678", "404 10 1234 5678", lowercase hex CI, etc. Joining
records to the tower repository on the raw string silently misses across formats, so both
sides of every tower lookup normalize through this one function: strip everything but
alphanumerics, uppercase. Display keeps whatever form the row carries; only matching is
normalized."""
from __future__ import annotations

import re

_STRIP = re.compile(r"[^0-9A-Za-z]+")


def norm_tower_key(value) -> str | None:
    """Normalized join key for a tower_id/CGI, or None when there's nothing usable."""
    if value is None:
        return None
    s = _STRIP.sub("", str(value)).upper()
    return s or None
