"""Load the walking network and sample metric chunks without changing topology."""

from __future__ import annotations

from math import ceil

import geopandas as gpd
import networkx as nx
import osmnx as ox
from pyproj import CRS, Transformer
from shapely.geometry import LineString

import config


def load_graph() -> nx.MultiDiGraph:
    """Load or download the simplified walking graph, returning UTM coordinates."""
    cache_path = config.DATA_DIR / "graph_walk.graphml"
    if cache_path.exists():
        graph = ox.load_graphml(cache_path)
    else:
        graph = ox.graph_from_point(
            (config.CENTER_LAT, config.CENTER_LON),
            dist=config.GRAPH_RADIUS_M,
            network_type="walk",
            simplify=True,
        )
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        ox.save_graphml(graph, cache_path)
    return ox.project_graph(graph)


def build_chunks(G: nx.MultiDiGraph) -> gpd.GeoDataFrame:
    """Sample equal pieces of at most CHUNK_SIZE_M along projected geometries.

    Lengths use the metric geometry, not OSMnx's pre-projection length attribute.
    Missing geometries use node endpoints; zero-length edges get one sample.
    """
    crs = CRS.from_user_input(G.graph["crs"])
    if not crs.is_projected or any(
        axis.unit_conversion_factor != 1 for axis in crs.axis_info[:2]
    ):
        raise ValueError("build_chunks requires a projected CRS with metre units")

    rows = []
    for u, v, key, data in G.edges(keys=True, data=True):
        geometry = data.get("geometry")
        if geometry is None:
            geometry = LineString(
                [(G.nodes[u]["x"], G.nodes[u]["y"]),
                 (G.nodes[v]["x"], G.nodes[v]["y"])]
            )
        count = max(1, ceil(geometry.length / config.CHUNK_SIZE_M))
        chunk_len = geometry.length / count
        for idx in range(count):
            rows.append((u, v, key, idx, chunk_len,
                         geometry.interpolate((idx + 0.5) * chunk_len)))

    return gpd.GeoDataFrame(
        rows,
        columns=["edge_u", "edge_v", "edge_key", "chunk_idx", "chunk_len", "geometry"],
        geometry="geometry",
        crs=crs,
    )


def nearest_node(G: nx.MultiDiGraph, lat: float, lon: float) -> int:
    """Snap WGS84 latitude/longitude to a node in the graph's coordinate system."""
    transformer = Transformer.from_crs("EPSG:4326", G.graph["crs"], always_xy=True)
    x, y = transformer.transform(lon, lat)
    return int(ox.distance.nearest_nodes(G, X=x, Y=y))
