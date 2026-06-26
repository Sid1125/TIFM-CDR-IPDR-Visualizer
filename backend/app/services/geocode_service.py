"""Offline reverse-geocoding for tower coordinates -> Indian city + state.

Auto-harvested towers carry lat/lng (from the records) but no place name, while master-CSV towers
do. To make the repository consistent we derive city/state from coordinates with a *nearest major
city* lookup against an embedded reference table — fully offline (no external API, matching the
app's air-gapped design). State accuracy is high; city is the nearest known city (approximate).
Values are only ever *filled in when missing* — an authoritative master CSV is never overwritten.
"""
from __future__ import annotations

from math import asin, cos, radians, sin, sqrt

from sqlalchemy import or_

from app.models.tower import Tower

# (city, state, latitude, longitude) — a spread of cities across every state/UT so the nearest
# match resolves the correct state for towers anywhere in the country. Coordinates ~2dp (≈1 km).
INDIA_CITIES: list[tuple[str, str, float, float]] = [
    # Delhi / NCR
    ("New Delhi", "Delhi", 28.61, 77.21), ("Delhi", "Delhi", 28.67, 77.23),
    ("Noida", "Uttar Pradesh", 28.54, 77.39), ("Ghaziabad", "Uttar Pradesh", 28.67, 77.45),
    ("Gurugram", "Haryana", 28.46, 77.03), ("Faridabad", "Haryana", 28.41, 77.31),
    # Maharashtra
    ("Mumbai", "Maharashtra", 19.07, 72.88), ("Thane", "Maharashtra", 19.22, 72.97),
    ("Pune", "Maharashtra", 18.52, 73.86), ("Nashik", "Maharashtra", 19.99, 73.79),
    ("Nagpur", "Maharashtra", 21.15, 79.09), ("Aurangabad", "Maharashtra", 19.88, 75.34),
    ("Solapur", "Maharashtra", 17.66, 75.91), ("Kolhapur", "Maharashtra", 16.70, 74.24),
    ("Sangli", "Maharashtra", 16.85, 74.58), ("Amravati", "Maharashtra", 20.93, 77.75),
    ("Akola", "Maharashtra", 20.71, 77.00), ("Nanded", "Maharashtra", 19.15, 77.32),
    ("Latur", "Maharashtra", 18.40, 76.58), ("Jalgaon", "Maharashtra", 21.01, 75.56),
    ("Ahmednagar", "Maharashtra", 19.09, 74.74),
    # Karnataka
    ("Bengaluru", "Karnataka", 12.97, 77.59), ("Mysuru", "Karnataka", 12.30, 76.64),
    ("Mangaluru", "Karnataka", 12.91, 74.86), ("Hubballi", "Karnataka", 15.36, 75.12),
    ("Belagavi", "Karnataka", 15.85, 74.50), ("Kalaburagi", "Karnataka", 17.33, 76.83),
    ("Davangere", "Karnataka", 14.47, 75.92), ("Ballari", "Karnataka", 15.14, 76.92),
    ("Shivamogga", "Karnataka", 13.93, 75.57), ("Tumakuru", "Karnataka", 13.34, 77.10),
    ("Bidar", "Karnataka", 17.91, 77.52),
    # Tamil Nadu
    ("Chennai", "Tamil Nadu", 13.08, 80.27), ("Coimbatore", "Tamil Nadu", 11.02, 76.96),
    ("Madurai", "Tamil Nadu", 9.93, 78.12), ("Tiruchirappalli", "Tamil Nadu", 10.79, 78.70),
    ("Salem", "Tamil Nadu", 11.66, 78.15), ("Tirunelveli", "Tamil Nadu", 8.71, 77.76),
    ("Vellore", "Tamil Nadu", 12.92, 79.13), ("Erode", "Tamil Nadu", 11.34, 77.72),
    ("Tiruppur", "Tamil Nadu", 11.11, 77.34), ("Thoothukudi", "Tamil Nadu", 8.76, 78.13),
    ("Dindigul", "Tamil Nadu", 10.36, 77.98),
    # Telangana
    ("Hyderabad", "Telangana", 17.39, 78.49), ("Warangal", "Telangana", 17.97, 79.59),
    ("Nizamabad", "Telangana", 18.67, 78.09), ("Karimnagar", "Telangana", 18.44, 79.13),
    ("Khammam", "Telangana", 17.25, 80.15),
    # Andhra Pradesh
    ("Visakhapatnam", "Andhra Pradesh", 17.69, 83.22), ("Vijayawada", "Andhra Pradesh", 16.51, 80.65),
    ("Guntur", "Andhra Pradesh", 16.31, 80.44), ("Nellore", "Andhra Pradesh", 14.44, 79.99),
    ("Tirupati", "Andhra Pradesh", 13.63, 79.42), ("Kurnool", "Andhra Pradesh", 15.83, 78.04),
    ("Rajahmundry", "Andhra Pradesh", 17.00, 81.78), ("Kakinada", "Andhra Pradesh", 16.96, 82.24),
    ("Anantapur", "Andhra Pradesh", 14.68, 77.60),
    # West Bengal
    ("Kolkata", "West Bengal", 22.57, 88.36), ("Howrah", "West Bengal", 22.59, 88.31),
    ("Durgapur", "West Bengal", 23.52, 87.31), ("Asansol", "West Bengal", 23.68, 86.95),
    ("Siliguri", "West Bengal", 26.73, 88.40), ("Bardhaman", "West Bengal", 23.26, 87.86),
    ("Malda", "West Bengal", 25.00, 88.14), ("Kharagpur", "West Bengal", 22.35, 87.32),
    # Gujarat
    ("Ahmedabad", "Gujarat", 23.03, 72.58), ("Surat", "Gujarat", 21.17, 72.83),
    ("Vadodara", "Gujarat", 22.31, 73.18), ("Rajkot", "Gujarat", 22.30, 70.80),
    ("Bhavnagar", "Gujarat", 21.76, 72.15), ("Jamnagar", "Gujarat", 22.47, 70.06),
    ("Gandhinagar", "Gujarat", 23.22, 72.65), ("Junagadh", "Gujarat", 21.52, 70.46),
    ("Anand", "Gujarat", 22.56, 72.95),
    # Rajasthan
    ("Jaipur", "Rajasthan", 26.91, 75.79), ("Jodhpur", "Rajasthan", 26.24, 73.02),
    ("Udaipur", "Rajasthan", 24.58, 73.71), ("Kota", "Rajasthan", 25.21, 75.86),
    ("Ajmer", "Rajasthan", 26.45, 74.64), ("Bikaner", "Rajasthan", 28.02, 73.31),
    ("Bhilwara", "Rajasthan", 25.35, 74.64), ("Alwar", "Rajasthan", 27.55, 76.63),
    ("Sri Ganganagar", "Rajasthan", 29.92, 73.88),
    # Uttar Pradesh
    ("Lucknow", "Uttar Pradesh", 26.85, 80.95), ("Kanpur", "Uttar Pradesh", 26.45, 80.33),
    ("Agra", "Uttar Pradesh", 27.18, 78.01), ("Varanasi", "Uttar Pradesh", 25.32, 82.97),
    ("Prayagraj", "Uttar Pradesh", 25.44, 81.85), ("Meerut", "Uttar Pradesh", 28.98, 77.71),
    ("Bareilly", "Uttar Pradesh", 28.37, 79.43), ("Gorakhpur", "Uttar Pradesh", 26.76, 83.37),
    ("Aligarh", "Uttar Pradesh", 27.88, 78.08), ("Moradabad", "Uttar Pradesh", 28.84, 78.77),
    ("Jhansi", "Uttar Pradesh", 25.45, 78.58), ("Saharanpur", "Uttar Pradesh", 29.97, 77.55),
    # Bihar
    ("Patna", "Bihar", 25.59, 85.14), ("Gaya", "Bihar", 24.80, 85.00),
    ("Bhagalpur", "Bihar", 25.34, 86.97), ("Muzaffarpur", "Bihar", 26.12, 85.39),
    ("Darbhanga", "Bihar", 26.15, 85.90), ("Purnia", "Bihar", 25.78, 87.47),
    ("Begusarai", "Bihar", 25.42, 86.13),
    # Jharkhand
    ("Ranchi", "Jharkhand", 23.34, 85.31), ("Jamshedpur", "Jharkhand", 22.80, 86.20),
    ("Dhanbad", "Jharkhand", 23.80, 86.43), ("Bokaro", "Jharkhand", 23.67, 86.15),
    ("Deoghar", "Jharkhand", 24.48, 86.70),
    # Madhya Pradesh
    ("Bhopal", "Madhya Pradesh", 23.26, 77.41), ("Indore", "Madhya Pradesh", 22.72, 75.86),
    ("Jabalpur", "Madhya Pradesh", 23.18, 79.99), ("Gwalior", "Madhya Pradesh", 26.22, 78.18),
    ("Ujjain", "Madhya Pradesh", 23.18, 75.78), ("Sagar", "Madhya Pradesh", 23.84, 78.74),
    ("Satna", "Madhya Pradesh", 24.58, 80.83), ("Rewa", "Madhya Pradesh", 24.53, 81.30),
    ("Ratlam", "Madhya Pradesh", 23.33, 75.04),
    # Chhattisgarh
    ("Raipur", "Chhattisgarh", 21.25, 81.63), ("Bhilai", "Chhattisgarh", 21.21, 81.38),
    ("Bilaspur", "Chhattisgarh", 22.08, 82.15), ("Korba", "Chhattisgarh", 22.35, 82.69),
    ("Durg", "Chhattisgarh", 21.19, 81.28),
    # Odisha
    ("Bhubaneswar", "Odisha", 20.30, 85.82), ("Cuttack", "Odisha", 20.46, 85.88),
    ("Rourkela", "Odisha", 22.26, 84.85), ("Berhampur", "Odisha", 19.31, 84.79),
    ("Sambalpur", "Odisha", 21.47, 83.97),
    # Kerala
    ("Thiruvananthapuram", "Kerala", 8.52, 76.94), ("Kochi", "Kerala", 9.93, 76.27),
    ("Kozhikode", "Kerala", 11.26, 75.78), ("Thrissur", "Kerala", 10.53, 76.21),
    ("Kollam", "Kerala", 8.89, 76.61), ("Kannur", "Kerala", 11.87, 75.37),
    # Punjab
    ("Ludhiana", "Punjab", 30.90, 75.86), ("Amritsar", "Punjab", 31.63, 74.87),
    ("Jalandhar", "Punjab", 31.33, 75.58), ("Patiala", "Punjab", 30.34, 76.39),
    ("Bathinda", "Punjab", 30.21, 74.95), ("Mohali", "Punjab", 30.70, 76.72),
    # Haryana
    ("Panipat", "Haryana", 29.39, 76.97), ("Ambala", "Haryana", 30.38, 76.78),
    ("Rohtak", "Haryana", 28.90, 76.61), ("Hisar", "Haryana", 29.15, 75.72),
    ("Karnal", "Haryana", 29.69, 76.99), ("Yamunanagar", "Haryana", 30.13, 77.27),
    # Uttarakhand
    ("Dehradun", "Uttarakhand", 30.32, 78.03), ("Haridwar", "Uttarakhand", 29.95, 78.16),
    ("Roorkee", "Uttarakhand", 29.87, 77.89), ("Haldwani", "Uttarakhand", 29.22, 79.51),
    # Himachal Pradesh
    ("Shimla", "Himachal Pradesh", 31.10, 77.17), ("Mandi", "Himachal Pradesh", 31.71, 76.93),
    ("Dharamshala", "Himachal Pradesh", 32.22, 76.32),
    # J&K / Ladakh
    ("Srinagar", "Jammu and Kashmir", 34.08, 74.80), ("Jammu", "Jammu and Kashmir", 32.73, 74.87),
    ("Leh", "Ladakh", 34.15, 77.58),
    # North-East
    ("Guwahati", "Assam", 26.14, 91.74), ("Dibrugarh", "Assam", 27.47, 94.91),
    ("Silchar", "Assam", 24.83, 92.78), ("Jorhat", "Assam", 26.75, 94.22),
    ("Imphal", "Manipur", 24.82, 93.94), ("Agartala", "Tripura", 23.83, 91.28),
    ("Aizawl", "Mizoram", 23.73, 92.72), ("Shillong", "Meghalaya", 25.58, 91.89),
    ("Kohima", "Nagaland", 25.67, 94.11), ("Dimapur", "Nagaland", 25.91, 93.73),
    ("Itanagar", "Arunachal Pradesh", 27.10, 93.62), ("Gangtok", "Sikkim", 27.33, 88.61),
    # UTs
    ("Chandigarh", "Chandigarh", 30.73, 76.78), ("Panaji", "Goa", 15.49, 73.83),
    ("Margao", "Goa", 15.27, 73.96), ("Puducherry", "Puducherry", 11.94, 79.83),
    ("Port Blair", "Andaman and Nicobar Islands", 11.62, 92.73),
    ("Kavaratti", "Lakshadweep", 10.57, 72.64), ("Daman", "Dadra and Nagar Haveli and Daman and Diu", 20.40, 72.83),
    ("Silvassa", "Dadra and Nagar Haveli and Daman and Diu", 20.27, 73.01),
]


def _haversine(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in km."""
    lat1, lng1, lat2, lng2 = map(radians, (lat1, lng1, lat2, lng2))
    dlat, dlng = lat2 - lat1, lng2 - lng1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlng / 2) ** 2
    return 2 * 6371.0 * asin(sqrt(a))


def nearest_city(lat: float, lng: float):
    """Return (city, state) of the nearest reference city, or None for non-finite input."""
    if lat is None or lng is None:
        return None
    best = None
    best_d = float("inf")
    for name, state, clat, clng in INDIA_CITIES:
        d = _haversine(lat, lng, clat, clng)
        if d < best_d:
            best_d, best = d, (name, state)
    return best


def fill_tower(tower) -> bool:
    """Fill a tower's missing city/state from its coordinates. Returns True if anything changed.
    Never overwrites a value that is already present (authoritative master data wins)."""
    if tower.latitude is None or tower.longitude is None:
        return False
    if tower.city and tower.state:
        return False
    nc = nearest_city(tower.latitude, tower.longitude)
    if not nc:
        return False
    changed = False
    if not tower.city:
        tower.city = nc[0]
        changed = True
    if not tower.state:
        tower.state = nc[1]
        changed = True
    return changed


def geocode_missing(db) -> dict:
    """Fill city/state for every repository tower that has coordinates but is missing a place
    name. Idempotent; never overwrites existing values."""
    rows = (
        db.query(Tower)
        .filter(
            Tower.latitude.isnot(None), Tower.longitude.isnot(None),
            or_(Tower.city.is_(None), Tower.city == "", Tower.state.is_(None), Tower.state == ""),
        )
        .all()
    )
    filled = sum(1 for t in rows if fill_tower(t))
    db.commit()
    return {"filled": filled}
