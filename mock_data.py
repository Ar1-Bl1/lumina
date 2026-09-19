"""mock_data.py – Generates data/mock.json with realistic OSM-anchored features.

The DEMO INVARIANT is encoded in ``_plant_demo_features``:
  - A "dark corridor" (broken lights + alert + risk hotspot) is placed on the
    middle third of the fastest walk path between the default start and end.
  - A "lively street" (24h stores, transit, crowd) is placed on a parallel
    alternative path, so the 3 routes visibly diverge and the fastest route
    triggers Escort Mode.

All coordinates jitter ≤ 20 m from real OSM node positions.
"""

from __future__ import annotations

import json
import math
import random
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import networkx as nx
import osmnx as ox

from config import (
    CENTER_LAT,
    CENTER_LON,
    CHUNK_SIZE_M,
    DATA_DIR,
    DEFAULT_END,
    DEFAULT_START,
    GRAPH_RADIUS_M,
    MOCK_DATA_PATH,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_RNG = random.Random()  # seeded per-call


def _jitter_latlon(
    lat: float, lon: float, max_m: float = 18.0, rng: random.Random = _RNG
) -> tuple[float, float]:
    """Displace (lat, lon) by ≤ max_m metres in a random direction."""
    bearing = rng.uniform(0, 2 * math.pi)
    dist_m = rng.uniform(0, max_m)
    # Approximate: 1° lat ≈ 111 320 m, 1° lon ≈ 111 320 * cos(lat)
    dlat = (dist_m * math.cos(bearing)) / 111_320
    dlon = (dist_m * math.sin(bearing)) / (111_320 * math.cos(math.radians(lat)))
    return round(lat + dlat, 7), round(lon + dlon, 7)


def _node_latlons(G: nx.MultiDiGraph) -> list[tuple[float, float]]:
    """Return list of (lat, lon) for every node in G."""
    return [(data["y"], data["x"]) for _, data in G.nodes(data=True)]


def _sample_nodes(
    G: nx.MultiDiGraph, n: int, rng: random.Random
) -> list[tuple[float, float]]:
    """Sample n distinct node positions (jittered ≤ 18 m)."""
    all_nodes = _node_latlons(G)
    chosen = rng.sample(all_nodes, min(n, len(all_nodes)))
    return [_jitter_latlon(lat, lon, rng=rng) for lat, lon in chosen]


def _hhmm(h: int, m: int = 0) -> str:
    return f"{h:02d}:{m:02d}"


def _midpoint(coords: list[tuple[float, float]]) -> tuple[float, float]:
    lats = [c[0] for c in coords]
    lons = [c[1] for c in coords]
    return (sum(lats) / len(lats), sum(lons) / len(lons))


def _path_coords(G: nx.MultiDiGraph, path: list[int]) -> list[tuple[float, float]]:
    """Return (lat, lon) for each node in *path*."""
    return [(G.nodes[n]["y"], G.nodes[n]["x"]) for n in path]


def _middle_third(
    coords: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    n = len(coords)
    lo = n // 3
    hi = 2 * n // 3
    return coords[lo : hi + 1] if hi > lo else coords[lo : lo + 1]


# ---------------------------------------------------------------------------
# DEMO INVARIANT helpers
# ---------------------------------------------------------------------------

def _fastest_path_nodes(
    G: nx.MultiDiGraph,
) -> list[int] | None:
    """Return node list of the shortest (length-weighted) path between defaults."""
    try:
        src = ox.distance.nearest_nodes(G, DEFAULT_START[1], DEFAULT_START[0])
        dst = ox.distance.nearest_nodes(G, DEFAULT_END[1], DEFAULT_END[0])
        return nx.astar_path(G, src, dst, weight="length")
    except Exception:
        return None


def _alternative_path_nodes(
    G: nx.MultiDiGraph, fastest_nodes: set[int]
) -> list[int] | None:
    """Find a path from default start → end that shares ≤ 20% nodes with the fastest."""
    try:
        src = ox.distance.nearest_nodes(G, DEFAULT_START[1], DEFAULT_START[0])
        dst = ox.distance.nearest_nodes(G, DEFAULT_END[1], DEFAULT_END[0])

        # penalise nodes on the fastest path to force divergence
        G2 = G.copy()
        for n in fastest_nodes:
            if n in G2 and n not in (src, dst):
                for u, v, k, d in list(G2.edges(n, data=True, keys=True)):
                    G2[u][v][k]["_alt_length"] = d.get("length", 50) * 100
                for u, v, k, d in list(G2.in_edges(n, data=True, keys=True)):
                    G2[u][v][k]["_alt_length"] = d.get("length", 50) * 100

        return nx.astar_path(G2, src, dst, weight="_alt_length")
    except Exception:
        return None


def _plant_demo_features(
    G: nx.MultiDiGraph,
    stores: list[dict],
    stops: list[dict],
    lights: list[dict],
    alerts: list[dict],
    hotspots: list[dict],
    crowd: list[dict],
    rng: random.Random,
) -> None:
    """Mutate feature lists to produce 3 visually distinct routes."""
    # ---- dark corridor on fastest path ----
    fastest = _fastest_path_nodes(G)
    if fastest:
        mid3 = _middle_third(_path_coords(G, fastest))
        for lat, lon in mid3:
            jlat, jlon = _jitter_latlon(lat, lon, max_m=5, rng=rng)
            lights.append({"lat": jlat, "lon": jlon})
            hotspots.append({"lat": jlat, "lon": jlon, "density": rng.uniform(0.75, 1.0)})

        # plant one high-severity alert at the midpoint
        mlat, mlon = _midpoint(mid3)
        alerts.insert(
            0,
            {
                "text": "Street harassment reported near underpass, avoid after dark",
                "lat": mlat,
                "lon": mlon,
                "timestamp_iso": datetime.now(timezone.utc)
                .replace(microsecond=0)
                .isoformat(),
            },
        )

    # ---- lively street on alternative path ----
    alt = _alternative_path_nodes(G, set(fastest or []))
    if alt:
        alt_coords = _path_coords(G, alt)
        for lat, lon in alt_coords[::3]:  # every 3rd node
            jlat, jlon = _jitter_latlon(lat, lon, max_m=5, rng=rng)
            stores.append(
                {
                    "lat": jlat,
                    "lon": jlon,
                    "name": f"24h Mart @ {jlat:.4f}",
                    "open": "00:00",
                    "close": "00:00",
                    "is_24h": True,
                }
            )
            stops.append(
                {
                    "lat": jlat,
                    "lon": jlon,
                    "next_arrivals_min": [rng.randint(1, 12) for _ in range(3)],
                }
            )
            # dense crowd throughout the day on this corridor
            hourly = [round(rng.uniform(0.6, 1.0), 2) for _ in range(24)]
            crowd.append({"lat": jlat, "lon": jlon, "hourly": hourly})


# ---------------------------------------------------------------------------
# Feature generators
# ---------------------------------------------------------------------------

def _gen_stores(
    nodes: list[tuple[float, float]], rng: random.Random
) -> list[dict]:
    stores: list[dict] = []
    sampled = rng.sample(nodes, min(55, len(nodes)))
    for i, (lat, lon) in enumerate(sampled):
        is_24h = rng.random() < 0.15
        if is_24h:
            entry: dict[str, Any] = {
                "lat": lat,
                "lon": lon,
                "name": f"All-Night Store {i}",
                "open": "00:00",
                "close": "00:00",
                "is_24h": True,
            }
        else:
            open_h = rng.randint(6, 9)
            close_h = rng.randint(20, 23)
            entry = {
                "lat": lat,
                "lon": lon,
                "name": f"Store {i}",
                "open": _hhmm(open_h),
                "close": _hhmm(close_h),
                "is_24h": False,
            }
        stores.append(entry)
    return stores


def _gen_transit(
    nodes: list[tuple[float, float]], rng: random.Random
) -> list[dict]:
    sampled = rng.sample(nodes, min(25, len(nodes)))
    return [
        {
            "lat": lat,
            "lon": lon,
            "next_arrivals_min": sorted(
                [rng.randint(1, 30) for _ in range(rng.randint(2, 4))]
            ),
        }
        for lat, lon in sampled
    ]


def _gen_broken_lights(
    nodes: list[tuple[float, float]], rng: random.Random
) -> list[dict]:
    sampled = rng.sample(nodes, min(35, len(nodes)))
    return [{"lat": lat, "lon": lon} for lat, lon in sampled]


_ALERT_TEMPLATES = [
    "Suspicious activity near the bus stop, stay alert",
    "Pothole and broken pavement reported on footpath",
    "Stray dog sighting, approach with caution",
    "Road work causing reduced visibility at night",
    "Isolated stretch reported, avoid late hours",
    "Flooding on footpath after heavy rain",
    "Verbal altercation reported near ATM",
    "Broken street lights on underpass stretch",
    "Crowd dispersal in progress, minor disruption",
    "Slippery surface near market area",
]


def _gen_alerts(
    nodes: list[tuple[float, float]], rng: random.Random
) -> list[dict]:
    sampled = rng.sample(nodes, min(9, len(nodes)))
    now = datetime.now(timezone.utc)
    alerts = []
    for i, (lat, lon) in enumerate(sampled):
        age_h = rng.uniform(0.5, 48)
        ts = datetime.fromtimestamp(
            now.timestamp() - age_h * 3600, tz=timezone.utc
        ).replace(microsecond=0)
        alerts.append(
            {
                "text": rng.choice(_ALERT_TEMPLATES),
                "lat": lat,
                "lon": lon,
                "timestamp_iso": ts.isoformat(),
            }
        )
    return alerts


def _gen_hotspots(
    nodes: list[tuple[float, float]], rng: random.Random
) -> list[dict]:
    sampled = rng.sample(nodes, min(20, len(nodes)))
    return [
        {"lat": lat, "lon": lon, "density": round(rng.uniform(0.05, 0.85), 3)}
        for lat, lon in sampled
    ]


def _gen_crowd(
    nodes: list[tuple[float, float]], rng: random.Random
) -> list[dict]:
    sampled = rng.sample(nodes, min(20, len(nodes)))
    crowd = []
    for lat, lon in sampled:
        # realistic crowd pattern: peaks at 9 AM and 6 PM
        hourly = []
        for h in range(24):
            if 8 <= h <= 10:
                v = rng.uniform(0.5, 0.9)
            elif 17 <= h <= 19:
                v = rng.uniform(0.55, 0.95)
            elif 0 <= h <= 5:
                v = rng.uniform(0.0, 0.2)
            else:
                v = rng.uniform(0.1, 0.5)
            hourly.append(round(v, 3))
        crowd.append({"lat": lat, "lon": lon, "hourly": hourly})
    return crowd


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def generate_mock(G: nx.MultiDiGraph, seed: int = 42) -> dict:
    """Generate mock feature data anchored to OSM node positions in *G*.

    Writes the result to ``data/mock.json`` and returns the dict.

    Parameters
    ----------
    G:
        An OSMnx MultiDiGraph (unprojected, lat/lon).
    seed:
        Random seed for reproducibility.

    Returns
    -------
    dict
        Keys: ``active_stores``, ``transit_stops``, ``broken_lights``,
        ``recent_alerts``, ``risk_hotspots``, ``crowd``.
    """
    _RNG.seed(seed)
    rng = _RNG

    nodes = _sample_nodes(G, n=300, rng=rng)  # pool large enough to sample from

    stores = _gen_stores(nodes, rng)
    stops = _gen_transit(nodes, rng)
    lights = _gen_broken_lights(nodes, rng)
    alerts = _gen_alerts(nodes, rng)
    hotspots = _gen_hotspots(nodes, rng)
    crowd = _gen_crowd(nodes, rng)

    # --- DEMO INVARIANT: plant dark corridor + lively street ---
    _plant_demo_features(G, stores, stops, lights, alerts, hotspots, crowd, rng)

    payload = {
        "active_stores": stores,
        "transit_stops": stops,
        "broken_lights": lights,
        "recent_alerts": alerts,
        "risk_hotspots": hotspots,
        "crowd": crowd,
    }

    MOCK_DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    MOCK_DATA_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def load_mock() -> dict:
    """Load mock data from disk (generate if missing)."""
    if not MOCK_DATA_PATH.exists():
        raise FileNotFoundError(
            f"{MOCK_DATA_PATH} not found. Run `generate_mock(G)` first."
        )
    return json.loads(MOCK_DATA_PATH.read_text(encoding="utf-8"))
