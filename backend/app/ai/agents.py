from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path
from collections import Counter, defaultdict
import networkx as nx

# Resolve knowledge base path
KB_PATH = Path(__file__).parent / "knowledge_base.json"

class ServiceAttributionAgent:
    """
    Service Attribution Agent: Determines application usage and confidence.
    """
    def __init__(self):
        self.kb = {}
        if KB_PATH.exists():
            try:
                with open(KB_PATH, "r", encoding="utf-8") as f:
                    self.kb = json.load(f)
            except Exception:
                pass

    def analyze(self, ipdr_records: list[dict]) -> dict:
        summary = defaultdict(lambda: {"count": 0, "evidence": set(), "confidence": 0})
        
        for r in ipdr_records:
            dport = r.get("destination_port")
            sport = r.get("source_port")
            protocol = (r.get("protocol") or "").upper()
            
            # Match ports from knowledge base
            matched_app = None
            matched_indicator = None
            
            for app_key, app_data in self.kb.items():
                ports = app_data.get("ports", [])
                if (dport in ports) or (sport in ports):
                    matched_app = app_data["name"]
                    # Find indicator containing the port or default
                    matched_indicator = f"Port match: {dport or sport}"
                    for ind in app_data.get("indicators", []):
                        if str(dport) in ind or str(sport) in ind:
                            matched_indicator = ind
                            break
                    break
            
            if matched_app:
                summary[matched_app]["count"] += 1
                summary[matched_app]["evidence"].add(matched_indicator)
                # Base confidence adjusted by protocol alignment
                conf = self.kb[app_key]["base_confidence"]
                if protocol in self.kb[app_key]["protocols"]:
                    conf = min(98, conf + 3)
                summary[matched_app]["confidence"] = max(summary[matched_app]["confidence"], conf)
                
        # Format output
        results = {}
        for app, data in summary.items():
            results[app] = {
                "count": data["count"],
                "confidence": data["confidence"],
                "evidence": list(data["evidence"])
            }
        return dict(results)


class IdentityAgent:
    """
    Identity Agent: Determines SIM swaps, device swaps, burner activity, and identity clusters.
    """
    def analyze(self, records: list[dict]) -> dict:
        # Group records by subject/MSISDN in chronological order
        subject_history = defaultdict(list)
        for r in sorted(records, key=lambda x: x.get("timestamp") or ""):
            sub = r.get("subject")
            if sub:
                subject_history[sub].append(r)
                
        results = {}
        for sub, rows in subject_history.items():
            sim_swaps = []
            device_changes = []
            seen_pairs = set()
            
            last_imsi = None
            last_imei = None
            
            for r in rows:
                imsi = r.get("imsi")
                imei = r.get("imei")
                ts = r.get("timestamp")
                
                if not imsi or not imei:
                    continue
                    
                seen_pairs.add((imsi, imei))
                
                if last_imsi and last_imei:
                    # SIM Swap: Same IMEI, different IMSI
                    if imei == last_imei and imsi != last_imsi:
                        sim_swaps.append({
                            "timestamp": str(ts),
                            "imei": imei,
                            "old_imsi": last_imsi,
                            "new_imsi": imsi,
                            "type": "SIM Swap",
                            "confidence": "High"
                        })
                    # Device Change: Same IMSI, different IMEI
                    elif imsi == last_imsi and imei != last_imei:
                        device_changes.append({
                            "timestamp": str(ts),
                            "imsi": imsi,
                            "old_imei": last_imei,
                            "new_imei": imei,
                            "type": "Device Change",
                            "confidence": "High"
                        })
                        
                last_imsi = imsi
                last_imei = imei
                
            # Burner indicator: high unique IMSI/IMEI pairs relative to volume
            burner_score = 0
            if len(rows) > 5:
                burner_score = int((len(seen_pairs) / len(rows)) * 100)
                
            results[sub] = {
                "unique_identities_count": len(seen_pairs),
                "unique_pairs": [f"IMSI: {p[0]} / IMEI: {p[1]}" for p in seen_pairs],
                "sim_swaps": sim_swaps,
                "device_changes": device_changes,
                "burner_score": burner_score,
                "is_suspected_burner": burner_score > 30 or len(sim_swaps) > 0 or len(device_changes) > 0
            }
            
        return results


class MovementAgent:
    """
    Movement Agent: Determines home/work towers, travel pattern, and meeting probability.
    """
    def analyze(self, records: list[dict]) -> dict:
        # Group by subject and hour
        subject_towers = defaultdict(list)
        for r in records:
            sub = r.get("subject")
            tow = r.get("tower_id")
            ts = r.get("timestamp")
            if sub and tow and ts:
                # Convert ts to datetime if string
                if isinstance(ts, str):
                    try:
                        ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    except Exception:
                        continue
                subject_towers[sub].append((ts, tow))
                
        results = {}
        for sub, visits in subject_towers.items():
            # Classify home/work towers
            # Home: active during night (19:00 - 08:00)
            # Work: active during day (09:00 - 17:00)
            night_towers = Counter()
            day_towers = Counter()
            
            for ts, tow in visits:
                h = ts.hour
                if h >= 19 or h < 8:
                    night_towers[tow] += 1
                elif h >= 9 and h <= 17:
                    day_towers[tow] += 1
                    
            home_tower = night_towers.most_common(1)[0][0] if night_towers else "Unknown"
            work_tower = day_towers.most_common(1)[0][0] if day_towers else "Unknown"
            
            # Simple travel indicator (distinct towers visited)
            all_visited = set(tow for _, tow in visits)
            
            results[sub] = {
                "home_tower": home_tower,
                "work_tower": work_tower,
                "total_towers_visited": len(all_visited),
                "towers": list(all_visited),
                "mobility_index": "High" if len(all_visited) > 4 else "Low"
            }
            
        # Detect meeting points (subjects co-located at same tower within 1 hour)
        meetings = []
        tower_timeline = defaultdict(list)
        
        for r in records:
            sub = r.get("subject")
            tow = r.get("tower_id")
            ts = r.get("timestamp")
            if sub and tow and ts:
                if isinstance(ts, str):
                    try:
                        ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    except Exception:
                        continue
                tower_timeline[tow].append((ts, sub))
                
        for tow, timeline in tower_timeline.items():
            timeline.sort()
            for i in range(len(timeline)):
                for j in range(i + 1, len(timeline)):
                    t1, sub1 = timeline[i]
                    t2, sub2 = timeline[j]
                    if sub1 == sub2:
                        continue
                    gap = abs((t2 - t1).total_seconds()) / 60.0
                    if gap <= 60.0: # 1 hour
                        meetings.append({
                            "tower_id": tow,
                            "subject_a": sub1,
                            "subject_b": sub2,
                            "time_a": t1.isoformat(),
                            "time_b": t2.isoformat(),
                            "gap_minutes": round(gap, 2)
                        })
                        
        return {
            "subjects_movement": results,
            "detected_meetings": meetings[:50] # limit to top 50
        }


class NetworkAgent:
    """
    Network Agent: Analysis of communication centrality, networks, and communities using NetworkX.
    """
    def analyze(self, cdr_records: list[dict]) -> dict:
        G = nx.Graph()
        
        # Add edges and weights
        edges = Counter()
        for r in cdr_records:
            sub = r.get("subject")
            cnt = r.get("counterpart")
            if sub and cnt:
                pair = tuple(sorted([sub, cnt]))
                edges[pair] += 1
                
        for (u, v), w in edges.items():
            G.add_edge(u, v, weight=w)
            
        if len(G.nodes) == 0:
            return {"nodes_count": 0, "edges_count": 0, "network_density": 0, "centrality_metrics": {}, "communities": []}
            
        # Centrality metrics
        deg_centrality = nx.degree_centrality(G)
        try:
            bet_centrality = nx.betweenness_centrality(G)
        except Exception:
            bet_centrality = {n: 0.0 for n in G.nodes}
            
        # Detect communities (greedy modularity)
        communities = []
        try:
            from networkx.algorithms.community import greedy_modularity_communities
            comm_list = list(greedy_modularity_communities(G))
            for idx, c in enumerate(comm_list):
                communities.append({
                    "id": idx + 1,
                    "members": list(c)
                })
        except Exception:
            pass
            
        # Identify kingpins (high degree & betweenness)
        role_assessments = {}
        for n in G.nodes:
            deg = deg_centrality.get(n, 0)
            bet = bet_centrality.get(n, 0)
            
            role = "Member"
            if deg > 0.5 and bet > 0.4:
                role = "Kingpin / Coordinator"
            elif bet > 0.5:
                role = "Bridge Node / Broker"
            elif deg > 0.6:
                role = "Hub Node / Lieutenant"
                
            role_assessments[n] = {
                "degree_centrality": round(deg, 3),
                "betweenness_centrality": round(bet, 3),
                "inferred_role": role
            }
            
        return {
            "nodes_count": len(G.nodes),
            "edges_count": len(G.edges),
            "network_density": round(nx.density(G), 3),
            "centrality_metrics": role_assessments,
            "communities": communities
        }


class ReportAgent:
    """
    Report Agent: Generates official digital forensics summaries.
    """
    def generate(self, analytics: dict, report_type: str = "full") -> str:
        # Pull records summary
        nodes_count = analytics.get("network", {}).get("nodes_count", 0)
        edges_count = analytics.get("network", {}).get("edges_count", 0)
        density = analytics.get("network", {}).get("network_density", 0)
        
        # Build Report Sections
        lines = []
        lines.append(f"# DIGITAL FORENSICS INVESTIGATION REPORT ({report_type.upper()})")
        lines.append(f"Generated at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
        lines.append("## 1. Executive Summary")
        lines.append(f"Analysis of network records reveals a community of **{nodes_count}** unique entities with **{edges_count}** communication edges.")
        lines.append(f"Overall network structural density is calculated at **{density}**.")
        
        # Add Network Communities info
        lines.append("\n## 2. Bounded Communities and Structural Roles")
        centrality = analytics.get("network", {}).get("centrality_metrics", {})
        if centrality:
            lines.append("| Subject | Degree Centrality | Betweenness Centrality | Inferred Network Role |")
            lines.append("|---|---|---|---|")
            for sub, metrics in sorted(centrality.items(), key=lambda x: x[1]["degree_centrality"], reverse=True)[:10]:
                lines.append(f"| {sub} | {metrics['degree_centrality']} | {metrics['betweenness_centrality']} | **{metrics['inferred_role']}** |")
        else:
            lines.append("No network metrics calculated.")
            
        # Add Identity transitions
        lines.append("\n## 3. Suspected Identity & Device Anomalies")
        identity = analytics.get("identity", {})
        has_anomalies = False
        for sub, id_data in identity.items():
            swaps = id_data.get("sim_swaps", [])
            devs = id_data.get("device_changes", [])
            if swaps or devs:
                has_anomalies = True
                lines.append(f"### Subject: {sub}")
                lines.append(f"- Burner Score: `{id_data.get('burner_score', 0)}%` (Suspected Burner: **{id_data.get('is_suspected_burner', False)}**)")
                for s in swaps:
                    lines.append(f"  - **[SIM SWAP]** on `{s['timestamp']}` | Old IMSI: `{s['old_imsi']}` -> New IMSI: `{s['new_imsi']}` (IMEI: `{s['imei']}`)")
                for d in devs:
                    lines.append(f"  - **[DEVICE SWAP]** on `{d['timestamp']}` | Old IMEI: `{d['old_imei']}` -> New IMEI: `{d['new_imei']}` (IMSI: `{d['imsi']}`)")
        if not has_anomalies:
            lines.append("No active SIM swaps or device changes detected.")
            
        # Add Meetings
        lines.append("\n## 4. Location & Meeting Logs")
        meetings = analytics.get("movement", {}).get("detected_meetings", [])
        if meetings:
            lines.append("| Tower ID | Subject A | Subject B | Gap (Minutes) | Trigger Time |")
            lines.append("|---|---|---|---|---|")
            for m in meetings[:15]:
                lines.append(f"| {m['tower_id']} | {m['subject_a']} | {m['subject_b']} | {m['gap_minutes']} | {m['time_a']} |")
        else:
            lines.append("No physical co-location meetings detected.")
            
        # Add App Attribution
        lines.append("\n## 5. Application Usage & Cryptographic Signatures")
        attribution = analytics.get("attribution", {})
        if attribution:
            lines.append("| App Service | Connection Counts | Signature Confidence | Sample Indicator |")
            lines.append("|---|---|---|---|")
            for app, data in sorted(attribution.items(), key=lambda x: x[1]["count"], reverse=True):
                ev = data["evidence"][0] if data["evidence"] else "Generic port attribution"
                lines.append(f"| **{app}** | {data['count']} | {data['confidence']}% | *{ev}* |")
        else:
            lines.append("No application signatures mapped.")
            
        return "\n".join(lines)
