from __future__ import annotations

import math
from datetime import datetime, timedelta
from collections import Counter, defaultdict, deque
from itertools import combinations
from typing import Any

# ---- helpers ----
def _ts(v):
    if isinstance(v, str):
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00") if "Z" in v else v)
        except Exception:
            return datetime.utcnow()
    return v

def _safe_list(seq):
    try:
        return list(seq)
    except Exception:
        return []

_EPOCH = datetime(2000, 1, 1)

def _ts_ord(v):
    t = _ts(v)
    if t is None:
        return 0
    return int((t - _EPOCH).total_seconds())

def _haversine_km(lat1, lng1, lat2, lng2):
    if None in (lat1, lng1, lat2, lng2):
        return None
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


# ================================================================
# MODULE 1: Session Analyzer
# ================================================================
class SessionAnalyzer:
    """Groups CDR records into conversation sessions and analyzes gaps."""

    GAP_THRESHOLD_MINUTES = 30  # gap > 30 min = new session

    def analyze(self, records: list[dict], towers: dict[str, dict] | None = None) -> dict:
        # Group by subject
        sub_records = defaultdict(list)
        for r in records:
            sub = r.get("subject")
            if sub:
                sub_records[sub].append(r)

        sessions_by_subject = {}
        all_sessions = []
        gap_stats = defaultdict(list)

        for sub, recs in sub_records.items():
            recs_sorted = sorted(recs, key=lambda x: _ts(x.get("timestamp", "")))
            sessions = []
            current: list[dict] = []
            for r in recs_sorted:
                ts = _ts(r.get("timestamp", ""))
                if not current:
                    current.append(r)
                else:
                    last_ts = _ts(current[-1].get("timestamp", ""))
                    gap = (ts - last_ts).total_seconds() / 60.0
                    if gap > self.GAP_THRESHOLD_MINUTES:
                        if current:
                            sessions.append(current)
                            gap_stats[sub].append(gap)
                        current = [r]
                    else:
                        current.append(r)
            if current:
                sessions.append(current)

            session_list = []
            for s in sessions:
                ts_list = [_ts(x.get("timestamp", "")) for x in s]
                dur_list = [x.get("duration", 0) or 0 for x in s]
                participants = set()
                for x in s:
                    if x.get("counterpart"):
                        participants.add(x.get("counterpart"))
                session_list.append({
                    "start": min(ts_list).isoformat() if ts_list else "",
                    "end": max(ts_list).isoformat() if ts_list else "",
                    "call_count": len(s),
                    "total_duration_seconds": sum(dur_list),
                    "unique_participants": len(participants),
                    "participants": _safe_list(participants),
                    "gap_from_previous_minutes": round(gap_stats[sub][len(session_list)]) if len(session_list) < len(gap_stats[sub]) else None
                })
                all_sessions.append(session_list[-1])

            sessions_by_subject[sub] = {
                "total_sessions": len(session_list),
                "sessions": session_list[:20],
                "avg_calls_per_session": round(len(recs_sorted) / max(len(session_list), 1), 1),
                "avg_gap_between_sessions_minutes": round(sum(gap_stats[sub]) / max(len(gap_stats[sub]), 1), 1) if gap_stats[sub] else None,
                "max_gap_minutes": round(max(gap_stats[sub])) if gap_stats[sub] else None,
                "min_gap_minutes": round(min(gap_stats[sub])) if gap_stats[sub] else None,
                "gaps_above_1h": sum(1 for g in gap_stats[sub] if g > 60),
                "gaps_above_6h": sum(1 for g in gap_stats[sub] if g > 360),
                "gaps_above_24h": sum(1 for g in gap_stats[sub] if g > 1440),
            }

        return {
            "by_subject": sessions_by_subject,
            "total_sessions": len(all_sessions),
            "subjects_analyzed": len(sessions_by_subject),
        }


# ================================================================
# MODULE 2: Communication Pattern Analyzer
# ================================================================
class CommunicationPatternAnalyzer:
    """Analyzes call direction, duration patterns, response times, calling circles."""

    def analyze(self, records: list[dict]) -> dict:
        sub_analysis = {}
        pair_stats: dict[tuple[str, str], dict] = {}

        for r in records:
            sub = r.get("subject")
            cnt = r.get("counterpart")
            if not sub or not cnt:
                continue
            dur = r.get("duration", 0) or 0
            direction = r.get("direction", "MO")
            ts = r.get("timestamp")

            pair = tuple(sorted([sub, cnt]))
            if pair not in pair_stats:
                pair_stats[pair] = {"call_count": 0, "total_dur": 0, "durations": [], "timestamps": [], "directions": []}
            ps = pair_stats[pair]
            ps["call_count"] += 1
            ps["total_dur"] += dur
            ps["durations"].append(dur)
            ps["timestamps"].append(ts)
            ps["directions"].append(direction)

        # Per-subject communication patterns
        for (a, b), ps in pair_stats.items():
            for sub in [a, b]:
                if sub not in sub_analysis:
                    sub_analysis[sub] = {
                        "total_calls": 0,
                        "incoming": 0,
                        "outgoing": 0,
                        "total_duration_seconds": 0,
                        "avg_duration_seconds": 0,
                        "unique_contacts": set(),
                        "contacts_detail": [],
                        "response_times": [],
                        "short_calls_under_5s": 0,
                        "long_calls_over_1h": 0,
                    }
                sa = sub_analysis[sub]

            for sub in [a, b]:
                sa = sub_analysis[sub]
                sa["total_calls"] += ps["call_count"]
                sa["total_duration_seconds"] += ps["total_dur"]
                other = b if sub == a else a
                sa["unique_contacts"].add(other)
                for i, d in enumerate(ps["durations"]):
                    dir_at = ps["directions"][i] if i < len(ps["directions"]) else "MO"
                    is_out = (sub == a and dir_at == "MO") or (sub == b and dir_at == "MT")
                    if is_out:
                        sa["outgoing"] += 1
                    else:
                        sa["incoming"] += 1
                    if d < 5:
                        sa["short_calls_under_5s"] += 1
                    if d > 3600:
                        sa["long_calls_over_1h"] += 1

                sa["contacts_detail"].append({
                    "contact": other,
                    "call_count": ps["call_count"],
                    "total_duration_seconds": ps["total_dur"],
                    "direction_ratio": round(sa["outgoing"] / max(sa["incoming"], 1), 2) if sa["incoming"] > 0 else None,
                })

        # Response time: for each incoming to same counterpart, time until next outgoing
        for sub, recs in self._group_records_by_subject(records).items():
            recs_sorted = sorted(recs, key=lambda x: _ts(x.get("timestamp", "")))
            incoming_queue: dict[str, datetime] = {}
            for r in recs_sorted:
                cnt = r.get("counterpart")
                ts = _ts(r.get("timestamp", ""))
                direction = r.get("direction", "MO")
                is_out = direction == "MO"
                if not is_out and cnt:
                    incoming_queue[cnt] = ts
                elif is_out and cnt and cnt in incoming_queue:
                    response_time = (ts - incoming_queue[cnt]).total_seconds()
                    if 0 <= response_time < 86400:
                        sub_analysis[sub]["response_times"].append(response_time)
                    del incoming_queue[cnt]

        # Compute calling circles
        calling_circles = self._detect_calling_circles(pair_stats)

        # Finalize
        results = {}
        for sub, sa in sub_analysis.items():
            contacts = sorted(sa["contacts_detail"], key=lambda x: x["call_count"], reverse=True)
            resp_times = sa["response_times"]
            results[sub] = {
                "total_calls": sa["total_calls"],
                "incoming": sa["incoming"],
                "outgoing": sa["outgoing"],
                "in_out_ratio": round(sa["incoming"] / max(sa["outgoing"], 1), 2) if sa["outgoing"] > 0 else None,
                "avg_duration_seconds": round(sa["total_duration_seconds"] / max(sa["total_calls"], 1), 1),
                "total_duration_seconds": sa["total_duration_seconds"],
                "unique_contacts": len(sa["unique_contacts"]),
                "short_calls_under_5s": sa["short_calls_under_5s"],
                "long_calls_over_1h": sa["long_calls_over_1h"],
                "top_contacts": contacts[:10],
                "response_time_avg_seconds": round(sum(resp_times) / max(len(resp_times), 1), 1) if resp_times else None,
                "response_time_median_seconds": self._median(resp_times) if resp_times else None,
                "response_time_under_1min": sum(1 for r in resp_times if r < 60) if resp_times else 0,
                "response_time_over_1h": sum(1 for r in resp_times if r > 3600) if resp_times else 0,
            }

        return {
            "by_subject": results,
            "calling_circles": calling_circles,
            "total_pairs_analyzed": len(pair_stats),
        }

    def _group_records_by_subject(self, records):
        groups = defaultdict(list)
        for r in records:
            if r.get("subject"):
                groups[r["subject"]].append(r)
        return dict(groups)

    def _detect_calling_circles(self, pair_stats):
        circles = []
        # Build graph of communication
        graph = defaultdict(set)
        for (a, b) in pair_stats:
            graph[a].add(b)
            graph[b].add(a)

        # Find triangles (3-node cliques)
        nodes = list(graph.keys())
        for i, n1 in enumerate(nodes):
            for j, n2 in enumerate(nodes[i + 1:], i + 1):
                if n2 not in graph[n1]:
                    continue
                for n3 in nodes[j + 1:]:
                    if n3 in graph[n1] and n3 in graph[n2]:
                        total_calls = sum(pair_stats.get(tuple(sorted(p)), {}).get("call_count", 0) for p in [(n1, n2), (n1, n3), (n2, n3)])
                        circles.append({
                            "members": [n1, n2, n3],
                            "size": 3,
                            "total_calls_between": total_calls,
                        })

        circles.sort(key=lambda x: x["total_calls_between"], reverse=True)
        return circles[:20]

    @staticmethod
    def _median(vals):
        s = sorted(vals)
        n = len(s)
        if n == 0:
            return None
        if n % 2 == 1:
            return s[n // 2]
        return (s[n // 2 - 1] + s[n // 2]) / 2


# ================================================================
# MODULE 3: Temporal Analyzer
# ================================================================
class TemporalAnalyzer:
    """Analyzes daily/weekly rhythms, night activity, trends."""

    def analyze(self, records: list[dict]) -> dict:
        hourly = Counter()
        daily = Counter()
        dow = Counter()
        dow_sets = defaultdict(set)
        night_records = 0
        total_records = 0
        day_records = 0
        sub_hourly = defaultdict(Counter)
        sub_night = Counter()
        sub_day = Counter()

        timestamps = []

        for r in records:
            ts = _ts(r.get("timestamp", ""))
            sub = r.get("subject")
            if not ts or not sub:
                continue
            timestamps.append(ts)
            h = ts.hour
            hourly[h] += 1
            daily[ts.date().isoformat()] += 1
            d = ts.weekday()
            dow[d] += 1
            total_records += 1
            sub_hourly[sub][h] += 1
            if h < 6 or h >= 22:
                night_records += 1
                sub_night[sub] += 1
            else:
                day_records += 1
                sub_day[sub] += 1

        # Time-of-day profile per subject
        sub_profiles = {}
        for sub, hc in sub_hourly.items():
            peak_hour = hc.most_common(1)[0][0] if hc else -1
            night_pct = round((sub_night.get(sub, 0) / max(sub_hourly[sub].total(), 1)) * 100, 1)
            morning = sum(v for h, v in hc.items() if 6 <= h < 12)
            afternoon = sum(v for h, v in hc.items() if 12 <= h < 17)
            evening = sum(v for h, v in hc.items() if 17 <= h < 22)
            night = sum(v for h, v in hc.items() if h < 6 or h >= 22)
            total = max(morning + afternoon + evening + night, 1)

            def _profile_desc(pct, label):
                if pct > 50:
                    return f"Predominantly {label}"
                if pct > 30:
                    return f"Significant {label}"
                return None

            profile_parts = [_profile_desc(morning / total * 100, "morning"),
                             _profile_desc(afternoon / total * 100, "afternoon"),
                             _profile_desc(evening / total * 100, "evening"),
                             _profile_desc(night / total * 100, "night")]
            profile_parts = [p for p in profile_parts if p]
            profile = profile_parts[0] if profile_parts else "Distributed"

            sub_profiles[sub] = {
                "peak_hour": peak_hour,
                "night_activity_pct": night_pct,
                "morning_pct": round(morning / total * 100, 1),
                "afternoon_pct": round(afternoon / total * 100, 1),
                "evening_pct": round(evening / total * 100, 1),
                "night_pct": round(night / total * 100, 1),
                "profile": profile,
                "is_night_owl": night_pct > 40,
                "activity_days": len(set(_ts(r2.get("timestamp", "")).date().isoformat() for r2 in records if r2.get("subject") == sub)),
            }

        # Trend: compare first half and second half activity rate
        if len(timestamps) >= 10:
            sorted_ts = sorted(timestamps)
            mid_idx = len(sorted_ts) // 2
            first_half_rate = mid_idx / max((sorted_ts[mid_idx] - sorted_ts[0]).total_seconds() / 3600, 1)
            second_half_rate = (len(sorted_ts) - mid_idx) / max((sorted_ts[-1] - sorted_ts[mid_idx]).total_seconds() / 3600, 1)
            trend = "increasing" if second_half_rate > first_half_rate * 1.2 else "decreasing" if second_half_rate < first_half_rate * 0.8 else "stable"
            trend_magnitude = round((second_half_rate / max(first_half_rate, 0.001) - 1) * 100, 1)
        else:
            trend = "insufficient_data"
            trend_magnitude = 0

        dow_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

        return {
            "total_records": total_records,
            "date_range": {
                "start": min(timestamps).isoformat() if timestamps else None,
                "end": max(timestamps).isoformat() if timestamps else None,
                "span_days": round((max(timestamps) - min(timestamps)).total_seconds() / 86400, 1) if len(timestamps) > 1 else 0,
            },
            "hourly_distribution": {str(h): hourly[h] for h in range(24)},
            "daily_activity": dict(daily.most_common(30)),
            "day_of_week": {dow_names[d]: dow[d] for d in range(7)},
            "night_activity_ratio": round(night_records / max(total_records, 1), 3),
            "night_record_count": night_records,
            "day_record_count": day_records,
            "most_active_hour": hourly.most_common(1)[0][0] if hourly else None,
            "most_active_day": daily.most_common(1)[0][0] if daily else None,
            "activity_trend": trend,
            "trend_magnitude_pct": trend_magnitude,
            "subject_profiles": sub_profiles,
        }


# ================================================================
# MODULE 4: Location Intelligence Analyzer
# ================================================================
class LocationIntelligenceAnalyzer:
    """Movement corridors, frequent locations, geo patterns."""

    def analyze(self, records: list[dict], towers: dict[str, dict] | None = None) -> dict:
        towers = towers or {}
        sub_tower_seq = defaultdict(list)

        for r in sorted(records, key=lambda x: _ts_ord(x.get("timestamp", ""))):
            sub = r.get("subject")
            tow = r.get("tower_id")
            ts = r.get("timestamp")
            if sub and tow and ts:
                sub_tower_seq[sub].append((ts, tow, r.get("lat"), r.get("lng")))

        results = {}
        for sub, seq in sub_tower_seq.items():
            # Tower visit counts
            tower_counts = Counter(tow for _, tow, _, _ in seq)
            total = sum(tower_counts.values())

            # Frequent locations
            frequent_locations = []
            for tow_id, count in tower_counts.most_common(10):
                lat = None
                lng = None
                for _, tid, lt, ln in seq:
                    if tid == tow_id:
                        lat = lt
                        lng = ln
                        break
                if lat is None and tow_id in towers:
                    lat = towers[tow_id].get("lat")
                    lng = towers[tow_id].get("lng")
                frequent_locations.append({
                    "tower_id": tow_id,
                    "visit_count": count,
                    "visit_pct": round(count / max(total, 1) * 100, 1),
                    "latitude": lat,
                    "longitude": lng,
                })

            # Movement corridors (most common tower transitions)
            transitions = Counter()
            for i in range(len(seq) - 1):
                from_tow = seq[i][1]
                to_tow = seq[i + 1][1]
                if from_tow != to_tow:
                    transitions[(from_tow, to_tow)] += 1

            corridors = []
            for (f, t), cnt in transitions.most_common(15):
                corridors.append({
                    "from_tower": f,
                    "to_tower": t,
                    "count": cnt,
                })

            # Radius of operation
            lats = [lt for _, _, lt, _ in seq if lt is not None]
            lngs = [ln for _, _, _, ln in seq if ln is not None]
            max_dist = 0
            if len(lats) >= 2:
                for lt1, ln1 in zip(lats, lngs):
                    for lt2, ln2 in zip(lats, lngs):
                        d = _haversine_km(lt1, ln1, lt2, ln2)
                        if d and d > max_dist:
                            max_dist = d

            # Location entropy (how predictable)
            location_entropy = 0
            if total > 0:
                for _, c in tower_counts.most_common():
                    p = c / total
                    if p > 0:
                        location_entropy -= p * math.log2(p)

            results[sub] = {
                "total_locations": len(tower_counts),
                "frequent_locations": frequent_locations,
                "movement_corridors": corridors[:10],
                "total_transitions": sum(transitions.values()),
                "radius_of_operation_km": round(max_dist, 1) if max_dist else None,
                "location_entropy": round(location_entropy, 3),
                "location_predictability": "High" if location_entropy < 2 else "Medium" if location_entropy < 4 else "Low",
                "unique_days_with_movement": len(set(_ts(t).date().isoformat() for t, _, _, _ in seq)),
            }

        # Geographic hotspots (towers with most subject visits)
        tower_subject_visits = defaultdict(lambda: {"subjects": set(), "total_visits": 0, "lat": None, "lng": None})
        for r in records:
            tow = r.get("tower_id")
            sub = r.get("subject")
            if tow and sub:
                tower_subject_visits[tow]["subjects"].add(sub)
                tower_subject_visits[tow]["total_visits"] += 1
                if tower_subject_visits[tow]["lat"] is None:
                    tower_subject_visits[tow]["lat"] = r.get("lat")
                    tower_subject_visits[tow]["lng"] = r.get("lng")

        hotspots = []
        for tow_id, info in sorted(tower_subject_visits.items(), key=lambda x: x[1]["total_visits"], reverse=True)[:20]:
            if tow_id in towers:
                info["lat"] = towers[tow_id].get("lat", info["lat"])
                info["lng"] = towers[tow_id].get("lng", info["lng"])
            hotspots.append({
                "tower_id": tow_id,
                "total_visits": info["total_visits"],
                "unique_subjects": len(info["subjects"]),
                "latitude": info["lat"],
                "longitude": info["lng"],
            })

        return {
            "by_subject": results,
            "geo_hotspots": hotspots,
            "total_subjects_analyzed": len(results),
        }


# ================================================================
# MODULE 5: Deep Social Network Analyzer
# ================================================================
class SocialNetworkAnalyzer:
    """Advanced network metrics: k-core, triads, cliques, bridges, centrality."""

    def analyze(self, records: list[dict]) -> dict:
        G = defaultdict(lambda: {"weight": 0, "timestamps": [], "directions": []})
        nodes = set()

        for r in records:
            sub = r.get("subject")
            cnt = r.get("counterpart")
            if not sub or not cnt:
                continue
            nodes.add(sub)
            nodes.add(cnt)
            pair = tuple(sorted([sub, cnt]))
            G[pair]["weight"] += 1
            G[pair]["timestamps"].append(r.get("timestamp"))
            direction = r.get("direction", "MO")
            G[pair]["directions"].append(direction)

        node_list = _safe_list(nodes)
        n = len(node_list)
        node_idx = {node: i for i, node in enumerate(node_list)}

        if n == 0:
            return {"nodes": 0, "edges": 0, "error": "no data"}

        # Adjacency
        adj = defaultdict(set)
        for (u, v), e in G.items():
            adj[u].add(v)
            adj[v].add(u)

        # Degree centrality
        deg = {node: len(adj[node]) / max(n - 1, 1) for node in node_list}

        # Betweenness centrality (approximate, O(n*m))
        bet = defaultdict(float)
        for s in node_list:
            stack = []
            pred = defaultdict(list)
            sigma = defaultdict(int)
            sigma[s] = 1
            dist = {s: 0}
            q = deque([s])
            while q:
                v = q.popleft()
                stack.append(v)
                for w in adj[v]:
                    if w not in dist:
                        dist[w] = dist[v] + 1
                        q.append(w)
                    if dist[w] == dist[v] + 1:
                        sigma[w] += sigma[v]
                        pred[w].append(v)
            delta = defaultdict(float)
            while stack:
                w = stack.pop()
                for v in pred[w]:
                    if sigma[w] > 0:
                        delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w])
                if w != s:
                    bet[w] += delta[w]

        max_bet = max(bet.values()) if bet else 1
        if max_bet > 0:
            bet = {k: v / max_bet for k, v in bet.items()}

        # Closeness centrality (sampled for large graphs)
        clo = {}
        for node in node_list:
            total_dist = 0
            reached = 0
            q = deque([(node, 0)])
            visited = {node}
            while q:
                v, d = q.popleft()
                for w in adj[v]:
                    if w not in visited:
                        visited.add(w)
                        q.append((w, d + 1))
                        total_dist += d + 1
                        reached += 1
            clo[node] = reached / max(total_dist, 1) if reached > 0 else 0

        # PageRank (iterative)
        pr = {node: 1.0 / n for node in node_list}
        damping = 0.85
        for _ in range(50):
            new_pr = {}
            for node in node_list:
                s = sum(pr.get(n, 0) / max(len(adj[n]), 1) for n in adj[node]) if adj[node] else 0
                new_pr[node] = (1 - damping) / n + damping * s
            pr = new_pr

        # K-core decomposition
        coreness = {}
        work_graph = {node: set(nei) for node, nei in adj.items()}
        k = 1
        while work_graph:
            changed = True
            while changed:
                changed = False
                to_remove = [node for node, nei in work_graph.items() if len(nei) < k]
                for node in to_remove:
                    coreness[node] = k - 1
                    for nei in work_graph.get(node, set()):
                        if nei in work_graph:
                            work_graph[nei].discard(node)
                    del work_graph[node]
                    changed = True
            k += 1

        # Clustering coefficient
        clustering = {}
        for node in node_list:
            neighbors = list(adj[node])
            k_n = len(neighbors)
            if k_n < 2:
                clustering[node] = 0
                continue
            edge_count = 0
            for i in range(k_n):
                for j in range(i + 1, k_n):
                    if neighbors[j] in adj[neighbors[i]]:
                        edge_count += 1
            clustering[node] = 2 * edge_count / max(k_n * (k_n - 1), 1)

        # Triad census
        triads = {"closed": 0, "open": 0, "total": 0}
        for (u, v) in combinations(node_list, 2):
            if v not in adj[u]:
                continue
            for w in node_list:
                if w == u or w == v:
                    continue
                if w in adj[u] and w in adj[v]:
                    triads["closed"] += 1
                elif w in adj[u] or w in adj[v]:
                    triads["open"] += 1
                triads["total"] += 1

        # Reciprocity
        reciprocal_pairs = 0
        total_pairs = 0
        for (u, v) in combinations(node_list, 2):
            if v in adj[u]:
                total_pairs += 1
                if u in adj[v]:
                    reciprocal_pairs += 1
        reciprocity = round(reciprocal_pairs / max(total_pairs, 1), 3)

        # Structural roles
        roles = {}
        for node in node_list:
            d = deg[node]
            b = bet.get(node, 0)
            c = clustering[node]
            kc = coreness.get(node, 0)

            if d > 0.4 and b > 0.3:
                role = "Broker / Bridge"
            elif d > 0.5:
                role = "Hub / Central Figure"
            elif kc >= 3:
                role = "Core Member"
            elif d < 0.05:
                role = "Peripheral / Leaf"
            else:
                role = "Regular Member"

            roles[node] = {
                "degree_centrality": round(d, 4),
                "betweenness_centrality": round(b, 4),
                "closeness_centrality": round(clo.get(node, 0), 4),
                "pagerank": round(pr.get(node, 0), 6),
                "k_core": kc,
                "clustering_coefficient": round(c, 4),
                "inferred_role": role,
            }

        # Bridges (edges where removal disconnects)
        bridges = []
        for (u, v) in G:
            if u not in adj or v not in adj[u]:
                continue
            temp_adj = {node: set(nei) for node, nei in adj.items()}
            temp_adj[u].discard(v)
            temp_adj[v].discard(u)
            visited = set()
            q = deque([u])
            while q:
                cur = q.popleft()
                if cur in visited:
                    continue
                visited.add(cur)
                for nei in temp_adj.get(cur, set()):
                    if nei not in visited:
                        q.append(nei)
            if v not in visited:
                bridges.append({"from": u, "to": v, "weight": G[(u, v)]["weight"]})
        bridges.sort(key=lambda x: x["weight"], reverse=True)

        # E/I ratio (within community vs external)
        # Approximate communities via k-core decomposition
        communities = defaultdict(list)
        for node, kc in coreness.items():
            communities[kc].append(node)

        return {
            "nodes": n,
            "edges": len(G),
            "density": round(2 * len(G) / max(n * (n - 1), 1), 4) if n > 1 else 0,
            "reciprocity": reciprocity,
            "transitivity": round(sum(clustering.values()) / max(n, 1), 4),
            "triads": triads,
            "total_bridges": len(bridges),
            "critical_bridges": bridges[:10],
            "structural_roles": roles,
            "communities_by_core": {f"k-core={k}": members for k, members in communities.items() if len(members) > 1},
            "network_summary": {
                "avg_clustering": round(sum(clustering.values()) / max(n, 1), 4),
                "avg_degree": round(2 * len(G) / max(n, 1), 2),
                "strongest_tie_weight": max(e["weight"] for e in G.values()),
                "most_influential_node": max(pr, key=pr.get),
                "highest_betweenness_node": max(bet, key=bet.get) if bet else None,
                "diameter": None,
            },
        }


# ================================================================
# MODULE 6: Identity Deep Analyzer
# ================================================================
class IdentityDeepAnalyzer:
    """SIM swaps, device changes, burner detection, multi-SIM, cycling patterns."""

    def analyze(self, records: list[dict]) -> dict:
        sub_records = defaultdict(list)
        for r in sorted(records, key=lambda x: _ts_ord(x.get("timestamp", ""))):
            sub = r.get("subject")
            imsi = r.get("imsi")
            imei = r.get("imei")
            if sub and (imsi or imei):
                sub_records[sub].append(r)

        results = {}
        all_swaps = []
        all_changes = []
        all_burners = []

        for sub, recs in sub_records.items():
            transitions = []
            seen_pairs = set()
            imei_history = Counter()
            imsi_history = Counter()
            date_imei = defaultdict(set)
            date_imsi = defaultdict(set)
            last_imsi = None
            last_imei = None

            for r in recs:
                imsi = r.get("imsi")
                imei = r.get("imei")
                ts = r.get("timestamp")
                if not imsi or not imei:
                    continue
                pair = (imsi, imei)
                seen_pairs.add(pair)
                imei_history[imei] += 1
                imsi_history[imsi] += 1
                dt = _ts(ts).date().isoformat() if ts else "unknown"
                date_imei[dt].add(imei)
                date_imsi[dt].add(imsi)

                if last_imsi and last_imei:
                    if imei == last_imei and imsi != last_imsi:
                        transitions.append({"type": "SIM Swap", "timestamp": str(ts), "imei": imei, "old_imsi": last_imsi, "new_imsi": imsi})
                    elif imsi == last_imsi and imei != last_imei:
                        transitions.append({"type": "Device Change", "timestamp": str(ts), "imsi": imsi, "old_imei": last_imei, "new_imei": imei})
                    elif imei != last_imei and imsi != last_imsi:
                        transitions.append({"type": "Combined Change", "timestamp": str(ts), "old_pair": f"{last_imsi}/{last_imei}", "new_pair": f"{imsi}/{imei}"})
                last_imsi = imsi
                last_imei = imei

            # Burner indicators
            n_records = len(recs)
            n_pairs = len(seen_pairs)
            n_unique_imei = len(imei_history)
            n_unique_imsi = len(imsi_history)
            pair_change_rate = n_pairs / max(n_records, 1)
            days_active = len(date_imei)

            # Multi-SIM: one IMEI with multiple IMSIs
            imei_to_imsis = defaultdict(set)
            for (imsi, imei) in seen_pairs:
                imei_to_imsis[imei].add(imsi)

            # Multi-device: one IMSI with multiple IMEIs
            imsi_to_imeis = defaultdict(set)
            for (imsi, imei) in seen_pairs:
                imsi_to_imeis[imsi].add(imei)

            # Cycling: alternating IMEI/IMSI patterns
            cycling_score = 0
            if len(transitions) >= 3:
                # Check if same IMEI reappears after changing away
                imei_seq = []
                for r in recs:
                    if r.get("imei"):
                        imei_seq.append(r["imei"])
                # Count how often an IMEI reappears after a different one
                reappearances = 0
                for i in range(2, len(imei_seq)):
                    if imei_seq[i] == imei_seq[i - 2] and imei_seq[i] != imei_seq[i - 1]:
                        reappearances += 1
                cycling_score = min(100, int(reappearances / max(len(imei_seq), 1) * 200))

            # Multi-SIM score
            max_sim_per_device = max(len(imsis) for imsis in imei_to_imsis.values()) if imei_to_imsis else 1
            multi_sim_detected = max_sim_per_device > 1

            # Burner score
            burner_score = min(100, int((
                (pair_change_rate * 40) +
                (min(n_unique_imei, 10) / 10 * 20) +
                (min(n_unique_imsi, 10) / 10 * 20) +
                (min(cycling_score, 100) / 100 * 20)
            )))

            # SIM swaps found
            sim_swaps = [t for t in transitions if t["type"] == "SIM Swap"]
            device_changes = [t for t in transitions if t["type"] == "Device Change"]
            combined_changes = [t for t in transitions if t["type"] == "Combined Change"]

            findings = []
            if sim_swaps:
                findings.append(f"{len(sim_swaps)} SIM swap(s) detected — suspect may have changed subscriber identity while keeping the same device")
            if device_changes:
                findings.append(f"{len(device_changes)} device change(s) detected — suspect may be switching handsets")
            if combined_changes:
                findings.append(f"{len(combined_changes)} combined SIM+device change(s) detected — potential complete identity reset")
            if multi_sim_detected:
                findings.append(f"Multi-SIM usage detected — one device used with {max_sim_per_device} different SIMs")
            if cycling_score > 30:
                findings.append(f"Device cycling detected (score: {cycling_score}) — suspect may be rotating through devices")
            if pair_change_rate > 0.5:
                findings.append("High identity volatility — frequent IMSI/IMEI pair changes suggest deliberate evasion")

            results[sub] = {
                "records_analyzed": n_records,
                "unique_imei": n_unique_imei,
                "unique_imsi": n_unique_imsi,
                "unique_identity_pairs": n_pairs,
                "pair_change_rate": round(pair_change_rate, 3),
                "days_active": days_active,
                "sim_swaps": [{"timestamp": s["timestamp"], "imei": s["imei"], "old_imsi": s["old_imsi"], "new_imsi": s["new_imsi"]} for s in sim_swaps],
                "device_changes": [{"timestamp": d["timestamp"], "imsi": d["imsi"], "old_imei": d["old_imei"], "new_imei": d["new_imei"]} for d in device_changes],
                "combined_changes": combined_changes,
                "total_transitions": len(transitions),
                "multi_sim_detected": multi_sim_detected,
                "max_sims_per_device": max_sim_per_device,
                "multi_device_detected": any(len(imeis) > 1 for imeis in imsi_to_imeis.values()),
                "max_devices_per_sim": max(len(imeis) for imeis in imsi_to_imeis.values()) if imsi_to_imeis else 1,
                "cycling_score": cycling_score,
                "burner_score": burner_score,
                "is_suspected_burner": burner_score > 25 or len(transitions) > 2,
                "findings": findings,
                "identity_summary": f"{n_unique_imei} IMEI(s), {n_unique_imsi} IMSI(s), {n_pairs} unique pairs, {len(transitions)} transitions",
            }
            all_swaps.extend(sim_swaps)
            all_changes.extend(device_changes)
            if burner_score > 25:
                all_burners.append(sub)

        return {
            "by_subject": results,
            "total_subjects_analyzed": len(results),
            "total_sim_swaps": len(all_swaps),
            "total_device_changes": len(all_changes),
            "suspected_burners": all_burners,
            "global_findings": self._global_findings(results),
        }

    def _global_findings(self, results):
        findings = []
        subjects_with_swaps = [s for s, d in results.items() if d["sim_swaps"]]
        subjects_with_changes = [s for s, d in results.items() if d["device_changes"]]
        burners = [s for s, d in results.items() if d["is_suspected_burner"]]

        if subjects_with_swaps:
            findings.append(f"SIM swap activity: {', '.join(subjects_with_swaps)}")
        if subjects_with_changes:
            findings.append(f"Device change activity: {', '.join(subjects_with_changes)}")
        if len(burners) >= 2:
            findings.append(f"Multiple suspected burner identities detected: {', '.join(burners)}")
        return findings


# ================================================================
# MODULE 7: Anomaly / Behavioral Shift Detector
# ================================================================
class AnomalyDetector:
    """Detects sudden changes in behavior patterns."""

    def analyze(self, records: list[dict]) -> dict:
        sub_records = defaultdict(list)
        for r in records:
            sub = r.get("subject")
            if sub:
                sub_records[sub].append(r)

        anomalies = []

        for sub, recs in sub_records.items():
            if len(recs) < 10:
                continue
            recs_sorted = sorted(recs, key=lambda x: _ts_ord(x.get("timestamp", "")))

            # Split into first 60% and last 40%
            split_idx = int(len(recs_sorted) * 0.6)
            first = recs_sorted[:split_idx]
            second = recs_sorted[split_idx:]

            # 1. Activity level change
            first_rate = len(first) / max((_ts_ord(first[-1].get("timestamp", "")) - _ts_ord(first[0].get("timestamp", ""))) / 3600, 1)
            second_rate = len(second) / max((_ts_ord(second[-1].get("timestamp", "")) - _ts_ord(second[0].get("timestamp", ""))) / 3600, 1)
            activity_change = round((second_rate / max(first_rate, 0.001) - 1) * 100, 1) if first_rate > 0 else 0

            if abs(activity_change) > 50:
                anomalies.append({
                    "subject": sub,
                    "type": "Activity Level Change",
                    "detail": f"Activity {'increased' if activity_change > 0 else 'decreased'} by {abs(activity_change)}%",
                    "first_half_rate": round(first_rate, 2),
                    "second_half_rate": round(second_rate, 2),
                    "severity": "High" if abs(activity_change) > 100 else "Medium",
                })

            # 2. Contact change (new contacts in second half)
            first_contacts = set()
            for r in first:
                if r.get("counterpart"):
                    first_contacts.add(r["counterpart"])
            second_contacts = set()
            for r in second:
                if r.get("counterpart"):
                    second_contacts.add(r["counterpart"])
            new_contacts = second_contacts - first_contacts
            dropped_contacts = first_contacts - second_contacts

            if len(new_contacts) >= 3:
                anomalies.append({
                    "subject": sub,
                    "type": "New Contact Surge",
                    "detail": f"{len(new_contacts)} new contact(s) appeared in recent activity",
                    "new_contacts": _safe_list(new_contacts),
                    "severity": "High" if len(new_contacts) > 5 else "Medium",
                })
            if len(dropped_contacts) >= 3:
                anomalies.append({
                    "subject": sub,
                    "type": "Contact Drop-off",
                    "detail": f"{len(dropped_contacts)} contact(s) stopped communicating",
                    "dropped_contacts": _safe_list(dropped_contacts),
                    "severity": "Medium",
                })

            # 3. Time-of-day shift
            if len(first) >= 5 and len(second) >= 5:
                first_night = sum(1 for r in first if _ts(r.get("timestamp", "")).hour in [0, 1, 2, 3, 4, 5, 22, 23])
                second_night = sum(1 for r in second if _ts(r.get("timestamp", "")).hour in [0, 1, 2, 3, 4, 5, 22, 23])
                f_night_ratio = first_night / max(len(first), 1)
                s_night_ratio = second_night / max(len(second), 1)
                night_shift = s_night_ratio - f_night_ratio
                if abs(night_shift) > 0.2:
                    anomalies.append({
                        "subject": sub,
                        "type": "Time-of-Day Pattern Shift",
                        "detail": f"Night activity {'increased' if night_shift > 0 else 'decreased'} by {abs(night_shift) * 100:.0f}%",
                        "severity": "Medium",
                    })

            # 4. Duration change
            first_durs = [r.get("duration", 0) or 0 for r in first]
            second_durs = [r.get("duration", 0) or 0 for r in second]
            if first_durs and second_durs:
                f_avg = sum(first_durs) / len(first_durs)
                s_avg = sum(second_durs) / len(second_durs)
                dur_change = (s_avg / max(f_avg, 0.001) - 1) * 100
                if abs(dur_change) > 80:
                    anomalies.append({
                        "subject": sub,
                        "type": "Call Duration Shift",
                        "detail": f"Average call duration {'increased' if dur_change > 0 else 'decreased'} by {abs(dur_change):.0f}%",
                        "first_avg_seconds": round(f_avg, 1),
                        "second_avg_seconds": round(s_avg, 1),
                        "severity": "Low",
                    })

        anomalies.sort(key=lambda x: {"High": 3, "Medium": 2, "Low": 1}.get(x["severity"], 0), reverse=True)
        return {
            "anomalies": anomalies,
            "total_anomalies": len(anomalies),
            "high_severity_count": sum(1 for a in anomalies if a["severity"] == "High"),
            "medium_severity_count": sum(1 for a in anomalies if a["severity"] == "Medium"),
        }


# ================================================================
# MODULE 8: Gap / Disappearance Analyzer
# ================================================================
class GapAnalyzer:
    """Analyzes periods of network silence."""

    MIN_GAP_MINUTES = 120  # 2 hours

    def analyze(self, records: list[dict]) -> dict:
        sub_records = defaultdict(list)
        for r in records:
            sub = r.get("subject")
            if sub:
                sub_records[sub].append(r)

        results = {}

        for sub, recs in sub_records.items():
            sorted_recs = sorted(recs, key=lambda x: _ts(x.get("timestamp", "")))
            gaps = []
            for i in range(1, len(sorted_recs)):
                prev_ts = _ts(sorted_recs[i - 1].get("timestamp", ""))
                curr_ts = _ts(sorted_recs[i].get("timestamp", ""))
                gap_minutes = (curr_ts - prev_ts).total_seconds() / 60.0
                if gap_minutes >= self.MIN_GAP_MINUTES:
                    gaps.append({
                        "start": prev_ts.isoformat(),
                        "end": curr_ts.isoformat(),
                        "duration_minutes": round(gap_minutes, 1),
                        "duration_hours": round(gap_minutes / 60, 1),
                        "before_contact": sorted_recs[i - 1].get("counterpart"),
                        "after_contact": sorted_recs[i].get("counterpart"),
                    })

            if not gaps:
                continue

            long_gaps = [g for g in gaps if g["duration_minutes"] > 1440]
            very_long_gaps = [g for g in gaps if g["duration_minutes"] > 10080]

            results[sub] = {
                "total_gaps": len(gaps),
                "gaps_above_2h": len(gaps),
                "gaps_above_24h": len(long_gaps),
                "gaps_above_1w": len(very_long_gaps),
                "max_gap_hours": max(g["duration_hours"] for g in gaps),
                "avg_gap_hours": round(sum(g["duration_hours"] for g in gaps) / max(len(gaps), 1), 1),
                "total_silent_hours": round(sum(g["duration_hours"] for g in gaps), 1),
                "notable_gaps": gaps[:10],
                "gap_finding": self._gap_finding(sub, gaps),
            }

        return {
            "by_subject": results,
            "subjects_with_gaps": len(results),
            "global_finding": self._global_finding(results),
        }

    def _gap_finding(self, sub, gaps):
        findings = []
        max_gap = max(g["duration_hours"] for g in gaps)
        if max_gap > 720:
            findings.append(f"Subject disappeared from network for {max_gap:.0f}h ({max_gap / 24:.1f} days)")
        elif max_gap > 168:
            findings.append(f"Subject had {len(gaps)} network silence periods, longest {max_gap:.0f}h")
        if len(gaps) > 10:
            findings.append(f"Frequent gaps ({len(gaps)} instances) suggest deliberate network avoidance")
        return findings

    def _global_finding(self, results):
        findings = []
        total_gaps = sum(v["total_gaps"] for v in results.values())
        if total_gaps > 50:
            findings.append(f"High number of network gaps detected across subjects ({total_gaps} total)")
        return findings


# ================================================================
# MODULE 9: Call Detail Analyzer
# ================================================================
class CallDetailAnalyzer:
    """Suspicious call patterns: short calls, odd hours, burst patterns."""

    def analyze(self, records: list[dict]) -> dict:
        SHORT_CALL_SEC = 5
        LONG_CALL_SEC = 3600
        ODD_HOURS = set(range(0, 5))  # 00:00-04:59

        sub_analysis = {}

        for sub, recs in self._group_by_subject(records).items():
            short_calls = []
            long_calls = []
            odd_hour_calls = []
            burst_sequences = []
            calls_to_same = []

            recs_sorted = sorted(recs, key=lambda x: _ts_ord(x.get("timestamp", "")))

            for r in recs_sorted:
                dur = r.get("duration", 0) or 0
                ts = _ts(r.get("timestamp", ""))
                cnt = r.get("counterpart")
                h = ts.hour

                if 0 < dur < SHORT_CALL_SEC:
                    short_calls.append({"timestamp": ts.isoformat(), "duration": dur, "counterpart": cnt, "direction": r.get("direction", "MO")})
                if dur > LONG_CALL_SEC:
                    long_calls.append({"timestamp": ts.isoformat(), "duration": dur, "counterpart": cnt})
                if h in ODD_HOURS:
                    odd_hour_calls.append({"timestamp": ts.isoformat(), "duration": dur, "counterpart": cnt, "hour": h})

            # Burst detection: >5 calls in 10 minutes to different contacts
            burst_start = 0
            for i in range(len(recs_sorted)):
                window_end = _ts(recs_sorted[i].get("timestamp", ""))
                burst = []
                for j in range(i, len(recs_sorted)):
                    if (_ts(recs_sorted[j].get("timestamp", "")) - window_end).total_seconds() < 600:
                        burst.append(recs_sorted[j])
                    else:
                        break
                if len(burst) >= 5:
                    unique_contacts = set(r.get("counterpart") for r in burst if r.get("counterpart"))
                    burst_sequences.append({
                        "start": _ts(burst[0].get("timestamp", "")).isoformat(),
                        "end": _ts(burst[-1].get("timestamp", "")).isoformat(),
                        "call_count": len(burst),
                        "unique_contacts": len(unique_contacts),
                    })
                    burst_start = i + len(burst)
                    i = burst_start

            # Consecutive calls to same contact
            for i in range(1, len(recs_sorted)):
                prev = recs_sorted[i - 1]
                curr = recs_sorted[i]
                if prev.get("counterpart") and prev.get("counterpart") == curr.get("counterpart"):
                    gap = (_ts(curr.get("timestamp", "")) - _ts(prev.get("timestamp", ""))).total_seconds()
                    if gap < 300:
                        calls_to_same.append({
                            "contact": prev.get("counterpart"),
                            "timestamps": [_ts(prev.get("timestamp", "")).isoformat(), _ts(curr.get("timestamp", "")).isoformat()],
                            "gap_seconds": round(gap, 1),
                        })

            # Deduplicate bursts
            unique_bursts = []
            seen_bursts = set()
            for b in sorted(burst_sequences, key=lambda x: x["call_count"], reverse=True):
                key = (b["start"], b["end"])
                if key not in seen_bursts:
                    seen_bursts.add(key)
                    unique_bursts.append(b)

            findings = []
            if len(short_calls) > 3:
                findings.append(f"{len(short_calls)} very short calls (<{SHORT_CALL_SEC}s) — potential pre-arranged signals")
            if len(odd_hour_calls) > 3:
                findings.append(f"{len(odd_hour_calls)} calls during odd hours (midnight-5am) — suspicious timing")
            if unique_bursts:
                findings.append(f"{len(unique_bursts)} call burst(s) detected — rapid-fire calling pattern")

            sub_analysis[sub] = {
                "short_signal_calls": len(short_calls),
                "short_signal_calls_detail": short_calls[:10],
                "long_calls": len(long_calls),
                "odd_hour_calls": len(odd_hour_calls),
                "odd_hour_calls_detail": odd_hour_calls[:10],
                "call_bursts": len(unique_bursts),
                "call_bursts_detail": unique_bursts[:5],
                "consecutive_same_contact": len(calls_to_same),
                "findings": findings,
            }

        return {
            "by_subject": sub_analysis,
            "subjects_analyzed": len(sub_analysis),
        }

    def _group_by_subject(self, records):
        groups = defaultdict(list)
        for r in records:
            if r.get("subject"):
                groups[r["subject"]].append(r)
        return dict(groups)


# ================================================================
# MODULE 10: Hierarchical / Organizational Analyzer
# ================================================================
class HierarchicalAnalyzer:
    """Infers command structure from communication patterns."""

    def analyze(self, records: list[dict]) -> dict:
        pair_initiations = defaultdict(lambda: {"a_to_b": 0, "b_to_a": 0})
        pair_first_contact = {}

        for r in records:
            sub = r.get("subject")
            cnt = r.get("counterpart")
            direction = r.get("direction", "MO")
            if not sub or not cnt:
                continue
            pair = (sub, cnt)
            if direction == "MO":
                pair_initiations[pair]["a_to_b"] += 1
            else:
                pair_initiations[pair]["b_to_a"] += 1
            if pair not in pair_first_contact:
                pair_first_contact[pair] = (sub, cnt)

        # Compute dominance scores
        sub_dominance = defaultdict(lambda: {"initiated": 0, "received": 0, "total": 0})
        for (a, b), dirs in pair_initiations.items():
            sub_dominance[a]["initiated"] += dirs["a_to_b"]
            sub_dominance[a]["received"] += dirs["b_to_a"]
            sub_dominance[a]["total"] += dirs["a_to_b"] + dirs["b_to_a"]
            sub_dominance[b]["initiated"] += dirs["b_to_a"]
            sub_dominance[b]["received"] += dirs["a_to_b"]
            sub_dominance[b]["total"] += dirs["a_to_b"] + dirs["b_to_a"]

        dominance_scores = {}
        for sub, stats in sub_dominance.items():
            total = stats["total"]
            if total > 0:
                init_ratio = stats["initiated"] / total
                dominance = "Leader / Initiator" if init_ratio > 0.6 else "Follower / Responder" if init_ratio < 0.4 else "Peer / Balanced"
            else:
                init_ratio = 0
                dominance = "Unknown"
            dominance_scores[sub] = {
                "initiated_count": stats["initiated"],
                "received_count": stats["received"],
                "initiation_ratio": round(init_ratio, 3),
                "total_interactions": total,
                "role": dominance,
            }

        # Fan-out patterns (one-to-many commands)
        fan_out = {}
        for sub in sub_dominance:
            unique_contacts = set()
            for r in records:
                if r.get("subject") == sub and r.get("counterpart"):
                    unique_contacts.add(r["counterpart"])
            if len(unique_contacts) >= 5:
                fan_out[sub] = {
                    "unique_contacts": len(unique_contacts),
                    "potential_command_breadth": "Wide" if len(unique_contacts) > 10 else "Moderate" if len(unique_contacts) > 5 else "Narrow",
                }

        # Check-in pattern detection (regular contacts at specific intervals)
        checkin_patterns = []
        for sub in sub_dominance:
            for r in records:
                if r.get("subject") != sub:
                    continue
                cnt = r.get("counterpart")
                ts = _ts(r.get("timestamp", ""))
                if not cnt:
                    continue
            # Simple check: subject calls same counterpart regularly
            pairs = {}
            for r in records:
                if r.get("subject") == sub:
                    cnt = r.get("counterpart")
                    ts = _ts(r.get("timestamp", ""))
                    if cnt:
                        if sub not in pairs:
                            pairs[sub] = defaultdict(list)
                        pairs[sub][cnt].append(ts)
            if sub in pairs:
                for cnt, times in pairs[sub].items():
                    if len(times) >= 5:
                        gaps = []
                        for i in range(1, len(times)):
                            gaps.append((times[i] - times[i - 1]).total_seconds() / 3600)
                        avg_gap = sum(gaps) / len(gaps) if gaps else 0
                        if 20 < avg_gap < 28:
                            checkin_patterns.append({
                                "subject": sub,
                                "contact": cnt,
                                "call_count": len(times),
                                "avg_interval_hours": round(avg_gap, 1),
                                "pattern": "Daily check-in",
                            })
                        elif 160 < avg_gap < 176:
                            checkin_patterns.append({
                                "subject": sub,
                                "contact": cnt,
                                "call_count": len(times),
                                "avg_interval_hours": round(avg_gap, 1),
                                "pattern": "Weekly check-in",
                            })

        hierarchy_levels = {"leaders": [], "followers": [], "peers": []}
        for sub, ds in dominance_scores.items():
            if ds["role"] == "Leader / Initiator":
                hierarchy_levels["leaders"].append(sub)
            elif ds["role"] == "Follower / Responder":
                hierarchy_levels["followers"].append(sub)
            else:
                hierarchy_levels["peers"].append(sub)

        return {
            "dominance_scores": dominance_scores,
            "hierarchy_levels": hierarchy_levels,
            "fan_out_analysis": fan_out,
            "checkin_patterns": checkin_patterns,
            "command_chain_summary": f"Leader(s): {len(hierarchy_levels['leaders'])} | Follower(s): {len(hierarchy_levels['followers'])} | Peer(s): {len(hierarchy_levels['peers'])}",
        }


# ================================================================
# MODULE 11: Correlation / Co-occurrence Analyzer
# ================================================================
class CorrelationAnalyzer:
    """Cross-subject correlation: co-location, shared contacts, movement similarity."""

    def analyze(self, records: list[dict], towers: dict[str, dict] | None = None) -> dict:
        # Shared contacts
        sub_contacts = defaultdict(set)
        for r in records:
            sub = r.get("subject")
            cnt = r.get("counterpart")
            if sub and cnt:
                sub_contacts[sub].add(cnt)

        shared_contacts = []
        subjects = list(sub_contacts.keys())
        for i, a in enumerate(subjects):
            for b in subjects[i + 1:]:
                shared = sub_contacts[a] & sub_contacts[b]
                if len(shared) >= 2:
                    shared_contacts.append({
                        "subject_a": a,
                        "subject_b": b,
                        "shared_contacts": len(shared),
                        "contacts": _safe_list(shared),
                        "jaccard_similarity": round(len(shared) / max(len(sub_contacts[a] | sub_contacts[b]), 1), 3),
                    })
        shared_contacts.sort(key=lambda x: x["shared_contacts"], reverse=True)

        # Co-location at towers
        sub_tower_times = defaultdict(lambda: defaultdict(list))
        for r in records:
            sub = r.get("subject")
            tow = r.get("tower_id")
            ts = r.get("timestamp")
            if sub and tow and ts:
                sub_tower_times[sub][tow].append(_ts(ts))

        colocations = []
        for i, a in enumerate(subjects):
            for b in subjects[i + 1:]:
                for tow in sub_tower_times.get(a, {}):
                    if tow in sub_tower_times.get(b, {}):
                        atimes = sub_tower_times[a][tow]
                        btimes = sub_tower_times[b][tow]
                        colocated = 0
                        for ta in atimes:
                            for tb in btimes:
                                if abs((ta - tb).total_seconds()) < 3600:  # 1h window
                                    colocated += 1
                        if colocated > 0:
                            colocations.append({
                                "subject_a": a,
                                "subject_b": b,
                                "tower_id": tow,
                                "co_located_count": colocated,
                            })
        colocations.sort(key=lambda x: x["co_located_count"], reverse=True)

        return {
            "shared_contacts": shared_contacts[:20],
            "top_shared_contact_pairs": shared_contacts[:5],
            "co_locations": colocations[:20],
            "subjects_with_shared_contacts": len(shared_contacts),
            "subjects_with_co_locations": len(colocations),
        }


# ================================================================
# MODULE 12: Evidence Aggregator (Findings Generator)
# ================================================================
class EvidenceAggregator:
    """Compiles all findings across modules into ranked investigation leads."""

    SEVERITY_WEIGHTS = {"Critical": 100, "High": 75, "Medium": 50, "Low": 25, "Info": 5}

    def aggregate(self, modules: dict) -> dict:
        findings = []

        # 1. Identity findings
        id_results = modules.get("identity", {})
        for sub, data in id_results.get("by_subject", {}).items():
            if data["is_suspected_burner"]:
                findings.append({
                    "category": "Identity",
                    "title": f"Suspected burner identity: {sub}",
                    "detail": f"Burner score {data['burner_score']}% | {data['identity_summary']}",
                    "severity": "High" if data["burner_score"] > 50 else "Medium",
                    "subject": sub,
                })
            for swap in data["sim_swaps"]:
                findings.append({
                    "category": "Identity",
                    "title": f"SIM swap detected for {sub}",
                    "detail": f"IMEI {swap['imei']}: {swap['old_imsi']} → {swap['new_imsi']} at {swap.get('timestamp', '')}",
                    "severity": "High",
                    "subject": sub,
                })
            for change in data["device_changes"]:
                findings.append({
                    "category": "Identity",
                    "title": f"Device change for {sub}",
                    "detail": f"IMSI {change['imsi']}: {change['old_imei']} → {change['new_imei']} at {change.get('timestamp', '')}",
                    "severity": "Medium",
                    "subject": sub,
                })
            if data["multi_sim_detected"]:
                findings.append({
                    "category": "Identity",
                    "title": f"Multi-SIM usage: {sub}",
                    "detail": f"{data['max_sims_per_device']} SIMs used in same device",
                    "severity": "Medium",
                    "subject": sub,
                })
            if data["cycling_score"] > 30:
                findings.append({
                    "category": "Identity",
                    "title": f"Device cycling: {sub}",
                    "detail": f"Cycling score {data['cycling_score']}/100 suggests deliberate rotation",
                    "severity": "High" if data["cycling_score"] > 60 else "Medium",
                    "subject": sub,
                })

        # 2. Anomaly findings
        anom_results = modules.get("anomalies", {})
        for a in anom_results.get("anomalies", []):
            findings.append({
                "category": "Behavioral Shift",
                "title": f"{a['type']}: {a['subject']}",
                "detail": a["detail"],
                "severity": a["severity"],
                "subject": a["subject"],
            })

        # 3. Gap findings
        gap_results = modules.get("gaps", {})
        for sub, data in gap_results.get("by_subject", {}).items():
            for finding_text in data.get("gap_finding", []):
                findings.append({
                    "category": "Network Gap",
                    "title": f"Network disappearance: {sub}",
                    "detail": finding_text,
                    "severity": "High" if "days" in finding_text else "Medium",
                    "subject": sub,
                })

        # 4. Call detail findings
        call_results = modules.get("call_details", {})
        for sub, data in call_results.get("by_subject", {}).items():
            for f_text in data.get("findings", []):
                findings.append({
                    "category": "Call Pattern",
                    "title": f"Suspicious calling: {sub}",
                    "detail": f_text,
                    "severity": "Medium",
                    "subject": sub,
                })

        # 5. Hierarchical findings
        hier_results = modules.get("hierarchy", {})
        for leader in hier_results.get("hierarchy_levels", {}).get("leaders", []):
            ds = hier_results.get("dominance_scores", {}).get(leader, {})
            findings.append({
                "category": "Organization",
                "title": f"Potential leader identified: {leader}",
                "detail": f"Initiation ratio {ds.get('initiation_ratio', 0)} — initiates {ds.get('initiated_count', 0)} of {ds.get('total_interactions', 0)} interactions",
                "severity": "High",
                "subject": leader,
            })

        # 6. Network role findings
        net_results = modules.get("social_network", {})
        for node, roles in net_results.get("structural_roles", {}).items():
            if "Broker" in roles.get("inferred_role", "") or "Hub" in roles.get("inferred_role", ""):
                findings.append({
                    "category": "Network Role",
                    "title": f"Structural {roles['inferred_role']}: {node}",
                    "detail": f"Degree centrality {roles['degree_centrality']}, betweenness {roles['betweenness_centrality']}, k-core {roles['k_core']}",
                    "severity": "High",
                    "subject": node,
                })

        for bridge in net_results.get("critical_bridges", [])[:3]:
            findings.append({
                "category": "Network Structure",
                "title": f"Critical bridge: {bridge['from']} ↔ {bridge['to']}",
                "detail": f"{bridge['weight']} interactions — removal would fragment the network",
                "severity": "High",
                "subject": bridge["from"],
            })

        # 7. Correlation findings
        corr_results = modules.get("correlation", {})
        for pair in corr_results.get("top_shared_contact_pairs", []):
            findings.append({
                "category": "Correlation",
                "title": f"Linked subjects: {pair['subject_a']} & {pair['subject_b']}",
                "detail": f"{pair['shared_contacts']} shared contact(s), Jaccard similarity {pair['jaccard_similarity']}",
                "severity": "Medium",
                "subject": pair["subject_a"],
            })

        # 8. Location findings
        loc_results = modules.get("location", {})
        for sub, data in loc_results.get("by_subject", {}).items():
            if data.get("radius_of_operation_km") and data["radius_of_operation_km"] > 100:
                findings.append({
                    "category": "Movement",
                    "title": f"Wide operational range: {sub}",
                    "detail": f"Radius of operation {data['radius_of_operation_km']}km across {data['total_locations']} towers",
                    "severity": "Medium",
                    "subject": sub,
                })

        # 9. Session findings
        sess_results = modules.get("sessions", {})
        for sub, data in sess_results.get("by_subject", {}).items():
            if data.get("gaps_above_24h", 0) > 3:
                findings.append({
                    "category": "Session Pattern",
                    "title": f"Gap-rich communication: {sub}",
                    "detail": f"{data['gaps_above_24h']} gaps >24h between sessions suggests deliberate silence periods",
                    "severity": "Medium",
                    "subject": sub,
                })

        # 10. Temporal findings
        temp_results = modules.get("temporal", {})
        for sub, data in temp_results.get("subject_profiles", {}).items():
            if data.get("is_night_owl"):
                findings.append({
                    "category": "Behavioral",
                    "title": f"Night-dominant activity: {sub}",
                    "detail": f"{data['night_activity_pct']}% activity during night hours — profile: {data['profile']}",
                    "severity": "Low",
                    "subject": sub,
                })

        # Rank findings
        findings.sort(key=lambda f: self.SEVERITY_WEIGHTS.get(f["severity"], 0), reverse=True)

        # Deduplicate by title
        seen = set()
        deduped = []
        for f in findings:
            key = f["title"]
            if key not in seen:
                seen.add(key)
                deduped.append(f)

        return {
            "findings": deduped,
            "total_findings": len(deduped),
            "by_severity": {
                level: sum(1 for f in deduped if f["severity"] == level)
                for level in ["Critical", "High", "Medium", "Low", "Info"]
            },
            "by_category": {
                cat: sum(1 for f in deduped if f["category"] == cat)
                for cat in set(f["category"] for f in deduped)
            },
            "high_priority": [f for f in deduped if f["severity"] in ("Critical", "High")],
            "executive_summary": self._executive_summary(deduped),
        }

    def _executive_summary(self, findings):
        if not findings:
            return "No significant findings discovered."
        high = [f for f in findings if f["severity"] in ("Critical", "High")]
        medium = [f for f in findings if f["severity"] == "Medium"]
        return (
            f"Investigation produced {len(findings)} findings total. "
            f"{len(high)} high-severity items requiring immediate attention. "
            f"{len(medium)} medium-severity items for further investigation. "
            f"Key areas: {', '.join(sorted(set(f['category'] for f in findings)))}."
        )


# ================================================================
# MAIN: PoliceInvestigator
# ================================================================
class PoliceInvestigator:
    """Comprehensive police investigation copilot — runs ALL analytics modules."""

    def __init__(self):
        self.session_analyzer = SessionAnalyzer()
        self.comm_pattern_analyzer = CommunicationPatternAnalyzer()
        self.temporal_analyzer = TemporalAnalyzer()
        self.location_analyzer = LocationIntelligenceAnalyzer()
        self.social_network_analyzer = SocialNetworkAnalyzer()
        self.identity_deep_analyzer = IdentityDeepAnalyzer()
        self.anomaly_detector = AnomalyDetector()
        self.gap_analyzer = GapAnalyzer()
        self.call_detail_analyzer = CallDetailAnalyzer()
        self.hierarchical_analyzer = HierarchicalAnalyzer()
        self.correlation_analyzer = CorrelationAnalyzer()
        self.evidence_aggregator = EvidenceAggregator()

    def investigate(self, cdr_records: list[dict], ipdr_records: list[dict] | None = None, towers: dict[str, dict] | None = None) -> dict:
        towers = towers or {}
        all_records = cdr_records + (ipdr_records or [])

        # If no towers dict given, extract from records
        if not towers:
            for r in all_records:
                tow = r.get("tower_id")
                lat = r.get("lat") or r.get("latitude")
                lng = r.get("lng") or r.get("longitude")
                if tow and tow not in towers:
                    towers[tow] = {"tower_id": tow, "lat": lat, "lng": lng}

        # Run all modules
        sessions = self.session_analyzer.analyze(all_records, towers)
        comm_patterns = self.comm_pattern_analyzer.analyze(all_records)
        temporal = self.temporal_analyzer.analyze(all_records)
        location = self.location_analyzer.analyze(all_records, towers)
        social_network = self.social_network_analyzer.analyze(all_records)
        identity = self.identity_deep_analyzer.analyze(all_records)
        anomalies = self.anomaly_detector.analyze(all_records)
        gaps = self.gap_analyzer.analyze(all_records)
        call_details = self.call_detail_analyzer.analyze(all_records)
        hierarchy = self.hierarchical_analyzer.analyze(all_records)

        # Correlation (uses both CDR and IPDR counterparts)
        correlation = self.correlation_analyzer.analyze(all_records, towers)

        # Aggregate findings
        modules = {
            "sessions": sessions,
            "comm_patterns": comm_patterns,
            "temporal": temporal,
            "location": location,
            "social_network": social_network,
            "identity": identity,
            "anomalies": anomalies,
            "gaps": gaps,
            "call_details": call_details,
            "hierarchy": hierarchy,
            "correlation": correlation,
        }
        evidence = self.evidence_aggregator.aggregate(modules)

        # Summary stats
        total_records = len(all_records)
        total_subjects = len(set(r.get("subject") for r in all_records if r.get("subject")))
        date_range = temporal.get("date_range", {})

        return {
            "summary": {
                "total_records_analyzed": total_records,
                "cdr_count": len(cdr_records),
                "ipdr_count": len(ipdr_records or []),
                "total_subjects": total_subjects,
                "total_towers": len(towers),
                "date_range": date_range,
                "modules_executed": len(modules),
                "total_findings": evidence["total_findings"],
                "high_priority_findings": len(evidence["high_priority"]),
            },
            "sessions": sessions,
            "communication_patterns": comm_patterns,
            "temporal_analysis": temporal,
            "location_intelligence": location,
            "social_network": social_network,
            "identity_analysis": identity,
            "anomaly_detection": anomalies,
            "gap_analysis": gaps,
            "call_detail_analysis": call_details,
            "hierarchical_analysis": hierarchy,
            "correlation_analysis": correlation,
            "findings": evidence,
        }
