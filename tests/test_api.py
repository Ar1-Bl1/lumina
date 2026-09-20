"""Offline API contract tests; synthetic resources never download map data."""

import json
from unittest.mock import Mock

import networkx as nx
import pytest
from pyproj import Transformer

pytest.importorskip('fastapi', reason='FastAPI is not installed; installation was not requested')
pytest.importorskip('httpx', reason='FastAPI TestClient requires httpx')
from fastapi.testclient import TestClient

import api
import config
import strings as S
from escort import LocalJsonlSink


@pytest.fixture
def client(tmp_path, monkeypatch):
    x, y = Transformer.from_crs(4326, 32643, always_xy=True).transform(
        config.CENTER_LON, config.CENTER_LAT)
    graph = nx.MultiDiGraph(crs='EPSG:32643')
    for node, dx in enumerate((0, 120, 240, 500)):
        graph.add_node(node, x=x + dx, y=y)
    graph.add_edge(0, 1, length=120)
    graph.add_edge(1, 2, length=120)
    (tmp_path / 'graph_walk.graphml').touch()
    mock_path = tmp_path / 'mock.json'
    mock_path.write_text(json.dumps({'risk_hotspots': [
        {'lat': config.CENTER_LAT, 'lon': config.CENTER_LON, 'density': 1}],
        'broken_lights': [{'lat': config.CENTER_LAT, 'lon': config.CENTER_LON}]}))
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(config, 'MOCK_DATA_PATH', mock_path)
    monkeypatch.setattr(config, 'WEBHOOK_URL', None)
    monkeypatch.setattr(api.ox, 'graph_from_point', Mock(side_effect=AssertionError('Network forbidden')))
    load = Mock(return_value=graph)
    monkeypatch.setattr(api.ox, 'load_graphml', load)
    monkeypatch.setattr(api.ox, 'project_graph', lambda graph: graph)
    build = Mock(wraps=api.build_chunks)
    score = Mock(wraps=api.score_chunks)
    monkeypatch.setattr(api, 'build_chunks', build)
    monkeypatch.setattr(api, 'score_chunks', score)
    sink = LocalJsonlSink(tmp_path / 'telemetry.jsonl')
    monkeypatch.setattr(api, 'LocalJsonlSink', lambda: sink)
    with TestClient(api.app) as session:
        session.load, session.build, session.score, session.sink = load, build, score, sink
        session.positions = [Transformer.from_crs(32643, 4326, always_xy=True)
                             .transform(x + dx, y)[::-1] for dx in (0, 120, 240, 500)]
        yield session


def params(client, end=2, **extra):
    start_lat, start_lon = client.positions[0]
    end_lat, end_lon = client.positions[end]
    return dict(start_lat=start_lat, start_lon=start_lon, end_lat=end_lat,
                end_lon=end_lon, hour=22, mode='walk') | extra


def test_config(client):
    response = client.get('/config')
    assert response.status_code == 200
    body = response.json()
    for key in ('ROUTE_FASTEST_LABEL', 'ROUTE_PRACTICAL_LABEL', 'ROUTE_VIS_LABEL',
                'TOS_BODY', 'ESCORT_BANNER', 'EYES_UP_BODY', 'EYES_UP_AUDIO_CUE'):
        assert body['strings'][key] == getattr(S, key)
    for key in ('ESCORT_THRESHOLD', 'POLL_NORMAL_S', 'POLL_ESCORT_S', 'EYES_UP_DELAY_S'):
        assert body['constants'][key] == getattr(config, key)
    assert body['default_start'] == list(config.DEFAULT_START)
    assert body['default_end'] == list(config.DEFAULT_END)
    assert body['map_center'] == [config.CENTER_LAT, config.CENTER_LON]


def test_routes_and_hour_cache(client):
    response = client.get('/routes', params=params(client))
    assert response.status_code == 200
    routes = response.json()['routes']
    assert [r['id'] for r in routes] == ['fastest', 'practical', 'visibility']
    assert [r['color'] for r in routes] == ['#e53935', '#ffb300', '#1e88ff']
    assert [r['name'] for r in routes] == [S.ROUTE_FASTEST_LABEL, S.ROUTE_PRACTICAL_LABEL, S.ROUTE_VIS_LABEL]
    for route in routes:
        assert route['coords'][0] == pytest.approx(client.positions[0])
        assert route['coords'][-1] == pytest.approx(client.positions[2])
        assert route['length_m'] == 240
        assert route['eta_min'] == pytest.approx(2.88)
        assert route['n_low_segments'] == 1
        assert route['min_score'] < route['mean_score']
        assert route['needs_escort'] is True
    assert client.get('/overlay', params={'hour': 22}).status_code == 200
    run = client.get('/routes', params=params(client, mode='run')).json()['routes'][0]
    assert run['eta_min'] == pytest.approx(1.44)
    assert client.score.call_count == 1
    client.get('/overlay', params={'hour': 12})
    assert client.get('/routes', params=params(client)).json()['routes'] == routes
    assert client.score.call_count == 2
    assert client.load.call_count == client.build.call_count == 1


def test_overlay(client):
    response = client.get('/overlay', params={'hour': 22})
    assert response.status_code == 200
    body = response.json()
    assert body['type'] == 'FeatureCollection'
    assert len(body['features']) == 2
    feature = body['features'][0]
    assert feature['geometry']['type'] == 'LineString'
    assert feature['geometry']['coordinates'][0] == pytest.approx(client.positions[0])
    assert 0.1 <= feature['properties']['mean_score'] <= 100


@pytest.mark.parametrize('extra', [dict(start_lat=91), dict(start_lon='nan'),
                                 dict(end_lon=181), dict(hour=24), dict(mode='car'),
                                 dict(start_lat=0, start_lon=0)])
def test_bad_route_input(client, extra):
    response = client.get('/routes', params=params(client, **extra))
    assert response.status_code == 400
    assert response.json()['detail']


def test_disconnected_and_same_node(client):
    response = client.get('/routes', params=params(client, end=3))
    assert response.status_code == 404
    assert response.json()['detail'] == S.ERR_NO_ROUTE
    route = client.get('/routes', params=params(client, end=0)).json()['routes'][0]
    assert route['length_m'] == 0
    assert route['min_score'] is None
    assert route['needs_escort'] is False


@pytest.mark.parametrize('active', [False, True])
def test_telemetry(client, active):
    lat, lon = client.positions[0]
    response = client.post('/telemetry', json=dict(lat=lat, lon=lon, route_id='fastest', escort_active=active))
    assert response.status_code == 200
    record = json.loads(client.sink.path.read_text())
    assert record['lat'] == lat and record['lon'] == lon
    assert record['route_id'] == 'fastest' and record['node_id'] == 0
    assert isinstance(record['is_night'], bool)
    assert record['ts']
    assert record['poll_interval_s'] == (config.POLL_ESCORT_S if active else config.POLL_NORMAL_S)


def test_notify(client, monkeypatch):
    notify = Mock(wraps=api.notify_contact)
    monkeypatch.setattr(api, 'notify_contact', notify)
    response = client.post('/notify', json={'phone': '+911234567890', 'route_id': 'route/1'})
    assert response.status_code == 200
    assert response.json() == {'tracking_link': 'https://lumina.example/track/route%2F1'}
    notify.assert_called_once_with('+911234567890', 'route/1')


@pytest.mark.parametrize('origin,allowed', [('http://localhost:5173', True),
    ('http://127.0.0.1:43210', True), ('https://example.com', False),
    ('http://localhost:5173.example.com', False)])
def test_cors(client, origin, allowed):
    response = client.options('/telemetry', headers={'Origin': origin,
        'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type'})
    assert (response.headers.get('access-control-allow-origin') == origin) is allowed


def test_missing_cache_never_downloads(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    load = Mock(side_effect=AssertionError('No graph should load'))
    monkeypatch.setattr(api.ox, 'load_graphml', load)
    with pytest.raises(FileNotFoundError, match='Cached graph required'):
        with TestClient(api.app):
            pass
    load.assert_not_called()
