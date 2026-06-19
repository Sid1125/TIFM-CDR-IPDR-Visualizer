from __future__ import annotations

import csv
import random
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "sample_data"

random.seed(42)


def write_csv(path: Path, header: list[str], rows: list[list[object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)


CALL_TYPES = ["VOICE", "VIDEO", "SMS", "USSD", "CONFERENCE"]
DIRECTIONS = ["MO", "MT", "ROAMING"]
TECHNOLOGIES = ["2G", "3G", "4G", "5G", "VoLTE", "VoWiFi"]
PROTOCOLS = ["TCP", "UDP", "TLS", "HTTP", "HTTPS", "DNS"]
APNS = ["internet", "wap", "mms", "jio", "airtel", "bsnl", "vi", "jazz", "telenor"]
RATS = ["LTE", "UMTS", "GPRS", "EDGE", "NR", "HSPA", "HSDPA"]

SUBJECT_NUMBER = "91111111111"
SUBJECT_IP = "10.1.0.1"
MSISDNS = [f"9{idx:09d}" for idx in range(120, 320)]


def generate_towers(count: int = 60) -> list[dict[str, object]]:
    cities = [
        ("New Delhi", "Delhi", 28.6139, 77.2090),
        ("Gurugram", "Haryana", 28.4595, 77.0266),
        ("Mumbai", "Maharashtra", 19.0760, 72.8777),
        ("Bengaluru", "Karnataka", 12.9716, 77.5946),
        ("Kolkata", "West Bengal", 22.5726, 88.3639),
        ("Chennai", "Tamil Nadu", 13.0827, 80.2707),
        ("Hyderabad", "Telangana", 17.3850, 78.4867),
        ("Pune", "Maharashtra", 18.5204, 73.8567),
        ("Ahmedabad", "Gujarat", 23.0225, 72.5714),
        ("Jaipur", "Rajasthan", 26.9124, 75.7873),
    ]

    towers: list[dict[str, object]] = []
    for index in range(count):
        city, state, lat, lon = cities[index % len(cities)]
        lat += random.uniform(-0.2, 0.2)
        lon += random.uniform(-0.2, 0.2)
        towers.append(
            {
                "tower_id": f"TWR{index + 1:03d}",
                "latitude": round(lat, 6),
                "longitude": round(lon, 6),
                "city": city,
                "state": state,
            }
        )
    return towers


def generate_cdr_rows(towers: list[dict[str, object]], count: int = 1200) -> list[list[object]]:
    imeis = [f"35{random.randint(10000000000, 99999999999)}" for _ in range(200)]
    case_ids = [f"CASE-{random.randint(1000, 9999)}" for _ in range(15)]
    start = datetime(2026, 6, 1, 6, 0, 0)
    rows: list[list[object]] = []

    for i in range(count):
        contact = random.choice([s for s in MSISDNS if s != SUBJECT_NUMBER])
        imsi = f"404{random.randint(10, 99)}{random.randint(100000000, 999999999)}"
        imei = random.choice(imeis)
        start_time = start + timedelta(minutes=random.randint(0, 7 * 24 * 60))
        duration = random.randint(5, 900)
        end_time = start_time + timedelta(seconds=duration)
        tower = random.choice(towers)
        call_type = random.choice(CALL_TYPES)
        direction = random.choice(DIRECTIONS)
        tech = random.choice(TECHNOLOGIES)
        cell_id = str(random.randint(1000, 9999))
        lac = str(random.randint(100, 999))

        if random.random() < 0.5:
            a_party, b_party = SUBJECT_NUMBER, contact
        else:
            a_party, b_party = contact, SUBJECT_NUMBER

        rows.append([
            random.choice(case_ids),
            SUBJECT_NUMBER,
            imsi,
            imei,
            a_party,
            b_party,
            call_type,
            direction,
            start_time.isoformat(),
            end_time.isoformat(),
            duration,
            tower["tower_id"],
            cell_id,
            lac,
            round(tower["latitude"] + random.uniform(-0.01, 0.01), 6),
            round(tower["longitude"] + random.uniform(-0.01, 0.01), 6),
            tech,
        ])

    return rows


def generate_ipdr_rows(towers: list[dict[str, object]], count: int = 1800) -> list[list[object]]:
    external_hosts = [
        "157.240.22.35",
        "142.250.72.14",
        "91.108.56.166",
        "52.114.132.8",
        "8.8.8.8",
        "1.1.1.1",
        "104.16.132.229",
        "13.107.42.12",
        "34.117.59.81",
        "172.217.160.110",
    ]
    port_protocol = [
        (53, "UDP"), (80, "TCP"), (443, "TCP"), (3478, "UDP"),
        (5222, "TCP"), (5223, "TCP"), (5228, "UDP"), (8080, "TCP"),
        (8443, "TCP"), (993, "TCP"), (995, "TCP"), (5060, "UDP"),
    ]
    imeis = [f"35{random.randint(10000000000, 99999999999)}" for _ in range(200)]
    case_ids = [f"CASE-{random.randint(1000, 9999)}" for _ in range(15)]
    start = datetime(2026, 6, 1, 6, 0, 0)
    subject_ip = "10.1.0.1"
    rows: list[list[object]] = []

    for _ in range(count):
        msisdn = subject_number if random.random() < 0.7 else random.choice(msisdns)
        imsi = f"404{random.randint(10, 99)}{random.randint(100000000, 999999999)}"
        imei = random.choice(imeis)
        start_time = start + timedelta(minutes=random.randint(0, 7 * 24 * 60))
        duration = random.randint(1, 3600)
        end_time = start_time + timedelta(seconds=duration)
        dest_port, protocol = random.choice(port_protocol)
        source_port = random.randint(49152, 65535)
        bytes_up = random.randint(512, 1_500_000)
        bytes_down = random.randint(512, 2_500_000)
        tower = random.choice(towers)
        cell_id = str(random.randint(1000, 9999))
        lac = str(random.randint(100, 999))

        if random.random() < 0.5:
            source_ip, destination_ip = subject_ip, random.choice(external_hosts)
        else:
            source_ip, destination_ip = random.choice(external_hosts), subject_ip

        rows.append([
            random.choice(case_ids),
            msisdn,
            imsi,
            imei,
            start_time.isoformat(),
            end_time.isoformat(),
            duration,
            source_ip,
            destination_ip,
            source_port,
            dest_port,
            protocol,
            bytes_up,
            bytes_down,
            tower["tower_id"],
            cell_id,
            lac,
            round(tower["latitude"] + random.uniform(-0.01, 0.01), 6),
            round(tower["longitude"] + random.uniform(-0.01, 0.01), 6),
            random.choice(APNS),
            random.choice(RATS),
        ])

    return rows


def main() -> None:
    towers = generate_towers()
    cdr_rows = generate_cdr_rows(towers)
    ipdr_rows = generate_ipdr_rows(towers)

    write_csv(
        OUT_DIR / "towers_sample.csv",
        ["tower_id", "latitude", "longitude", "city", "state"],
        [[t["tower_id"], t["latitude"], t["longitude"], t["city"], t["state"]] for t in towers],
    )

    cdr_header = [
        "case_id", "msisdn", "imsi", "imei",
        "a_party_number", "b_party_number",
        "call_type", "direction",
        "start_time", "end_time", "duration_seconds",
        "tower_id", "cell_id", "lac",
        "latitude", "longitude", "technology",
    ]
    write_csv(OUT_DIR / "cdr_sample.csv", cdr_header, cdr_rows)

    ipdr_header = [
        "case_id", "msisdn", "imsi", "imei",
        "start_time", "end_time", "duration_seconds",
        "source_ip", "destination_ip",
        "source_port", "destination_port",
        "protocol",
        "bytes_uploaded", "bytes_downloaded",
        "tower_id", "cell_id", "lac",
        "latitude", "longitude",
        "apn", "rat",
    ]
    write_csv(OUT_DIR / "ipdr_sample.csv", ipdr_header, ipdr_rows)


if __name__ == "__main__":
    main()
