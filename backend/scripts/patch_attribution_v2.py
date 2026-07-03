"""One-off migration: attribution_data.json v2 — ASN enrichment, historical ownership,
contested-range fixes, and behavioral fingerprint profiles.

Run once (idempotent):  .venv/Scripts/python.exe -m scripts.patch_attribution_v2
Then regenerate the frontend copy:  .venv/Scripts/python.exe scripts/gen_attribution_js.py

What it does:
1. Fixes contested /8 claims that longest-prefix matching couldn't resolve (same prefix
   length, two owners — first-listed silently won):
     52.0.0.0/8  was claimed by BOTH Amazon and Microsoft -> split into the documented
                 halves (52.0/10 + 52.64/12 + 52.84/15 + 52.192/11 AWS; 52.96/12 O365 +
                 52.112/14 Teams + 52.224/11 Azure).
     35.0.0.0/8  was claimed by BOTH Google and Amazon -> split (35.184/13 + 35.192/11 +
                 35.224/12 + 35.240/13 GCP; 35.72/13 + 35.80/12 + 35.160/11 AWS).
     13.0.0.0/8  was claimed whole by Amazon (wrong — 13.64/11 + 13.104/14 are Azure, and
                 the /8 is legacy Xerox space) -> narrowed to documented AWS blocks.
2. Adds 3.0.0.0/8 to Amazon (missing entirely) — the canonical historical-transfer example.
3. Adds `country` and `type` to every range-bearing provider (type: Content Provider /
   CDN / Hosting / Cloud / ISP / Residential).
4. Adds `range_history`: famous legacy /8 ownership transfers, so a record timestamped
   BEFORE the transfer resolves to the owner AT THAT TIME (a 2016 CDR hitting 3.x.x.x was
   talking to General Electric infrastructure, not AWS). Dates are the publicly known
   transfer years, precise to ~the quarter — good enough for multi-year-old records, and
   each entry carries a note so reports can flag the approximation.
5. Adds `fingerprints`: behavioral app profiles (protocol + duration + volume + up/down
   ratio + ports + provider) consumed by both engines' fingerprint layer.
"""
from __future__ import annotations

import json
import os

PATH = os.path.join(os.path.dirname(__file__), "..", "app", "data", "attribution_data.json")

AWS_52 = ["52.0.0.0/10", "52.64.0.0/12", "52.84.0.0/15", "52.192.0.0/11"]
MS_52 = ["52.96.0.0/12", "52.112.0.0/14", "52.224.0.0/11"]
GOOG_35 = ["35.184.0.0/13", "35.192.0.0/11", "35.224.0.0/12", "35.240.0.0/13"]
AWS_35 = ["35.72.0.0/13", "35.80.0.0/12", "35.160.0.0/11"]
AWS_13 = ["13.32.0.0/15", "13.52.0.0/13", "13.224.0.0/14"]

COUNTRY_TYPE = {
    "Meta": ("US", "Content Provider"), "Google": ("US", "Content Provider"),
    "Microsoft": ("US", "Content Provider"), "Amazon": ("US", "Hosting / Cloud"),
    "Cloudflare": ("US", "CDN"), "Akamai": ("US", "CDN"), "Fastly": ("US", "CDN"),
    "DigitalOcean": ("US", "Hosting / Cloud"), "Telegram": ("AE", "Content Provider"),
    "Apple": ("US", "Content Provider"), "Reliance Jio": ("IN", "ISP / Residential"),
    "Bharti Airtel": ("IN", "ISP / Residential"), "Vodafone Idea": ("IN", "ISP / Residential"),
    "BSNL": ("IN", "ISP / Residential"), "Yandex": ("RU", "Content Provider"),
    "Alibaba Cloud": ("CN", "Hosting / Cloud"), "Hetzner": ("DE", "Hosting / Cloud"),
    "Vultr": ("US", "Hosting / Cloud"),
}

# Publicly documented legacy /8 transfers. `to` = approximate transfer completion; a record
# timestamped before `to` resolves to this historical owner instead of today's.
RANGE_HISTORY = [
    {"cidr": "3.0.0.0/8", "provider": "General Electric", "to": "2018-07-01",
     "type": "Enterprise (legacy)", "country": "US",
     "note": "GE sold 3.0.0.0/8 to Amazon/AWS in 2018 (date approximate)"},
    {"cidr": "13.0.0.0/8", "provider": "Xerox", "to": "2017-01-01",
     "type": "Enterprise (legacy)", "country": "US",
     "note": "Xerox legacy /8; blocks sold to AWS and Microsoft around 2016-2018 (date approximate)"},
    {"cidr": "20.0.0.0/8", "provider": "CSC (Computer Sciences Corp)", "to": "2017-06-01",
     "type": "Enterprise (legacy)", "country": "US",
     "note": "CSC/DXC legacy /8; large blocks acquired by Microsoft ~2017 (date approximate)"},
    {"cidr": "40.0.0.0/8", "provider": "Eli Lilly and Company", "to": "2011-01-01",
     "type": "Enterprise (legacy)", "country": "US",
     "note": "Eli Lilly legacy /8; large blocks acquired by Microsoft ~2011 (date approximate)"},
]

# Behavioral app fingerprints: every bound is optional; the scorer only counts features
# both the profile and the record actually have. ratio = bytes_up / bytes_down.
FINGERPRINTS = [
    {"name": "whatsapp_voice_call", "app": "WhatsApp Voice Call", "family": "WhatsApp",
     "subtype": "Voice call (behavioral)", "category": "service", "proto": "UDP",
     "dur": [30, 7200], "bytes": [50_000, 20_000_000], "ratio": [0.3, 3.0],
     "ports": [3478, 3479, 3480, 443], "providers": ["Meta"]},
    {"name": "whatsapp_video_call", "app": "WhatsApp Video Call", "family": "WhatsApp",
     "subtype": "Video call (behavioral)", "category": "service", "proto": "UDP",
     "dur": [60, 7200], "bytes": [20_000_000, 2_000_000_000], "ratio": [0.3, 3.0],
     "ports": [3478, 3479, 3480, 443], "providers": ["Meta"]},
    {"name": "whatsapp_messaging", "app": "WhatsApp Messaging", "family": "WhatsApp",
     "subtype": "Messaging (behavioral)", "category": "service", "proto": "TCP",
     "dur": [0, 60], "bytes": [0, 100_000], "ports": [5222, 5223, 443], "providers": ["Meta"]},
    {"name": "video_conference", "app": "Video Conference", "family": "Video Conf / Streaming",
     "subtype": "Conference call (behavioral)", "category": "service", "proto": "UDP",
     "dur": [120, 14400], "bytes": [500_000, 5_000_000_000], "ratio": [0.2, 5.0],
     "ports": [3478, 3479, 3480, 3481, 8801, 8810, 19302, 19303, 19304, 19305],
     "providers": ["Microsoft", "Google", "Zoom"]},
    {"name": "video_streaming", "app": "Video Streaming", "family": "Streaming",
     "subtype": "Content stream (behavioral)", "category": "service", "proto": "TCP",
     "dur": [120, 28800], "bytes": [5_000_000, 50_000_000_000], "ratio": [0, 0.2],
     "providers": ["Google", "Netflix", "Amazon", "Akamai", "Fastly", "Cloudflare"]},
    {"name": "voip_generic", "app": "VoIP Call", "family": "VoIP / SIP",
     "subtype": "Voice session (behavioral)", "category": "service", "proto": "UDP",
     "dur": [30, 7200], "bytes": [50_000, 20_000_000], "ratio": [0.3, 3.0]},
    {"name": "vpn_tunnel", "app": "VPN Tunnel", "family": "VPN / Tunnel",
     "subtype": "Encrypted tunnel (behavioral)", "category": "vpn",
     "dur": [300, 86400], "bytes": [100_000, 100_000_000_000],
     "ports": [500, 1194, 1701, 4500, 51820]},
    {"name": "file_download", "app": "Large Download", "family": "File Transfer",
     "subtype": "Bulk download (behavioral)", "category": "service", "proto": "TCP",
     "dur": [10, 28800], "bytes": [10_000_000, 1_000_000_000_000], "ratio": [0, 0.1]},
    {"name": "media_upload", "app": "Media Upload", "family": "File Transfer",
     "subtype": "Bulk upload (behavioral)", "category": "service", "proto": "TCP",
     "dur": [5, 28800], "bytes": [500_000, 1_000_000_000_000], "ratio": [5.0, 10000]},
    {"name": "cloud_sync", "app": "Cloud Sync / Backup", "family": "File Transfer",
     "subtype": "Sync session (behavioral)", "category": "service", "proto": "TCP",
     "dur": [60, 86400], "bytes": [100_000, 100_000_000_000], "ratio": [0.3, 3.0],
     "providers": ["Google", "Microsoft", "Apple", "Dropbox", "Amazon"]},
    {"name": "gaming_session", "app": "Online Gaming", "family": "Gaming",
     "subtype": "Multiplayer session (behavioral)", "category": "service", "proto": "UDP",
     "dur": [300, 28800], "bytes": [1_000_000, 500_000_000], "ratio": [0.3, 3.0],
     "ports": [27015, 27031, 3074, 3478, 30000]},
    {"name": "keepalive_probe", "app": "Keepalive / Probe", "family": "Infrastructure",
     "subtype": "Keepalive (behavioral)", "category": "unknown",
     "dur": [0, 5], "bytes": [0, 5_000]},
]


def main():
    with open(PATH, encoding="utf-8") as handle:
        data = json.load(handle)

    for p in data["providers"]:
        if not p.get("ranges"):
            continue
        name = p["pr"]
        if name == "Amazon":
            p["ranges"] = [r for r in p["ranges"] if r not in ("52.0.0.0/8", "35.0.0.0/8", "13.0.0.0/8", "54.0.0.0/8")]
            for add in ["3.0.0.0/8", *AWS_52, *AWS_35, *AWS_13,
                        "54.64.0.0/10", "54.144.0.0/12", "54.160.0.0/11", "54.192.0.0/10"]:
                if add not in p["ranges"]:
                    p["ranges"].append(add)
        elif name == "Microsoft":
            p["ranges"] = [r for r in p["ranges"] if r != "52.0.0.0/8"]
            for add in MS_52:
                if add not in p["ranges"]:
                    p["ranges"].append(add)
        elif name == "Google":
            p["ranges"] = [r for r in p["ranges"] if r != "35.0.0.0/8"]
            for add in GOOG_35:
                if add not in p["ranges"]:
                    p["ranges"].append(add)
        if name in COUNTRY_TYPE:
            country, ptype = COUNTRY_TYPE[name]
            p.setdefault("country", country)
            p.setdefault("type", ptype)

    data["range_history"] = RANGE_HISTORY
    data["fingerprints"] = FINGERPRINTS

    with open(PATH, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=1, ensure_ascii=False)
    print("patched", PATH)


if __name__ == "__main__":
    main()
