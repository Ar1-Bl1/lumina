"""strings.py – All user-facing text for Lumina.

Approved terminology only. Enforcement is via tests/test_core.py (banned-word grep).

All keys are UPPER_SNAKE constants.  app.py imports from here exclusively.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# App identity
# ---------------------------------------------------------------------------
APP_NAME = "Lumina"
APP_TAGLINE = "Environmental Route Visibility Planner"
APP_DESCRIPTION = (
    "Calculates environmental visibility factors for pedestrians, "
    "cyclists, and runners. Urban conditions change rapidly — "
    "always exercise personal judgement."
)

# ---------------------------------------------------------------------------
# ToS dialog
# ---------------------------------------------------------------------------
TOS_TITLE = "Terms of Use – Please Read"
TOS_BODY = (
    "This application aggregates environmental data to optimize route visibility. "
    "Urban conditions change rapidly. "
    "This is an informational tool, not a substitute for personal vigilance."
)
TOS_CHECKBOX = "I understand and agree to the Terms of Use"
TOS_PROCEED = "Continue to Lumina"
TOS_BLOCKED = "Please accept the Terms of Use to continue."

# ---------------------------------------------------------------------------
# Route labels
# ---------------------------------------------------------------------------
ROUTE_FASTEST_LABEL = "Fastest Route"
ROUTE_PRACTICAL_LABEL = "Practical Route"
ROUTE_VIS_LABEL = "Visibility-Optimized Route"

ROUTE_FASTEST_DESC = (
    "Shortest travel time. Calculates environmental visibility factors "
    "but prioritises distance."
)
ROUTE_PRACTICAL_DESC = (
    "Balances travel time with environmental visibility. "
    "High-Vitality Route with moderate detour tolerance."
)
ROUTE_VIS_DESC = (
    "Visibility-Optimized Route. Calculates environmental visibility factors "
    "including active storefronts, transit presence, and lighting conditions "
    "to maximise route vitality."
)

# ---------------------------------------------------------------------------
# Sidebar labels
# ---------------------------------------------------------------------------
SIDEBAR_MODE = "Travel Mode"
SIDEBAR_START = "Start coordinates (lat, lon)"
SIDEBAR_END = "Destination coordinates (lat, lon)"
SIDEBAR_HOUR = "Hour-of-day override (0–23)"
SIDEBAR_PHONE = "Emergency contact phone (optional)"
SIDEBAR_OVERLAY = "Show segment-score overlay"
SIDEBAR_CALC = "Calculate Routes"

MODE_OPTIONS = ["Pedestrian", "Cyclist", "Runner"]
MODE_TO_KEY = {"Pedestrian": "walk", "Cyclist": "bike", "Runner": "run"}

# ---------------------------------------------------------------------------
# Metric card labels
# ---------------------------------------------------------------------------
METRIC_DISTANCE = "Distance"
METRIC_ETA = "ETA"
METRIC_MEAN_SCORE = "Mean Visibility Score"
METRIC_MIN_SCORE = "Min Score"
METRIC_LOW_SEGS = "Low-Visibility Segments"

# ---------------------------------------------------------------------------
# Navigation
# ---------------------------------------------------------------------------
NAV_START_BTN = "Start Navigation"
NAV_STOP_BTN = "Stop Navigation"
NAV_PROGRESS = "Navigation in progress…"

# ---------------------------------------------------------------------------
# Escort Mode
# ---------------------------------------------------------------------------
ESCORT_BANNER = (
    "⚠️  Entering low-visibility area. Stay vigilant. "
    "Poll rate increased to 3 s. Contact notified (simulated)."
)
ESCORT_POLL_LABEL = "Current poll rate"
ESCORT_CONTACT_LOG = "Emergency contact notified (simulated GPS link sent)."
ESCORT_SIMULATED_NOTE = "GPS tracking and SMS are simulated in this MVP."

# ---------------------------------------------------------------------------
# Eyes Up overlay
# ---------------------------------------------------------------------------
EYES_UP_TITLE = "Route Active"
EYES_UP_BODY = (
    "Keep your head up and stay vigilant. "
    "Audio cues enabled."
)
EYES_UP_UNLOCK = "Swipe to unlock map"
EYES_UP_AUDIO_CUE = "Eyes up — you are navigating a route. Stay alert."

# ---------------------------------------------------------------------------
# Simulation / data freshness notices
# ---------------------------------------------------------------------------
SIM_GPS = "📍 GPS position: simulated"
SIM_SMS = "📱 SMS/contact notification: simulated"
SIM_CLOUD = "☁️  Cloud sync: simulated"

DATA_FRESHNESS = (
    "Environmental data is updated periodically. "
    "Conditions may have changed since the last update."
)

# ---------------------------------------------------------------------------
# Errors / info
# ---------------------------------------------------------------------------
ERR_NO_ROUTE = "Could not compute a route between the selected points. Try adjusting the coordinates."
ERR_GRAPH_LOAD = "Graph data unavailable. Please wait while the map loads."
ERR_IDENTICAL_ROUTES = (
    "Two or more routes are identical under current conditions. "
    "Try a different hour or mode."
)
INFO_ROUTES_READY = "Routes calculated. Select a route to begin navigation."
INFO_FALLBACK_NLP = "Alert classifier running in offline mode (no OpenAI key)."
