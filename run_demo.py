"""Print walking route statistics from the cached map at 22:00 today."""

from datetime import datetime
import json
import networkx as nx

import config
from graph import build_chunks, load_graph, nearest_node
from routing import _practical_cost
from routing import find_routes
from scoring import LOCAL_TZ, score_chunks, score_graph


def main() -> None:
    cache_path = config.DATA_DIR / "graph_walk.graphml"
    if not cache_path.is_file():
        raise FileNotFoundError(f"Cached graph required: {cache_path}")
    graph = load_graph()
    chunks = build_chunks(graph)
    with config.MOCK_DATA_PATH.open(encoding="utf-8") as handle:
        mock = json.load(handle)
    query_time = datetime.now(LOCAL_TZ).replace(
        hour=22, minute=0, second=0, microsecond=0
    )
    score_graph(graph, chunks, mock, query_time)

    # Preserve individual scores so routing can count low chunks exactly.
    from pyproj import Transformer

    xs = [data["x"] for _, data in graph.nodes(data=True)]
    ys = [data["y"] for _, data in graph.nodes(data=True)]
    lon, lat = Transformer.from_crs(
        graph.graph["crs"], "EPSG:4326", always_xy=True
    ).transform((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)
    scored = score_chunks(chunks, mock, query_time, (lat, lon))
    for edge, group in scored.groupby(["edge_u", "edge_v", "edge_key"]):
        graph.edges[edge]["chunks"] = group[["chunk_len", "score"]].to_dict("records")

    print(f"Chunks: below 30={sum(scored.score < 30)}, exactly 50={sum(scored.score == 50)}, above 60={sum(scored.score > 60)} / {len(scored)}")
    edges = list(graph.edges(data=True))
    print(f"Distinct edge costs: vis != fast {sum(d['cost_vis'] != d['cost_fast'] for _, _, d in edges)}/{len(edges)}; "
          f"vis != practical {sum(d['cost_vis'] != d['cost_practical'] for _, _, d in edges)}/{len(edges)}")
    source, target = (nearest_node(graph, *p) for p in (config.DEFAULT_START, config.DEFAULT_END))
    extreme = nx.shortest_path(graph, source, target,
        weight=lambda u, v, ds: min(_practical_cost(d, 1000) for d in ds.values()))
    extreme_length = sum(min(graph[u][v].values(), key=lambda d: _practical_cost(d, 1000))["length"]
                         for u, v in zip(extreme, extreme[1:]))
    fastest_length = nx.shortest_path_length(graph, source, target, weight="cost_fast")
    print(f"Alpha 1000: {extreme_length:.2f} m; fastest: {fastest_length:.2f} m ({extreme_length / fastest_length:.3f}x)")
    clear = nx.subgraph_view(graph, filter_edge=lambda u, v, k: graph[u][v][k]["min_score"] >= config.LOW_SEGMENT_THRESHOLD)
    try:
        clear_length = nx.shortest_path_length(clear, source, target, weight="length")
        print(f"Shortest path avoiding low chunks: {clear_length:.2f} m; within 1.4x: {clear_length <= 1.4 * fastest_length}")
    except nx.NetworkXNoPath:
        print("No path within 1.4x fastest avoids low chunks (no low-free path exists).")

    routes = find_routes(graph, config.DEFAULT_START, config.DEFAULT_END, "walk")
    print(f"{'Route':<20} {'length_m':>10} {'eta_min':>9} "
          f"{'mean_score':>11} {'min_score':>10} {'n_low_segments':>14}")
    for name, route in routes.items():
        values = [
            "N/A" if route[field] is None else f"{route[field]:.2f}"
            for field in ("length_m", "eta_min", "mean_score", "min_score")
        ]
        print(f"{name:<20} {values[0]:>10} {values[1]:>9} "
              f"{values[2]:>11} {values[3]:>10} {route['n_low_segments']:>14}")


if __name__ == "__main__":
    main()
