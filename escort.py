"""UI-independent escort decisions, navigation telemetry, and contact hooks."""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import quote
from urllib.request import Request, urlopen

import config

logger = logging.getLogger(__name__)


def needs_escort(route: Mapping[str, Any]) -> bool:
    """Use the minimum score, falling back to routing's low-chunk count."""
    minimum = route.get("min_score")
    if minimum is not None:
        return minimum < config.ESCORT_THRESHOLD
    return (route.get("n_low_segments") or 0) > 0


def poll_interval(escort_active: bool) -> int:
    return config.POLL_ESCORT_S if escort_active else config.POLL_NORMAL_S


class TelemetrySink(ABC):
    """Call write at every navigation poll, including outside escort mode."""

    @abstractmethod
    def write(
        self, *, lat: float, lon: float, node_id: int | str,
        is_night: bool, route_id: str, poll_interval_s: int,
    ) -> None:
        """Persist a navigation sample with a sink-generated UTC timestamp."""


# S3/Firebase plugs in by implementing TelemetrySink and replacing the local sink.
class LocalJsonlSink(TelemetrySink):
    def __init__(self, path: Path | str | None = None) -> None:
        self.path = Path(path) if path is not None else config.LOGS_DIR / "telemetry.jsonl"

    def write(
        self, *, lat: float, lon: float, node_id: int | str,
        is_night: bool, route_id: str, poll_interval_s: int,
    ) -> None:
        record = dict(
            ts=datetime.now(timezone.utc).isoformat(), lat=lat, lon=lon,
            node_id=node_id, is_night=is_night, route_id=route_id,
            poll_interval_s=poll_interval_s,
        )
        line = json.dumps(record, allow_nan=False)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(line + "\n")


def notify_contact(phone: str, route_id: str) -> str:
    """Log and return a simulated tracking link; webhook errors propagate."""
    tracking_link = f"https://lumina.example/track/{quote(route_id, safe='')}"
    payload = dict(phone=phone, route_id=route_id, tracking_link=tracking_link)
    logger.info("Simulated contact notification: %s", json.dumps(payload))
    if config.WEBHOOK_URL:
        request = Request(
            config.WEBHOOK_URL, data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urlopen(request, timeout=10) as response:
            response.read()
    return tracking_link
