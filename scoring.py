"""scoring.py – Segment scoring for Lumina.

Scores projected chunk midpoints and writes aggregate costs to graph edges.
"""

from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from math import exp

import geopandas as gpd
import networkx as nx
from astral import Observer
from astral.sun import sunrise, sunset
from pyproj import Transformer

import config
from nlp import classify_alert
from config import SCORE_MAX, SCORE_MIN


# ---------------------------------------------------------------------------
# Pure helpers (Phase 1)
# ---------------------------------------------------------------------------

def clamp_score(raw: float) -> float:
    """Clamp a raw score to [SCORE_MIN, SCORE_MAX] = [0.1, 100]."""
    return max(SCORE_MIN, min(SCORE_MAX, raw))


def edge_chunk_cost(chunk_len: float, score: float, alpha: float) -> float:
    """Compute travel cost for one 50 m chunk.

    Formula:  cost = chunk_len * (1 + alpha / clamped_score)

    Parameters
    ----------
    chunk_len : float
        Length of the chunk in metres.
    score : float
        Visibility score (raw; will be clamped to [0.1, 100]).
    alpha : float
        Weighting factor (ALPHA_VIS / ALPHA_PRACTICAL / ALPHA_FAST).

    Returns
    -------
    float
        Travel cost (always finite).
    """
    s = clamp_score(score)
    return chunk_len * (1.0 + alpha / s)


# ---------------------------------------------------------------------------
# Full implementation (Phase 2)
# ---------------------------------------------------------------------------
LOCAL_TZ = timezone(timedelta(hours=5, minutes=30))


def _local_time(value: datetime) -> datetime:
    """Naive timestamps represent Bengaluru local time; aware ones are converted."""
    return value.replace(tzinfo=LOCAL_TZ) if value.tzinfo is None else value.astimezone(LOCAL_TZ)


def _store_open(store: dict, query_time: datetime) -> bool:
    if store.get("is_24h", False):
        return True
    start, end = time.fromisoformat(store["open"]), time.fromisoformat(store["close"])
    current = query_time.time()
    if start > end:
        return current >= start or current < end
    return start <= current < end


def score_chunks(
    chunks_gdf: gpd.GeoDataFrame, mock_data: dict,
    query_hour: int | datetime, center_latlon: tuple[float, float] | None = None,
) -> gpd.GeoDataFrame:
    """Return scored chunks; integer hours use today's local date for compatibility.

    Alerts select the worst raw NLP penalty, then decay that alert by its age.
    Ties prefer the newest alert. Crowd uses the highest matched density.
    """
    query_time = _local_time(query_hour) if isinstance(query_hour, datetime) else datetime.now(LOCAL_TZ).replace(hour=query_hour, minute=0, second=0, microsecond=0)
    lat, lon = center_latlon or (config.CENTER_LAT, config.CENTER_LON)
    observer = Observer(latitude=lat, longitude=lon)
    dawn = sunrise(observer, date=query_time.date(), tzinfo=LOCAL_TZ)
    dusk = sunset(observer, date=query_time.date(), tzinfo=LOCAL_TZ)
    night = not dawn <= query_time < dusk
    result = chunks_gdf.copy()
    points = chunks_gdf[[chunks_gdf.geometry.name]].reset_index(drop=True)
    scores = points.geometry.apply(lambda _: float(config.SCORE_BASE))

    for category in ("active_stores", "transit_stops", "broken_lights", "recent_alerts", "risk_hotspots", "crowd"):
        records = mock_data.get(category, [])
        if not records or points.empty:
            continue
        features = gpd.GeoDataFrame(
            records, geometry=gpd.points_from_xy(
                [r["lon"] for r in records], [r["lat"] for r in records]),
            crs="EPSG:4326",
        ).to_crs(points.crs)
        if category == "active_stores":
            features["delta"] = [config.DELTA_STORE_OPEN if _store_open(r, query_time) else 0 for r in records]
        elif category == "transit_stops":
            features["delta"] = [config.DELTA_TRANSIT if any(0 <= a <= config.TRANSIT_ARRIVAL_WINDOW_MIN for a in r["next_arrivals_min"]) else 0 for r in records]
        elif category == "broken_lights":
            features["delta"] = config.DELTA_BROKEN_LIGHT * (1 if night else config.BROKEN_LIGHT_DAY_FACTOR)
        elif category == "recent_alerts":
            features["penalty"] = [classify_alert(r["text"])["penalty"] for r in records]
            ages = [max(0, (query_time - _local_time(datetime.fromisoformat(r["timestamp_iso"]))).total_seconds() / 3600) for r in records]
            features["delta"] = [p * exp(-age / config.ALERT_DECAY_HALF_LIFE_H) for p, age in zip(features["penalty"], ages)]
        elif category == "risk_hotspots":
            features["delta"] = features["density"] * config.DELTA_RISK_BASE
        else:
            features["delta"] = [r["hourly"][query_time.hour] for r in records]
        matched = gpd.sjoin(points, features, how="inner", predicate="dwithin", distance=config.MATCH_RADIUS_M)
        if matched.empty:
            continue
        if category == "recent_alerts":
            matched = matched.sort_values(["penalty", "delta"])
            delta = matched.loc[~matched.index.duplicated(), "delta"]
        else:
            grouped = matched.groupby(level=0)["delta"]
            delta = grouped.min() if category in ("broken_lights", "risk_hotspots") else grouped.max()
        if category == "crowd":
            delta = delta.apply(lambda density: config.DELTA_CROWD_HIGH if density >= config.CROWD_HIGH_THRESH else config.DELTA_CROWD_LOW if night and density <= config.CROWD_LOW_THRESH else 0)
        scores = scores.add(delta, fill_value=0)

    result["score"] = scores.clip(SCORE_MIN, SCORE_MAX).to_numpy()
    result["is_night"] = night
    for name, alpha in (("fast", 0), ("practical", config.ALPHA_PRACTICAL), ("vis", config.ALPHA_VIS)):
        result[f"cost_{name}"] = result["chunk_len"] * (1 + alpha / result["score"])
    return result


def score_graph(G: nx.MultiDiGraph, chunks: gpd.GeoDataFrame, mock: dict, query_time: datetime) -> nx.MultiDiGraph:
    """Rescore existing chunks without loading a graph or changing topology."""
    center = (config.CENTER_LAT, config.CENTER_LON)
    if G.number_of_nodes():
        xs = [data["x"] for _, data in G.nodes(data=True)]
        ys = [data["y"] for _, data in G.nodes(data=True)]
        lon, lat = Transformer.from_crs(G.graph["crs"], "EPSG:4326", always_xy=True).transform(
            (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)
        center = (lat, lon)
    scored = score_chunks(chunks, mock, query_time, center)
    for edge, group in scored.groupby(["edge_u", "edge_v", "edge_key"], sort=False):
        data = G.edges[edge]
        length = group["chunk_len"].sum()
        data.update(
            cost_fast=float(data.get("length", length)),
            cost_practical=float(group["cost_practical"].sum()),
            cost_vis=float(group["cost_vis"].sum()),
            min_score=float(group["score"].min()),
            mean_score=float((group["score"] * group["chunk_len"]).sum() / length if length else group["score"].mean()),
        )
    return G
