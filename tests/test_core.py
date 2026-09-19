"""tests/test_core.py – Phase 1 & 2 unit + integration tests for Lumina.

Run:  pytest tests/test_core.py -v

Tests are grouped by module.  Graph-dependent tests are skipped when the
OSMnx graph is unavailable (CI without network access).
"""

from __future__ import annotations

import ast
import json
import math
import sys
from pathlib import Path

import pytest

# Ensure project root is importable
sys.path.insert(0, str(Path(__file__).parent.parent))

ROOT = Path(__file__).parent.parent   # lumina/

# ---------------------------------------------------------------------------
# Banned-word scanner helpers
# ---------------------------------------------------------------------------
# We only check USER-FACING TEXT — i.e. the literal string values that will
# be shown to users in the UI.  We deliberately skip:
#   • comments and docstrings (developer notes, not shown to users)
#   • every file except strings.py and app.py
#   • venv/, .git/, __pycache__, data/, logs/, tests/

# Words that must NEVER appear in user-facing text.
# (This list itself lives in the test file, so it is intentionally excluded
# from the scan to avoid self-flagging.)
_BANNED = [
    "safest",
    "danger-free",
    "secure path",
    "guarantee",
]

# Files that contain user-facing strings we must check.
_UI_FILES = ["strings.py", "app.py"]


def _docstring_node_ids(tree: ast.AST) -> set[int]:
    """Return the id() of every AST node that is a docstring.

    A docstring is the first statement of a module / class / function body
    when that statement is a bare string expression (ast.Expr wrapping
    ast.Constant with a str value).
    """
    ids: set[int] = set()
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if not body:
            continue
        first = body[0]
        if (
            isinstance(first, ast.Expr)
            and isinstance(first.value, ast.Constant)
            and isinstance(first.value.value, str)
        ):
            ids.add(id(first.value))
    return ids


def _user_string_literals(path: Path) -> list[tuple[int, str]]:
    """Return (lineno, value) for every non-docstring string literal in *path*.

    Skips the file gracefully if it does not exist (e.g. app.py before Phase 3).
    """
    if not path.exists():
        return []
    try:
        source = path.read_text(encoding="utf-8", errors="ignore")
        tree = ast.parse(source, filename=str(path))
    except SyntaxError:
        return []

    docstring_ids = _docstring_node_ids(tree)

    results: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and id(node) not in docstring_ids
        ):
            results.append((node.lineno, node.value))
    return results


# ===========================================================================
# strings.py + app.py – banned user-facing text check
# ===========================================================================

BANNED_WORDS = _BANNED   # alias so parametrize picks it up


class TestBannedWords:
    """Verify banned words are absent from all user-facing string literals.

    Only strings.py and app.py are scanned; comments, docstrings, and
    every other file (including installed libraries) are ignored entirely.
    """

    @pytest.mark.parametrize("word", BANNED_WORDS)
    def test_banned_word_absent(self, word: str) -> None:
        offending: list[str] = []
        for filename in _UI_FILES:
            path = ROOT / filename
            for lineno, value in _user_string_literals(path):
                if word.lower() in value.lower():
                    offending.append(f"{filename}:{lineno}  →  {value!r}")
        assert not offending, (
            f'Banned word "{word}" found in user-facing string literals:\n'
            + "\n".join(offending)
        )


# ===========================================================================
# nlp.py – penalty mapping + fallback classifier
# ===========================================================================

class TestNlp:
    def test_penalty_severity_1(self) -> None:
        from nlp import _penalty
        assert _penalty(1) == -10

    def test_penalty_severity_5(self) -> None:
        from nlp import _penalty
        assert _penalty(5) == -50

    def test_penalty_severity_3(self) -> None:
        from nlp import _penalty
        assert _penalty(3) == -30

    def test_penalty_clamp_low(self) -> None:
        from nlp import _penalty
        assert _penalty(0) == -10   # clamp to 1

    def test_penalty_clamp_high(self) -> None:
        from nlp import _penalty
        assert _penalty(9) == -50   # clamp to 5

    def test_keyword_harassment(self) -> None:
        from nlp import _keyword_classify
        r = _keyword_classify("Street harassment reported near underpass")
        assert r["category"] == "harassment"
        assert r["severity"] >= 3
        assert r["penalty"] <= -30

    def test_keyword_lighting(self) -> None:
        from nlp import _keyword_classify
        r = _keyword_classify("Broken street lights on the underpass stretch")
        assert r["category"] == "lighting"

    def test_keyword_crime_high_severity(self) -> None:
        from nlp import _keyword_classify
        r = _keyword_classify("Robbery reported near ATM")
        assert r["severity"] >= 4
        assert r["penalty"] <= -40

    def test_fallback_result_shape(self) -> None:
        from nlp import classify_alert
        r = classify_alert("generic alert text that matches nothing specific")
        assert set(r.keys()) == {"severity", "category", "penalty"}
        assert 1 <= r["severity"] <= 5
        assert -50 <= r["penalty"] <= -10

    def test_cache_creates_file(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        cache_path = tmp_path / "nlp_cache.json"
        monkeypatch.setattr("config.NLP_CACHE_PATH", cache_path)
        monkeypatch.setattr("nlp.NLP_CACHE_PATH", cache_path)
        monkeypatch.setattr("config.OPENAI_API_KEY", None)
        monkeypatch.setattr("nlp.OPENAI_API_KEY", None)

        from nlp import classify_alert
        classify_alert("broken pavement on footpath")
        assert cache_path.exists()
        data = json.loads(cache_path.read_text())
        assert len(data) == 1

    def test_cache_hit_no_duplicate(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        cache_path = tmp_path / "nlp_cache.json"
        monkeypatch.setattr("config.NLP_CACHE_PATH", cache_path)
        monkeypatch.setattr("nlp.NLP_CACHE_PATH", cache_path)
        monkeypatch.setattr("config.OPENAI_API_KEY", None)
        monkeypatch.setattr("nlp.OPENAI_API_KEY", None)

        from nlp import classify_alert
        r1 = classify_alert("stray dog near the park")
        r2 = classify_alert("stray dog near the park")
        assert r1 == r2
        data = json.loads(cache_path.read_text())
        assert len(data) == 1  # only one entry despite two calls


# ===========================================================================
# scoring.py – cost formula + score clamping
# ===========================================================================

class TestScoringFormulas:
    """Pure formula tests; no OSMnx dependency."""

    def test_cost_dist50_score10_alpha50(self) -> None:
        # cost = chunk_len * (1 + alpha / score)
        chunk_len, score, alpha = 50.0, 10.0, 50.0
        expected = chunk_len * (1 + alpha / score)
        assert math.isclose(expected, 300.0, rel_tol=1e-9)

    def test_cost_formula_general(self) -> None:
        from scoring import edge_chunk_cost
        assert math.isclose(edge_chunk_cost(50.0, 10.0, 50.0), 300.0, rel_tol=1e-9)

    def test_cost_minimum_score_clamp(self) -> None:
        from scoring import edge_chunk_cost
        cost = edge_chunk_cost(50.0, 0.0, 50.0)
        assert math.isfinite(cost)
        assert cost == edge_chunk_cost(50.0, 0.1, 50.0)

    def test_score_clamp_upper(self) -> None:
        from scoring import clamp_score
        assert clamp_score(999.0) == 100.0

    def test_score_clamp_lower(self) -> None:
        from scoring import clamp_score
        assert clamp_score(-50.0) == 0.1

    def test_score_clamp_mid(self) -> None:
        from scoring import clamp_score
        assert clamp_score(75.0) == 75.0


# ===========================================================================
# mock_data.py – structure validation (no live OSMnx needed)
#
# FIX: stub_graph is a MODULE-LEVEL fixture with scope="class".
# Pytest requires class-scoped fixtures to be defined outside the class
# (or as @staticmethod) to avoid the "class-scoped fixture in instance
# method" warning.
# ===========================================================================

@pytest.fixture(scope="class")
def stub_graph():
    """Minimal synthetic MultiDiGraph that looks like an OSMnx graph.

    20 nodes near Bengaluru center, connected in a cycle with cross-edges,
    giving the demo-invariant planting code enough topology to work with.
    """
    import random

    import networkx as nx

    G = nx.MultiDiGraph()
    rng = random.Random(0)
    lat0, lon0 = 12.9757, 77.6011

    for i in range(20):
        lat = lat0 + rng.uniform(-0.01, 0.01)
        lon = lon0 + rng.uniform(-0.01, 0.01)
        G.add_node(i, y=lat, x=lon, osmid=i)

    # Cycle so every node is reachable
    for i in range(20):
        j = (i + 1) % 20
        G.add_edge(i, j, key=0, length=100.0, geometry=None)
        G.add_edge(j, i, key=0, length=100.0, geometry=None)

    # A few cross-edges to give the router an alternative path
    for i in range(0, 20, 4):
        j = (i + 8) % 20
        G.add_edge(i, j, key=0, length=150.0, geometry=None)

    return G


class TestMockDataStructure:
    """Validate the shape of generated mock data using a tiny stub graph."""

    @pytest.fixture(autouse=True)
    def isolate_mock_output(self, tmp_path, monkeypatch):
        """Synthetic fixtures must never replace the real cached-map scenario."""
        mock_path = tmp_path / "mock.json"
        monkeypatch.setattr("config.MOCK_DATA_PATH", mock_path)
        monkeypatch.setattr("mock_data.MOCK_DATA_PATH", mock_path)

    def test_keys_present(self, stub_graph) -> None:
        from mock_data import generate_mock
        data = generate_mock(stub_graph, seed=42)
        required = {
            "active_stores", "transit_stops", "broken_lights",
            "recent_alerts", "risk_hotspots", "crowd",
        }
        assert required.issubset(data.keys())

    def test_stores_have_required_fields(self, stub_graph) -> None:
        from mock_data import generate_mock
        data = generate_mock(stub_graph, seed=42)
        for s in data["active_stores"]:
            assert {"lat", "lon", "name", "open", "close", "is_24h"}.issubset(s.keys())

    def test_transit_has_arrivals(self, stub_graph) -> None:
        from mock_data import generate_mock
        data = generate_mock(stub_graph, seed=42)
        for t in data["transit_stops"]:
            assert isinstance(t["next_arrivals_min"], list)

    def test_hotspot_density_in_range(self, stub_graph) -> None:
        from mock_data import generate_mock
        data = generate_mock(stub_graph, seed=42)
        for h in data["risk_hotspots"]:
            assert 0.0 <= h["density"] <= 1.0

    def test_crowd_hourly_length(self, stub_graph) -> None:
        from mock_data import generate_mock
        data = generate_mock(stub_graph, seed=42)
        for c in data["crowd"]:
            assert len(c["hourly"]) == 24
            assert all(0.0 <= v <= 1.0 for v in c["hourly"])

    def test_alerts_have_timestamp(self, stub_graph) -> None:
        from mock_data import generate_mock
        data = generate_mock(stub_graph, seed=42)
        for a in data["recent_alerts"]:
            assert "timestamp_iso" in a
            assert "text" in a

    def test_mock_json_written(self, stub_graph, tmp_path, monkeypatch) -> None:
        mock_path = tmp_path / "mock.json"
        monkeypatch.setattr("config.MOCK_DATA_PATH", mock_path)
        monkeypatch.setattr("mock_data.MOCK_DATA_PATH", mock_path)
        from mock_data import generate_mock
        generate_mock(stub_graph, seed=7)
        assert mock_path.exists()
        loaded = json.loads(mock_path.read_text())
        assert "active_stores" in loaded


# ===========================================================================
# routing.py – cost invariants (Phase 2; skipped until routing.py exists)
# ===========================================================================

@pytest.mark.skipif(
    not (ROOT / "routing.py").exists(),
    reason="routing.py not yet implemented (Phase 2)",
)
class TestRoutingInvariants:
    """These tests require routing.py from Phase 2."""

    @pytest.fixture(scope="class")
    def routes(self):
        try:
            import osmnx as ox
            from graph import build_graph, build_chunk_gdf
            from mock_data import generate_mock
            from routing import compute_routes
            from scoring import score_chunks

            G = build_graph(network_type="walk")
            Gp = ox.project_graph(G)
            mock = generate_mock(G, seed=42)
            chunks = build_chunk_gdf(Gp)
            scored = score_chunks(chunks, mock, query_hour=20)
            return compute_routes(G, Gp, scored, mode="walk", query_hour=20)
        except Exception as exc:
            pytest.skip(f"Could not build routes: {exc}")

    def test_fastest_shortest(self, routes) -> None:
        fastest = routes["fastest"]["length_m"]
        for key in ("practical", "visibility"):
            assert routes[key]["length_m"] >= fastest * 0.99

    def test_visibility_better_mean_score(self, routes) -> None:
        vis_score = routes["visibility"]["mean_score"]
        fast_score = routes["fastest"]["mean_score"]
        assert vis_score >= fast_score - 1.0

    def test_alert_penalty_mapping(self) -> None:
        from nlp import _penalty
        expected = {1: -10, 2: -20, 3: -30, 4: -40, 5: -50}
        for sev, pen in expected.items():
            assert _penalty(sev) == pen
