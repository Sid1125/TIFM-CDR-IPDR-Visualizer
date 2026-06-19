from __future__ import annotations

import random
import uuid
from datetime import datetime, timedelta

# Constants for Generation
TOWERS = [
    {"tower_id": "TWR_DEL_01", "lat": 28.6139, "lng": 77.2090, "lac": 101, "cell_id": 5001, "tech": "LTE", "city": "Delhi", "state": "Delhi"},
    {"tower_id": "TWR_DEL_02", "lat": 28.6200, "lng": 77.2150, "lac": 101, "cell_id": 5002, "tech": "NR", "city": "Delhi", "state": "Delhi"},
    {"tower_id": "TWR_DEL_03", "lat": 28.6110, "lng": 77.2000, "lac": 101, "cell_id": 5003, "tech": "LTE", "city": "Delhi", "state": "Delhi"},
    {"tower_id": "TWR_DEL_04", "lat": 28.6250, "lng": 77.2210, "lac": 102, "cell_id": 5011, "tech": "UMTS", "city": "Delhi", "state": "Delhi"},
    {"tower_id": "TWR_DEL_05", "lat": 28.6300, "lng": 77.2300, "lac": 102, "cell_id": 5012, "tech": "LTE", "city": "Delhi", "state": "Delhi"},
    {"tower_id": "TWR_DEL_06", "lat": 28.5900, "lng": 77.2200, "lac": 103, "cell_id": 5021, "tech": "LTE", "city": "Delhi", "state": "Delhi"},
    {"tower_id": "TWR_DEL_07", "lat": 28.5800, "lng": 77.2350, "lac": 103, "cell_id": 5022, "tech": "NR", "city": "Delhi", "state": "Delhi"},
    {"tower_id": "TWR_MUM_01", "lat": 19.0760, "lng": 72.8777, "lac": 201, "cell_id": 6001, "tech": "LTE", "city": "Mumbai", "state": "Maharashtra"},
    {"tower_id": "TWR_MUM_02", "lat": 19.0800, "lng": 72.8800, "lac": 201, "cell_id": 6002, "tech": "NR", "city": "Mumbai", "state": "Maharashtra"},
    {"tower_id": "TWR_MUM_03", "lat": 19.0600, "lng": 72.8700, "lac": 201, "cell_id": 6003, "tech": "LTE", "city": "Mumbai", "state": "Maharashtra"}
]

APPS = {
    "WhatsApp": {"ports": [3478, 5222], "protocol": "UDP", "apn": "portalnmps"},
    "Telegram": {"ports": [443, 8443], "protocol": "TCP", "apn": "internet"},
    "Signal": {"ports": [4433, 3478], "protocol": "TCP", "apn": "internet"},
    "VPN": {"ports": [1194, 51820], "protocol": "UDP", "apn": "vpn.secure"},
    "Web": {"ports": [443, 80], "protocol": "TCP", "apn": "internet"},
    "DNS": {"ports": [53], "protocol": "UDP", "apn": "internet"}
}

def pick(arr):
    return arr[random.randint(0, len(arr) - 1)]

def generate_synthetic_case(scenario: str = "criminal") -> dict:
    """
    Generates synthetic case records matching specific telecom investigation scenarios.
    Returns:
        dict: {"cdr": [...], "ipdr": [...], "towers": [...]}
    """
    random.seed(42) # Seeded generation
    
    start_time = datetime.now() - timedelta(days=5)
    cdr_records = []
    ipdr_records = []
    
    # Base configuration based on scenario
    if scenario == "criminal":
        # Network Topology: Leader, Courier, Lookout, Runner
        leader = "+919999999901"
        courier = "+919999999902"
        lookout = "+919999999903"
        runner = "+919999999904"
        
        subjects = [leader, courier, lookout, runner]
        imsis = {s: f"40445000000000{i}" for i, s in enumerate(subjects)}
        imeis = {s: f"86000000000000{i}" for i, s in enumerate(subjects)}
        
        # 1. Leader communicates mostly with Courier (Lieutenant)
        # 2. Courier communicates with Lookout and Runner
        # 3. Lookout and Runner rarely communicate directly with Leader
        for day in range(5):
            day_start = start_time + timedelta(days=day)
            
            # Leader calls Courier
            for _ in range(random.randint(3, 6)):
                ts = day_start + timedelta(hours=random.randint(9, 18), minutes=random.randint(0, 59))
                cdr_records.append({
                    "id": str(uuid.uuid4()), "timestamp": ts, "type": "CDR", "subject": leader, "counterpart": courier,
                    "duration": random.randint(30, 300), "call_type": "Voice", "direction": "MO", "tower_id": "TWR_DEL_01",
                    "cell_id": 5001, "lac": 101, "imsi": imsis[leader], "imei": imeis[leader], "msisdn": leader,
                    "technology": "LTE", "lat": 28.6139, "lng": 77.2090
                })
                
            # Courier calls Lookout & Runner
            for peer in [lookout, runner]:
                for _ in range(random.randint(4, 8)):
                    ts = day_start + timedelta(hours=random.randint(9, 21), minutes=random.randint(0, 59))
                    cdr_records.append({
                        "id": str(uuid.uuid4()), "timestamp": ts, "type": "CDR", "subject": courier, "counterpart": peer,
                        "duration": random.randint(20, 180), "call_type": "Voice", "direction": "MO", "tower_id": "TWR_DEL_02",
                        "cell_id": 5002, "lac": 101, "imsi": imsis[courier], "imei": imeis[courier], "msisdn": courier,
                        "technology": "LTE", "lat": 28.6200, "lng": 77.2150
                    })
                    
            # Generate IPDR sessions (WhatsApp, Signal, VPN) for Leader & Courier
            for sub in [leader, courier]:
                for app_name, app_info in [("WhatsApp", APPS["WhatsApp"]), ("VPN", APPS["VPN"])]:
                    for _ in range(random.randint(5, 10)):
                        ts = day_start + timedelta(hours=random.randint(6, 23), minutes=random.randint(0, 59))
                        ipdr_records.append({
                            "id": str(uuid.uuid4()), "timestamp": ts, "type": "IPDR", "subject": sub, "counterpart": "10.0.0.1",
                            "duration": random.randint(10, 1200), "protocol": app_info["protocol"], "source_port": random.randint(40000, 60000),
                            "destination_port": app_info["ports"][0], "apn": app_info["apn"], "imsi": imsis[sub], "imei": imeis[sub],
                            "msisdn": sub, "technology": "LTE", "bytes_uploaded": random.randint(5000, 200000),
                            "bytes_downloaded": random.randint(10000, 800000), "tower_id": "TWR_DEL_01" if sub == leader else "TWR_DEL_02",
                            "cell_id": 5001 if sub == leader else 5002, "lac": 101, "lat": 28.6139 if sub == leader else 28.6200,
                            "lng": 77.2090 if sub == leader else 77.2150, "rat": "LTE"
                        })

    elif scenario == "drug":
        # Drug Network: Night activity, burner phones, frequent SIM swaps
        dealer = "+918888888801"
        runner1 = "+918888888802"
        runner2 = "+918888888803"
        
        subjects = [dealer, runner1, runner2]
        # Dealer swap SIMs on day 3
        imsi_dealer_1 = "40445000008801"
        imsi_dealer_2 = "40445000008809" # Swapped SIM
        
        for day in range(5):
            day_start = start_time + timedelta(days=day)
            active_imsi = imsi_dealer_2 if day >= 3 else imsi_dealer_1
            
            # Dealer operates mostly at night (23:00 - 04:00)
            for _ in range(random.randint(6, 12)):
                h = random.choice([23, 0, 1, 2, 3, 4])
                ts = day_start + timedelta(hours=h, minutes=random.randint(0, 59))
                peer = random.choice([runner1, runner2])
                
                cdr_records.append({
                    "id": str(uuid.uuid4()), "timestamp": ts, "type": "CDR", "subject": dealer, "counterpart": peer,
                    "duration": random.randint(10, 60), # Short operational calls
                    "call_type": "Voice", "direction": "MO", "tower_id": "TWR_DEL_06", # Lodhi Colony
                    "cell_id": 5021, "lac": 103, "imsi": active_imsi, "imei": "86000000008888", "msisdn": dealer,
                    "technology": "LTE", "lat": 28.5900, "lng": 77.2200
                })
                
            # IPDR: Telegram messaging & secure VPN usage
            for sub in subjects:
                for app_name, app_info in [("Telegram", APPS["Telegram"]), ("VPN", APPS["VPN"])]:
                    for _ in range(random.randint(4, 8)):
                        h = random.choice([23, 0, 1, 2, 3, 4, 12, 16])
                        ts = day_start + timedelta(hours=h, minutes=random.randint(0, 59))
                        cur_imsi = active_imsi if sub == dealer else f"4044500000880{subjects.index(sub)}"
                        ipdr_records.append({
                            "id": str(uuid.uuid4()), "timestamp": ts, "type": "IPDR", "subject": sub, "counterpart": "20.20.20.20",
                            "duration": random.randint(5, 300), "protocol": app_info["protocol"], "source_port": random.randint(40000, 60000),
                            "destination_port": app_info["ports"][0], "apn": app_info["apn"], "imsi": cur_imsi, "imei": "86000000008888" if sub == dealer else "86000000008800",
                            "msisdn": sub, "technology": "LTE", "bytes_uploaded": random.randint(2000, 50000),
                            "bytes_downloaded": random.randint(4000, 150000), "tower_id": "TWR_DEL_06",
                            "cell_id": 5021, "lac": 103, "lat": 28.5900, "lng": 77.2200, "rat": "LTE"
                        })

    elif scenario == "scam":
        # Scam Network: One-to-many communication, mass victim contacts
        scammer = "+917777777701"
        # 15 unique victim numbers
        victims = [f"+9198765432{i:02d}" for i in range(15)]
        
        for day in range(5):
            day_start = start_time + timedelta(days=day)
            
            # Scammer makes dozens of calls to different numbers
            for v in victims:
                # Scammer dials victim
                ts = day_start + timedelta(hours=random.randint(10, 17), minutes=random.randint(0, 59))
                cdr_records.append({
                    "id": str(uuid.uuid4()), "timestamp": ts, "type": "CDR", "subject": scammer, "counterpart": v,
                    "duration": random.randint(15, 90), # Quick pitches
                    "call_type": "Voice", "direction": "MO", "tower_id": "TWR_DEL_05", # Karol Bagh
                    "cell_id": 5012, "lac": 102, "imsi": "40445000007701", "imei": "86000000007701", "msisdn": scammer,
                    "technology": "LTE", "lat": 28.6300, "lng": 77.2300
                })
                
            # Scammer has dense web/IPDR traffic (likely fraud dashboards, VoIP dialing panels)
            for _ in range(random.randint(15, 30)):
                ts = day_start + timedelta(hours=random.randint(9, 18), minutes=random.randint(0, 59))
                ipdr_records.append({
                    "id": str(uuid.uuid4()), "timestamp": ts, "type": "IPDR", "subject": scammer, "counterpart": "8.8.8.8",
                    "duration": random.randint(5, 60), "protocol": "TCP", "source_port": random.randint(30000, 60000),
                    "destination_port": 443, "apn": "internet", "imsi": "40445000007701", "imei": "86000000007701",
                    "msisdn": scammer, "technology": "LTE", "bytes_uploaded": random.randint(1000, 15000),
                    "bytes_downloaded": random.randint(2000, 50000), "tower_id": "TWR_DEL_05",
                    "cell_id": 5012, "lac": 102, "lat": 28.6300, "lng": 77.2300, "rat": "LTE"
                })

    elif scenario == "human_trafficking":
        # Human Trafficking Pattern: Movement corridors, multiple devices, controlled communication
        trafficker = "+916666666601"
        victim_1 = "+916666666602"
        victim_2 = "+916666666603"
        # Two victims moved along a corridor (Delhi → Mumbai)

        subjects = [trafficker, victim_1, victim_2]
        imsis = {s: f"4044500000660{i}" for i, s in enumerate(subjects)}
        imeis = {s: f"8600000000660{i}" for i, s in enumerate(subjects)}

        for day in range(10):
            day_start = start_time + timedelta(days=day)
            # Corridor movement: first 3 days Delhi, next 4 days transit, last 3 days Mumbai
            if day < 3:
                tow_id, lat, lng = "TWR_DEL_01", 28.6139, 77.2090
            elif day < 7:
                tow_id, lat, lng = "TWR_DEL_04", 28.6250, 77.2210  # Transit hub
            else:
                tow_id, lat, lng = "TWR_MUM_01", 19.0760, 72.8777  # Mumbai arrival

            # Trafficker uses multiple burner IMEIs (device cycling)
            day_imei = imeis[trafficker] if day % 2 == 0 else f"8699990000{day:04d}"

            # Trafficker controls victims via short calls
            for v in [victim_1, victim_2]:
                for _ in range(random.randint(2, 4)):
                    ts = day_start + timedelta(hours=random.randint(7, 22), minutes=random.randint(0, 59))
                    cdr_records.append({
                        "id": str(uuid.uuid4()), "timestamp": ts, "type": "CDR", "subject": trafficker, "counterpart": v,
                        "duration": random.randint(15, 90), "call_type": "Voice", "direction": "MO",
                        "tower_id": tow_id, "cell_id": 5001, "lac": 101, "imsi": imsis[trafficker], "imei": day_imei,
                        "msisdn": trafficker, "technology": "LTE", "lat": lat, "lng": lng
                    })

            # Victims call each other rarely (isolation pattern)
            if day % 3 == 0:
                ts = day_start + timedelta(hours=random.randint(10, 18), minutes=random.randint(0, 59))
                cdr_records.append({
                    "id": str(uuid.uuid4()), "timestamp": ts, "type": "CDR", "subject": victim_1, "counterpart": victim_2,
                    "duration": random.randint(30, 120), "call_type": "Voice", "direction": "MO",
                    "tower_id": tow_id, "cell_id": 5001, "lac": 101, "imsi": imsis[victim_1], "imei": imeis[victim_1],
                    "msisdn": victim_1, "technology": "LTE", "lat": lat, "lng": lng
                })

            # IPDR: Trafficker uses encrypted apps + VPN; victims have minimal data usage
            for _ in range(random.randint(3, 6)):
                ts = day_start + timedelta(hours=random.randint(8, 23), minutes=random.randint(0, 59))
                ipdr_records.append({
                    "id": str(uuid.uuid4()), "timestamp": ts, "type": "IPDR", "subject": trafficker,
                    "counterpart": "10.0.0.1", "duration": random.randint(30, 600),
                    "protocol": pick(["TCP", "UDP"]), "source_port": random.randint(40000, 60000),
                    "destination_port": pick([443, 3478, 1194]), "apn": pick(["internet", "vpn.secure"]),
                    "imsi": imsis[trafficker], "imei": day_imei, "msisdn": trafficker, "technology": "LTE",
                    "bytes_uploaded": random.randint(10000, 500000), "bytes_downloaded": random.randint(20000, 2000000),
                    "tower_id": tow_id, "cell_id": 5001, "lac": 101, "lat": lat, "lng": lng, "rat": "LTE"
                })

    elif scenario == "financial_fraud":
        # Financial Fraud: Call clusters, disposable numbers, SIM farms
        kingpin = "+915555555501"
        operators = [f"+9155555555{i:02d}" for i in range(2, 8)]
        # 20 victim numbers
        fraud_victims = [f"+919000{str(i).zfill(6)}" for i in range(20)]

        subjects = [kingpin] + operators
        imsis = {s: f"404450000055{i}" for i, s in enumerate([kingpin] + operators)}
        imeis = {s: f"860000000055{i}" for i, s in enumerate([kingpin] + operators)}

        for day in range(5):
            day_start = start_time + timedelta(days=day)

            # Kingpin delegates to operators via short calls
            for op in operators:
                for _ in range(random.randint(1, 3)):
                    ts = day_start + timedelta(hours=random.randint(9, 18), minutes=random.randint(0, 59))
                    cdr_records.append({
                        "id": str(uuid.uuid4()), "timestamp": ts, "type": "CDR", "subject": kingpin, "counterpart": op,
                        "duration": random.randint(10, 60), "call_type": "Voice", "direction": "MO",
                        "tower_id": "TWR_DEL_03", "cell_id": 5003, "lac": 101, "imsi": imsis[kingpin],
                        "imei": imeis[kingpin], "msisdn": kingpin, "technology": "LTE",
                        "lat": 28.6110, "lng": 77.2000
                    })

            # Each operator calls multiple victims (cluster pattern)
            for op in operators:
                assigned_victims = fraud_victims[operators.index(op) * 3: (operators.index(op) + 1) * 3]
                for v in assigned_victims:
                    for _ in range(random.randint(1, 4)):
                        ts = day_start + timedelta(hours=random.randint(10, 17), minutes=random.randint(0, 59))
                        cdr_records.append({
                            "id": str(uuid.uuid4()), "timestamp": ts, "type": "CDR", "subject": op, "counterpart": v,
                            "duration": random.randint(30, 300), "call_type": "Voice", "direction": "MO",
                            "tower_id": "TWR_DEL_05", "cell_id": 5012, "lac": 102, "imsi": imsis[op],
                            "imei": imeis[op], "msisdn": op, "technology": "LTE",
                            "lat": 28.6300, "lng": 77.2300
                        })

            # Kingpin swaps SIM on day 3 (disposable number rotation)
            if day == 3:
                imsis[kingpin] = "40445000005599"  # swapped

            # IPDR: Fraud dashboard access (web) + VoIP panel usage
            fraud_apps = [("Web", APPS["Web"]), ("VPN", APPS["VPN"])]
            for app_name, app_info in fraud_apps:
                for _ in range(random.randint(5, 10)):
                    ts = day_start + timedelta(hours=random.randint(8, 20), minutes=random.randint(0, 59))
                    ipdr_records.append({
                        "id": str(uuid.uuid4()), "timestamp": ts, "type": "IPDR", "subject": kingpin,
                        "counterpart": "10.0.0.1", "duration": random.randint(60, 1800),
                        "protocol": app_info["protocol"], "source_port": random.randint(40000, 60000),
                        "destination_port": app_info["ports"][0], "apn": app_info["apn"],
                        "imsi": imsis[kingpin], "imei": imeis[kingpin], "msisdn": kingpin, "technology": "LTE",
                        "bytes_uploaded": random.randint(5000, 100000), "bytes_downloaded": random.randint(10000, 500000),
                        "tower_id": "TWR_DEL_03", "cell_id": 5003, "lac": 101,
                        "lat": 28.6110, "lng": 77.2000, "rat": "LTE"
                    })

    else:
        # Default / Ad-hoc: Standard random movements and chats
        subA = "+919000000001"
        subB = "+919000000002"
        subjects = [subA, subB]
        
        for day in range(3):
            day_start = start_time + timedelta(days=day)
            ts = day_start + timedelta(hours=14, minutes=30)
            
            cdr_records.append({
                "id": str(uuid.uuid4()), "timestamp": ts, "type": "CDR", "subject": subA, "counterpart": subB,
                "duration": 180, "call_type": "Voice", "direction": "MO", "tower_id": "TWR_DEL_01",
                "cell_id": 5001, "lac": 101, "imsi": "40445000000101", "imei": "86000000000101", "msisdn": subA,
                "technology": "LTE", "lat": 28.6139, "lng": 77.2090
            })

    return {
        "cdr": cdr_records,
        "ipdr": ipdr_records,
        "towers": TOWERS
    }
