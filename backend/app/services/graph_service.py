from __future__ import annotations

import math
import random
from collections import Counter
from datetime import datetime

import networkx as nx
from networkx.algorithms.community import greedy_modularity_communities

from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord


def compute_layout(node_ids, edges, iterations: int = 60, seed: int = 42) -> dict:
    """Pure-Python grid-approximated Fruchterman-Reingold force layout — no SciPy (NetworkX's
    layouts require it), so it fits the air-gapped build. Repulsion is computed only within each
    node's grid cell + neighbours (≈O(n) per iteration instead of O(n²)), so a few-thousand-node
    subgraph lays out in a couple of seconds; the result is cached, making it a one-time cost, and
    the browser then just *draws* the positions instead of running its own simulation.

    Returns ``{node_id: [x, y]}`` in a normalised 1000×1000 box."""
    rnd = random.Random(seed)
    ids = list(node_ids)
    n = len(ids)
    if n == 0:
        return {}
    if n == 1:
        return {ids[0]: [500.0, 500.0]}
    W = H = 1000.0
    k = math.sqrt((W * H) / n)          # optimal edge length
    cell = k                            # grid cell size == k
    pos = {i: [rnd.uniform(0, W), rnd.uniform(0, H)] for i in ids}
    disp = {i: [0.0, 0.0] for i in ids}
    t = W / 10.0
    cool = t / (iterations + 1)
    for _ in range(iterations):
        for i in ids:
            disp[i][0] = 0.0
            disp[i][1] = 0.0
        grid: dict = {}
        for i in ids:
            grid.setdefault((int(pos[i][0] // cell), int(pos[i][1] // cell)), []).append(i)
        for (cx, cy), members in grid.items():
            neigh = []
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    neigh.extend(grid.get((cx + dx, cy + dy), ()))
            for i in members:
                pix, piy = pos[i]
                for j in neigh:
                    if i == j:
                        continue
                    ddx = pix - pos[j][0]
                    ddy = piy - pos[j][1]
                    d2 = ddx * ddx + ddy * ddy
                    if d2 == 0:
                        ddx, ddy = rnd.uniform(-1, 1), rnd.uniform(-1, 1)
                        d2 = ddx * ddx + ddy * ddy + 1e-6
                    d = math.sqrt(d2)
                    f = (k * k) / d
                    disp[i][0] += ddx / d * f
                    disp[i][1] += ddy / d * f
        for a, b in edges:
            if a not in pos or b not in pos:
                continue
            ddx = pos[a][0] - pos[b][0]
            ddy = pos[a][1] - pos[b][1]
            d = math.sqrt(ddx * ddx + ddy * ddy) or 1e-6
            f = (d * d) / k
            fx, fy = ddx / d * f, ddy / d * f
            disp[a][0] -= fx
            disp[a][1] -= fy
            disp[b][0] += fx
            disp[b][1] += fy
        for i in ids:
            dx, dy = disp[i]
            dl = math.sqrt(dx * dx + dy * dy) or 1e-6
            pos[i][0] = min(W, max(0.0, pos[i][0] + dx / dl * min(dl, t)))
            pos[i][1] = min(H, max(0.0, pos[i][1] + dy / dl * min(dl, t)))
        t = max(t - cool, 1.0)
    return {i: [round(pos[i][0], 1), round(pos[i][1], 1)] for i in ids}


def _filtered_records(db, start_date: datetime | None = None, end_date: datetime | None = None, case_id=None):
    query = db.query(CDRRecord)

    if case_id:
        query = query.filter(CDRRecord.case_id == case_id)
    if start_date is not None:
        query = query.filter(CDRRecord.start_time >= start_date)
    if end_date is not None:
        query = query.filter(CDRRecord.start_time <= end_date)

    return query.all()


def _filtered_ipdr(db, start_date=None, end_date=None, case_id=None):
    query = db.query(IPDRRecord)
    if case_id:
        query = query.filter(IPDRRecord.case_id == case_id)
    if start_date is not None:
        query = query.filter(IPDRRecord.start_time >= start_date)
    if end_date is not None:
        query = query.filter(IPDRRecord.start_time <= end_date)
    return query.all()


def build_graph(db, start_date: datetime | None = None, end_date: datetime | None = None,
                case_id=None, subject=None, limit: int = 0):
    """Build the call graph server-side. ``subject`` focuses on edges touching one number;
    ``limit`` caps the returned edges to the top-N heaviest so the browser renders a bounded
    subgraph at any case size. Node weights are the node's TRUE total over *all* edges (not just
    the shown ones), so centrality stays exact/full-coverage even when the view is trimmed.
    Includes both the CDR call network (phone↔phone) and the IPDR connection network
    (source_ip↔destination_ip). The two never share an edge, so they appear as disjoint
    components — no CDR/IPDR cross-attribution — but each node is tagged with its kind so the
    view can colour them distinctly. Returns nodes/edges plus total_nodes/total_edges/
    shown_edges for an honest 'top N of M'."""
    edge_counts: Counter[tuple[str, str]] = Counter()
    node_kind: dict[str, str] = {}

    for record in _filtered_records(db, start_date=start_date, end_date=end_date, case_id=case_id):
        a, b = record.a_party_number, record.b_party_number
        if not a or not b or a == b:
            continue
        if subject and subject not in (a, b):
            continue
        edge_counts[tuple(sorted((a, b)))] += 1
        node_kind.setdefault(a, "cdr")
        node_kind.setdefault(b, "cdr")

    for record in _filtered_ipdr(db, start_date=start_date, end_date=end_date, case_id=case_id):
        a, b = record.source_ip, record.destination_ip
        if not a or not b or a == b:
            continue
        if subject and subject not in (a, b):
            continue
        edge_counts[tuple(sorted((a, b)))] += 1
        node_kind.setdefault(a, "ipdr")
        node_kind.setdefault(b, "ipdr")

    # true node weights over every edge (full coverage), before any display trim
    full_node_weight: Counter[str] = Counter()
    for (s, t), w in edge_counts.items():
        full_node_weight[s] += w
        full_node_weight[t] += w

    items = edge_counts.most_common()  # heaviest first
    total_edges = len(items)
    if limit and limit > 0:
        items = items[:limit]

    shown_nodes = set()
    for (s, t), _ in items:
        shown_nodes.add(s)
        shown_nodes.add(t)

    return {
        "nodes": [{"id": n, "weight": full_node_weight[n], "kind": node_kind.get(n, "cdr")} for n in shown_nodes],
        "edges": [{"source": s, "target": t, "weight": w} for (s, t), w in items],
        "total_nodes": len(full_node_weight),
        "total_edges": total_edges,
        "shown_edges": len(items),
    }


def _pagerank_py(graph, alpha: float = 0.85, max_iter: int = 100, tol: float = 1.0e-6) -> dict:
    """Weighted PageRank by power iteration — pure Python so it works in the air-gapped build
    (NetworkX's nx.pagerank pulls in SciPy, which we don't ship). Equivalent ranking; bounded by
    max_iter. Returns {} for an empty graph."""
    nodes = list(graph)
    n = len(nodes)
    if n == 0:
        return {}
    x = {v: 1.0 / n for v in nodes}
    deg = {v: sum(graph[v][u].get("weight", 1) for u in graph[v]) for v in nodes}
    dangling = [v for v in nodes if deg[v] == 0.0]
    teleport = (1.0 - alpha) / n
    for _ in range(max_iter):
        xlast = x
        x = dict.fromkeys(nodes, 0.0)
        danglesum = alpha * sum(xlast[v] for v in dangling) / n
        for v in nodes:
            d = deg[v]
            if d:
                share = alpha * xlast[v] / d
                for u in graph[v]:
                    x[u] += share * graph[v][u].get("weight", 1)
        for v in nodes:
            x[v] += danglesum + teleport
        if sum(abs(x[v] - xlast[v]) for v in nodes) < tol:
            break
    return x


def cached_layout(db, case_id, subject, limit, node_ids, edges) -> dict:
    """Return precomputed positions for this exact view, computing + caching on miss. The layout is
    stored in analytics_cache (so it's cleared with the case on any data change); a cached layout is
    reused only if it covers every current node, otherwise it's recomputed."""
    from app.services.analytics_materialize_service import get_cached, _upsert
    key = f"graph_layout:{subject or 'all'}:{limit}"
    cached = get_cached(db, case_id, key)
    if isinstance(cached, dict) and all(nid in cached for nid in node_ids):
        return cached
    pos = compute_layout(node_ids, edges)
    _upsert(db, case_id or "", key, pos)
    db.commit()
    return pos


def build_graph_with_layout(db, start_date=None, end_date=None, case_id=None, subject=None, limit=0):
    """build_graph + server-computed node positions (Phase 2 server-side layout). The browser draws
    the returned x/y directly instead of running its own force simulation."""
    payload = build_graph(db, start_date=start_date, end_date=end_date, case_id=case_id,
                          subject=subject, limit=limit)
    node_ids = [n["id"] for n in payload["nodes"]]
    edges = [(e["source"], e["target"]) for e in payload["edges"]]
    pos = cached_layout(db, case_id, subject, limit, node_ids, edges)
    for n in payload["nodes"]:
        xy = pos.get(n["id"])
        if xy:
            n["x"], n["y"] = xy[0], xy[1]
    payload["layout"] = True
    return payload


def get_graph_metrics(db, start_date: datetime | None = None, end_date: datetime | None = None, case_id=None):
    # Build over the FULL graph (limit=0) so metrics cover every edge.
    graph_payload = build_graph(db, start_date=start_date, end_date=end_date, case_id=case_id, limit=0)
    graph = nx.Graph()

    for edge in graph_payload["edges"]:
        graph.add_edge(edge["source"], edge["target"], weight=edge["weight"])

    if graph.number_of_nodes() == 0:
        return {
            "degree_centrality": {},
            "betweenness_centrality": {},
            "pagerank": {},
            "closeness_centrality": {},
            "communities": [],
            "bridges": [],
        }

    if graph.number_of_edges() == 0:
        communities = [[node] for node in graph.nodes()]
    else:
        communities = [sorted(list(community)) for community in greedy_modularity_communities(graph)]

    # Exact betweenness is O(V*E) — infeasible on large graphs. Above a threshold, estimate it
    # from a random pivot sample (NetworkX's k-sampling); the ranking it produces is what an
    # investigator uses to spot brokers, and it stays bounded in time.
    n = graph.number_of_nodes()
    if n > 800:
        k = min(n, 500)
        betweenness = nx.betweenness_centrality(graph, k=k, seed=42)
        betweenness_sampled = True
    else:
        betweenness = nx.betweenness_centrality(graph)
        betweenness_sampled = False

    # PageRank — cheap (power iteration, ~O(E) per step) and a strong "influence" signal that
    # rewards being connected to other well-connected nodes, so always computed. Pure-Python impl
    # (no SciPy) to keep the air-gapped build dependency-free.
    pagerank = _pagerank_py(graph)

    # Closeness is O(V·E) (an all-pairs shortest-path per node) — like exact betweenness it's
    # infeasible at scale, and unlike betweenness NetworkX has no k-sampling for it, so above the
    # threshold we skip it and flag that rather than hang.
    if n <= 800:
        closeness = nx.closeness_centrality(graph)
        closeness_skipped = False
    else:
        closeness = {}
        closeness_skipped = True

    return {
        "degree_centrality": nx.degree_centrality(graph),
        "betweenness_centrality": betweenness,
        "betweenness_sampled": betweenness_sampled,
        "pagerank": pagerank,
        "closeness_centrality": closeness,
        "closeness_skipped": closeness_skipped,
        "communities": communities,
        "bridges": [{"source": a, "target": b} for a, b in nx.bridges(graph)],
        "total_nodes": n,
    }
