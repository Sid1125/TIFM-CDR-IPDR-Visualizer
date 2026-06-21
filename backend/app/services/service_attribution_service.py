from __future__ import annotations

import csv
import ipaddress
import json
import os
from collections import Counter

from app.models.ipdr import IPDRRecord

# --- Shared attribution knowledge base (single source of truth) ---
# backend/app/data/attribution_data.json is the canonical provider/port/constant data,
# consumed here and (via scripts/gen_attribution_js.py) by the frontend engine. Edit the
# JSON, not these structures, and regenerate the frontend copy.
_DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "attribution_data.json")


def _load_attribution_data():
    try:
        with open(_DATA_PATH, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {"providers": [], "port_svc": {}, "port_families": {}, "family_gaps": {}, "constants": {}}


_ATTR = _load_attribution_data()
_CONST = _ATTR.get("constants", {})

EPHEMERAL_MIN = _CONST.get("ephemeral_min", 49152)
_CGNAT_NET = ipaddress.ip_network(_CONST.get("cgnat", "100.64.0.0/10"))
_HOSTING_PROVIDERS = set(_CONST.get("hosting_providers", []))
# Generic web families carry no real service detail, so they don't outrank a carrier match.
_GENERIC_PORT_FAMILIES = set(_CONST.get("generic_families", ["Web", "Encrypted Web/App"]))
# Port -> coarse activity family, and family -> session idle gap (seconds), shared with the
# timeline reconstruction in investigation_service.py.
PORT_FAMILY_MAP = {int(k): v for k, v in _ATTR.get("port_families", {}).items()}
FAMILY_GAP_MAP = dict(_ATTR.get("family_gaps", {}))

# (label, confidence, reason, service_family, default_subtype)
PORT_MAP = {
    # --- Web ---
    80: ("Likely Web", 72, "HTTP port", "Web", "Page fetch / browsing"),
    443: ("Likely Encrypted Web/App", 76, "HTTPS or encrypted application traffic", "Encrypted Web/App", "Encrypted session"),
    8080: ("Likely Web", 64, "HTTP-alt web traffic", "Web", "Page fetch / browsing"),
    8443: ("Likely Encrypted Web/App", 74, "Encrypted alternate web traffic", "Encrypted Web/App", "Encrypted session"),
    8000: ("Likely Web", 58, "Web alternative port", "Web", "Page fetch / browsing"),
    8888: ("Likely Web", 56, "Web/Dev alternative port", "Web", "Page fetch / browsing"),
    3000: ("Likely Web", 48, "Dev framework web port", "Web", "Page fetch / browsing"),
    5000: ("Likely Web", 48, "Flask dev / UPnP port", "Web", "Page fetch / browsing"),
    9000: ("Likely Web", 50, "Web application port", "Web", "Page fetch / browsing"),
    9090: ("Likely Web", 50, "Web admin console port", "Web", "Page fetch / browsing"),
    2082: ("Likely Hosting / Web", 58, "cPanel web traffic", "Web", "Hosting control traffic"),
    2083: ("Likely Hosting / Web", 58, "cPanel secure web traffic", "Web", "Secure hosting control traffic"),
    2096: ("Likely Hosting / Web", 56, "cPanel secure web traffic alt", "Web", "Hosting control traffic"),
    8090: ("Likely Web", 50, "Web alternative port", "Web", "Page fetch / browsing"),
    9999: ("Likely Web", 44, "Web alternative port", "Web", "Page fetch / browsing"),

    # --- Mail ---
    25: ("Likely Mail", 84, "SMTP mail transport", "Mail", "Submission"),
    465: ("Likely Mail", 76, "SMTPS mail transport", "Mail", "Submission"),
    587: ("Likely Mail", 78, "SMTP submission", "Mail", "Submission"),
    110: ("Likely Mail", 82, "POP3 mail retrieval", "Mail", "Retrieval"),
    143: ("Likely Mail", 82, "IMAP mail retrieval", "Mail", "Retrieval"),
    993: ("Likely Mail", 78, "IMAPS mail retrieval", "Mail", "Retrieval"),
    995: ("Likely Mail", 78, "POP3S mail retrieval", "Mail", "Retrieval"),
    2525: ("Likely Mail", 56, "SMTP alternate port", "Mail", "Submission"),
    135: ("Likely Mail / RPC", 42, "MS RPC / Exchange mailbox", "Mail", "Retrieval"),

    # --- DNS ---
    53: ("Likely DNS", 90, "DNS resolution port", "DNS", "Lookup / resolution"),
    853: ("Likely DNS", 80, "DNS-over-TLS", "DNS", "Encrypted resolution"),
    5353: ("Likely mDNS", 72, "mDNS / Bonjour discovery", "Device Discovery", "Local discovery"),

    # --- Social Media / Messaging ---
    3478: ("Likely WhatsApp/Meta", 92, "STUN / NAT traversal session", "WhatsApp", "Call initialization"),
    5222: ("Likely WhatsApp/Meta", 88, "XMPP-style messaging", "WhatsApp", "Session setup / keepalive"),
    5223: ("Likely WhatsApp/Meta", 88, "Push messaging", "WhatsApp", "Session setup / keepalive"),
    5228: ("Likely WhatsApp/Meta", 90, "Push messaging range", "WhatsApp", "Session setup / keepalive"),
    3479: ("Likely WhatsApp/Meta", 88, "STUN media port", "WhatsApp", "Call initialization"),
    3480: ("Likely WhatsApp/Meta", 86, "STUN media port", "WhatsApp", "Call initialization"),
    4433: ("Likely Signal", 78, "Signal websocket port", "Messaging / Social", "Secure messaging"),
    5190: ("Likely AIM / ICQ", 60, "AOL messaging protocol", "Messaging / Social", "Instant messaging"),
    6660: ("Likely IRC", 62, "IRC chat", "Messaging / Social", "Chat session"),
    6661: ("Likely IRC", 62, "IRC chat", "Messaging / Social", "Chat session"),
    6662: ("Likely IRC", 62, "IRC chat", "Messaging / Social", "Chat session"),
    6663: ("Likely IRC", 62, "IRC chat", "Messaging / Social", "Chat session"),
    6664: ("Likely IRC", 62, "IRC chat", "Messaging / Social", "Chat session"),
    6665: ("Likely IRC", 62, "IRC chat", "Messaging / Social", "Chat session"),
    6666: ("Likely IRC", 62, "IRC chat", "Messaging / Social", "Chat session"),
    6667: ("Likely IRC", 72, "IRC chat default port", "Messaging / Social", "Chat session"),
    6668: ("Likely IRC", 62, "IRC chat", "Messaging / Social", "Chat session"),
    6669: ("Likely IRC", 62, "IRC chat", "Messaging / Social", "Chat session"),
    6697: ("Likely IRC", 66, "IRC over TLS", "Messaging / Social", "Secure chat session"),
    6679: ("Likely IRC", 64, "IRC over TLS alt", "Messaging / Social", "Secure chat session"),

    # --- VoIP / SIP ---
    5060: ("Likely VoIP / SIP", 88, "SIP signaling", "VoIP / SIP", "Call signaling"),
    5061: ("Likely VoIP / SIP", 90, "SIP over TLS", "VoIP / SIP", "Secure call signaling"),
    4569: ("Likely IAX2", 74, "Asterisk IAX2 protocol", "VoIP / SIP", "Call session"),
    5036: ("Likely IAX", 68, "Asterisk IAX", "VoIP / SIP", "Call session"),
    64738: ("Likely Mumble", 70, "Mumble VoIP", "VoIP / SIP", "Voice session"),

    # --- VPN / Tunnel / Proxy ---
    500: ("Likely VPN / Tunnel", 78, "IKE negotiation", "VPN / Tunnel", "Tunnel setup"),
    1194: ("Likely VPN / Tunnel", 84, "OpenVPN port", "VPN / Tunnel", "Tunnel setup"),
    1701: ("Likely VPN / Tunnel", 81, "L2TP tunnel", "VPN / Tunnel", "Tunnel setup"),
    1723: ("Likely VPN / Tunnel", 82, "PPTP tunnel", "VPN / Tunnel", "Tunnel setup"),
    4500: ("Likely VPN / Tunnel", 84, "IPsec NAT-T", "VPN / Tunnel", "Tunnel setup"),
    51820: ("Likely VPN / Tunnel", 88, "WireGuard port", "VPN / Tunnel", "Tunnel setup"),
    51821: ("Likely VPN / Tunnel", 82, "WireGuard alt port", "VPN / Tunnel", "Tunnel setup"),
    1080: ("Likely Proxy / SOCKS", 74, "SOCKS proxy port", "Proxy / Tor", "Proxy session"),
    3128: ("Likely Web Proxy", 64, "Squid proxy port", "Proxy / Tor", "HTTP proxy"),
    8118: ("Likely Proxy", 60, "Privoxy proxy port", "Proxy / Tor", "HTTP proxy"),
    3544: ("Likely Teredo Tunnel", 68, "Teredo IPv6 tunneling", "VPN / Tunnel", "Tunnel setup"),
    2408: ("Likely Cloudflare WARP", 60, "Cloudflare WARP tunnel", "VPN / Tunnel", "Tunnel setup"),

    # --- Google Meet / Conferencing ---
    19302: ("Likely Google Meet", 88, "Google STUN port", "Video Conf / Streaming", "STUN negotiation"),
    19303: ("Likely Google Meet", 86, "Google STUN port", "Video Conf / Streaming", "STUN negotiation"),
    19304: ("Likely Google Meet", 86, "Google STUN port", "Video Conf / Streaming", "STUN negotiation"),
    19305: ("Likely Google Meet", 86, "Google STUN port", "Video Conf / Streaming", "STUN negotiation"),
    19306: ("Likely Google Meet", 86, "Google STUN port", "Video Conf / Streaming", "STUN negotiation"),
    19307: ("Likely Google Meet", 84, "Google STUN port", "Video Conf / Streaming", "STUN negotiation"),
    19308: ("Likely Google Meet", 84, "Google STUN port", "Video Conf / Streaming", "STUN negotiation"),
    19309: ("Likely Google Meet", 84, "Google STUN port", "Video Conf / Streaming", "STUN negotiation"),

    # --- Zoom ---
    8801: ("Likely Zoom", 84, "Zoom media port", "Video Conf / Streaming", "Media session"),
    8802: ("Likely Zoom", 82, "Zoom media port", "Video Conf / Streaming", "Media session"),

    # --- Microsoft Teams (media ports 50000-50059) ---
    50000: ("Likely MS Teams", 84, "Teams media port range", "Video Conf / Streaming", "Media session"),
    50001: ("Likely MS Teams", 84, "Teams media port range", "Video Conf / Streaming", "Media session"),
    50002: ("Likely MS Teams", 84, "Teams media port range", "Video Conf / Streaming", "Media session"),
    50003: ("Likely MS Teams", 84, "Teams media port range", "Video Conf / Streaming", "Media session"),
    50004: ("Likely MS Teams", 84, "Teams media port range", "Video Conf / Streaming", "Media session"),
    50005: ("Likely MS Teams", 84, "Teams media port range", "Video Conf / Streaming", "Media session"),
    50006: ("Likely MS Teams", 84, "Teams media port range", "Video Conf / Streaming", "Media session"),
    50007: ("Likely MS Teams", 84, "Teams media port range", "Video Conf / Streaming", "Media session"),
    50008: ("Likely MS Teams", 84, "Teams media port range", "Video Conf / Streaming", "Media session"),
    50009: ("Likely MS Teams", 84, "Teams media port range", "Video Conf / Streaming", "Media session"),
    50010: ("Likely MS Teams", 84, "Teams media port range", "Video Conf / Streaming", "Media session"),
    50011: ("Likely MS Teams", 84, "Teams media port range", "Video Conf / Streaming", "Media session"),
    50012: ("Likely MS Teams", 84, "Teams media port range", "Video Conf / Streaming", "Media session"),
    50013: ("Likely MS Teams", 84, "Teams media port range", "Video Conf / Streaming", "Media session"),
    50014: ("Likely MS Teams", 84, "Teams media port range", "Video Conf / Streaming", "Media session"),
    50015: ("Likely MS Teams", 84, "Teams media port range", "Video Conf / Streaming", "Media session"),

    # --- File Transfer ---
    20: ("Likely File Transfer", 78, "FTP data port", "File Transfer", "Data transfer"),
    21: ("Likely File Transfer", 82, "FTP control port", "File Transfer", "Control session"),
    69: ("Likely File Transfer", 72, "TFTP port", "File Transfer", "Data transfer"),
    989: ("Likely File Transfer", 72, "FTPS data port", "File Transfer", "Secure data transfer"),
    990: ("Likely File Transfer", 74, "FTPS control port", "File Transfer", "Secure control session"),
    2049: ("Likely File Transfer", 60, "NFS file sharing", "File Transfer", "File transfer session"),
    # NOTE: 9418 (Git protocol) is mapped under Development / Version Control below.
    548: ("Likely File Transfer", 56, "AFP file sharing", "File Transfer", "File sharing"),

    # --- Remote Desktop / Access ---
    3389: ("Likely Remote Desktop", 85, "RDP session", "Remote Desktop", "Session setup / interaction"),
    5900: ("Likely Remote Desktop", 82, "VNC session", "Remote Desktop", "Session setup / interaction"),
    5901: ("Likely Remote Desktop", 78, "VNC display 1", "Remote Desktop", "Session setup / interaction"),
    5902: ("Likely Remote Desktop", 76, "VNC display 2", "Remote Desktop", "Session setup / interaction"),
    5903: ("Likely Remote Desktop", 74, "VNC display 3", "Remote Desktop", "Session setup / interaction"),
    5631: ("Likely Remote Desktop", 64, "Remote control traffic", "Remote Desktop", "Interactive session"),
    5632: ("Likely Remote Desktop", 62, "Remote control data", "Remote Desktop", "Interactive session"),
    4899: ("Likely Remote Desktop", 68, "Radmin remote control", "Remote Desktop", "Interactive session"),
    5800: ("Likely Remote Desktop", 66, "VNC HTTP display", "Remote Desktop", "HTTP tunnel session"),
    5801: ("Likely Remote Desktop", 64, "VNC HTTP display alt", "Remote Desktop", "HTTP tunnel session"),

    # --- Remote Access (Shell/Admin) ---
    22: ("Likely Remote Access", 86, "SSH port", "Remote Access", "Remote login"),
    23: ("Likely Remote Access", 68, "Telnet port", "Remote Access", "Remote login"),
    2222: ("Likely Remote Access", 64, "Alternate SSH or admin access", "Remote Access", "Remote login"),
    22222: ("Likely Remote Access", 62, "Alternate shell access", "Remote Access", "Remote login"),
    6000: ("Likely Remote Access", 60, "X11-style remote display", "Remote Access", "Remote display session"),
    6001: ("Likely Remote Access", 58, "X11 display 1", "Remote Access", "Remote display session"),
    6002: ("Likely Remote Access", 56, "X11 display 2", "Remote Access", "Remote display session"),
    6003: ("Likely Remote Access", 54, "X11 display 3", "Remote Access", "Remote display session"),
    6004: ("Likely Remote Access", 52, "X11 display 4", "Remote Access", "Remote display session"),
    6005: ("Likely Remote Access", 50, "X11 display 5", "Remote Access", "Remote display session"),
    6006: ("Likely Remote Access", 48, "X11 display 6", "Remote Access", "Remote display session"),
    6007: ("Likely Remote Access", 46, "X11 display 7", "Remote Access", "Remote display session"),

    # --- Database ---
    3306: ("Likely Database", 68, "MySQL traffic", "Database", "Query / transaction"),
    5432: ("Likely Database", 69, "PostgreSQL traffic", "Database", "Query / transaction"),
    1433: ("Likely Database", 62, "Microsoft SQL Server", "Database", "Query / transaction"),
    1434: ("Likely Database", 58, "MS SQL Browser", "Database", "Discovery"),
    1521: ("Likely Database", 66, "Oracle DB listener", "Database", "Query / transaction"),
    2483: ("Likely Database", 58, "Oracle DB alt port", "Database", "Query / transaction"),
    2484: ("Likely Database", 58, "Oracle DB SSL", "Database", "Query / transaction"),
    27017: ("Likely Database", 68, "MongoDB port", "Database", "Query / transaction"),
    27018: ("Likely Database", 64, "MongoDB shard", "Database", "Query / transaction"),
    27019: ("Likely Database", 62, "MongoDB config", "Database", "Query / transaction"),
    28017: ("Likely Database", 60, "MongoDB HTTP status", "Database", "Status / admin"),
    6379: ("Likely Cache / Backend", 58, "Redis traffic", "Cache / Backend", "Backend session"),
    6380: ("Likely Cache / Backend", 56, "Redis SSL traffic", "Cache / Backend", "Backend session"),
    11211: ("Likely Cache / Backend", 60, "Memcached port", "Cache / Backend", "Backend session"),
    9200: ("Likely Database", 58, "Elasticsearch HTTP", "Database", "Query / transaction"),
    9300: ("Likely Database", 60, "Elasticsearch transport", "Database", "Cluster communication"),
    8086: ("Likely Database", 54, "InfluxDB HTTP", "Database", "Time-series query"),
    8087: ("Likely Database", 50, "InfluxDB RPC", "Database", "Time-series query"),
    5672: ("Likely Messaging Queue", 66, "AMQP protocol", "Queue / Backend", "Message broker session"),

    # --- Streaming ---
    554: ("Likely Streaming", 68, "RTSP media session", "Streaming", "Media session"),
    1755: ("Likely Streaming", 56, "MMS streaming", "Streaming", "Media session"),
    7070: ("Likely Streaming", 58, "RTSP alt streaming", "Streaming", "Media session"),
    32400: ("Likely Streaming", 62, "Plex media server", "Streaming", "Media session"),
    8008: ("Likely Casting / Streaming", 59, "Device casting traffic", "Casting / Streaming", "Casting session"),
    8009: ("Likely Casting / Streaming", 59, "Device casting traffic", "Casting / Streaming", "Casting session"),
    37777: ("Likely IPTV", 58, "IPTV streaming port", "Streaming", "TV stream"),

    # --- Gaming ---
    3074: ("Likely Gaming", 72, "Xbox Live / PS Network", "Gaming", "Multiplayer session"),
    3075: ("Likely Gaming", 66, "Xbox Live alt", "Gaming", "Multiplayer session"),
    3076: ("Likely Gaming", 64, "Xbox Live alt", "Gaming", "Multiplayer session"),
    2302: ("Likely Gaming", 66, "Halo / FPS game port", "Gaming", "Multiplayer session"),
    28960: ("Likely Gaming", 66, "CoD multiplayer", "Gaming", "Multiplayer session"),
    28961: ("Likely Gaming", 64, "CoD multiplayer alt", "Gaming", "Multiplayer session"),
    27015: ("Likely Gaming", 72, "Steam / Source engine", "Gaming", "Multiplayer session"),
    27016: ("Likely Gaming", 70, "Steam / Source engine", "Gaming", "Multiplayer session"),
    # NOTE: 27017 intentionally omitted here — it is MongoDB's default port (mapped
    # under Database above). The Steam 27015-27030 PORT_RANGES band still covers it.
    27018: ("Likely Gaming", 66, "Steam / Source engine", "Gaming", "Multiplayer session"),
    27019: ("Likely Gaming", 66, "Steam / Source engine", "Gaming", "Multiplayer session"),
    27020: ("Likely Gaming", 66, "Steam / Source engine", "Gaming", "Multiplayer session"),
    27031: ("Likely Gaming", 60, "Steam in-home streaming", "Gaming", "Streaming session"),
    27036: ("Likely Gaming", 60, "Steam download", "Gaming", "Content download"),
    4380: ("Likely Gaming", 62, "Steam P2P UDP", "Gaming", "P2P session"),
    25565: ("Likely Gaming", 74, "Minecraft server", "Gaming", "Multiplayer session"),
    25575: ("Likely Gaming", 60, "Minecraft RCON", "Gaming", "Admin session"),
    26000: ("Likely Gaming", 58, "Quake / Half-Life", "Gaming", "Multiplayer session"),
    27901: ("Likely Gaming", 58, "Quake Live", "Gaming", "Multiplayer session"),
    27910: ("Likely Gaming", 56, "Quake Live alt", "Gaming", "Multiplayer session"),
    28000: ("Likely Gaming", 56, "Xbox 360 traffic", "Gaming", "Multiplayer session"),
    29900: ("Likely Gaming", 56, "Nintendo DS", "Gaming", "Multiplayer session"),
    29901: ("Likely Gaming", 54, "Nintendo DS alt", "Gaming", "Multiplayer session"),
    29920: ("Likely Gaming", 54, "Nintendo Wii", "Gaming", "Multiplayer session"),

    # --- Steam ports (overlapping) ---
    27014: ("Likely Steam", 70, "Steam client", "Gaming", "Client session"),
    # 27015-27020 already in Gaming above

    # --- File Sharing / P2P ---
    6881: ("Likely BitTorrent", 76, "BitTorrent default start", "P2P / File Sharing", "Peer session"),
    6882: ("Likely BitTorrent", 74, "BitTorrent port", "P2P / File Sharing", "Peer session"),
    6883: ("Likely BitTorrent", 74, "BitTorrent port", "P2P / File Sharing", "Peer session"),
    6884: ("Likely BitTorrent", 74, "BitTorrent port", "P2P / File Sharing", "Peer session"),
    6885: ("Likely BitTorrent", 74, "BitTorrent port", "P2P / File Sharing", "Peer session"),
    6886: ("Likely BitTorrent", 74, "BitTorrent port", "P2P / File Sharing", "Peer session"),
    6887: ("Likely BitTorrent", 74, "BitTorrent port", "P2P / File Sharing", "Peer session"),
    6888: ("Likely BitTorrent", 74, "BitTorrent port", "P2P / File Sharing", "Peer session"),
    6889: ("Likely BitTorrent", 74, "BitTorrent port", "P2P / File Sharing", "Peer session"),
    6969: ("Likely BitTorrent", 74, "BitTorrent tracker", "P2P / File Sharing", "Tracker session"),
    4662: ("Likely eDonkey", 66, "eDonkey / eMule port", "P2P / File Sharing", "P2P session"),
    4672: ("Likely eDonkey", 64, "eDonkey UDP", "P2P / File Sharing", "P2P session"),
    6346: ("Likely Gnutella", 60, "Gnutella peer", "P2P / File Sharing", "P2P session"),
    6347: ("Likely Gnutella", 58, "Gnutella UDP", "P2P / File Sharing", "P2P session"),

    # --- IoT / MQTT ---
    1883: ("Likely IoT / MQTT", 62, "MQTT broker", "IoT / MQTT", "Broker session"),
    8883: ("Likely IoT / MQTT", 68, "MQTTS broker", "IoT / MQTT", "Secure broker session"),
    5683: ("Likely IoT / CoAP", 58, "CoAP protocol", "IoT / MQTT", "Device telemetry"),

    # --- Device Discovery ---
    1900: ("Likely Device Discovery", 56, "SSDP/UPnP discovery", "Device Discovery", "Discovery"),

    # --- Directory / LDAP ---
    389: ("Likely Directory / LDAP", 60, "LDAP directory traffic", "Directory / LDAP", "Directory lookup"),
    636: ("Likely Directory / LDAP", 64, "LDAPS secure directory traffic", "Directory / LDAP", "Secure directory lookup"),
    3268: ("Likely Directory / LDAP", 56, "LDAP GC port", "Directory / LDAP", "Global catalog lookup"),
    3269: ("Likely Directory / LDAP", 58, "LDAP GC SSL port", "Directory / LDAP", "Secure global catalog"),

    # --- Authentication ---
    88: ("Likely Authentication", 62, "Kerberos port", "Authentication", "Authentication session"),
    464: ("Likely Authentication", 56, "Kerberos change password", "Authentication", "Password change"),
    1812: ("Likely Authentication", 64, "RADIUS authentication", "Authentication", "AAA session"),
    1813: ("Likely Authentication", 60, "RADIUS accounting", "Authentication", "AAA accounting"),
    1645: ("Likely Authentication", 58, "RADIUS legacy auth", "Authentication", "AAA session"),
    1646: ("Likely Authentication", 54, "RADIUS legacy accounting", "Authentication", "AAA accounting"),

    # --- Infrastructure / Network Services ---
    67: ("Likely DHCP", 72, "DHCP server port", "Infrastructure", "Address assignment"),
    68: ("Likely DHCP", 72, "DHCP client port", "Infrastructure", "Address assignment"),
    123: ("Likely NTP", 72, "Network time protocol", "Infrastructure", "Time sync"),
    161: ("Likely SNMP", 68, "SNMP monitoring", "Infrastructure", "Polling / monitoring"),
    162: ("Likely SNMP Trap", 60, "SNMP trap port", "Infrastructure", "Alert / trap"),
    514: ("Likely Syslog", 64, "Syslog port", "Infrastructure", "Log transmission"),
    179: ("Likely BGP", 70, "BGP routing protocol", "Infrastructure", "Routing session"),
    546: ("Likely DHCPv6", 64, "DHCPv6 client", "Infrastructure", "IPv6 address assignment"),
    547: ("Likely DHCPv6", 64, "DHCPv6 server", "Infrastructure", "IPv6 address assignment"),
    37: ("Likely Time", 44, "Time protocol", "Infrastructure", "Time sync"),

    # --- Remote Management ---
    2375: ("Likely Remote Management", 64, "Docker API", "Remote Management", "Admin session"),
    2376: ("Likely Remote Management", 66, "Docker TLS API", "Remote Management", "Secure admin session"),
    10000: ("Likely Remote Management", 54, "Webmin / NDMP", "Remote Management", "Admin session"),
    20000: ("Likely Remote Management", 50, "Usermin port", "Remote Management", "Admin session"),
    8200: ("Likely Remote Management", 50, "VMware management", "Remote Management", "Admin session"),
    8222: ("Likely Remote Management", 48, "VMware management alt", "Remote Management", "Admin session"),

    # --- File / Print Services (SMB/NetBIOS) ---
    137: ("Likely NetBIOS", 60, "NetBIOS name service", "File / Print", "Name resolution"),
    138: ("Likely NetBIOS", 58, "NetBIOS datagram", "File / Print", "Datagram service"),
    139: ("Likely NetBIOS", 62, "NetBIOS session", "File / Print", "File sharing session"),
    445: ("Likely SMB", 70, "SMB file sharing (Direct Host)", "File / Print", "File sharing session"),
    515: ("Likely Print", 56, "LPD print service", "File / Print", "Print job"),
    631: ("Likely Print", 58, "IPP printing", "File / Print", "Print job"),
    9100: ("Likely Print", 56, "PDL print stream", "File / Print", "Print job"),

    # --- Crypto / Blockchain ---
    8332: ("Likely Bitcoin", 64, "Bitcoin JSON-RPC", "Crypto / Blockchain", "RPC session"),
    8333: ("Likely Bitcoin", 74, "Bitcoin peer-to-peer", "Crypto / Blockchain", "Blockchain sync"),
    8444: ("Likely Chia / Crypto", 56, "Chia blockchain", "Crypto / Blockchain", "Blockchain sync"),

    # --- Tor / Anonymity ---
    9001: ("Likely Tor", 70, "Tor OR port", "Proxy / Tor", "Tor relay"),
    9030: ("Likely Tor", 64, "Tor directory", "Proxy / Tor", "Directory communication"),
    9040: ("Likely Tor", 62, "Tor obfsproxy", "Proxy / Tor", "Bridged connection"),
    9050: ("Likely Tor", 66, "Tor SOCKS proxy", "Proxy / Tor", "Tor exit connection"),
    9150: ("Likely Tor", 64, "Tor Browser SOCKS", "Proxy / Tor", "Tor Browser connection"),

    # --- Multimedia / Home ---
    3689: ("Likely DAAP", 54, "DAAP music sharing", "Multimedia / Home", "Media sharing"),
    5355: ("Likely LLMNR", 44, "Link-Local Multicast Name Resolution", "Infrastructure", "Name resolution"),

    # --- Development / Version Control ---
    3690: ("Likely Version Control", 56, "SVN port", "Development", "Version control sync"),
    9418: ("Likely Version Control", 59, "Git protocol", "Development", "Git transfer session"),
    7990: ("Likely Development", 48, "Bitbucket / Stash", "Development", "Web interface"),
    7991: ("Likely Development", 46, "Atlassian dev tools", "Development", "Web interface"),

    # --- FaceTime / Apple ---
    5349: ("Likely FaceTime / Apple", 74, "Apple TURN/STUN", "Video Conf / Streaming", "Call signaling"),
    16393: ("Likely FaceTime / Apple", 72, "Apple media range", "Video Conf / Streaming", "Media session"),
    16394: ("Likely FaceTime / Apple", 72, "Apple media range", "Video Conf / Streaming", "Media session"),
    16395: ("Likely FaceTime / Apple", 72, "Apple media range", "Video Conf / Streaming", "Media session"),
    16396: ("Likely FaceTime / Apple", 72, "Apple media range", "Video Conf / Streaming", "Media session"),
    16397: ("Likely FaceTime / Apple", 72, "Apple media range", "Video Conf / Streaming", "Media session"),
    16398: ("Likely FaceTime / Apple", 72, "Apple media range", "Video Conf / Streaming", "Media session"),
    16399: ("Likely FaceTime / Apple", 72, "Apple media range", "Video Conf / Streaming", "Media session"),
    16400: ("Likely FaceTime / Apple", 72, "Apple media range", "Video Conf / Streaming", "Media session"),
    16401: ("Likely FaceTime / Apple", 72, "Apple media range", "Video Conf / Streaming", "Media session"),
    16402: ("Likely FaceTime / Apple", 72, "Apple media range", "Video Conf / Streaming", "Media session"),

    # --- Security / RATs ---
    12345: ("Likely RAT / Trojan", 52, "NetBus / common RAT port", "Security", "Remote access trojan"),
    27374: ("Likely RAT / Trojan", 50, "Sub7 / common RAT port", "Security", "Remote access trojan"),
    31337: ("Likely RAT / Trojan", 54, "Back Orifice / RAT port", "Security", "Remote access trojan"),

    # --- Monitoring / Agents ---
    5666: ("Likely Monitoring", 52, "Nagios NRPE", "Infrastructure", "Monitoring check"),
    5667: ("Likely Monitoring", 50, "Nagios NSCA", "Infrastructure", "Monitoring result"),

    # --- Legacy / Old Protocols ---
    7: ("Likely Echo", 30, "Echo protocol", "Infrastructure", "Diagnostic"),
    9: ("Likely Discard", 28, "Discard protocol", "Infrastructure", "Diagnostic"),
    13: ("Likely Daytime", 30, "Daytime protocol", "Infrastructure", "Diagnostic"),
    19: ("Likely Chargen", 28, "Character generator", "Infrastructure", "Diagnostic"),
}

SERVICE_FAMILIES = {
    "Web",
    "Encrypted Web/App",
    "Mail",
    "DNS",
    "WhatsApp",
    "Messaging / Social",
    "VoIP / SIP",
    "VPN / Tunnel",
    "Video Conf / Streaming",
    "File Transfer",
    "Remote Desktop",
    "Remote Access",
    "Database",
    "Streaming",
    "IoT / MQTT",
    "File / Print",
    "Device Discovery",
    "Directory / LDAP",
    "Authentication",
    "Infrastructure",
    "Remote Management",
    "Cache / Backend",
    "Queue / Backend",
    "Casting / Streaming",
    "Gaming",
    "P2P / File Sharing",
    "Proxy / Tor",
    "Multimedia / Home",
    "Development",
    "Crypto / Blockchain",
    "Security",
}

# Port ranges for apps not covered by exact PORT_MAP entries
# (start, end, label, confidence, reason, service_family, default_subtype)
PORT_RANGES = [
    (50000, 50059, "Likely MS Teams", 82, "Teams media port range (50000-50059)", "Video Conf / Streaming", "Media session"),
    (19302, 19309, "Likely Google Meet", 84, "Google STUN range (19302-19309)", "Video Conf / Streaming", "STUN negotiation"),
    (27015, 27030, "Likely Steam / Gaming", 72, "Steam Source engine range", "Gaming", "Multiplayer session"),
    (27031, 27036, "Likely Steam Streaming", 62, "Steam in-home streaming range", "Gaming", "Streaming session"),
    (16393, 16402, "Likely FaceTime / Apple", 70, "Apple FaceTime media range", "Video Conf / Streaming", "Media session"),
    (3478, 3481, "Likely Conferencing / STUN", 82, "STUN / ICE negotiation range", "Video Conf / Streaming", "STUN negotiation"),
    (6881, 6889, "Likely BitTorrent", 74, "BitTorrent default port range", "P2P / File Sharing", "Peer session"),
    (6000, 6007, "Likely Remote Access", 58, "X11 display range", "Remote Access", "Remote display session"),
    (6660, 6669, "Likely IRC", 62, "IRC chat range", "Messaging / Social", "Chat session"),
    (50001, 50030, "Likely Discord", 68, "Discord voice range (50001-50030)", "Messaging / Social", "Voice session"),
    (27901, 27910, "Likely Quake / Gaming", 58, "Quake engine multiplayer range", "Gaming", "Multiplayer session"),
    (33434, 33500, "Likely Traceroute", 60, "Traceroute UDP range", "Infrastructure", "Network diagnostic"),
]


def _check_port_ranges(port: int):
    for start, end, label, confidence, reason, service_family, default_subtype in PORT_RANGES:
        if start <= port <= end:
            return (label, confidence, reason, service_family, default_subtype)
    return None


def _classify_whatsapp(protocol: str, port: int, bytes_transferred: int | None):
    if port == 3478 and protocol == "UDP":
        return "Call initialization", 96, ["UDP STUN / NAT traversal"]
    if port in {5222, 5223}:
        return "Session setup / keepalive", 90, ["Messaging session port"]
    if port == 5228:
        return "Session keepalive", 91, ["Push / background messaging port"]
    if bytes_transferred is not None:
        if bytes_transferred < 25_000:
            return "Call teardown / keepalive", 72, ["Low transfer volume"]
        if bytes_transferred < 250_000:
            return "Call signaling", 82, ["Medium transfer volume"]
        if bytes_transferred < 1_500_000:
            return "Call duration / active session", 88, ["Sustained media exchange"]
        return "Call duration / media session", 92, ["High transfer volume"]
    return "Call session", 80, ["Port mapped to WhatsApp"]


def _classify_generic(service: str, port: int, bytes_transferred: int | None, protocol: str):
    if service == "DNS":
        return "Lookup / resolution", 92, ["DNS family port"]
    if service in {"Web", "Encrypted Web/App", "Hosting / Web", "Casting / Streaming"}:
        if bytes_transferred is not None and bytes_transferred > 500_000:
            return "Content transfer / session", 80, ["Large payload"]
        if protocol == "TLS" or port in {443, 8443, 2083, 2096}:
            return "Encrypted session", 82, ["Encrypted transport"]
        return "Page fetch / browsing", 76, ["Web family port"]
    if service == "Mail":
        if port in {25, 465, 587, 2525}:
            return "Submission", 84, ["Mail submission port"]
        return "Retrieval", 84, ["Mailbox retrieval port"]
    if service == "VPN / Tunnel":
        if bytes_transferred is not None and bytes_transferred > 250_000:
            return "Tunnel traffic", 84, ["Sustained tunnel traffic"]
        if bytes_transferred is not None and bytes_transferred < 5000:
            return "Keepalive / handshake", 78, ["Minimal tunnel traffic"]
        return "Tunnel setup", 86, ["Tunnel negotiation port"]
    if service == "VoIP / SIP":
        return "Call signaling", 90, ["SIP family port"]
    if service == "Remote Desktop":
        if bytes_transferred is not None and bytes_transferred > 250_000:
            return "Interactive session", 86, ["Active remote session"]
        return "Session setup", 82, ["Remote access port"]
    if service == "Database":
        if bytes_transferred is not None and bytes_transferred > 1_000_000:
            return "Bulk data / query", 80, ["Large database transfer"]
        return "Query / transaction", 78, ["Database family port"]
    if service == "Streaming":
        if bytes_transferred is not None and bytes_transferred > 5_000_000:
            return "Active media stream", 86, ["High-volume streaming"]
        return "Media session", 80, ["Streaming family port"]
    if service == "IoT / MQTT":
        return "Broker session", 78, ["MQTT broker port"]
    if service == "File Transfer":
        if bytes_transferred is not None and bytes_transferred > 5_000_000:
            return "Large file transfer", 84, ["High-volume transfer"]
        return "Transfer session", 78, ["File transfer port"]
    if service == "Remote Access":
        if bytes_transferred is not None and bytes_transferred > 100_000:
            return "Active session", 76, ["Sustained remote access"]
        return "Remote login", 74, ["Remote access port"]
    if service == "Device Discovery":
        return "Discovery", 70, ["Discovery port"]
    if service == "Video Conf / Streaming":
        if bytes_transferred is not None and bytes_transferred > 500_000:
            return "Active video call", 86, ["Sustained media exchange"]
        if bytes_transferred is not None and bytes_transferred > 50_000:
            return "Audio call / screen share", 80, ["Medium media exchange"]
        if bytes_transferred is not None and bytes_transferred < 5000:
            return "Keepalive / STUN", 72, ["Minimal media keepalive"]
        return "Media session", 78, ["Conferencing family port"]
    if service == "Messaging / Social":
        if bytes_transferred is not None and bytes_transferred < 10_000:
            return "Instant message / ping", 74, ["Minimal transfer volume"]
        return "Messaging session", 72, ["Messaging platform port"]
    if service == "Gaming":
        if bytes_transferred is not None and bytes_transferred > 5_000_000:
            return "Active gameplay", 82, ["High-volume game traffic"]
        if bytes_transferred is not None and bytes_transferred > 100_000:
            return "Multiplayer session", 78, ["Sustained game traffic"]
        return "Client / lobby", 72, ["Game family port"]
    if service == "P2P / File Sharing":
        if bytes_transferred is not None and bytes_transferred > 10_000_000:
            return "Active download / upload", 86, ["High-volume P2P transfer"]
        return "P2P session", 76, ["P2P family port"]
    if service == "Proxy / Tor":
        if bytes_transferred is not None and bytes_transferred > 1_000_000:
            return "Relayed traffic", 76, ["High-volume proxy tunnel"]
        return "Proxy session", 72, ["Proxy family port"]
    if service == "Cache / Backend":
        return "Backend session", 70, ["Cache / backend port"]
    if service == "Queue / Backend":
        return "Message broker session", 72, ["Queue/backend port"]
    if service == "File / Print":
        return "File / print service", 68, ["File/print family port"]
    if service == "Directory / LDAP":
        return "Directory lookup", 72, ["Directory family port"]
    if service == "Authentication":
        return "Auth session", 68, ["Authentication protocol port"]
    if service == "Infrastructure":
        return "Network service", 68, ["Infrastructure port"]
    if service == "Remote Management":
        return "Admin session", 66, ["Management port"]
    if service == "Multimedia / Home":
        return "Media sharing session", 62, ["Home entertainment port"]
    if service == "Development":
        return "Dev tool session", 62, ["Development port"]
    if service == "Crypto / Blockchain":
        if bytes_transferred is not None and bytes_transferred > 100_000_000:
            return "Blockchain sync", 80, ["High-volume blockchain traffic"]
        return "Crypto node session", 68, ["Blockchain port"]
    if service == "Security":
        return "Suspicious activity", 44, ["Common RAT port"]
    return "Session", 60, ["Generic service family"]


def _fallback_classify(protocol: str, bytes_transferred: int | None, port: int | None):
    candidates = []

    if protocol == "UDP":
        base_confidence = 42
        if bytes_transferred is not None and bytes_transferred > 5_000_000:
            candidates.append({
                "service": "Likely Streaming / Media",
                "subtype": "High-volume stream",
                "confidence": 60,
                "evidence": [f"UDP high traffic ({_human_bytes(bytes_transferred)})", "Unrecognized port"],
            })
        if bytes_transferred is not None and bytes_transferred > 1_000_000:
            candidates.append({
                "service": "Likely Video Conf / Streaming",
                "subtype": "Media stream",
                "confidence": 56,
                "evidence": [f"UDP sustained traffic ({_human_bytes(bytes_transferred)})", "Unrecognized port"],
            })
        candidates.append({
            "service": "Likely Messaging / VoIP",
            "subtype": "Media / signalling session",
            "confidence": base_confidence,
            "evidence": ["Protocol UDP", "Generic media or signalling session"],
        })

    elif protocol == "TCP":
        base_confidence = 26
        if bytes_transferred is not None and bytes_transferred > 10_000_000:
            candidates.append({
                "service": "Likely Content Transfer",
                "subtype": "Large download / upload",
                "confidence": 58,
                "evidence": [f"TCP high traffic ({_human_bytes(bytes_transferred)})", "Unrecognized port"],
            })
        if bytes_transferred is not None and bytes_transferred > 500_000:
            candidates.append({
                "service": "Likely File Transfer",
                "subtype": "Medium file transfer",
                "confidence": 44,
                "evidence": [f"TCP sustained traffic ({_human_bytes(bytes_transferred)})", "Unrecognized port"],
            })
        candidates.append({
            "service": "Likely Encrypted Web/App",
            "subtype": "Generic TCP session",
            "confidence": base_confidence,
            "evidence": ["Protocol TCP", "Generic TCP session"],
        })

    else:
        candidates.append({
            "service": "Likely Custom Protocol",
            "subtype": f"Protocol {protocol} session",
            "confidence": 18,
            "evidence": [f"Unknown protocol {protocol}", "No known port match"],
        })

    if bytes_transferred is not None and bytes_transferred == 0 and port:
        candidates.append({
            "service": "Likely Keepalive / Probe",
            "subtype": "Zero-byte session",
            "confidence": 36,
            "evidence": ["Zero data transferred", "Port connection attempt"],
        })

    if port is not None and 49152 <= port <= 65535:
        for c in candidates:
            c["evidence"].append("Ephemeral source port (no service info)")

    return max(candidates, key=lambda x: x["confidence"]) if candidates else None


def _human_bytes(b):
    if b >= 1_000_000_000:
        return f"{b/1_000_000_000:.1f}GB"
    if b >= 1_000_000:
        return f"{b/1_000_000:.1f}MB"
    if b >= 1_000:
        return f"{b/1_000:.1f}KB"
    return f"{b}B"


# --- IP-range / provider attribution (Level 1: infrastructure) ---
# (provider, is_isp, [CIDR, ...]) sourced from the shared attribution_data.json. `is_isp`
# entries identify the access network/carrier and never override a real content match.
# Matching is longest-prefix, so broad blocks defer to more specific ones.
PROVIDER_RANGES = [
    (p["pr"], bool(p.get("isp")), p.get("ranges", []))
    for p in _ATTR.get("providers", [])
    if p.get("ranges")
]

# Pre-parse CIDRs into network objects once at import.
_PROVIDER_NETS = []
for _prov, _is_isp, _cidrs in PROVIDER_RANGES:
    for _cidr in _cidrs:
        try:
            _PROVIDER_NETS.append((ipaddress.ip_network(_cidr), _prov, _is_isp))
        except ValueError:
            continue


def _load_external_ranges(path):
    """Optionally extend coverage from an external CSV (e.g. derived from MaxMind
    GeoLite2-ASN or IPinfo). Columns: network/cidr, provider/org, [is_isp]. Missing
    file is fine — the curated table is the default. Because matching is
    longest-prefix, external entries simply add/override by specificity."""
    nets = []
    if not path or not os.path.isfile(path):
        return nets
    try:
        with open(path, newline="", encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                cidr = (row.get("network") or row.get("cidr") or "").strip()
                provider = (row.get("provider") or row.get("org") or "").strip()
                if not cidr or not provider:
                    continue
                is_isp = str(row.get("is_isp", "")).strip().lower() in ("1", "true", "yes", "isp")
                try:
                    nets.append((ipaddress.ip_network(cidr), provider, is_isp))
                except ValueError:
                    continue
    except OSError:
        return []
    return nets


# Drop a CSV at backend/data/asn_ranges.csv (or point ASN_RANGES_CSV at one) to extend
# coverage to every ASN without code changes. External entries are checked first so a
# same-specificity external row wins the tie.
_EXTERNAL_RANGES_PATH = os.environ.get(
    "ASN_RANGES_CSV",
    os.path.join(os.path.dirname(__file__), "..", "..", "data", "asn_ranges.csv"),
)
_PROVIDER_NETS = _load_external_ranges(_EXTERNAL_RANGES_PATH) + _PROVIDER_NETS


# --- Fast longest-prefix index ---
# A linear scan over every CIDR per IP is fine for a curated table but melts down once
# the live provider feeds add thousands of ranges (~2k AWS/Google/... prefixes). Index
# IPv4 nets by their first octet: any prefix /8 or longer lives entirely inside one /8,
# so a query only checks its own bucket plus the rare <\8 "broad" nets. Each entry is
# precomputed integer (lo, hi) bounds so matching is integer comparison, not object
# containment. This turns ~2000 checks/IP into a few dozen.
_V4_BUCKETS: dict = {}   # first octet -> [(lo, hi, prefixlen, provider, is_isp, cidr)]
_V4_BROAD: list = []     # IPv4 nets with prefixlen < 8 (span multiple /8s)
_V6_NETS: list = []      # IPv6 (rare here) -> linear fallback


def _index_provider_nets(nets):
    for net, provider, is_isp in nets:
        if net.version == 6:
            _V6_NETS.append((net, provider, is_isp))
            continue
        entry = (int(net.network_address), int(net.broadcast_address),
                 net.prefixlen, provider, is_isp, str(net))
        if net.prefixlen < 8:
            _V4_BROAD.append(entry)
        else:
            _V4_BUCKETS.setdefault(entry[0] >> 24, []).append(entry)


_index_provider_nets(_PROVIDER_NETS)


def _match_ip(ip):
    """Longest-prefix match: among all CIDRs containing the address, return the most
    specific one (largest prefix length), so a tight block beats a broad one."""
    if not ip:
        return None
    try:
        addr = ipaddress.ip_address(str(ip).strip())
    except (ValueError, AttributeError):
        return None

    if addr.version == 6:
        best = None
        for net, provider, is_isp in _V6_NETS:
            if addr in net and (best is None or net.prefixlen > best[3]):
                best = (provider, is_isp, str(net), net.prefixlen)
        return best

    ip_int = int(addr)
    best = None  # (provider, is_isp, cidr, prefixlen)
    bucket = _V4_BUCKETS.get(ip_int >> 24)
    if bucket:
        for lo, hi, plen, provider, is_isp, cidr in bucket:
            if lo <= ip_int <= hi and (best is None or plen > best[3]):
                best = (provider, is_isp, cidr, plen)
    for lo, hi, plen, provider, is_isp, cidr in _V4_BROAD:
        if lo <= ip_int <= hi and (best is None or plen > best[3]):
            best = (provider, is_isp, cidr, plen)
    return best


def _ip_kind(ip):
    """Classify a non-public address: CGNAT, private, loopback, or link-local."""
    try:
        addr = ipaddress.ip_address(str(ip).strip())
    except (ValueError, AttributeError):
        return None
    if addr in _CGNAT_NET:
        return "cgnat"
    if addr.is_loopback:
        return "loopback"
    if addr.is_link_local:
        return "link_local"
    if addr.is_private:
        return "private"
    return None


def _classify_by_ip(record: IPDRRecord):
    """Resolve the provider for the SERVICE the subject contacted — which is the
    DESTINATION. The source IP is the subject's own endpoint (carrier/CGNAT, or for a
    server-side record the host itself); using it to name the contacted service would
    mislabel any session merely *originating* from an AWS/Meta IP as that service.
    The source is therefore only consulted to identify the subject's access network
    (ISP) when the destination matches nothing — never as a content-provider label."""
    dest = _match_ip(getattr(record, "destination_ip", None))
    if dest:
        return dest
    src = _match_ip(getattr(record, "source_ip", None))
    if src and src[1]:  # source identifies the subject's carrier (ISP) only
        return src
    return None


def _category_for(family):
    if family == "VPN / Tunnel":
        return "vpn"
    if family == "Proxy / Tor":
        return "anonymization"
    return "service"


def _merge_provider(provider, raw, prefixlen, port_result):
    # An IP-range (infrastructure) match is a strong signal; scale confidence with CIDR specificity.
    confidence = 90 if prefixlen >= 20 else 85 if prefixlen >= 16 else 78
    subtype = port_result["subtype"] if port_result["service"] != "Unknown" else "Network session"
    hosting = provider in _HOSTING_PROVIDERS
    evidence = [f"{provider} IP range ({raw})"]
    if hosting:
        evidence.append("Cloud/VPS host — possible VPN, proxy, or self-hosted endpoint")
    if port_result.get("port"):
        evidence.append(f"Port {port_result['port']}")
    for item in port_result.get("evidence", []):
        if item not in evidence:
            evidence.append(item)
        if len(evidence) >= 5:
            break
    return {
        "service": f"Likely {provider}",
        "subtype": subtype,
        "confidence": confidence,
        "family": provider,
        "port": port_result.get("port"),
        "category": "hosting" if hosting else "content",
        "evidence": evidence,
    }


_PRIVATE_LABEL = {
    "cgnat": "Carrier NAT (CGNAT)",
    "private": "Private / Internal Network",
    "loopback": "Loopback",
    "link_local": "Link-Local",
}


def _access_network_result(provider, raw, protocol):
    return {
        "service": f"{provider} (Access Network)",
        "subtype": "Carrier / ISP traffic",
        "confidence": 30,
        "family": "Access Network",
        "port": None,
        "category": "access_network",
        "evidence": [f"{provider} access network ({raw})",
                     f"Protocol {protocol}" if protocol else "Protocol unknown"],
    }


def _private_result(kind, port_result, protocol):
    label = _PRIVATE_LABEL.get(kind, "Private")
    # Keep a specific port-mapped service if one was found; otherwise label the internal traffic.
    if port_result.get("port") is not None and port_result.get("family") not in _GENERIC_PORT_FAMILIES:
        out = dict(port_result)
        out["category"] = "internal"
        out["evidence"] = list(out["evidence"]) + [f"{label} destination"]
        return out
    return {
        "service": label,
        "subtype": "Internal / non-routable",
        "confidence": 70,
        "family": "Private",
        "port": None,
        "category": "internal",
        "evidence": [f"{label} destination IP",
                     f"Protocol {protocol}" if protocol else "Protocol unknown"],
    }


def attribute_service(record: IPDRRecord):
    protocol = (record.protocol or "").upper()
    bytes_transferred = _record_bytes(record)

    port_result = _classify_by_port(record, protocol, bytes_transferred)

    # Deterministic: a private/CGNAT/loopback destination is internal, not an internet service.
    dest_kind = _ip_kind(getattr(record, "destination_ip", None))
    if dest_kind:
        return _private_result(dest_kind, port_result, protocol)

    ip_result = _classify_by_ip(record)

    if ip_result:
        provider, is_isp, raw, prefixlen = ip_result
        if not is_isp:
            # Content-provider IP match is the strongest signal — it names the actual service.
            return _merge_provider(provider, raw, prefixlen, port_result)
        # Access network/ISP: keep a *specific* port-mapped service (DNS, mail, VPN, ...) and
        # annotate the carrier; but a generic web / behavioural guess shouldn't outrank the
        # one thing we actually know — the carrier — so fall back to the access-network label.
        specific_port = port_result.get("port") is not None and port_result.get("family") not in _GENERIC_PORT_FAMILIES
        if specific_port:
            annotated = dict(port_result)
            annotated["evidence"] = list(port_result["evidence"]) + [f"{provider} access network ({raw})"]
            return annotated
        return _access_network_result(provider, raw, protocol)

    return port_result


def _classify_by_port(record: IPDRRecord, protocol: str, bytes_transferred: int):
    candidates = []
    seen_services = set()

    # Inspect the destination port first: for an outbound IP session the destination
    # is the well-known service port, while the source is typically ephemeral. This
    # ordering means the meaningful match is recorded before any ephemeral one.
    for raw_port, is_source in ((record.destination_port, False), (record.source_port, True)):
        if raw_port is None:
            continue
        try:
            port = int(raw_port)
        except (TypeError, ValueError):
            continue

        base = PORT_MAP.get(port)

        if not base:
            base = _check_port_ranges(port)

        if not base:
            continue

        label, confidence, reason, service_family, default_subtype = base

        if service_family in seen_services:
            continue
        seen_services.add(service_family)

        # A match on the source port inside the ephemeral range is almost always the
        # connection's own short-lived port coinciding with a service band (e.g. a
        # source port of 50005 looking like MS Teams/Discord), not the real service.
        # Flag it so it can be demoted once we know a stronger match exists.
        suspect_ephemeral = is_source and port >= EPHEMERAL_MIN

        subtype = default_subtype
        evidence = [f"Port {port}", reason]

        if service_family == "WhatsApp":
            subtype, confidence, sub_evidence = _classify_whatsapp(protocol, port, bytes_transferred)
            evidence.extend(sub_evidence)
        else:
            subtype, confidence, sub_evidence = _classify_generic(service_family, port, bytes_transferred, protocol)
            evidence.extend(sub_evidence)

        if protocol == "UDP" and port in {53, 3478, 500, 4500, 1194, 1701, 51820, 3544, 19302}:
            confidence = min(96, confidence + 3)
            evidence.append("UDP aligned")
        elif protocol == "TCP" and port in {80, 443, 5222, 5223, 5228, 5060, 5061, 3389, 5900, 3306, 5432, 8443, 25, 110, 143, 993, 995}:
            confidence = min(96, confidence + 2)
            evidence.append("TCP aligned")

        candidates.append(
            {
                "service": label,
                "subtype": subtype,
                "confidence": confidence,
                "evidence": evidence,
                "family": service_family,
                "port": port,
                "suspect_ephemeral": suspect_ephemeral,
            }
        )

    if candidates:
        strong = [c for c in candidates if not c["suspect_ephemeral"]]
        if strong:
            # Drop coincidental ephemeral source-port matches when a real port exists.
            candidates = strong
        else:
            # Only ephemeral source-port guesses survive — keep them but mark low-trust.
            for c in candidates:
                c["confidence"] = max(10, c["confidence"] - 25)
                c["evidence"].append("Ephemeral source-port match (low confidence)")

        # Best = highest confidence; tie-break toward the more well-known (lower) port.
        best = max(candidates, key=lambda item: (item["confidence"], -item["port"]))
        return _public(best)

    fallback = _fallback_classify(protocol, bytes_transferred, record.destination_port or record.source_port)
    if fallback:
        fallback.setdefault("family", fallback["service"])
        fallback["category"] = "unknown"
        return fallback

    return {
        "service": "Unknown",
        "subtype": "Unclassified",
        "confidence": 10,
        "family": "Unknown",
        "port": None,
        "category": "unknown",
        "evidence": [f"Protocol {protocol}" if protocol else "Protocol unknown", "No classification possible"],
    }


def _public(candidate: dict) -> dict:
    """Strip internal bookkeeping keys before returning a classification."""
    family = candidate.get("family", candidate["service"])
    return {
        "service": candidate["service"],
        "subtype": candidate["subtype"],
        "confidence": candidate["confidence"],
        "family": family,
        "port": candidate.get("port"),
        "category": _category_for(family),
        "evidence": candidate["evidence"],
    }


def _record_bytes(record) -> int:
    total = 0
    for attr in ("bytes_uploaded", "bytes_downloaded"):
        value = getattr(record, attr, None)
        if value is None:
            continue
        try:
            total += int(value)
        except (TypeError, ValueError):
            continue
    return total


def summarize_services(records):
    counts = Counter()
    best_example = {}
    total_bytes = Counter()

    for record in records:
        attribution = attribute_service(record)
        service = attribution["service"]
        counts[service] += 1
        total_bytes[service] += _record_bytes(record)

        # Keep the most-confident classification as the representative example,
        # rather than whichever record happened to be processed first.
        current = best_example.get(service)
        if current is None or attribution["confidence"] > current["confidence"]:
            best_example[service] = attribution

    return [
        {
            "service": service,
            "count": count,
            "confidence": best_example[service]["confidence"],
            "evidence": best_example[service]["evidence"],
            "subtype": best_example[service]["subtype"],
            "family": best_example[service].get("family", service),
            "total_bytes": total_bytes[service],
        }
        for service, count in counts.most_common()
    ]
