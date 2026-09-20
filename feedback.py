"""UI-independent local feedback storage; no request metadata is collected."""

from collections import deque
from datetime import datetime, timezone
import ipaddress
import json
from pathlib import Path
import re
from threading import Lock
import unicodedata
from uuid import uuid4


_LOCK = Lock()
_FIELDS = ('rating', 'well_lit', 'escort_helpful', 'comment', 'route_id',
           'mode', 'hour', 'escort_triggered', 'min_score', 'length_m')


def clean_comment(comment: str) -> str:
    """Strip controls and common contact identifiers, not arbitrary personal prose."""
    comment = ''.join(c for c in comment if unicodedata.category(c) not in ('Cc', 'Cf'))
    comment = re.sub(r'\b[\w.+-]+@[\w.-]+\.[\w-]+\b', '[redacted]', comment)

    def redact_ip(match):
        try:
            ipaddress.ip_address(match.group())
        except ValueError:
            return match.group()
        return '[redacted]'

    comment = re.sub(r'(?<![\w:])(?:[0-9a-fA-F]*:){2,}[0-9a-fA-F:.]+(?![\w:])',
                     redact_ip, comment)
    comment = re.sub(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', redact_ip, comment)
    return re.sub(r'(?<!\w)\+?\d[\d\s().-]{5,}\d(?!\w)', '[redacted]', comment)


def save_feedback(payload: dict, path="logs/feedback.jsonl") -> dict:
    """Append an allowlisted record with a server-generated UUID and UTC time."""
    record = {key: payload[key] for key in _FIELDS if key in payload}
    if record.get('comment') is not None:
        record['comment'] = clean_comment(record['comment'])
    record.update(id=str(uuid4()), ts=datetime.now(timezone.utc).isoformat())
    line = json.dumps(record, allow_nan=False)
    target = Path(path)
    with _LOCK:
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('a', encoding='utf-8') as stream:
            stream.write(line + '\n')
    return record


def feedback_summary(path="logs/feedback.jsonl") -> dict:
    """Aggregate stored feedback; recent nonempty comments are oldest first."""
    count, total = 0, 0
    well_lit = dict.fromkeys(('yes', 'somewhat', 'no'), 0)
    escort_helpful = dict.fromkeys(('helpful', 'neutral', 'distracting'), 0)
    comments = deque(maxlen=5)
    with _LOCK:
        try:
            stream = Path(path).open(encoding='utf-8')
        except FileNotFoundError:
            stream = None
        if stream is not None:
            with stream:
                for line in stream:
                    record = json.loads(line)
                    count += 1
                    total += record['rating']
                    well_lit[record['well_lit']] += 1
                    if record.get('escort_helpful') is not None:
                        escort_helpful[record['escort_helpful']] += 1
                    if record.get('comment'):
                        comments.append(clean_comment(record['comment'])[:200])
    return dict(count=count, avg_rating=total / count if count else None,
                well_lit_counts=well_lit, escort_helpful_counts=escort_helpful,
                recent_comments=list(comments))
