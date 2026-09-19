"""Try several Overpass servers / radii until the map downloads and caches."""
import os, time
import osmnx as ox
import config, graph

SERVERS = [
    "https://overpass-api.de/api",
    "https://overpass.kumi.systems/api",
    "https://overpass.private.coffee/api",
]
RADII = [1500, 1000, 700]
CACHE = os.path.join("data", "graph_walk.graphml")


def set_first(obj, names, value):
    for n in names:
        if hasattr(obj, n):
            setattr(obj, n, value)
            return n


radius_names = [n for n in dir(config)
                if n.isupper() and any(k in n for k in ("RADIUS", "DIST"))]
print("Radius setting(s) found in config.py:", radius_names)

ox.settings.log_console = True
set_first(ox.settings, ["requests_timeout", "timeout"], 300)

for radius in RADII:
    for n in radius_names:
        setattr(config, n, radius)
    for server in SERVERS:
        set_first(ox.settings, ["overpass_url", "overpass_endpoint"], server)
        if os.path.exists(CACHE):
            os.remove(CACHE)
        print(f"\n=== radius {radius} m via {server} ===")
        t = time.time()
        try:
            G = graph.load_graph()
            chunks = graph.build_chunks(G)
        except Exception as e:
            print("FAILED:", type(e).__name__, str(e)[:200])
            continue
        print(f"SUCCESS in {time.time() - t:.0f}s: {len(G.edges)} edges, {len(chunks)} chunks")
        print(f"Cached at {CACHE}. Now set the radius in config.py to {radius}.")
        raise SystemExit

print("\nAll attempts failed. Try a phone hotspot or another laptop.")