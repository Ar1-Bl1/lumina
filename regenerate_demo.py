"""Rebuild the dense real-map demo using only the existing walking cache."""
from datetime import datetime
import json
from math import ceil

import networkx as nx
from pyproj import Transformer
from shapely.geometry import LineString, Point

import config
from graph import load_graph, nearest_node
from scoring import LOCAL_TZ


def main() -> None:
    if not (config.DATA_DIR / "graph_walk.graphml").is_file():
        raise FileNotFoundError("Cached walking map required")
    graph = load_graph()
    source, target = [nearest_node(graph, *p) for p in (config.DEFAULT_START, config.DEFAULT_END)]
    fast = nx.shortest_path(graph, source, target, weight="length")
    fast_pairs = set(zip(fast, fast[1:]))
    def length(path):
        return sum(min(d['length'] for d in graph[u][v].values()) for u, v in zip(path, path[1:]))
    def samples(path):
        points = []
        offset = 0
        for u, v in zip(path, path[1:]):
            d = min(graph[u][v].values(), key=lambda d: d['length'])
            line = d.get('geometry', LineString([(graph.nodes[n]['x'], graph.nodes[n]['y']) for n in (u, v)]))
            if line.interpolate(0).distance(Point(graph.nodes[u]['x'], graph.nodes[u]['y'])) > 1:
                line = LineString(list(line.coords)[::-1])
            count = max(1, ceil(line.length / 30))
            for i in range(count):
                distance = (i + .5) * line.length / count
                points.append((offset + distance, line.interpolate(distance)))
            offset += line.length
        return points
    project = Transformer.from_crs(graph.graph['crs'], 4326, always_xy=True)
    def position(point):
        lon, lat = project.transform(point.x, point.y)
        return dict(lat=lat, lon=lon)
    fast_length = length(fast)
    query = datetime.now(LOCAL_TZ).replace(hour=22, minute=0, second=0, microsecond=0)
    # Every edge gets a metric weight. Missing weights would default to 1.
    alt = nx.shortest_path(
        graph, source, target,
        weight=lambda u, v, ds: min(d['length'] for d in ds.values())
        * (5 if (u, v) in fast_pairs else 1),
    )
    if not 1.1 <= length(alt) / fast_length <= 1.25:
        raise RuntimeError('Cached map no longer has the expected 10-25% parallel detour')
    fast_samples, alt_samples = samples(fast), samples(alt)
    # Sample by metres along geometry, including long edges between OSM nodes.
    # The 550 m corridor begins before the parallel street branches off.
    mock = {k: [] for k in ('active_stores', 'transit_stops', 'broken_lights', 'recent_alerts', 'risk_hotspots', 'crowd')}
    dark = [(s, p) for s, p in fast_samples if .17 * fast_length <= s <= .17 * fast_length + 550]
    for _, point in dark:
        pos = position(point)
        mock['broken_lights'].append(pos)
        mock['risk_hotspots'].append(dict(pos, density=.9))
    for index in (len(dark)//3, 2*len(dark)//3):
        mock['recent_alerts'].append(dict(position(dark[index][1]), text='Street harassment reported near underpass, avoid after dark', timestamp_iso=query.isoformat()))
    for _, point in alt_samples:
        if min(point.distance(p) for _, p in dark) < 100:
            continue
        if min(point.distance(p) for _, p in fast_samples) < 60:
            continue
        pos = position(point)
        mock['active_stores'].append(dict(pos, name='Demo 24h Mart', open='00:00', close='00:00', is_24h=True))
        mock['transit_stops'].append(dict(pos, next_arrivals_min=[3, 8, 12]))
        mock['crowd'].append(dict(pos, hourly=[.85]*24))
    if not dark or dark[-1][0] - dark[0][0] < 400:
        raise RuntimeError('Dark corridor must cover at least 400 m')
    config.MOCK_DATA_PATH.write_text(json.dumps(mock, indent=2) + '\n', encoding='utf-8')
    print(f"Dark corridor: {dark[-1][0] - dark[0][0]:.0f} m; "
          f"parallel street: {length(alt):.2f} m ({length(alt)/fast_length:.3f}x fastest)")
    print('Saved features:', {key: len(records) for key, records in mock.items()})


if __name__ == '__main__':
    main()
