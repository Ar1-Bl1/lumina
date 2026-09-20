export const API_BASE_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '');
export type Coordinate = [number, number];
export type FeedbackBody = {
  rating: number; well_lit: 'yes' | 'somewhat' | 'no';
  escort_helpful?: 'helpful' | 'neutral' | 'distracting'; comment: string;
  route_id: 'fastest' | 'practical' | 'visibility'; mode: 'pedestrian' | 'cyclist' | 'runner';
  hour: number; escort_triggered: boolean; min_score: number; length_m: number;
};
export type FeedbackContext = Omit<FeedbackBody, 'rating' | 'well_lit' | 'escort_helpful' | 'comment'>;
export type FeedbackStrings = {
  title: string; rating_label: string; well_lit_question: string;
  well_lit_options: Record<FeedbackBody['well_lit'], string>;
  escort_question: string; escort_options: Record<NonNullable<FeedbackBody['escort_helpful']>, string>;
  comment_label: string; comment_hint: string; submit: string; skip: string; success: string; error: string;
};
export type Config = {
  feedback: FeedbackStrings;
  strings: Record<string, string> & { MODE_OPTIONS: string[]; MODE_TO_KEY: Record<string, string> };
  constants: { ESCORT_THRESHOLD: number; POLL_NORMAL_S: number; POLL_ESCORT_S: number; EYES_UP_DELAY_S: number };
  default_start: Coordinate; default_end: Coordinate; map_center: Coordinate;
};
export type ApiRoute = {
  id: string; name: string; color: string; coords: Coordinate[]; needs_escort: boolean;
  length_m: number; eta_min: number; mean_score: number; min_score: number; n_low_segments: number;
};
export type Overlay = { features: { geometry: { coordinates: Coordinate[] }; properties: { mean_score: number } }[] };
export class ApiError extends Error {
  constructor(message: string, public status = 0) { super(message); }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  init.signal?.addEventListener('abort', cancel, { once: true });
  if (init.signal?.aborted) controller.abort();
  const timeout = setTimeout(cancel, 60000);
  try {
    const response = await fetch(API_BASE_URL + path, { ...init, signal: controller.signal });
    if (!response.ok) throw new ApiError(path.startsWith('/routes') && [400, 404].includes(response.status) ? 'No route found' : "Can't reach the server", response.status);
    return await response.json();
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw error instanceof ApiError ? error : new ApiError("Can't reach the server");
  } finally { clearTimeout(timeout); init.signal?.removeEventListener('abort', cancel); }
}
export const getConfig = (signal?: AbortSignal) => request<Config>('/config', { signal });
export const getRoutes = (start: Coordinate, end: Coordinate, mode: string, signal?: AbortSignal) =>
  request<{ routes: ApiRoute[] }>('/routes?' + new URLSearchParams({ start_lat: String(start[0]), start_lon: String(start[1]), end_lat: String(end[0]), end_lon: String(end[1]), mode }), { signal });
export const getOverlay = (signal?: AbortSignal) => request<Overlay>('/overlay', { signal });
const post = <T,>(path: string, body: unknown, signal?: AbortSignal) => request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
export const postFeedback = (body: FeedbackBody, signal?: AbortSignal) => post<{ ok: boolean; id: string }>('/feedback', body, signal);
export const postTelemetry = (body: { lat: number; lon: number; route_id: string; escort_active: boolean }, signal?: AbortSignal) => post<{ ok: boolean }>('/telemetry', body, signal);
export const postNotify = (phone: string, route_id: string, signal?: AbortSignal) => post<{ tracking_link: string }>('/notify', { phone, route_id }, signal);
export function parseCoordinate(value: string): Coordinate | null {
  const parts = value.split(',');
  if (parts.length !== 2 || parts.some(p => !p.trim())) return null;
  const [lat, lon] = parts.map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}
export function adaptRoute(route: ApiRoute, strings: Config['strings']) {
  const key = route.id === 'visibility' ? 'VIS' : route.id.toUpperCase();
  return { ...route, name: strings[`ROUTE_${key}_LABEL`] || route.name,
    tagline: strings[`ROUTE_${key}_DESC`], duration: `${route.eta_min.toFixed(1)} min`,
    distance: `${(route.length_m / 1000).toFixed(2)} km`, safetyScore: Number(route.mean_score.toFixed(1)),
    highlights: [`${strings.METRIC_MIN_SCORE}: ${route.min_score.toFixed(1)}`, `${strings.METRIC_LOW_SEGS}: ${route.n_low_segments}`],
    segments: [{ name: strings.METRIC_MIN_SCORE, score: route.min_score, dist: '', status: String(route.n_low_segments) + ' ' + strings.METRIC_LOW_SEGS }],
  };
}
export type Route = ReturnType<typeof adaptRoute>;
