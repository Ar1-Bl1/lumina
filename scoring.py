"""scoring.py – Segment scoring for Lumina.

Phase 1 stub: exposes pure helper functions so tests pass immediately.
Full vectorised implementation lands in Phase 2 (graph.py + geopandas sjoin).

Public API (all pure, no side-effects):
  clamp_score(raw) -> float
  edge_chunk_cost(chunk_len, score, alpha) -> float
  score_chunks(chunks_gdf, mock_data, query_hour, center_latlon) -> GeoDataFrame
"""

from __future__ import annotations

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
# score_chunks is imported by Phase-2 tests; stubbed here so Phase-1 imports work.

def score_chunks(chunks_gdf, mock_data: dict, query_hour: int, center_latlon=None):  # type: ignore[return]
    """Score every chunk GeoDataFrame row given mock feature data.

    Full implementation in Phase 2.  This stub raises NotImplementedError
    so Phase-2 tests correctly fail until the implementation is added.
    """
    raise NotImplementedError("score_chunks: implemented in Phase 2")
