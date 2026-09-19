"""Small offline, projected grid compatible with the normal graph pipeline."""
import networkx as nx
from pyproj import CRS, Transformer
from shapely.geometry import LineString

import config


def build_demo_graph() -> nx.MultiDiGraph:
    """Cover the configured endpoints with a bidirectional 9 by 9 grid."""
    zone = int((config.CENTER_LON + 180) / 6) + 1
    crs = CRS.from_epsg((32600 if config.CENTER_LAT >= 0 else 32700) + zone)
    project = Transformer.from_crs(4326, crs, always_xy=True)
    endpoints = [project.transform(lon, lat) for lat, lon in
                 (config.DEFAULT_START, config.DEFAULT_END)]
    xmin, ymin = [min(p[i] for p in endpoints) - 150 for i in (0, 1)]
    xmax, ymax = [max(p[i] for p in endpoints) + 150 for i in (0, 1)]
    graph = nx.MultiDiGraph(crs=crs, simplified=True)
    for row in range(9):
        for col in range(9):
            node = row * 9 + col
            graph.add_node(node, x=xmin + col * (xmax - xmin) / 8,
                           y=ymin + row * (ymax - ymin) / 8, osmid=node)
    for row in range(9):
        for col in range(9):
            u = row * 9 + col
            for v in ([u + 1] if col < 8 else []) + ([u + 9] if row < 8 else []):
                for a, b in ((u, v), (v, u)):
                    line = LineString([(graph.nodes[n]['x'], graph.nodes[n]['y'])
                                       for n in (a, b)])
                    graph.add_edge(a, b, key=0, length=line.length, geometry=line,
                                   osmid=a * 100 + b, highway='residential', oneway=False)
    return graph
