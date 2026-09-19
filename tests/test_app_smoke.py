"""Offline app-helper integration; existing Phase 1 tests remain untouched."""
from datetime import datetime

import config
from app import load_resources, make_map, prepare_scores
from demo_graph import build_demo_graph
from graph import build_chunks
from routing import find_routes
from scoring import LOCAL_TZ


def test_demo_pipeline():
    graph = build_demo_graph()
    chunks = build_chunks(graph)
    scored, night = prepare_scores(graph, chunks, {}, datetime(2026, 9, 20, 22, tzinfo=LOCAL_TZ))
    routes = find_routes(scored, config.DEFAULT_START, config.DEFAULT_END, 'walk')
    assert night
    assert 'mean_score' not in next(iter(graph.edges(data=True)))[2]
    assert len(routes) == 3
    assert all(r['length_m'] > 0 and r['n_low_segments'] == 0 for r in routes.values())
    assert routes['Practical']['length_m'] <= 1.25 * routes['Fastest']['length_m']
    html = make_map(scored, routes, config.DEFAULT_START, config.DEFAULT_END, True, True).get_root().render()
    assert all(color in html for color in ('#e53935', '#ffb300', '#1e88ff'))
    assert 'tile.openstreetmap.org' not in html


def test_missing_cache_never_downloads(tmp_path, monkeypatch):
    import osmnx as ox
    def forbidden(*args, **kwargs):
        raise AssertionError('Unexpected download')
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(ox, 'graph_from_point', forbidden)
    graph, chunks, mock, demo = load_resources.__wrapped__(0, 0)
    assert demo and not chunks.empty and mock
    scored, _ = prepare_scores(graph, chunks, mock, datetime(2026, 9, 20, 20, tzinfo=LOCAL_TZ))
    routes = find_routes(scored, config.DEFAULT_START, config.DEFAULT_END, 'bike')
    assert all(r['n_low_segments'] is not None for r in routes.values())
