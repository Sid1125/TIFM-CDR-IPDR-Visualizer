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


def build_graph(db, start_date: datetime | None = None, end_date: datetime | None = None, case_id=None):
    graph = nx.Graph()
    records = _filtered_records(db, start_date=start_date, end_date=end_date, case_id=case_id)

    edge_counts: Counter[tuple[str, str]] = Counter()
    for record in records:
        if not record.a_party_number or not record.b_party_number:
            continue
        edge = tuple(sorted((record.a_party_number, record.b_party_number)))
        edge_counts[edge] += 1

    for (source, target), weight in edge_counts.items():
        graph.add_edge(source, target, weight=weight)

    return {
        "nodes": [{"id": node} for node in graph.nodes()],
        "edges": [
            {"source": source, "target": target, "weight": data.get("weight", 1)}
            for source, target, data in graph.edges(data=True)
        ],
    }


def get_graph_metrics(db, start_date: datetime | None = None, end_date: datetime | None = None, case_id=None):
    graph_payload = build_graph(db, start_date=start_date, end_date=end_date, case_id=case_id)
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

    return {
        "degree_centrality": nx.degree_centrality(graph),
        "betweenness_centrality": nx.betweenness_centrality(graph),
        "communities": communities,
        "bridges": [{"source": a, "target": b} for a, b in nx.bridges(graph)],
    }
