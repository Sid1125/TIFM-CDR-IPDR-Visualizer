"""Geospatial helpers for movement/speed inference.

Coordinates here are tower (cell) positions, i.e. an *approximation* of where the
handset was — cell radius can be hundreds of metres to several km. So distances and
speeds are area-to-area estimates: reliable for catching gross anomalies (a handset
"teleporting" between cities), not for street-level precision.
"""
from __future__ import annotations

import math

EARTH_KM = 6371.0088

# Speed (km/h) -> plausible travel mode. Ordered ascending; first band whose upper
# bound is >= the speed wins. Anything above the last real band is physically
# impossible for a person and flags a likely SIM clone / spoofed record / data error.
TRAVEL_BANDS = [
    (3.0, "stationary"),
    (12.0, "walking"),
    (45.0, "local road"),
    (120.0, "road / highway"),
    (250.0, "rail / expressway"),
    (900.0, "air"),
]
IMPOSSIBLE_KMH = 900.0


def haversine_km(lat1, lon1, lat2, lon2):
    """Great-circle distance in km, or None if any coordinate is missing."""
    if None in (lat1, lon1, lat2, lon2):
        return None
    try:
        p1, p2 = math.radians(float(lat1)), math.radians(float(lat2))
        dphi = math.radians(float(lat2) - float(lat1))
        dlmb = math.radians(float(lon2) - float(lon1))
    except (TypeError, ValueError):
        return None
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_KM * math.asin(min(1.0, math.sqrt(a)))


def classify_speed(kmh):
    """Map an implied speed to a plausible travel mode label."""
    if kmh is None:
        return None
    for upper, name in TRAVEL_BANDS:
        if kmh <= upper:
            return name
    return "impossible"
