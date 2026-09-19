STATUS: Phase 1 DONE and tested (28 pass). Do not modify Phase 1 files or rename fields/constants.



ROLE: Senior Python/GIS engineer. Build "Lumina", an MVP route planner for pedestrians, cyclists and runners. It scores street segments by environmental visibility/vitality and returns 3 routes. Output complete, runnable code (no TODOs/placeholders). Print the file tree first. Build in PHASES; stop after each and wait for "next".



STACK: Python 3.11, osmnx>=2, networkx, geopandas>=1, pandas, shapely, astral, openai, python-dotenv, scikit-learn, streamlit>=1.37, streamlit-folium, folium. Config via .env (OPENAI\_API\_KEY optional, OPENAI\_MODEL configurable, default a small cheap chat model). App must run fully without an API key (fallback classifier).



AREA: \[Bangaluru, MG Road], graph = 3200 m radius around center. Default start/end: \[12.9820°N, 77.5933°E],\[12.9687°N, 77.6104°E].



FILES: config.py, strings.py, mock\_data.py, nlp.py, graph.py, scoring.py, routing.py, escort.py, app.py, tests/test\_core.py, requirements.txt, README.md.

Core modules (everything except app.py) must be UI-independent: pure functions returning dicts/GeoJSON, so the frontend can be swapped later.



CONFIG: ALPHA\_VIS=50, ALPHA\_PRACTICAL=15, ALPHA\_FAST=0; SCORE\_BASE=50, clamp \[0.1,100]; ESCORT\_THRESHOLD=30; MATCH\_RADIUS\_M=50; PRACTICAL\_MAX\_DETOUR=1.25; speeds km/h walk 5, run 10, bike 15; mode->network\_type (walk/run="walk", bike="bike"); POLL\_NORMAL\_S=15, POLL\_ESCORT\_S=3; EYES\_UP\_DELAY\_S=30.



PHASE 1: mock\_data.py + nlp.py + tests

\- generate\_mock(G, seed=42) -> data/mock.json. Sample real OSM node coords + <=20 m jitter so features actually land on the graph. Arrays:

&#x20; active\_stores{lat,lon,name,open"HH:MM",close"HH:MM",is\_24h} \~60 (support overnight wrap);

&#x20; transit\_stops{lat,lon,next\_arrivals\_min\[]} \~25;

&#x20; broken\_lights{lat,lon} \~40;

&#x20; recent\_alerts{text,lat,lon,timestamp\_iso} \~10, realistic free text;

&#x20; risk\_hotspots{lat,lon,density 0-1} (historical FIR/crime density);

&#x20; crowd{lat,lon,hourly\[24] 0-1} (crowd/event density).

\- DEMO GUARANTEE: compute the fastest path between default start/end, plant a "dark corridor" (broken lights + alert + risk hotspot) on its middle third, and a well-lit "lively street" (24h stores, transit, crowd) on a parallel alternative. The 3 routes must visibly differ, and the fastest must trigger Escort Mode.

\- nlp.py: classify\_alert(text)->{"severity":1-5,"category":str,"penalty":int}. LLM returns strict JSON {severity,category} only (temperature 0, JSON mode, validate/clamp). penalty = -(10+10\*(severity-1)), i.e. -10..-50. Fallback keyword classifier when no key or on error. Cache in data/nlp\_cache.json by text hash.



PHASE 2: graph.py + scoring.py + routing.py + tests

\- graph.py: ox.graph\_from\_point(center, dist=3200, network\_type=...), simplify, cache to data/graph\_{type}.graphml, project to UTM for metric ops.

\- 50 m discretization WITHOUT changing topology: split each edge geometry into ceil(length/50) chunks, and score each chunk at its midpoint (GeoDataFrame: edge\_id, chunk\_idx, chunk\_len, point).

\- Scoring (vectorized; match features with geopandas sjoin predicate="dwithin", distance=50), given query time t and is\_night from astral sunrise/sunset at center:

&#x20; +15 store open at t within 50 m; +10 transit stop with arrival <=15 min; -20 broken light (x0.3 if daytime);

&#x20; alert: worst (most negative) NLP penalty within 50 m, scaled by recency decay exp(-age\_h/6);

&#x20; risk hotspot: -20\*max density; crowd: +10 if hourly\[t]>=0.6, -5 if <=0.15 at night.

&#x20; Each category applies at most once per chunk (no stacking). score = clip(50+sum, 0.1, 100).

\- Cost per chunk = chunk\_len\*(1+alpha/score). Edge attrs: cost\_fast (=length), cost\_practical, cost\_vis (sum over chunks), min\_score, mean\_score. Rescoring on time change recomputes only modifiers (cache graph via st.cache\_resource).

\- routing.py: nx.astar\_path with haversine heuristic (admissible because multiplier>=1); weight is a callable taking min over parallel edges of the MultiDiGraph. Use nearest nodes via ox.distance.nearest\_nodes.

&#x20; Fastest=cost\_fast. Visibility-Optimized=cost\_vis. Practical=cost\_practical; if its length > 1.25x fastest, retry with alpha 10,5,2 until satisfied.

&#x20; Return per route: coords, length\_m, eta\_min (by mode speed), mean\_score (length-weighted), min\_score, n\_low\_segments (<30). If two routes are identical, flag it.

\- Tests: cost(dist=50,score=10,alpha=50)==300; clamp at 0.1; fastest length <= others; visibility mean\_score >= fastest; alert penalty mapping.



PHASE 3: escort.py + strings.py + app.py

\- escort.py: needs\_escort(route) = any chunk score < 30. TelemetrySink interface + LocalJsonlSink (logs/telemetry.jsonl: ts, lat, lon, node\_id, is\_night, route\_id, poll\_interval\_s), with a documented swap point for S3/Firebase. Telemetry is ALWAYS on during navigation. notify\_contact(phone): generate tracking link stub, log it, optionally POST to WEBHOOK\_URL if set. In escort mode poll interval 15s->3s.

\- strings.py: ALL UI text. Never use "safest", "danger-free", "secure path", "guarantee". Use "Visibility-Optimized Route", "High-Vitality Route", "Calculates environmental visibility factors". Add a test that greps the repo for banned words.

\- app.py (Streamlit), in order:

&#x20; 1. Blocking ToS dialog (st.dialog + checkbox), else st.stop(). Text: "This application aggregates environmental data to optimize route visibility. Urban conditions change rapidly. This is an informational tool, not a substitute for personal vigilance."

&#x20; 2. Sidebar: mode (Pedestrian/Cyclist/Runner), start/end lat-lon inputs, hour-of-day override for demos, emergency contact phone, toggle for segment-score overlay (edges colored red->green).

&#x20; 3. Folium map, 3 routes: Fastest red #e53935; Practical amber #ffb300; Visibility-Optimized blue #1e88ff with glow (extra polyline weight 12, opacity .25 beneath weight 5). Layer control. Metric cards for each route.

&#x20; 4. Choose route -> "Start navigation": simulate movement along the route (st.fragment run\_every=1, session\_state index; marker moves). If needs\_escort: banner "Entering low-visibility area. Stay vigilant.", show poll rate 3 s, notify contact once, log telemetry.

&#x20; 5. Eyes Up: after 30 s of navigation, full-screen dim overlay (CSS) with large eye icon + "Route active. Keep your head up and stay vigilant. Audio cues enabled." + button "Swipe to unlock map" (hides overlay 10 s, then re-dims). Optional speechSynthesis audio cue via st.components.html.

&#x20; Label GPS/SMS/cloud as simulated in the MVP.



OUTPUT RULES: complete files only, concise comments, type hints. README: setup, .env, `streamlit run app.py`, 60-second demo script (pick default start/end -> show 3 routes -> toggle overlay -> start navigation -> Escort banner -> Eyes Up).

