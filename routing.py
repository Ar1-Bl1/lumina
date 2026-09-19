"""Offline A* routing on scored street graphs; coordinates are (lat, lon)."""

from __future__ import annotations

from math import asin, ceil, cos, radians, sin, sqrt
from typing import Any

import networkx as nx
from pyproj import Transformer

import config
import graph
from scoring import edge_chunk_cost


def _haversine(a: tuple, b: tuple) -> float:
    lat1, lat2 = radians(a[0]), radians(b[0])
    value = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin(radians(b[1] - a[1]) / 2) ** 2
    return 2 * 6371009 * asin(sqrt(min(1.0, value)))


def _practical_cost(data: dict, alpha: float) -> float:
    if "chunks" in data:
        return sum(edge_chunk_cost(c["chunk_len"], c["score"], alpha) for c in data["chunks"])
    # Costs are affine in alpha. Recover the chunk-length intercept from
    # geometry, as build_chunks uses geometry length rather than OSM length.
    base = data["geometry"].length if "geometry" in data else data["length"]
    if config.ALPHA_VIS:
        return base + alpha * (data["cost_vis"] - base) / config.ALPHA_VIS
    if config.ALPHA_PRACTICAL:
        return base + alpha * (data["cost_practical"] - base) / config.ALPHA_PRACTICAL
    raise ValueError("Chunk scores are required when both scoring alphas are zero")


def _low_count(data: dict) -> int | None:
    if "chunks" in data:
        return sum(c["score"] < config.ESCORT_THRESHOLD for c in data["chunks"])
    if data["min_score"] >= config.ESCORT_THRESHOLD:
        return 0
    if data["mean_score"] == data["min_score"]:
        length = data["geometry"].length if "geometry" in data else data["length"]
        return max(1, ceil(length / config.CHUNK_SIZE_M))
    return None


def find_routes(
    G: nx.MultiDiGraph, start: tuple[float, float],
    end: tuple[float, float], mode: str,
) -> dict[str, dict[str, Any]]:
    """Return three named routes without modifying G.

    Optional edge ``chunks`` records contain ``chunk_len`` and ``score``.
    For mixed-score edges without these records, n_low_segments is None:
    the aggregates written by score_graph cannot determine an exact count.
    identical_to lists matching route names, comparing selected keyed edges.
    NetworkXNoPath propagates when the snapped endpoints are disconnected.
    """
    speed = config.SPEEDS_KMH[mode]
    source = graph.nearest_node(G, *start)
    target = graph.nearest_node(G, *end)
    transform = Transformer.from_crs(G.graph["crs"], "EPSG:4326", always_xy=True)

    def latlon(x: float, y: float) -> tuple[float, float]:
        lon, lat = transform.transform(x, y)
        return lat, lon

    positions = {n: latlon(d["x"], d["y"]) for n, d in G.nodes(data=True)}

    def route(weight: str, alpha: float | None = None) -> tuple[dict, list]:
        def cost(data: dict) -> float:
            return data[weight] if alpha is None else _practical_cost(data, alpha)

        nodes = nx.astar_path(
            G, source, target,
            heuristic=lambda u, v: _haversine(positions[u], positions[v]),
            weight=lambda u, v, edges: min(cost(d) for d in edges.values()),
        )
        edges = [(u, v, min(G[u][v], key=lambda k: cost(G[u][v][k])))
                 for u, v in zip(nodes, nodes[1:])]
        attrs = [G.edges[e] for e in edges]
        length = sum(d["length"] for d in attrs)
        coords = [positions[source]]
        for (u, v, _), data in zip(edges, attrs):
            if "geometry" in data:
                points = [latlon(*p[:2]) for p in data["geometry"].coords]
                if _haversine(points[-1], positions[u]) < _haversine(points[0], positions[u]):
                    points.reverse()
                coords.extend(p for p in points if p != coords[-1])
            if coords[-1] != positions[v]:
                coords.append(positions[v])
        counts = [_low_count(d) for d in attrs]
        return dict(
            coords=coords, length_m=length, eta_min=length / (speed * 1000 / 60),
            mean_score=sum(d["length"] * d["mean_score"] for d in attrs) / length if length else None,
            min_score=min((d["min_score"] for d in attrs), default=None),
            n_low_segments=None if None in counts else sum(counts),
            identical_to=[],
        ), edges

    fastest = route("cost_fast")
    visibility = route("cost_vis")
    practical = route("cost_practical")
    cap = config.PRACTICAL_MAX_DETOUR * fastest[0]["length_m"]
    for alpha in config.PRACTICAL_ALPHA_FALLBACK:
        if practical[0]["length_m"] <= cap:
            break
        practical = route("cost_practical", alpha)
    if practical[0]["length_m"] > cap:
        practical = (dict(fastest[0]), fastest[1])
    results = {"Fastest": fastest, "Visibility-Optimized": visibility, "Practical": practical}
    for name, (result, edges) in results.items():
        result["identical_to"] = [other for other, (_, path) in results.items() if other != name and path == edges]
    return {name: result for name, (result, _) in results.items()}
