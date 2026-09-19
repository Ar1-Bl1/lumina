"""Offline scoring tests using synthetic graphs and feature records."""
from datetime import datetime
from math import exp

import geopandas as gpd
import networkx as nx
import pytest
from pyproj import Transformer
from shapely.geometry import Point

import config
from graph import build_chunks
import scoring


def at(hour):
    return datetime(2026, 9, 20, hour, tzinfo=scoring.LOCAL_TZ)


@pytest.fixture
def sample():
    x, y = Transformer.from_crs(4326, 32643, always_xy=True).transform(77.6011, 12.9757)
    graph = nx.MultiDiGraph(crs="EPSG:32643")
    graph.add_node(0, x=x, y=y)
    graph.add_node(1, x=x + 80, y=y)
    graph.add_edge(0, 1, key=0, length=80)
    return graph, build_chunks(graph)


def feature(chunks, **fields):
    point = chunks.to_crs(4326).geometry.iloc[0]
    return dict(lat=point.y, lon=point.x, **fields)


def test_cost_and_clamps():
    assert scoring.edge_chunk_cost(50, 10, 50) == 300
    assert scoring.clamp_score(-100) == 0.1
    assert scoring.clamp_score(101) == 100


@pytest.mark.parametrize("category,fields,expected", [
    ("active_stores", {"is_24h": True}, 65),
    ("transit_stops", {"next_arrivals_min": [15]}, 60),
    ("broken_lights", {}, 30),
    ("recent_alerts", {"text": "alert", "timestamp_iso": at(23).isoformat()}, 40),
    ("risk_hotspots", {"density": 0.8}, 34),
    ("crowd", {"hourly": [0.6] * 24}, 60),
    ("crowd", {"hourly": [0.15] * 24}, 45),
])
def test_categories_do_not_stack(sample, monkeypatch, category, fields, expected):
    graph, chunks = sample
    monkeypatch.setattr(scoring, "classify_alert", lambda _: {"penalty": -10})
    record = feature(chunks, **fields)
    scoring.score_graph(graph, chunks, {category: [record, record.copy()]}, at(23))
    assert graph.edges[0, 1, 0]["mean_score"] == pytest.approx(expected)


@pytest.mark.parametrize("hour,expected", [(23, 65), (1, 65), (2, 50), (12, 50), (22, 65)])
def test_overnight_store(sample, hour, expected):
    graph, chunks = sample
    mock = {"active_stores": [feature(chunks, open="22:00", close="02:00", is_24h=False)]}
    scoring.score_graph(graph, chunks, mock, at(hour))
    assert graph.edges[0, 1, 0]["mean_score"] == expected


def test_day_night_rescore_without_download(sample, monkeypatch):
    import osmnx as ox
    monkeypatch.setattr(ox, "graph_from_point", lambda *a, **k: pytest.fail("Graph download attempted"))
    graph, chunks = sample
    mock = {"broken_lights": [feature(chunks)]}
    assert scoring.score_graph(graph, chunks, mock, at(12)) is graph
    assert graph.edges[0, 1, 0]["mean_score"] == 44

    scoring.score_graph(graph, chunks, mock, at(23))
    assert graph.edges[0, 1, 0]["mean_score"] == 30


def test_alert_selects_worst_raw_penalty_then_decays(sample, monkeypatch):
    graph, chunks = sample
    monkeypatch.setattr(scoring, "classify_alert", lambda text: {"penalty": -50 if text == "old" else -10})
    mock = {"recent_alerts": [
        feature(chunks, text="old", timestamp_iso=at(11).isoformat()),
        feature(chunks, text="new", timestamp_iso=at(23).isoformat()),
    ]}
    scoring.score_graph(graph, chunks, mock, at(23))
    assert graph.edges[0, 1, 0]["mean_score"] == pytest.approx(50 - 50 * exp(-2))


def test_score_floor(sample, monkeypatch):
    graph, chunks = sample
    monkeypatch.setattr(scoring, "classify_alert", lambda _: {"penalty": -50})
    mock = {"broken_lights": [feature(chunks)], "recent_alerts": [feature(chunks, text="alert", timestamp_iso=at(23).isoformat())]}
    scoring.score_graph(graph, chunks, mock, at(23))
    assert graph.edges[0, 1, 0]["min_score"] == 0.1


def test_spatial_matching_weighted_aggregation_and_parallel_edges(sample):
    graph, original = sample
    first = original.geometry.iloc[0]
    chunks = gpd.GeoDataFrame([
        (0, 1, 0, 0, 20, first),
        (0, 1, 0, 1, 60, Point(first.x + 200, first.y)),
        (0, 1, 1, 0, 10, first),
    ], columns=["edge_u", "edge_v", "edge_key", "chunk_idx", "chunk_len", "geometry"], crs=original.crs, index=[7, 7, 9])
    graph.add_edge(0, 1, key=1, length=10)
    mock = {"active_stores": [feature(chunks, is_24h=True)]}
    scoring.score_graph(graph, chunks, mock, at(23))
    edge = graph.edges[0, 1, 0]
    assert edge["cost_fast"] == 80
    assert edge["min_score"] == 50
    assert edge["mean_score"] == (20 * 65 + 60 * 50) / 80
    for name, alpha in [("practical", config.ALPHA_PRACTICAL), ("vis", config.ALPHA_VIS)]:
        assert edge[f"cost_{name}"] == pytest.approx(20 * (1 + alpha / 65) + 60 * (1 + alpha / 50))
    assert graph.edges[0, 1, 1]["mean_score"] == 65


def test_risk_and_crowd_use_maximum(sample):
    graph, chunks = sample
    mock = {
        "risk_hotspots": [feature(chunks, density=d) for d in (0.2, 0.8)],
        "crowd": [feature(chunks, hourly=[d] * 24) for d in (0.1, 0.8)],
        "transit_stops": [feature(chunks, next_arrivals_min=[16, 30])],
    }
    scoring.score_graph(graph, chunks, mock, at(23))
    assert graph.edges[0, 1, 0]["mean_score"] == 44

@pytest.fixture
def routing_graph(monkeypatch):
    import osmnx as ox
    monkeypatch.setattr(ox, "graph_from_point", lambda *a, **k: pytest.fail("Graph download attempted"))
    network = nx.MultiDiGraph(crs="EPSG:32643")
    x, y = Transformer.from_crs(4326, 32643, always_xy=True).transform(77.6011, 12.9757)
    for node, dx, dy in [(0, 0, 0), (1, 40, 0), (2, 40, 30), (3, 80, 0)]:
        network.add_node(node, x=x + dx, y=y + dy)
    for u, v, length, score in [(0, 1, 50, 10), (1, 3, 50, 10), (0, 2, 70, 90), (2, 3, 70, 90)]:
        network.add_edge(u, v, length=length, mean_score=score, min_score=score,
                         chunks=[{"chunk_len": length / 2, "score": score}] * 2,
                         **{f"cost_{name}": scoring.edge_chunk_cost(length, score, alpha)
                            for name, alpha in [("fast", 0), ("vis", config.ALPHA_VIS), ("practical", config.ALPHA_PRACTICAL)]})
    transform = Transformer.from_crs(network.graph["crs"], 4326, always_xy=True)
    coords = {n: tuple(reversed(transform.transform(d["x"], d["y"]))) for n, d in network.nodes(data=True)}
    return network, coords


def test_routing_choices_metrics_and_detour(routing_graph):
    from routing import find_routes
    network, coords = routing_graph
    routes = find_routes(network, coords[0], coords[3], "walk")
    fast, vis, practical = (routes[n] for n in ("Fastest", "Visibility-Optimized", "Practical"))
    assert fast["length_m"] <= vis["length_m"]
    assert fast["length_m"] <= practical["length_m"]
    assert vis["mean_score"] >= fast["mean_score"]
    assert vis["coords"] == [coords[0], coords[2], coords[3]]
    assert practical["length_m"] <= config.PRACTICAL_MAX_DETOUR * fast["length_m"]
    assert fast["eta_min"] == pytest.approx(1.2)
    assert fast["min_score"] == 10
    assert fast["n_low_segments"] == 4
    assert vis["n_low_segments"] == 0
    assert fast["identical_to"] == ["Practical"]
    assert practical["identical_to"] == ["Fastest"]


@pytest.mark.parametrize("dark_score,expected_alphas", [(10, [10, 5, 2]), (15, [10, 5]), (20, [10]), (0.1, [10, 5, 2])])
def test_practical_retries_and_fallback(routing_graph, monkeypatch, dark_score, expected_alphas):
    import routing
    network, coords = routing_graph
    for u, v in [(0, 1), (1, 3)]:
        edge = network.edges[u, v, 0]
        edge.update(mean_score=dark_score, min_score=dark_score,
                    chunks=[{"chunk_len": 50, "score": dark_score}])
        edge["cost_vis"] = scoring.edge_chunk_cost(50, dark_score, config.ALPHA_VIS)
        edge["cost_practical"] = scoring.edge_chunk_cost(50, dark_score, config.ALPHA_PRACTICAL)
    original = routing._practical_cost
    calls = []
    def record(data, alpha):
        if alpha not in calls:
            calls.append(alpha)
        return original(data, alpha)
    monkeypatch.setattr(routing, "_practical_cost", record)
    before = {(u, v, k): dict(d) for u, v, k, d in network.edges(keys=True, data=True)}
    routes = routing.find_routes(network, coords[0], coords[3], "run")
    assert calls == expected_alphas
    assert routes["Practical"]["length_m"] == 100
    assert routes["Fastest"]["eta_min"] == pytest.approx(0.6)
    assert before == {(u, v, k): dict(d) for u, v, k, d in network.edges(keys=True, data=True)}


def test_parallel_edge_selection_and_identity(routing_graph):
    from routing import find_routes
    network, coords = routing_graph
    network.remove_node(2)
    network.add_edge(0, 1, key=1, length=60, mean_score=90, min_score=90,
                     chunks=[{"chunk_len": 60, "score": 90}], cost_fast=60,
                     cost_vis=scoring.edge_chunk_cost(60, 90, config.ALPHA_VIS),
                     cost_practical=scoring.edge_chunk_cost(60, 90, config.ALPHA_PRACTICAL))
    routes = find_routes(network, coords[0], coords[3], "bike")
    assert routes["Fastest"]["length_m"] == 100
    assert routes["Visibility-Optimized"]["length_m"] == 110
    assert routes["Visibility-Optimized"]["mean_score"] == pytest.approx((60 * 90 + 50 * 10) / 110)
    assert routes["Visibility-Optimized"]["n_low_segments"] == 2
    assert routes["Fastest"]["identical_to"] == []
    network.remove_edge(0, 1, 1)
    routes = find_routes(network, coords[0], coords[3], "bike")
    assert all(len(r["identical_to"]) == 2 for r in routes.values())


def test_route_empty_and_disconnected(routing_graph):
    from routing import find_routes
    network, coords = routing_graph
    routes = find_routes(network, coords[0], coords[0], "walk")
    assert all(r["length_m"] == 0 and r["coords"] == [coords[0]] and r["n_low_segments"] == 0 for r in routes.values())
    with pytest.raises(nx.NetworkXNoPath):
        find_routes(network, coords[3], coords[0], "walk")


def test_aggregate_cost_recovery_and_unknown_chunk_count():
    from routing import _low_count, _practical_cost
    data = dict(length=100, mean_score=50, min_score=10,
                cost_vis=scoring.edge_chunk_cost(25, 10, config.ALPHA_VIS) + scoring.edge_chunk_cost(75, 90, config.ALPHA_VIS))
    assert _practical_cost(data, 5) == pytest.approx(scoring.edge_chunk_cost(25, 10, 5) + scoring.edge_chunk_cost(75, 90, 5))
    assert _low_count(data) is None

