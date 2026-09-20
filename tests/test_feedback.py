"""Offline feedback API and JSONL storage tests."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
from uuid import UUID

from fastapi.testclient import TestClient
import pytest

import api
import config
from feedback import feedback_summary, save_feedback


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'LOGS_DIR', tmp_path / 'logs')
    # Feedback needs no map resources, so do not enter the map-loading lifespan.
    session = TestClient(api.app)
    yield session
    session.close()


@pytest.fixture
def payload():
    return dict(rating=4, well_lit='yes', route_id='visibility', mode='pedestrian',
                hour=22, escort_triggered=True, comment='Good lighting')


@pytest.mark.parametrize('changes', [
    {'rating': 0}, {'rating': 6}, {'rating': 2.5}, {'rating': True},
    {'comment': 'x' * 501}, {'comment': '\n' * 501}, {'hour': -1}, {'hour': 24},
    {'well_lit': 'maybe'}, {'escort_helpful': 'yes'}, {'route_id': 'other'},
    {'mode': 'walk'}, {'escort_triggered': 'true'}, {'min_score': 'NaN'},
])
def test_invalid_input(client, payload, changes):
    assert client.post('/feedback', json=payload | changes).status_code == 422
    assert not (config.LOGS_DIR / 'feedback.jsonl').exists()


def test_rating_required(client, payload):
    del payload['rating']
    assert client.post('/feedback', json=payload).status_code == 422


def test_valid_post_and_privacy(client, payload):
    response = client.post('/feedback', json=payload | {
        'phone': '+919876543210', 'ip': '192.0.2.1', 'name': 'Example Person',
        'lat': 12.3, 'id': 'client-id', 'ts': 'client-time',
        'comment': 'Good\n\x00 lighting\u200b +919876543210 me@example.com 192.0.2.1 2001:db8::1',
    }, headers={'X-Forwarded-For': '192.0.2.2'})
    assert response.status_code == 200
    lines = (config.LOGS_DIR / 'feedback.jsonl').read_text(encoding='utf-8').splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert response.json() == {'ok': True, 'id': record['id']}
    assert UUID(record['id']).version == 4
    assert datetime.fromisoformat(record['ts']).utcoffset().total_seconds() == 0
    assert set(record) == set(payload) | {'escort_helpful', 'min_score', 'length_m', 'id', 'ts'}
    assert record['comment'] == 'Good lighting [redacted] [redacted] [redacted] [redacted]'
    assert '192.0.2.2' not in lines[0]


def test_summary(client, payload):
    empty = client.get('/feedback/summary').json()
    assert empty['count'] == 0 and empty['avg_rating'] is None
    assert empty['recent_comments'] == []
    for i in range(7):
        response = client.post('/feedback', json=payload | {
            'rating': i % 5 + 1, 'well_lit': ('yes', 'somewhat', 'no')[i % 3],
            'escort_helpful': ('helpful', 'neutral', 'distracting', None)[i % 4],
            'comment': chr(97 + i) * 250,
        })
        assert response.status_code == 200
    summary = client.get('/feedback/summary').json()
    assert summary == dict(count=7, avg_rating=18 / 7,
                          well_lit_counts={'yes': 3, 'somewhat': 2, 'no': 2},
                          escort_helpful_counts={'helpful': 2, 'neutral': 2, 'distracting': 2},
                          recent_comments=[chr(97 + i) * 200 for i in range(2, 7)])


def test_concurrent_storage_and_allowlist(tmp_path, payload):
    path = tmp_path / 'nested' / 'feedback.jsonl'
    with ThreadPoolExecutor(max_workers=8) as executor:
        records = list(executor.map(lambda _: save_feedback(payload | {'phone': '1234567890'}, path),
                                    range(40)))
    lines = path.read_text(encoding='utf-8').splitlines()
    assert len(lines) == 40
    assert len({record['id'] for record in records}) == 40
    assert all('phone' not in json.loads(line) for line in lines)
    assert feedback_summary(path)['avg_rating'] == 4
    assert feedback_summary(path)['count'] == 40


def test_feedback_config(client):
    feedback = client.get('/config').json()['feedback']
    assert feedback['title'] == 'How was your route?'
    assert feedback['well_lit_options'] == {'yes': 'Yes', 'somewhat': 'Somewhat', 'no': 'No'}
    assert feedback['comment_hint'] == "Please don't include personal details."
