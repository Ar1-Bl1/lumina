"""config.py – All tunable constants for Lumina.
Every module imports from here; nothing is hard-coded elsewhere.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ROOT_DIR: Path = Path(__file__).parent
DATA_DIR: Path = ROOT_DIR / "data"
LOGS_DIR: Path = ROOT_DIR / "logs"
DATA_DIR.mkdir(exist_ok=True)
LOGS_DIR.mkdir(exist_ok=True)

# ---------------------------------------------------------------------------
# Area / Map
# ---------------------------------------------------------------------------
# Bengaluru – MG Road corridor (swap via .env)
CENTER_LAT: float = float(os.getenv("CENTER_LAT", "12.9757"))
CENTER_LON: float = float(os.getenv("CENTER_LON", "77.6011"))
GRAPH_RADIUS_M: int = int(os.getenv("GRAPH_RADIUS_M", "1500"))

# Default start / end coordinates
DEFAULT_START: tuple[float, float] = (
    float(os.getenv("DEFAULT_START_LAT", "12.9820")),
    float(os.getenv("DEFAULT_START_LON", "77.5933")),
)
DEFAULT_END: tuple[float, float] = (
    float(os.getenv("DEFAULT_END_LAT", "12.9687")),
    float(os.getenv("DEFAULT_END_LON", "77.6104")),
)

# ---------------------------------------------------------------------------
# Routing cost weights  (alpha_X: higher = stronger pull toward score)
# ---------------------------------------------------------------------------
ALPHA_VIS: float = float(os.getenv("ALPHA_VIS", "200"))
ALPHA_PRACTICAL: float = float(os.getenv("ALPHA_PRACTICAL", "60"))
ALPHA_FAST: float = float(os.getenv("ALPHA_FAST", "0"))

# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------
SCORE_BASE: float = float(os.getenv("SCORE_BASE", "50"))
SCORE_MIN: float = 0.1
SCORE_MAX: float = 100.0

CHUNK_SIZE_M: float = 50.0          # discretization resolution
MATCH_RADIUS_M: float = 50.0        # spatial join radius for features

# Feature score deltas
DELTA_STORE_OPEN: float = 15.0
DELTA_TRANSIT: float = 10.0
DELTA_BROKEN_LIGHT: float = -20.0
BROKEN_LIGHT_DAY_FACTOR: float = 0.3   # multiply at daytime
DELTA_RISK_BASE: float = -20.0
DELTA_CROWD_HIGH: float = 10.0
DELTA_CROWD_LOW: float = -5.0
CROWD_HIGH_THRESH: float = 0.6
CROWD_LOW_THRESH: float = 0.15
TRANSIT_ARRIVAL_WINDOW_MIN: int = 15
ALERT_DECAY_HALF_LIFE_H: float = 6.0   # exp(-age/6) recency decay

# ---------------------------------------------------------------------------
# Practical route
# ---------------------------------------------------------------------------
PRACTICAL_MAX_DETOUR: float = float(os.getenv("PRACTICAL_MAX_DETOUR", "1.25"))
PRACTICAL_ALPHA_FALLBACK: list[float] = [10.0, 5.0, 2.0]

# ---------------------------------------------------------------------------
# Escort / navigation
# ---------------------------------------------------------------------------
ESCORT_THRESHOLD: float = float(os.getenv("ESCORT_THRESHOLD", "30"))
LOW_SEGMENT_THRESHOLD: float = 30.0   # same value, used in routing stats
POLL_NORMAL_S: int = int(os.getenv("POLL_NORMAL_S", "15"))
POLL_ESCORT_S: int = int(os.getenv("POLL_ESCORT_S", "3"))
EYES_UP_DELAY_S: int = int(os.getenv("EYES_UP_DELAY_S", "30"))

# Webhook for contact notification (optional)
WEBHOOK_URL: str | None = os.getenv("WEBHOOK_URL")

# ---------------------------------------------------------------------------
# Mode speeds
# ---------------------------------------------------------------------------
SPEEDS_KMH: dict[str, float] = {
    "walk": 5.0,
    "run": 10.0,
    "bike": 15.0,
}
MODE_TO_NETWORK: dict[str, str] = {
    "walk": "walk",
    "run": "walk",
    "bike": "bike",
}

# ---------------------------------------------------------------------------
# OpenAI (optional)
# ---------------------------------------------------------------------------
OPENAI_API_KEY: str | None = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL: str = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

NLP_CACHE_PATH: Path = DATA_DIR / "nlp_cache.json"
MOCK_DATA_PATH: Path = DATA_DIR / "mock.json"
