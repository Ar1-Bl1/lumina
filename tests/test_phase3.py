"""Offline escort, telemetry, notification, and UI text checks."""

from datetime import datetime
import json
import logging
from pathlib import Path
from unittest.mock import MagicMock

import pytest

import config
import escort
import strings


@pytest.mark.parametrize("route,expected", [
    ({"n_low_segments": 1}, True),
    ({"n_low_segments": 0}, False),
    ({"min_score": 29, "n_low_segments": None}, True),
    ({"min_score": 30}, False),
    ({"min_score": 75}, False),
    ({"min_score": None, "n_low_segments": 0}, False),
])
def test_needs_escort(monkeypatch, route, expected):
    monkeypatch.setattr(config, "ESCORT_THRESHOLD", 30)
    assert escort.needs_escort(route) is expected


def test_escort_uses_configured_threshold(monkeypatch):
    monkeypatch.setattr(config, "ESCORT_THRESHOLD", 45)
    assert escort.needs_escort({"min_score": 40, "n_low_segments": 0})
    assert not escort.needs_escort({"min_score": 45})


def test_poll_interval_switching(monkeypatch):
    monkeypatch.setattr(config, "POLL_NORMAL_S", 17)
    monkeypatch.setattr(config, "POLL_ESCORT_S", 4)
    assert [escort.poll_interval(active) for active in (False, True, False)] == [17, 4, 17]


def test_telemetry_appends_in_both_modes(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "LOGS_DIR", tmp_path / "logs")
    sink = escort.LocalJsonlSink()
    assert isinstance(sink, escort.TelemetrySink)
    before = datetime.now().astimezone()
    for active in (False, True):
        sink.write(lat=12.97, lon=77.60, node_id=123, is_night=True,
                   route_id="demo", poll_interval_s=escort.poll_interval(active))
    records = [json.loads(line) for line in sink.path.read_text().splitlines()]
    assert len(records) == 2
    for record, active in zip(records, (False, True)):
        timestamp = datetime.fromisoformat(record.pop("ts"))
        assert timestamp.utcoffset().total_seconds() == 0
        assert before <= timestamp <= datetime.now().astimezone()
        assert record == dict(lat=12.97, lon=77.60, node_id=123, is_night=True,
                              route_id="demo", poll_interval_s=escort.poll_interval(active))


@pytest.mark.parametrize("webhook", [None, "", "https://example.invalid/hook"])
def test_contact_notification(monkeypatch, caplog, webhook):
    monkeypatch.setattr(config, "WEBHOOK_URL", webhook)
    opener = MagicMock()
    monkeypatch.setattr(escort, "urlopen", opener)
    with caplog.at_level(logging.INFO, logger=escort.__name__):
        link = escort.notify_contact("+910000000000", "route/1 ?")
    assert link == "https://lumina.example/track/route%2F1%20%3F"
    assert link in caplog.text
    if webhook:
        opener.assert_called_once()
        request = opener.call_args.args[0]
        assert request.full_url == webhook
        assert request.get_method() == "POST"
        assert json.loads(request.data) == dict(
            phone="+910000000000", route_id="route/1 ?", tracking_link=link)
        assert opener.call_args.kwargs["timeout"] == 10
    else:
        opener.assert_not_called()


def test_ui_text():
    source = Path(strings.__file__).read_text(encoding="utf-8").casefold()
    for term in ("safest", "danger-free", "secure path", "guarantee"):
        assert term not in source
    assert strings.ROUTE_FASTEST_LABEL == "Fastest Route"
    assert strings.ROUTE_PRACTICAL_LABEL == "Practical Route"
    assert strings.ROUTE_VIS_LABEL == "Visibility-Optimized Route"
    assert strings.ESCORT_BANNER == "Entering low-visibility area. Stay vigilant."
    assert strings.EYES_UP_BODY == (
        "Route active. Keep your head up and stay vigilant. Audio cues enabled.")
    assert strings.TOS_BODY == (
        "This application aggregates environmental data to optimize route visibility. "
        "Urban conditions change rapidly. "
        "This is an informational tool, not a substitute for personal vigilance.")
