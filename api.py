"""FastAPI adapter. Run with: venv\\Scripts\\python.exe -m uvicorn api:app.

Overlay coordinates intentionally use [lat, lon], matching the frontend contract.
Scored graphs are cached for up to 24 date/hour pairs per worker.
"""

from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import datetime
import json
from threading import Lock
from typing import Annotated, Literal

from astral import Observer
from astral.sun import sunrise, sunset
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import networkx as nx
import osmnx as ox
from pydantic import BaseModel, Field
from pyproj import Transformer
from shapely.geometry import LineString, Point

import config
import strings as S
from escort import LocalJsonlSink, needs_escort, notify_contact, poll_interval
from graph import build_chunks, nearest_node
from routing import find_routes
from scoring import LOCAL_TZ, score_chunks

ROUTES = (
    ('fastest', 'Fastest', S.ROUTE_FASTEST_LABEL, '#e53935'),
    ('practical', 'Practical', S.ROUTE_PRACTICAL_LABEL, '#ffb300'),
    ('visibility', 'Visibility-Optimized', S.ROUTE_VIS_LABEL, '#1e88ff'),
)
Latitude = Annotated[float, Field(ge=-90, le=90, allow_inf_nan=False)]
Longitude = Annotated[float, Field(ge=-180, le=180, allow_inf_nan=False)]
Hour = Annotated[int | None, Query(ge=0, le=23)]


class Resources:
    def __init__(self) -> None:
        path = config.DATA_DIR / 'graph_walk.graphml'
        if not path.is_file():
            raise FileNotFoundError(f'Cached graph required: {path}')
        self.graph = ox.project_graph(ox.load_graphml(path))
        for u, v, data in self.graph.edges(data=True):
            if data.get('geometry') is None:
                data['geometry'] = LineString([
                    (self.graph.nodes[n]['x'], self.graph.nodes[n]['y']) for n in (u, v)])
        self.chunks = build_chunks(self.graph)
        self.mock = json.loads(config.MOCK_DATA_PATH.read_text(encoding='utf-8'))
        self.sink = LocalJsonlSink()
        self.lock = Lock()
        self.cache = OrderedDict()
        self.to_xy = Transformer.from_crs(4326, self.graph.graph['crs'], always_xy=True)
        to_ll = Transformer.from_crs(self.graph.graph['crs'], 4326, always_xy=True)
        center = Point(*self.to_xy.transform(config.CENTER_LON, config.CENTER_LAT))
        edges = sorted(self.graph.edges(keys=True),
                       key=lambda edge: self.graph.edges[edge]['geometry'].distance(center))[:3000]
        self.overlay = [(edge, [list(to_ll.transform(*p[:2])[::-1])
                               for p in self.graph.edges[edge]['geometry'].coords])
                        for edge in edges]

    def scored(self, hour: int | None) -> nx.MultiDiGraph:
        now = datetime.now(LOCAL_TZ)
        when = now.replace(hour=now.hour if hour is None else hour,
                           minute=0, second=0, microsecond=0)
        with self.lock:
            if when not in self.cache:
                result = self.graph.copy()
                chunks = score_chunks(self.chunks, self.mock, when)
                # Aggregate once; reuse these chunks for exact low-segment counts.
                for edge, group in chunks.groupby(['edge_u', 'edge_v', 'edge_key'], sort=False):
                    length = group.chunk_len.sum()
                    mean = ((group.score * group.chunk_len).sum() / length
                            if length else group.score.mean())
                    result.edges[edge].update(
                        cost_fast=float(result.edges[edge]['length']),
                        cost_practical=float(group.cost_practical.sum()),
                        cost_vis=float(group.cost_vis.sum()), mean_score=float(mean),
                        min_score=float(group.score.min()),
                        chunks=group[['chunk_len', 'score']].to_dict('records'))
                self.cache[when] = result
                if len(self.cache) > 24:
                    self.cache.popitem(last=False)
            self.cache.move_to_end(when)
            return self.cache[when]

    def snap(self, lat: float, lon: float) -> int:
        try:
            node = nearest_node(self.graph, lat, lon)
            x, y = self.to_xy.transform(lon, lat)
            data = self.graph.nodes[node]
            if Point(x, y).distance(Point(data['x'], data['y'])) > config.GRAPH_RADIUS_M:
                raise ValueError('Outside cached map coverage')
            return node
        except (ValueError, KeyError, nx.NetworkXException) as exc:
            raise HTTPException(400, 'Coordinates could not be snapped to the cached map.') from exc


@asynccontextmanager
async def lifespan(application: FastAPI):
    application.state.resources = Resources()
    yield
    del application.state.resources


app = FastAPI(title='Lumina API', lifespan=lifespan)
app.add_middleware(CORSMiddleware,
                   allow_origin_regex=r'http\://(localhost|127.0.0.1):\d+',
                   allow_methods=['GET', 'POST'], allow_headers=['Content-Type'])


@app.exception_handler(RequestValidationError)
async def invalid_request(request: Request, exc: RequestValidationError):
    errors = [{'field': '.'.join(map(str, e['loc'])), 'message': e['msg']}
              for e in exc.errors()]
    return JSONResponse(status_code=400, content={'detail': errors})


@app.get('/config')
def get_config():
    return {
        'strings': {key: value for key, value in vars(S).items() if key.isupper()},
        'constants': {key: getattr(config, key) for key in
                      ('ESCORT_THRESHOLD', 'POLL_NORMAL_S', 'POLL_ESCORT_S', 'EYES_UP_DELAY_S')},
        'default_start': config.DEFAULT_START, 'default_end': config.DEFAULT_END,
        'map_center': [config.CENTER_LAT, config.CENTER_LON],
    }


@app.get('/routes')
def get_routes(request: Request, start_lat: Latitude, start_lon: Longitude,
               end_lat: Latitude, end_lon: Longitude,
               mode: Literal['walk', 'run', 'bike'] = 'walk', hour: Hour = None):
    resources = request.app.state.resources
    resources.snap(start_lat, start_lon)
    resources.snap(end_lat, end_lon)
    try:
        routes = find_routes(resources.scored(hour), (start_lat, start_lon),
                             (end_lat, end_lon), mode)
    except (nx.NetworkXNoPath, nx.NodeNotFound) as exc:
        raise HTTPException(404, S.ERR_NO_ROUTE) from exc
    except ValueError as exc:
        raise HTTPException(400, 'Coordinates could not be snapped to the cached map.') from exc
    fields = ('coords', 'length_m', 'eta_min', 'mean_score', 'min_score', 'n_low_segments')
    return {'routes': [dict(id=id_, name=label, color=color,
                            needs_escort=needs_escort(routes[key]),
                            **{field: routes[key][field] for field in fields})
                       for id_, key, label, color in ROUTES]}


@app.get('/overlay')
def get_overlay(request: Request, hour: Hour = None):
    resources = request.app.state.resources
    graph = resources.scored(hour)
    return {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': coords},
         'properties': {'mean_score': graph.edges[edge]['mean_score']}}
        for edge, coords in resources.overlay]}


class Telemetry(BaseModel):
    lat: Latitude
    lon: Longitude
    route_id: str = Field(min_length=1)
    escort_active: bool


class Notification(BaseModel):
    phone: str
    route_id: str = Field(min_length=1)


@app.post('/telemetry')
def telemetry(body: Telemetry, request: Request):
    resources = request.app.state.resources
    node = resources.snap(body.lat, body.lon)
    now = datetime.now(LOCAL_TZ)
    observer = Observer(latitude=config.CENTER_LAT, longitude=config.CENTER_LON)
    night = not (sunrise(observer, date=now.date(), tzinfo=LOCAL_TZ) <= now
                 < sunset(observer, date=now.date(), tzinfo=LOCAL_TZ))
    try:
        with resources.lock:
            resources.sink.write(lat=body.lat, lon=body.lon, node_id=node, is_night=night,
                                 route_id=body.route_id, poll_interval_s=poll_interval(body.escort_active))
    except OSError as exc:
        raise HTTPException(500, S.ERR_TELEMETRY) from exc
    return {'ok': True}


@app.post('/notify')
def notify(body: Notification):
    try:
        return {'tracking_link': notify_contact(body.phone, body.route_id)}
    except OSError as exc:
        raise HTTPException(502, S.ERR_CONTACT) from exc
