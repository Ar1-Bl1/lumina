"""nlp.py – Alert classification for Lumina.

classify_alert(text) -> {"severity": int(1-5), "category": str, "penalty": int}

Strategy:
  1. LLM path: if OPENAI_API_KEY is set, call GPT with JSON mode (temperature 0).
     Validate/clamp the response before returning.
  2. Fallback: keyword classifier runs on any error or missing key.

Results are cached in data/nlp_cache.json keyed by SHA-256 of the input text,
so repeated calls (e.g. on page reload) are free.

penalty formula: -(10 + 10*(severity-1))  →  severity 1→-10, 5→-50.
"""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import TypedDict

from config import NLP_CACHE_PATH, OPENAI_API_KEY, OPENAI_MODEL

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

class AlertResult(TypedDict):
    severity: int   # 1..5
    category: str
    penalty: int    # -(10..50)


_CATEGORIES = (
    "harassment",
    "infrastructure",
    "wildlife",
    "road_hazard",
    "crime",
    "weather",
    "crowd",
    "lighting",
    "other",
)

# ---------------------------------------------------------------------------
# Penalty formula
# ---------------------------------------------------------------------------

def _penalty(severity: int) -> int:
    s = max(1, min(5, severity))
    return -(10 + 10 * (s - 1))


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

def _cache_key(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _load_cache() -> dict[str, AlertResult]:
    if NLP_CACHE_PATH.exists():
        try:
            return json.loads(NLP_CACHE_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _save_cache(cache: dict[str, AlertResult]) -> None:
    NLP_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    NLP_CACHE_PATH.write_text(json.dumps(cache, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Keyword fallback classifier
# ---------------------------------------------------------------------------

_KEYWORD_RULES: list[tuple[list[str], str, int]] = [
    # (keywords, category, severity) — ORDER MATTERS: first match wins
    (["murder", "assault", "stabbing", "shooting", "attack"], "crime", 5),
    (["robbery", "theft", "mugging", "snatch"], "crime", 4),
    (["harassment", "stalking", "molest"], "harassment", 4),
    (["suspicious", "altercation", "confrontation", "verbal"], "harassment", 3),
    # lighting before road_hazard so "broken street lights" matches here first
    (
        ["broken light", "broken street light", "broken lights", "unlit", "no light",
         "pitch black", "dark corridor", "street lights", "streetlight"],
        "lighting",
        3,
    ),
    (["pothole", "broken pavement", "footpath", "road work", "construction"], "infrastructure", 2),
    (["stray dog", "snake", "animal", "wildlife"], "wildlife", 2),
    (["flood", "waterlogged", "slippery", "rain", "puddle"], "weather", 2),
    (["crowd", "gathering", "protest", "rally", "dispersal"], "crowd", 2),
    (["underpass", "isolated", "avoid", "late hours"], "road_hazard", 3),
]


def _keyword_classify(text: str) -> AlertResult:
    lower = text.lower()
    for keywords, category, severity in _KEYWORD_RULES:
        if any(kw in lower for kw in keywords):
            return AlertResult(
                severity=severity,
                category=category,
                penalty=_penalty(severity),
            )
    # Default: low-severity generic
    return AlertResult(severity=1, category="other", penalty=_penalty(1))


# ---------------------------------------------------------------------------
# LLM classifier
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = (
    "You are a public-safety alert classifier for a route-planning app. "
    "Given an alert text, respond with ONLY a JSON object with two keys:\n"
    "  severity: integer 1-5 (1=minor inconvenience, 5=immediate threat to life)\n"
    f"  category: one of {_CATEGORIES}\n"
    "No explanation, no markdown, just the JSON object."
)


def _llm_classify(text: str) -> AlertResult:
    """Call OpenAI chat completions with JSON mode. Raises on any error."""
    try:
        from openai import OpenAI  # lazy import – not required if no key
    except ImportError as exc:
        raise RuntimeError("openai package not installed") from exc

    client = OpenAI(api_key=OPENAI_API_KEY)
    response = client.chat.completions.create(
        model=OPENAI_MODEL,
        temperature=0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
    )
    raw = response.choices[0].message.content or "{}"
    data = json.loads(raw)

    severity = int(data.get("severity", 1))
    severity = max(1, min(5, severity))  # clamp

    category = str(data.get("category", "other"))
    if category not in _CATEGORIES:
        category = "other"

    return AlertResult(
        severity=severity,
        category=category,
        penalty=_penalty(severity),
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def classify_alert(text: str) -> AlertResult:
    """Classify an alert text and return severity/category/penalty.

    Uses LLM when OPENAI_API_KEY is configured; falls back to keyword
    classifier on error or missing key. Results are cached by text hash.

    Parameters
    ----------
    text:
        Free-text alert description.

    Returns
    -------
    AlertResult
        ``severity`` (1–5), ``category`` (str), ``penalty`` (negative int).
    """
    cache = _load_cache()
    key = _cache_key(text)

    if key in cache:
        return AlertResult(**cache[key])  # type: ignore[misc]

    result: AlertResult
    if OPENAI_API_KEY:
        try:
            result = _llm_classify(text)
            log.info("LLM classified alert: %s → %s", text[:60], result)
        except Exception as exc:  # noqa: BLE001
            log.warning("LLM classify failed (%s); using fallback.", exc)
            result = _keyword_classify(text)
    else:
        result = _keyword_classify(text)

    cache[key] = dict(result)  # type: ignore[assignment]
    _save_cache(cache)
    return result
