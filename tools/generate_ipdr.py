"""
ARGUS — IPDR sample data generator
Produces a realistic 50 000-row IPDR CSV ready to import via the IPDR upload tile.

Usage
-----
    python tools/generate_ipdr.py                  # → samples/generated_ipdr.csv
    python tools/generate_ipdr.py -o /tmp/big.csv  # custom output path
    python tools/generate_ipdr.py -n 100000        # different row count

The generated data is modelled on a 30-day window (June 2026) across 8 subjects
(Indian mobile numbers) with realistic session patterns: heavy downloaders, night
owls, VoIP-heavy users, SIM-swap cases (one MSISDN switching IMEI mid-month), etc.
All destination IPs include recognisable service blocks (Google, Meta, Akamai, etc.)
so the ISD / external-IP analysis reports have interesting content.
"""

import argparse
import csv
import ipaddress
import math
import os
import random
import sys
from datetime import datetime, timedelta

SEED = 42
random.seed(SEED)

# ── Configuration ────────────────────────────────────────────────────────────

OUT_DEFAULT = os.path.join(os.path.dirname(__file__), "..", "samples", "generated_ipdr.csv")
ROWS = 50_000
WINDOW_START = datetime(2026, 6, 1, 0, 0, 0)
WINDOW_END   = datetime(2026, 6, 30, 23, 59, 59)

# ── Subjects (8 phones, realistic Indian series) ──────────────────────────────

SUBJECTS = [
    # (msisdn,  imsi,              imei_list,                          weight)
    ("9810012345", "404451234567890", ["356789012345671"],                     0.18),
    ("9820055667", "404452234567890", ["356789012345672", "356789099999999"],  0.15),  # SIM-swap
    ("9845098765", "404453234567890", ["356789012345673"],                     0.12),
    ("7020012345", "404454234567890", ["356789012345674"],                     0.10),
    ("8826110099", "404458234567890", ["356789012345688"],                     0.09),
    ("9871022334", "404455234567890", ["356789012345675"],                     0.14),
    ("9899001122", "404456234567890", ["356789012345676"],                     0.11),
    ("6300123456", "404457234567890", ["356789012345677"],                     0.11),
]

# Weights must sum to 1
_total_w = sum(s[3] for s in SUBJECTS)
SUBJECTS = [(m, si, ie, w / _total_w) for m, si, ie, w in SUBJECTS]

# ── Tower data (matches sample_towers.csv where possible) ─────────────────────

TOWERS = [
    ("TWR_DEL_001", 28.6448, 77.2167, "New Delhi",     "Delhi"),
    ("TWR_DEL_002", 28.5355, 77.3910, "Noida",          "Delhi"),
    ("TWR_DEL_003", 28.4595, 77.0266, "Gurugram",       "Delhi"),
    ("TWR_MUM_001", 19.0760, 72.8777, "Mumbai",         "Maharashtra"),
    ("TWR_MUM_002", 19.1136, 72.8697, "Andheri",        "Maharashtra"),
    ("TWR_MUM_003", 18.9220, 72.8347, "Colaba",         "Maharashtra"),
    ("TWR_BLR_001", 12.9716, 77.5946, "Bengaluru",      "Karnataka"),
    ("TWR_BLR_002", 13.0100, 77.5667, "Yelahanka",      "Karnataka"),
    ("TWR_HYD_001", 17.3850, 78.4867, "Hyderabad",      "Telangana"),
    ("TWR_CHN_001", 13.0827, 80.2707, "Chennai",        "Tamil Nadu"),
    ("TWR_PUN_001", 18.5204, 73.8567, "Pune",           "Maharashtra"),
    ("TWR_KOL_001", 22.5726, 88.3639, "Kolkata",        "West Bengal"),
]

# ── Network parameters ────────────────────────────────────────────────────────

# Private IP ranges (NAT'd UE source IPs)
PRIVATE_NETS = [
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("100.64.0.0/10"),  # CGNAT — common in Indian operators
    ipaddress.IPv4Network("172.16.0.0/12"),
]

# Destination IP blocks (public, realistic service IPs)
DEST_BLOCKS = [
    # Google / YouTube / GCP
    ("8.8.8.0/24",       "DNS",      [53],             [53],   "UDP", 0.04),
    ("142.250.0.0/15",   "Google",   [443, 80],        [443],  "TCP", 0.12),
    ("172.217.0.0/16",   "Google",   [443],            [443],  "TCP", 0.06),
    ("35.190.0.0/17",    "GCP",      [443, 8080],      [443],  "TCP", 0.03),
    # Meta / WhatsApp / Instagram
    ("157.240.0.0/17",   "Meta",     [443, 80],        [443],  "TCP", 0.10),
    ("31.13.64.0/18",    "Facebook", [443],            [443],  "TCP", 0.05),
    # WhatsApp UDP (VoIP / relay)
    ("157.240.192.0/22", "WA-VoIP",  [3478, 3479, 5004],[3478],"UDP", 0.06),
    # Akamai CDN
    ("23.32.0.0/11",     "Akamai",   [443, 80],        [443],  "TCP", 0.05),
    ("104.64.0.0/10",    "Akamai",   [443],            [443],  "TCP", 0.03),
    # Cloudflare
    ("104.16.0.0/13",    "Cloudflare",[443, 80],       [443],  "TCP", 0.05),
    ("1.1.1.0/24",       "CF-DNS",   [53],             [53],   "UDP", 0.02),
    # JioSaavn / Hotstar (Indian OTT)
    ("49.44.0.0/15",     "Jio-CDN",  [443, 80],        [443],  "TCP", 0.04),
    ("103.16.0.0/14",    "Hotstar",  [443],            [443],  "TCP", 0.03),
    # Telegram
    ("91.108.0.0/16",    "Telegram", [443, 5222],      [443],  "TCP", 0.04),
    ("149.154.160.0/20", "Telegram", [443],            [443],  "TCP", 0.02),
    # Generic HTTPS traffic (fills the rest)
    ("52.0.0.0/8",       "AWS",      [443, 80, 8443],  [443],  "TCP", 0.06),
    ("3.0.0.0/8",        "AWS",      [443],            [443],  "TCP", 0.04),
    ("13.64.0.0/11",     "Azure",    [443, 80],        [443],  "TCP", 0.03),
    ("20.0.0.0/8",       "Azure",    [443],            [443],  "TCP", 0.03),
    ("34.0.0.0/9",       "GCP-2",    [443],            [443],  "TCP", 0.03),
    # STUN/TURN (WebRTC / video calls)
    ("74.125.0.0/16",    "STUN",     [3478, 19302],    [3478], "UDP", 0.03),
    # Misc / background
    ("203.88.0.0/13",    "BSNL-GW",  [443, 80],        [443],  "TCP", 0.02),
    ("117.96.0.0/11",    "Airtel-GW",[443, 80],        [443],  "TCP", 0.02),
]

# Normalise destination weights
_dw = sum(b[5] for b in DEST_BLOCKS)
DEST_BLOCKS = [(*b[:5], b[5] / _dw) for b in DEST_BLOCKS]

# APNs by operator hint (we'll just randomise from a pool)
APNS = [
    ("internet",          0.30),
    ("airtelgprs.com",    0.18),
    ("jionet",            0.18),
    ("www",               0.10),
    ("ims",               0.10),
    ("fast.t-mobile.com", 0.04),
    ("mobileweb.vodafone.net.in", 0.10),
]
_aw = sum(a[1] for a in APNS)
APNS = [(a[0], a[1] / _aw) for a in APNS]

RATS = [("4G", 0.55), ("LTE", 0.20), ("5G", 0.12), ("3G", 0.09), ("2G", 0.04)]
_rw = sum(r[1] for r in RATS)
RATS = [(r[0], r[1] / _rw) for r in RATS]

# ── Helper utilities ──────────────────────────────────────────────────────────

def _wrand(weighted_list):
    """Pick from list of (value, weight) tuples."""
    r = random.random()
    acc = 0.0
    for val, w in weighted_list:
        acc += w
        if r < acc:
            return val
    return weighted_list[-1][0]


def _rand_ip_in(net_str):
    net = ipaddress.IPv4Network(net_str)
    # pick a random host in the network
    host_count = net.num_addresses - 2  # exclude network + broadcast
    if host_count <= 0:
        return str(net.network_address)
    return str(net.network_address + random.randint(1, host_count))


# Pre-compute one source IP per subject (CGNAT — same across sessions, realistic)
def _subject_src_ip(msisdn):
    random.seed(int(msisdn) % (2**31))
    net = random.choice(PRIVATE_NETS)
    host_count = net.num_addresses - 2
    ip = str(net.network_address + random.randint(1, host_count))
    random.seed(SEED)  # restore global seed
    return ip


SOURCE_IPS = {m: _subject_src_ip(m) for m, *_ in SUBJECTS}

# ── Session generation ────────────────────────────────────────────────────────

def _session_duration(dest_label):
    """Return (duration_s, up_bytes, down_bytes) appropriate for the destination."""
    if dest_label in ("DNS", "CF-DNS"):
        dur = random.randint(0, 2)
        return dur, random.randint(40, 200), random.randint(60, 500)
    if dest_label in ("WA-VoIP", "STUN", "Telegram"):
        dur = random.randint(15, 3600)
        # VoIP: roughly symmetric, ~8 kbps each way
        kbps = random.uniform(6, 12)
        b = int(kbps * 1000 / 8 * dur)
        return dur, b + random.randint(-200, 200), b + random.randint(-200, 200)
    if dest_label in ("Google", "Meta", "Facebook", "Hotstar", "Akamai", "Jio-CDN"):
        # Streaming / browsing: heavy download
        dur = random.randint(30, 7200)
        up = random.randint(500, 50_000)
        down = int(up * random.uniform(8, 60))
        return dur, up, down
    # Generic HTTPS
    dur = random.randint(1, 1800)
    up = random.randint(200, 100_000)
    down = int(up * random.uniform(2, 20))
    return dur, up, down


def _jitter_tower(tower, msisdn_seed):
    """Add tiny coordinate jitter so different subjects on the same tower differ slightly."""
    rng = random.Random(msisdn_seed)
    t = list(tower)
    t[1] = round(t[1] + rng.uniform(-0.002, 0.002), 6)
    t[2] = round(t[2] + rng.uniform(-0.002, 0.002), 6)
    return tuple(t)


def _pick_imei(subject_data, ts):
    """For the SIM-swap subject (index 1), switch IMEI after June 14."""
    imeis = subject_data[2]
    if len(imeis) == 1:
        return imeis[0]
    return imeis[0] if ts < datetime(2026, 6, 15) else imeis[1]


def _rand_ts():
    delta = WINDOW_END - WINDOW_START
    return WINDOW_START + timedelta(seconds=random.randint(0, int(delta.total_seconds())))


# ── Main generator ────────────────────────────────────────────────────────────

HEADER = [
    "msisdn", "imsi", "imei",
    "start_time", "end_time", "duration_seconds",
    "source_ip", "destination_ip", "source_port", "destination_port",
    "protocol", "bytes_uploaded", "bytes_downloaded",
    "tower_id", "cell_id", "lac",
    "latitude", "longitude",
    "apn", "rat",
]

TS_FMT = "%Y-%m-%d %H:%M:%S"

# Each subject gravitates toward a subset of towers (home / work patterns)
def _subject_towers(msisdn):
    idx = [m for m, *_ in SUBJECTS].index(msisdn)
    # first 3 subjects: Delhi towers; next 2: Mumbai; rest: mixed
    groups = [
        [0, 1, 2],   # Delhi
        [3, 4, 5],   # Mumbai
        [6, 7],      # Bangalore
        [8],         # Hyderabad
        [9],         # Chennai
        [0, 3],      # Delhi + Mumbai
        [10],        # Pune
        [11],        # Kolkata
    ]
    primary = groups[idx % len(groups)]
    # 80 % chance of home tower, 20 % chance of any tower
    if random.random() < 0.80:
        return TOWERS[random.choice(primary)]
    return random.choice(TOWERS)


def generate(n, out_path):
    # Build cumulative weights for subject selection
    sub_weights = [s[3] for s in SUBJECTS]
    sub_cumulative = []
    acc = 0.0
    for w in sub_weights:
        acc += w
        sub_cumulative.append(acc)

    dest_cumulative = []
    acc = 0.0
    for b in DEST_BLOCKS:
        acc += b[5]
        dest_cumulative.append(acc)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(HEADER)

        for i in range(n):
            # Pick subject
            r = random.random()
            sub_idx = next(j for j, c in enumerate(sub_cumulative) if r < c)
            sub = SUBJECTS[sub_idx]
            msisdn, imsi = sub[0], sub[1]

            # Pick destination block
            r2 = random.random()
            dest_idx = next(j for j, c in enumerate(dest_cumulative) if r2 < c)
            db = DEST_BLOCKS[dest_idx]
            net_str, label, src_ports, dst_ports, proto = db[0], db[1], db[2], db[3], db[4]

            ts = _rand_ts()
            imei = _pick_imei(sub, ts)

            dur, up, down = _session_duration(label)
            end_ts = ts + timedelta(seconds=dur)
            if end_ts > WINDOW_END:
                end_ts = WINDOW_END
                dur = int((end_ts - ts).total_seconds())

            tower = _subject_towers(msisdn)
            tower = _jitter_tower(tower, int(msisdn) % 10000)
            tower_id, lat, lng, city, state = tower[0], tower[1], tower[2], tower[3], tower[4]
            cell_id = str(10000 + (sub_idx * 13 + int(tower_id[-3:])) % 9000)
            lac = str(4000 + sub_idx * 100 + int(tower_id[-2:]))

            src_ip = SOURCE_IPS[msisdn]
            dst_ip = _rand_ip_in(net_str)
            src_port = random.choice(src_ports) if proto == "DNS" else random.randint(1024, 65535)
            dst_port = random.choice(dst_ports)

            apn = _wrand(APNS)
            rat = _wrand(RATS)

            w.writerow([
                msisdn, imsi, imei,
                ts.strftime(TS_FMT), end_ts.strftime(TS_FMT), dur,
                src_ip, dst_ip, src_port, dst_port,
                proto, up, down,
                tower_id, cell_id, lac,
                lat, lng,
                apn, rat,
            ])

            if (i + 1) % 5000 == 0:
                pct = (i + 1) / n * 100
                bar = "#" * int(pct / 2)
                sys.stderr.write(f"\r  [{bar:<50}] {pct:.0f}%  {i+1:,}/{n:,}")
                sys.stderr.flush()

    sys.stderr.write(f"\r  [{'#'*50}] 100%  {n:,}/{n:,}\n")
    sys.stderr.flush()


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description="Generate a synthetic IPDR CSV for ARGUS testing.")
    p.add_argument("-o", "--output", default=OUT_DEFAULT,
                   help="Output CSV path (default: samples/generated_ipdr.csv)")
    p.add_argument("-n", "--rows", type=int, default=ROWS,
                   help=f"Number of rows to generate (default: {ROWS})")
    p.add_argument("-s", "--seed", type=int, default=SEED,
                   help="Random seed (default: 42)")
    args = p.parse_args()

    random.seed(args.seed)

    print(f"Generating {args.rows:,} IPDR records -> {args.output}")
    print(f"  Subjects : {len(SUBJECTS)}  |  Towers : {len(TOWERS)}  |  "
          f"Dest blocks : {len(DEST_BLOCKS)}  |  Seed : {args.seed}")
    print(f"  Window   : {WINDOW_START.date()} to {WINDOW_END.date()}")
    print()

    generate(args.rows, args.output)

    size_kb = os.path.getsize(args.output) / 1024
    print(f"\nDone. File size: {size_kb:.0f} KB")
    print()
    print("Subjects in this file:")
    for m, si, imeis, w in SUBJECTS:
        print(f"  {m}  (IMSI {si})  IMEIs: {', '.join(imeis)}  ~{w*100:.0f}% of rows")
    print()
    print("Tips:")
    print("  * Import via Dashboard -> IPDR upload tile (select the subject MSISDN first).")
    print("  * 9820055667 switches IMEI after 15 Jun -- check Analysis Reports -> IMEI summary.")
    print("  * Analysis Reports -> ISD calls: DNS + STUN sessions to non-IN destination IPs.")
    print("  * Group Compare -> common contacts: reveals shared destination IPs across subjects.")


if __name__ == "__main__":
    main()
