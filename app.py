"""Streamlit entry point; importing helpers never renders widgets."""
from datetime import datetime
from html import escape
import json
from time import monotonic
from uuid import uuid4

import folium
import networkx as nx
import osmnx as ox
from pyproj import Transformer
from shapely.geometry import LineString
import streamlit as st
from streamlit_folium import st_folium

import config
import strings as S
from demo_graph import build_demo_graph
from escort import LocalJsonlSink, needs_escort, notify_contact, poll_interval
from graph import build_chunks, nearest_node
from routing import find_routes
from scoring import LOCAL_TZ, score_chunks

ROUTES = {'Fastest': (S.ROUTE_FASTEST_LABEL, '#e53935'),
          'Practical': (S.ROUTE_PRACTICAL_LABEL, '#ffb300'),
          'Visibility-Optimized': (S.ROUTE_VIS_LABEL, '#1e88ff')}


def route_label(name: str) -> str:
    return ROUTES[name][0]


def file_stamp(path) -> int:
    if path.exists():
        return path.stat().st_mtime_ns
    return 0


@st.cache_resource
def load_resources(graph_stamp: int, mock_stamp: int) -> tuple:
    """Stamps invalidate the cache when files change; never download a graph."""
    path = config.DATA_DIR / 'graph_walk.graphml'
    demo = not path.exists()
    try:
        if demo:
            graph = build_demo_graph()
        else:
            graph = ox.project_graph(ox.load_graphml(path))
    except Exception:
        graph, demo = build_demo_graph(), True
    for u, v, data in graph.edges(data=True):
        if data.get('geometry') is None:
            data['geometry'] = LineString([(graph.nodes[n]['x'], graph.nodes[n]['y']) for n in (u, v)])
    mock = json.loads(config.MOCK_DATA_PATH.read_text(encoding='utf-8'))
    return graph, build_chunks(graph), mock, demo


def prepare_scores(graph: nx.MultiDiGraph, chunks, mock: dict, when: datetime) -> tuple:
    """Copy shared topology; retain per-chunk scores for exact low-segment counts."""
    result = graph.copy()
    scored = score_chunks(chunks, mock, when)
    for edge, group in scored.groupby(['edge_u', 'edge_v', 'edge_key'], sort=False):
        length = group.chunk_len.sum()
        mean = float(group.score.mean())
        if length:
            mean = float((group.score * group.chunk_len).sum() / length)
        result.edges[edge].update(
            cost_fast=float(result.edges[edge]['length']),
            cost_practical=float(group.cost_practical.sum()), cost_vis=float(group.cost_vis.sum()),
            mean_score=mean, min_score=float(group.score.min()),
            chunks=group[['chunk_len', 'score']].to_dict('records'))
    return result, bool(scored.is_night.iloc[0])


def make_map(graph: nx.MultiDiGraph, routes: dict, start: tuple, end: tuple,
             overlay: bool, demo: bool, position=None) -> folium.Map:
    """Limit the score layer to 600 edges; synthetic maps need no tile server."""
    tiles = 'OpenStreetMap'
    if demo:
        tiles = None
    map_ = folium.Map(location=start, zoom_start=14, tiles=tiles)
    transform = Transformer.from_crs(graph.graph['crs'], 4326, always_xy=True)
    if overlay or demo:
        label = S.MAP_NETWORK
        if overlay:
            label = S.SIDEBAR_OVERLAY
        layer = folium.FeatureGroup(name=label)
        edges = list(graph.edges(data=True))
        for _, _, data in edges[::max(1, (len(edges) + 599) // 600)]:
            points = [transform.transform(*p[:2])[::-1] for p in data['geometry'].coords]
            ratio = max(0, min(1, data['mean_score'] / 100))
            color = '#999999'
            if overlay:
                color = f'#{int(255 * (1-ratio)):02x}{int(190 * ratio):02x}00'
            folium.PolyLine(points, color=color, weight=3, opacity=.65).add_to(layer)
        layer.add_to(map_)
    for name, (label, color) in ROUTES.items():
        layer = folium.FeatureGroup(name=label)
        coords = routes[name]['coords']
        if name == 'Visibility-Optimized':
            folium.PolyLine(coords, color=color, weight=12, opacity=.25).add_to(layer)
        folium.PolyLine(coords, color=color, weight=5).add_to(layer)
        layer.add_to(map_)
    for point, label in ((start, S.SIDEBAR_START), (end, S.SIDEBAR_END)):
        folium.Marker(point, tooltip=label).add_to(map_)
    if position is not None:
        folium.CircleMarker(position, radius=9, color='#ffffff', fill=True,
                            fill_color='#222222', fill_opacity=1, tooltip=S.NAV_POSITION).add_to(map_)
    map_.fit_bounds([p for route in routes.values() for p in route['coords']] + [start, end])
    folium.LayerControl().add_to(map_)
    return map_


@st.dialog(S.TOS_TITLE, dismissible=False)
def terms_gate() -> None:
    st.write(S.TOS_BODY)
    checked = st.checkbox(S.TOS_CHECKBOX, key='terms_checked')
    if st.button(S.TOS_PROCEED, disabled=not checked):
        st.session_state.terms_accepted = True
        st.rerun()


def eyes_up(now: float) -> None:
    state = st.session_state
    if now - state.nav_started < config.EYES_UP_DELAY_S or now < state.nav_unlock_until:
        return
    # The keyed container places a real Streamlit button above the dimmer.
    st.markdown('''<style>.st-key-eyes_up {position:fixed; inset:0; z-index:999990;
        background:rgba(0,0,0,.94); color:white; display:flex; align-items:center;
        justify-content:center; padding:15vh 12vw; text-align:center;}
        .st-key-eyes_up button {font-size:1.5rem; min-height:4rem;}</style>''', unsafe_allow_html=True)
    with st.container(key='eyes_up'):
        st.markdown(f'<div style="font-size:90px">{escape(S.EYE_ICON)}</div>', unsafe_allow_html=True)
        st.title(S.EYES_UP_TITLE)
        st.write(S.EYES_UP_BODY)
        if not state.get('nav_audio_played', False):
            st.components.v1.html('<script>speechSynthesis.speak(new SpeechSynthesisUtterance('
                                  + json.dumps(S.EYES_UP_AUDIO_CUE) + '));</script>', height=0)
            state.nav_audio_played = True
        if st.button(S.EYES_UP_UNLOCK):
            state.nav_unlock_until = now + 10
            st.rerun(scope='fragment')


@st.fragment(run_every=1)
def navigation_view() -> None:
    state = st.session_state
    graph, routes, start, end, overlay, demo, night = state.map_context
    position = None
    if state.get('nav_active', False):
        now = monotonic()
        route = state.nav_route
        active = needs_escort(route)
        interval = poll_interval(active)
        if active:
            st.warning(S.ESCORT_BANNER)
            if not state.nav_notified:
                state.nav_notified = True  # One attempt per navigation, including reruns.
                try:
                    notify_contact(state.nav_phone, state.nav_id)
                    state.nav_contact_ok = True
                except Exception:
                    state.nav_contact_ok = False
            if state.nav_contact_ok:
                st.caption(S.ESCORT_CONTACT_LOG)
            else:
                st.caption(S.ERR_CONTACT)
        st.caption(S.ESCORT_POLL_LABEL + ': ' + S.POLL_VALUE.format(interval))
        # Monotonic guard prevents widget reruns from adding extra ticks.
        if now - state.nav_last_tick >= 1:
            state.nav_index = min(state.nav_index + 1, len(route['coords']) - 1)
            state.nav_last_tick = now
            position = route['coords'][state.nav_index]
            try:
                LocalJsonlSink().write(lat=position[0], lon=position[1],
                    node_id=nearest_node(graph, *position), is_night=night,
                    route_id=state.nav_id, poll_interval_s=interval)
            except OSError:
                state.nav_active = False
                st.error(S.ERR_TELEMETRY)
            if state.nav_index == len(route['coords']) - 1:
                state.nav_active = False
                state.nav_finished = True
        position = route['coords'][state.nav_index]
        if st.button(S.NAV_STOP_BTN):
            state.nav_active = False
            st.rerun()
        if state.nav_active:
            st.caption(S.NAV_PROGRESS)
            eyes_up(now)
    if state.get('nav_finished', False):
        position = state.nav_route['coords'][-1]
        st.success(S.NAV_DONE)
    st_folium(make_map(graph, routes, start, end, overlay, demo, position),
              height=480, key='route_map', returned_objects=[])
    for column, name in zip(st.columns(3), ROUTES):
        route = routes[name]
        with column:
            st.subheader(ROUTES[name][0])
            for label, value in ((S.METRIC_DISTANCE, S.DISTANCE_VALUE.format(route['length_m'])),
                (S.METRIC_ETA, S.ETA_VALUE.format(route['eta_min'])),
                (S.METRIC_MEAN_SCORE, route['mean_score']), (S.METRIC_MIN_SCORE, route['min_score']),
                (S.METRIC_LOW_SEGS, route['n_low_segments'])):
                if value is None:
                    value = S.UNKNOWN_VALUE
                elif isinstance(value, float):
                    value = f'{value:.1f}'
                st.metric(label, value)


def main() -> None:
    st.set_page_config(page_title=S.APP_NAME, layout='wide')
    state = st.session_state
    if not state.get('terms_accepted', False):
        terms_gate()
        st.stop()
    st.title(S.APP_NAME)
    st.caption(S.APP_TAGLINE)
    st.write(S.APP_DESCRIPTION)
    with st.sidebar:
        mode = st.selectbox(S.SIDEBAR_MODE, S.MODE_OPTIONS)
        points = []
        for key, label, default in (('start', S.SIDEBAR_START, config.DEFAULT_START),
                                    ('end', S.SIDEBAR_END, config.DEFAULT_END)):
            st.caption(label)
            points.append(tuple(st.number_input(text, min_value=-bound, max_value=bound,
                value=value, format='%.6f', key=f'{key}_{axis}')
                for axis, text, bound, value in zip(('lat', 'lon'),
                    (S.LATITUDE, S.LONGITUDE), (90., 180.), default)))
        hour = st.slider(S.SIDEBAR_HOUR, 0, 23, datetime.now(LOCAL_TZ).hour)
        phone = st.text_input(S.SIDEBAR_PHONE)
        overlay = st.checkbox(S.SIDEBAR_OVERLAY)
        st.caption(S.WALK_NETWORK_NOTE)
    path = config.DATA_DIR / 'graph_walk.graphml'
    stamps = (file_stamp(path), file_stamp(config.MOCK_DATA_PATH))
    try:
        graph, chunks, mock, demo = load_resources(*stamps)
    except (OSError, ValueError):
        st.error(S.ERR_MOCK)
        st.stop()
    if demo:
        st.error(S.ERR_CACHE_MISSING)
        st.warning(S.DEMO_MAP)
    when = datetime.now(LOCAL_TZ).replace(hour=hour, minute=0, second=0, microsecond=0)
    score_key = (stamps, when.isoformat())
    if state.get('score_key') != score_key:
        state.scored_graph, state.is_night = prepare_scores(graph, chunks, mock, when)
        state.score_key = score_key
    route_key = (score_key, *points, mode)
    if state.get('route_key') != route_key:
        state.nav_active = state.nav_finished = False
        try:
            state.routes = find_routes(state.scored_graph, *points, S.MODE_TO_KEY[mode])
        except (nx.NetworkXException, ValueError):
            st.error(S.ERR_NO_ROUTE)
            st.stop()
        state.route_key = route_key
    if any(r['identical_to'] for r in state.routes.values()):
        st.info(S.ERR_IDENTICAL_ROUTES)
    for text in (S.SIM_GPS, S.SIM_SMS, S.SIM_CLOUD, S.DATA_FRESHNESS):
        st.caption(text)
    choice = st.radio(S.ROUTE_CHOICE, list(ROUTES), format_func=route_label)
    if config.WEBHOOK_URL:
        st.warning(S.WEBHOOK_DISABLED)
    if st.button(S.NAV_START_BTN, disabled=bool(config.WEBHOOK_URL)):
        state.nav_route = dict(state.routes[choice])
        # Densify to approximately one simulated second of travel per coordinate.
        coords = state.nav_route['coords']
        dense = [coords[0]]
        for a, b in zip(coords, coords[1:]):
            distance = ox.distance.great_circle(*a, *b)
            steps = max(1, int(distance / (config.SPEEDS_KMH[S.MODE_TO_KEY[mode]] / 3.6)))
            dense.extend(tuple(a[j] + (b[j] - a[j]) * i / steps for j in (0, 1))
                         for i in range(1, steps + 1))
        state.nav_route['coords'] = dense
        state.nav_id, state.nav_phone = uuid4().hex, phone
        state.nav_index, state.nav_unlock_until = 0, 0.
        state.nav_started = state.nav_last_tick = monotonic()
        state.nav_notified = state.nav_finished = False
        state.nav_audio_played = False
        state.nav_active = True
    state.map_context = (state.scored_graph, state.routes, *points, overlay, demo, state.is_night)
    navigation_view()


if __name__ == '__main__':
    main()
