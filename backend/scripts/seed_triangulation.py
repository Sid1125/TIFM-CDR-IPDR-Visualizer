from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.database import SessionLocal
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower

# ── Towers in Mumbai (BKC to Bandra ~3 km corridor) ──
TOWERS = [
    {
        "tower_id": "TRI_TWR_A",
        "latitude": 19.0745,
        "longitude": 72.8772,
        "city": "Mumbai",
        "state": "Maharashtra",
    },
    {
        "tower_id": "TRI_TWR_B",
        "latitude": 19.0670,
        "longitude": 72.8690,
        "city": "Mumbai",
        "state": "Maharashtra",
    },
    {
        "tower_id": "TRI_TWR_C",
        "latitude": 19.0590,
        "longitude": 72.8610,
        "city": "Mumbai",
        "state": "Maharashtra",
    },
    {
        "tower_id": "TRI_TWR_D",
        "latitude": 19.0510,
        "longitude": 72.8530,
        "city": "Mumbai",
        "state": "Maharashtra",
    },
]

# ── 3 time clusters (each ≤30 min, using ≥2 towers) ──
CLUSTERS = [
    {
        "start": datetime(2026, 6, 5, 10, 0, 0),
        "towers": ["TRI_TWR_A", "TRI_TWR_B"],
        "rat": "LTE",
    },
    {
        "start": datetime(2026, 6, 5, 11, 15, 0),
        "towers": ["TRI_TWR_B", "TRI_TWR_C", "TRI_TWR_D"],
        "rat": "NR",
    },
    {
        "start": datetime(2026, 6, 5, 14, 30, 0),
        "towers": ["TRI_TWR_A", "TRI_TWR_C"],
        "rat": "UMTS",
    },
]

SUBJECT_IP = "10.1.0.1"
DEST_IPS = ["8.8.8.8", "142.250.72.14", "157.240.22.35"]


def main():
    db = SessionLocal()
    try:
        # 1. Upsert towers
        for t in TOWERS:
            existing = db.query(Tower).filter(Tower.tower_id == t["tower_id"]).one_or_none()
            if existing:
                existing.latitude = t["latitude"]
                existing.longitude = t["longitude"]
                existing.city = t["city"]
                existing.state = t["state"]
            else:
                db.add(Tower(**t))
        db.flush()

        # Build lookup: tower_id → Tower
        tower_map = {t.tower_id: t for t in db.query(Tower).filter(Tower.tower_id.in_([tw["tower_id"] for tw in TOWERS])).all()}

        # 2. Build IPDR records — 3 records per tower per cluster
        records = []
        for cluster in CLUSTERS:
            base = cluster["start"]
            for i, tid in enumerate(cluster["towers"]):
                tw = tower_map[tid]
                for offset_min in range(3):
                    st = base + timedelta(minutes=i * 8 + offset_min * 2)
                    et = st + timedelta(seconds=120 + i * 30)
                    # For half the records, flip subject↔dest so geoSub finds them
                    if (i + offset_min) % 2 == 0:
                        sip, dip = SUBJECT_IP, DEST_IPS[i % len(DEST_IPS)]
                    else:
                        sip, dip = DEST_IPS[i % len(DEST_IPS)], SUBJECT_IP
                    records.append(
                        IPDRRecord(
                            case_id="TRIANGULATION_CASE",
                            msisdn="91111111111",
                            imsi="404101234567890",
                            imei="351234567890123",
                            start_time=st,
                            end_time=et,
                            duration_seconds=120 + i * 30,
                            source_ip=sip,
                            destination_ip=dip,
                            source_port=49152 + i,
                            destination_port=443,
                            protocol="TCP",
                            bytes_uploaded=1024 * (50 + i * 10),
                            bytes_downloaded=2048 * (50 + i * 10),
                            tower_id=tid,
                            cell_id=str(1000 + i),
                            lac="123",
                            latitude=tw.latitude,
                            longitude=tw.longitude,
                            apn="internet",
                            rat=cluster["rat"],
                        )
                    )
        db.add_all(records)
        db.commit()
        print(f"Seeded {len(TOWERS)} towers and {len(records)} IPDR records.")
        print("Subject IP: 10.1.0.1")
        print("MSISDN: 91111111111")
        print("Open Map tab -> select '10.1.0.1' -> choose 'Triangulation' -> click Go")

    except Exception as e:
        db.rollback()
        print(f"Error: {e}")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
