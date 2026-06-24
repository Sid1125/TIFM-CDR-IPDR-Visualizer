from __future__ import annotations

from collections import Counter
from datetime import datetime

import networkx as nx
from networkx.algorithms.community import greedy_modularity_communities

from app.models.cdr import CDRRecord


def _filtered_records(db, start_date: datetime | None = None, end_date: datetime | None = None, case_id=None):
    query = db.query(CDRRecord)

    if case_id:
        query = query.filter(CDRRecord.case_id == case_id)
    if start_date is not None:
        query = query.filter(CDRRecord.start_time >= start_date)
    if end_date is not None:
        query = query.filter(CDRRecord.start_time <= end_date)

    return query.all()


def build_graph(db, start_date: datetime | None = None, end_date: datetime | None = None,
                case_id=None, subject=None, limit: int = 0):
    """Build the call graph server-side. ``subject`` focuses on edges touching one number;
    ``limit`` caps the returned edges to the top-N heaviest so the browser renders a bounded
    subgraph at any case size. Node weights are the node's TRUE total over *all* edges (not just
    the shown ones), so centrality stays exact/full-coverage even when the view is trimmed.
    Returns nodes/edges plus total_nodes/total_edges/shown_edges for an honest 'top N of M'."""
    records = _filtered_records(db, start_date=start_date, end_date=end_date, case_id=case_id)

    edge_counts: Counter[tuple[str, str]] = Counter()
    for record in records:
        a, b = record.a_party_number, record.b_party_number
        if not a or not b or a == b:
            continue
        if subject and subject not in (a, b):
            continue
        edge_counts[tuple(sorted((a, b)))] += 1

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
        "nodes": [{"id": n, "weight": full_node_weight[n]} for n in shown_nodes],
        "edges": [{"source": s, "target": t, "weight": w} for (s, t), w in items],
        "total_nodes": len(full_node_weight),
        "total_edges": total_edges,
        "shown_edges": len(items),
    }


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

    return {
        "degree_centrality": nx.degree_centrality(graph),
        "betweenness_centrality": betweenness,
        "betweenness_sampled": betweenness_sampled,
        "communities": communities,
        "bridges": [{"source": a, "target": b} for a, b in nx.bridges(graph)],
        "total_nodes": n,
    }
