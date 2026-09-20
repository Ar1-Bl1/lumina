import { useState, useEffect, useMemo, useRef, useCallback, createContext, useContext } from 'react';
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import { getTimes } from 'suncalc';
import FeedbackModal from './FeedbackModal';
import type { FeedbackContext } from './api';
import { getConfig, getRoutes, getOverlay, postNotify, postTelemetry, adaptRoute, parseCoordinate, type Config, type Route, type Overlay, type Coordinate } from './api';
const DataContext = createContext<{ config: Config; routes: Route[] }>(null!);
const useData = () => useContext(DataContext);

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const SIDEBAR_W = 380;
const ESCORT_MESSAGE = 'Entering low-visibility area. Stay vigilant.';

type DayPhase = 'day' | 'golden' | 'twilight' | 'night';
type Screen = 'map' | 'escort' | 'eyesup' | 'stats';
type AccountPanel = 'account' | 'notifications' | 'savedroutes' | null;

function ts(d: Date | null) { return d ? d.getTime() : 0; }

function getDayPhase(now: Date, center: Coordinate): DayPhase {
  const t = getTimes(now, ...center);
  const ms = now.getTime();
  if (ms >= ts(t.goldenHourEnd) && ms < ts(t.goldenHour)) return 'day';
  if ((ms >= ts(t.goldenHour) && ms < ts(t.sunsetStart)) || (ms >= ts(t.sunriseEnd) && ms < ts(t.goldenHourEnd))) return 'golden';
  if ((ms >= ts(t.sunsetStart) && ms < ts(t.dusk)) || (ms >= ts(t.dawn) && ms < ts(t.sunriseEnd))) return 'twilight';
  return 'night';
}

const TILE: Record<DayPhase, { label: string }> = {
  day:      { label: 'Daylight'    },
  golden:   { label: 'Golden Hour' },
  twilight: { label: 'Twilight'    },
  night:    { label: 'Night'       },
};

function formatTime(d: Date | null) {
  if (!d) return '--:--';
  return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
}

// ─── ICON SYSTEM ──────────────────────────────────────────────────────────────
function Icon({ name, size = 16, color = 'currentColor', strokeWidth = 1.5 }: { name: string; size?: number; color?: string; strokeWidth?: number }) {
  const s = size;
  const sw = strokeWidth;
  const props = { width: s, height: s, viewBox: '0 0 16 16', fill: 'none', stroke: color, strokeWidth: sw, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

  const icons: Record<string, React.ReactNode> = {
    sun:        <svg {...props}><circle cx="8" cy="8" r="3"/><line x1="8" y1="1" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="15"/><line x1="1" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="15" y2="8"/><line x1="2.9" y1="2.9" x2="4.3" y2="4.3"/><line x1="11.7" y1="11.7" x2="13.1" y2="13.1"/><line x1="2.9" y1="13.1" x2="4.3" y2="11.7"/><line x1="11.7" y1="4.3" x2="13.1" y2="2.9"/></svg>,
    moon:       <svg {...props}><path d="M13 10A6 6 0 016 3a6 6 0 100 10 6 6 0 007-3z"/></svg>,
    sunrise:    <svg {...props}><path d="M8 6V2M5 5L3 3M11 5l2-2M2 10h12M4 13a4 4 0 018 0"/></svg>,
    sunset:     <svg {...props}><path d="M8 6V2M5 5L3 3M11 5l2-2M2 10h12M4 13a4 4 0 018 0M6 15h4"/></svg>,
    twilight:   <svg {...props}><path d="M8 4V1M3.5 5.5L1.5 3.5M12.5 5.5l2-2M1 10h14M5 13a4 4 0 016 0"/><circle cx="8" cy="8" r="2" fill={color} strokeWidth="0"/></svg>,
    shield:     <svg {...props}><path d="M8 2L3 4v4c0 3 2.5 5 5 6 2.5-1 5-3 5-6V4L8 2z"/></svg>,
    bolt:       <svg {...props}><path d="M9 2L4 9h4l-1 5 5-7H8L9 2z"/></svg>,
    scales:     <svg {...props}><line x1="8" y1="2" x2="8" y2="14"/><path d="M4 14h8"/><path d="M2 6l2-4 2 4a2 2 0 01-4 0z"/><path d="M10 6l2-4 2 4a2 2 0 01-4 0z"/></svg>,
    map:        <svg {...props}><path d="M1 3l5 2 4-2 5 2v10l-5-2-4 2-5-2V3z"/><line x1="6" y1="5" x2="6" y2="15"/><line x1="10" y1="3" x2="10" y2="13"/></svg>,
    eye:        <svg {...props}><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>,
    chart:      <svg {...props}><rect x="2" y="9" width="3" height="5" rx="0.5"/><rect x="6.5" y="5" width="3" height="9" rx="0.5"/><rect x="11" y="2" width="3" height="12" rx="0.5"/></svg>,
    pin:        <svg {...props}><path d="M8 1a4 4 0 014 4c0 3-4 9-4 9S4 8 4 5a4 4 0 014-4z"/><circle cx="8" cy="5" r="1.5" fill={color} strokeWidth="0"/></svg>,
    person:     <svg {...props}><circle cx="8" cy="5" r="3"/><path d="M2 15c0-3 2.7-5 6-5s6 2 6 5"/></svg>,
    bell:       <svg {...props}><path d="M6 13a2 2 0 004 0"/><path d="M3 10V7a5 5 0 0110 0v3l1 2H2l1-2z"/></svg>,
    bookmark:   <svg {...props}><path d="M4 2h8v13l-4-3-4 3V2z"/></svg>,
    doc:        <svg {...props}><path d="M10 2H4a1 1 0 00-1 1v10a1 1 0 001 1h8a1 1 0 001-1V5L10 2z"/><polyline points="10 2 10 5 13 5"/><line x1="5" y1="8" x2="11" y2="8"/><line x1="5" y1="11" x2="9" y2="11"/></svg>,
    warning:    <svg {...props}><path d="M8 2L1 14h14L8 2z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12.5" r="0.5" fill={color} strokeWidth="0"/></svg>,
    signal:     <svg {...props}><path d="M1 12a9 9 0 0114 0M4 12a5 5 0 018 0M7 12a1 1 0 012 0"/></svg>,
    gps:        <svg {...props}><circle cx="8" cy="8" r="2" fill={color} strokeWidth="0"/><circle cx="8" cy="8" r="5"/><line x1="8" y1="1" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="15"/><line x1="1" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="15" y2="8"/></svg>,
    logout:     <svg {...props}><path d="M10 2H4a1 1 0 00-1 1v10a1 1 0 001 1h6"/><polyline points="13 11 16 8 13 5"/><line x1="7" y1="8" x2="16" y2="8"/></svg>,
    chevronR:   <svg {...props}><polyline points="5 3 11 8 5 13"/></svg>,
    chevronL:   <svg {...props}><polyline points="11 3 5 8 11 13"/></svg>,
    x:          <svg {...props}><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>,
    check:      <svg {...props}><polyline points="2 8 6 12 14 4"/></svg>,
    turnRight:  <svg {...props}><path d="M4 14V6a4 4 0 014-4h4M8 6l4-4 4 4"/></svg>,
    finger:     <svg {...props}><path d="M8 2v6M5 5V4a1 1 0 012 0v1M11 5V4a1 1 0 00-2 0v1M5 8a1 1 0 00-1 1v1a4 4 0 008 0V9a1 1 0 00-2 0"/></svg>,
    store:      <svg {...props}><path d="M2 7l1-4h10l1 4"/><rect x="2" y="7" width="12" height="7" rx="1"/><path d="M6 14v-4h4v4"/></svg>,
    walk:       <svg {...props}><circle cx="8" cy="3" r="1.5"/><path d="M6 7l2-3 2 3M5 14l1-4 2 1 2-1 1 4"/></svg>,
    bus:        <svg {...props}><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M6 13v2M10 13v2"/><line x1="2" y1="7" x2="14" y2="7"/><circle cx="5" cy="11" r="1" fill={color} strokeWidth="0"/><circle cx="11" cy="11" r="1" fill={color} strokeWidth="0"/></svg>,
    bulb:       <svg {...props}><path d="M8 2a4 4 0 00-1.5 7.7V11h3V9.7A4 4 0 008 2z"/><line x1="6.5" y1="13" x2="9.5" y2="13"/><line x1="7" y1="14.5" x2="9" y2="14.5"/></svg>,
    compass:    <svg {...props}><circle cx="8" cy="8" r="6"/><polygon points="8 4 9.5 8 8 7 6.5 8" fill={color} strokeWidth="0"/><polygon points="8 12 6.5 8 8 9 9.5 8" fill={color} stroke={color} strokeWidth="0" opacity="0.4"/></svg>,
  };

  return <>{icons[name] ?? <svg {...props}><circle cx="8" cy="8" r="5"/></svg>}</>;
}

function PhaseIcon({ phase }: { phase: DayPhase }) {
  const map: Record<DayPhase, string> = { day: 'sun', golden: 'sunset', twilight: 'twilight', night: 'moon' };
  return <Icon name={map[phase]} size={14} color="rgba(255,255,255,0.6)" />;
}

function RouteIcon({ id }: { id: string }) {
  return <Icon name={id === 'visibility' ? 'shield' : id === 'fastest' ? 'bolt' : 'scales'} size={16} color="currentColor" />;
}

function ScoreBar({ score, color, bg = 'rgba(255,255,255,0.1)' }: { score: number; color: string; bg?: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: bg }}>
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${score}%`, backgroundColor: color }} />
      </div>
      <span className="text-xs font-semibold tabular-nums" style={{ color }}>{score}</span>
    </div>
  );
}

function MapFocus({ activeId }: { activeId: string }) {
  const map = useMap();
  const { routes: ROUTES } = useData();
  useEffect(() => {
    if (!ROUTES.length) return;
    map.fitBounds(L.latLngBounds(ROUTES.flatMap(r => r.coords)), { padding: [80, 120] });
  }, [activeId, map, ROUTES]);
  return null;
}

function dotIcon(color: string, size = 20) {
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;background:${color};border:3px solid rgba(255,255,255,0.9);border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.5)"></div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  });
}

// ─── TERMS MODAL ──────────────────────────────────────────────────────────────
function TermsModal({ onAccept, onClose }: { onAccept?: () => void; onClose: () => void }) {
  const { config: { strings: S } } = useData();
  const [checked, setChecked] = useState(false);
  const isInitial = !!onAccept;
  return (
    <div className="absolute inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(8,10,18,0.92)', backdropFilter: 'blur(6px)' }}>
      <div className="relative w-full max-w-md mx-4 flex flex-col"
        style={{ background: '#13151f', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '20px', boxShadow: '0 32px 80px rgba(0,0,0,0.7)', maxHeight: '90vh' }}>
        <div className="absolute -inset-px rounded-[20px] pointer-events-none overflow-hidden opacity-25">
          <div style={{ position:'absolute', top:'-40%', left:'-20%', width:'60%', height:'60%', background:'radial-gradient(circle, #1a73e8 0%, transparent 70%)' }} />
          <div style={{ position:'absolute', bottom:'-40%', right:'-20%', width:'60%', height:'60%', background:'radial-gradient(circle, #22c55e 0%, transparent 70%)' }} />
        </div>
        <div className="relative px-8 pt-8 pb-6 text-center" style={{ borderBottom:'1px solid rgba(255,255,255,0.07)' }}>
          {!isInitial && (
            <button onClick={onClose} className="absolute top-4 right-4 w-7 h-7 rounded-full flex items-center justify-center"
              style={{ background:'rgba(255,255,255,0.07)', color:'rgba(255,255,255,0.5)' }}>
              <Icon name="x" size={12} color="currentColor" />
            </button>
          )}
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-white text-xl font-bold mx-auto mb-4"
            style={{ background:'linear-gradient(135deg,#1a73e8,#22c55e)' }}>L</div>
          <h1 className="text-xl font-bold text-white mb-1">{S.TOS_TITLE}</h1>
          <p className="text-sm" style={{ color:'rgba(255,255,255,0.4)' }}>{S.APP_TAGLINE}</p>
        </div>
        <div className="relative px-8 py-6 overflow-y-auto flex-1">
          <p className="text-sm font-semibold text-white mb-3">Please read carefully before you start:</p>
          <div className="rounded-xl p-4 mb-5 text-sm leading-relaxed space-y-3"
            style={{ background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.06)' }}>
            <p style={{ color:'rgba(255,255,255,0.7)' }}>{S.TOS_BODY}</p>
          </div>
          {isInitial && (
            <>
              <label className="flex items-start gap-3 cursor-pointer mt-5 mb-6">
                <button type="button" role="checkbox" aria-checked={checked} aria-label={S.TOS_CHECKBOX} onClick={() => setChecked(!checked)}
                  className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0 mt-0.5 transition-all"
                  style={{ background:checked?'#22c55e':'transparent', border:checked?'2px solid #22c55e':'2px solid rgba(255,255,255,0.25)' }}>
                  {checked && <Icon name="check" size={10} color="white" strokeWidth={2.5} />}
                </button>
                <span className="text-sm" style={{ color:'rgba(255,255,255,0.7)' }}>{S.TOS_CHECKBOX}</span>
              </label>
              <div className="flex gap-3">
                <button className="flex-1 py-3 rounded-xl text-sm font-medium"
                  style={{ background:'rgba(255,255,255,0.06)', color:'rgba(255,255,255,0.4)', border:'1px solid rgba(255,255,255,0.08)' }}>Decline</button>
                <button disabled={!checked} onClick={() => checked && onAccept?.()} className="flex-1 py-3 rounded-xl text-sm font-bold transition-all"
                  style={{ background:checked?'#22c55e':'rgba(34,197,94,0.12)', color:checked?'#0f1117':'rgba(34,197,94,0.35)', cursor:checked?'pointer':'not-allowed' }}>
                  {S.TOS_PROCEED}
                </button>
              </div>
            </>
          )}
          {!isInitial && (
            <button onClick={onClose} className="w-full mt-6 py-3 rounded-xl text-sm font-semibold"
              style={{ background:'rgba(255,255,255,0.07)', color:'rgba(255,255,255,0.7)', border:'1px solid rgba(255,255,255,0.1)' }}>Close</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── ACCOUNT PANELS ───────────────────────────────────────────────────────────
function AccountPanelModal({ panel, onClose }: { panel: AccountPanel; onClose: () => void }) {
  if (!panel) return null;
  const titles: Record<NonNullable<AccountPanel>, { icon: string; label: string }> = {
    account:       { icon: 'person',   label: 'My Account'    },
    notifications: { icon: 'bell',     label: 'Notifications' },
    savedroutes:   { icon: 'bookmark', label: 'Saved Routes'  },
  };
  const { icon, label } = titles[panel];
  return (
    <div className="absolute inset-0 z-[180] flex items-center justify-center"
      style={{ background:'rgba(8,10,18,0.88)', backdropFilter:'blur(6px)' }}>
      <div className="relative w-full max-w-sm mx-4"
        style={{ background:'#13151f', border:'1px solid rgba(255,255,255,0.1)', borderRadius:'20px', boxShadow:'0 24px 60px rgba(0,0,0,0.6)' }}>
        <div className="flex items-center justify-between px-6 pt-5 pb-4" style={{ borderBottom:'1px solid rgba(255,255,255,0.07)' }}>
          <div className="flex items-center gap-2.5">
            <span style={{ color:'rgba(255,255,255,0.5)' }}><Icon name={icon} size={16} color="currentColor" /></span>
            <h2 className="text-sm font-bold text-white">{label}</h2>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-full flex items-center justify-center"
            style={{ background:'rgba(255,255,255,0.07)', color:'rgba(255,255,255,0.5)' }}>
            <Icon name="x" size={12} color="currentColor" />
          </button>
        </div>

        {panel === 'account' && (
          <div className="px-6 py-5 space-y-3">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0"
                style={{ background:'linear-gradient(135deg,#3b82f6,#8b5cf6)' }}>L</div>
              <div>
                <div className="text-sm font-semibold text-white">Guest</div>
                <div className="text-xs" style={{ color:'rgba(255,255,255,0.45)' }}>Local session</div>
              </div>
            </div>
            <p className="text-sm text-white">Account services are unavailable in this API.</p>
          </div>
        )}

        {panel === 'notifications' && (
          <div className="px-6 py-5 space-y-2.5">
            <p className="text-sm text-white">Escort notifications are simulated during navigation.</p>
          </div>
        )}

        {panel === 'savedroutes' && (
          <div className="px-6 py-5 space-y-2">
            <p className="text-sm text-white">Saved routes are unavailable in this API.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SETTINGS MENU ────────────────────────────────────────────────────────────
function SettingsMenu({ onOpenTerms, onOpenPanel, onClose }: {
  onOpenTerms: () => void;
  onOpenPanel: (p: AccountPanel) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div ref={ref} className="absolute top-12 right-0 z-[150] w-64 rounded-2xl overflow-hidden"
      style={{ background:'#1a1d29', border:'1px solid rgba(255,255,255,0.1)', boxShadow:'0 16px 48px rgba(0,0,0,0.6)' }}>
      <div className="px-4 py-4" style={{ borderBottom:'1px solid rgba(255,255,255,0.07)' }}>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
            style={{ background:'linear-gradient(135deg,#3b82f6,#8b5cf6)' }}>L</div>
          <div>
            <div className="text-sm font-semibold text-white">Guest</div>
            <div className="text-[11px]" style={{ color:'rgba(255,255,255,0.4)' }}>Local session</div>
          </div>
        </div>
      </div>
      <div className="py-2">
        {([
          { icon:'person',   label:'My Account',    sub:'Profile & preferences',    panel:'account'       },
          { icon:'bell',     label:'Notifications', sub:'Alerts & escort contacts', panel:'notifications' },
          { icon:'bookmark', label:'Saved Routes',  sub:'Not available',           panel:'savedroutes'   },
        ] as { icon:string; label:string; sub:string; panel:AccountPanel }[]).map(({ icon, label, sub, panel }) => (
          <button key={label} onClick={() => { onOpenPanel(panel); onClose(); }}
            className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5">
            <span style={{ color:'rgba(255,255,255,0.45)' }}><Icon name={icon} size={15} color="currentColor" /></span>
            <div className="flex-1">
              <div className="text-sm text-white">{label}</div>
              <div className="text-[10px]" style={{ color:'rgba(255,255,255,0.35)' }}>{sub}</div>
            </div>
            <span style={{ color:'rgba(255,255,255,0.25)' }}><Icon name="chevronR" size={12} color="currentColor" /></span>
          </button>
        ))}
        <div className="mx-4 my-1" style={{ height:'1px', background:'rgba(255,255,255,0.06)' }} />
        <button onClick={() => { onOpenTerms(); onClose(); }}
          className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5">
          <span style={{ color:'rgba(255,255,255,0.45)' }}><Icon name="doc" size={15} color="currentColor" /></span>
          <div className="flex-1">
            <div className="text-sm text-white">Terms &amp; Conditions</div>
            <div className="text-[10px]" style={{ color:'rgba(255,255,255,0.35)' }}>Last accepted today</div>
          </div>
          <span style={{ color:'rgba(255,255,255,0.25)' }}><Icon name="chevronR" size={12} color="currentColor" /></span>
        </button>
        <div className="mx-4 my-1" style={{ height:'1px', background:'rgba(255,255,255,0.06)' }} />
        <button className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5">
          <span style={{ color:'rgba(239,68,68,0.6)' }}><Icon name="logout" size={15} color="currentColor" /></span>
          <div className="text-sm" style={{ color:'rgba(239,68,68,0.8)' }}>Sign Out</div>
        </button>
      </div>
    </div>
  );
}

// ─── LEFT PANEL ───────────────────────────────────────────────────────────────
function LeftPanel({
  activeRoute, setActiveRoute, phase, now, sunTimes, navigating, onStartNav, onStopNav,
  sidebarOpen, setSidebarOpen, fromLocation, setFromLocation, toLocation, setToLocation, loading, error, mode, setMode, overlayOn, setOverlayOn, phone, setPhone, pollRate, onRetry,
}: {
  onRetry: () => void; loading: boolean; error: string; mode: string; setMode: (s: string) => void; overlayOn: boolean; setOverlayOn: (b: boolean) => void; phone: string; setPhone: (s: string) => void; pollRate: number;
  activeRoute: string; setActiveRoute: (id: string) => void;
  phase: DayPhase; now: Date; sunTimes: ReturnType<typeof getTimes>;
  navigating: boolean; onStartNav: () => void; onStopNav: () => void;
  sidebarOpen: boolean; setSidebarOpen: (v: boolean) => void;
  fromLocation: string; setFromLocation: (v: string) => void;
  toLocation: string; setToLocation: (v: string) => void;
}) {
  const { routes: ROUTES, config: { strings: S } } = useData();
  const active = ROUTES.find(r => r.id === activeRoute);

  return (
    <>
      <div className="absolute left-0 top-0 bottom-16 z-30 flex flex-col overflow-hidden"
        style={{
          width: `${SIDEBAR_W}px`,
          background: '#13151f',
          borderRight: '1px solid rgba(255,255,255,0.06)',
          transform: sidebarOpen ? 'translateX(0)' : `translateX(-${SIDEBAR_W}px)`,
          transition: 'transform 0.3s cubic-bezier(0.4,0,0.2,1)',
        }}>

        {/* Header */}
        <div className="px-4 pt-5 pb-4 flex-shrink-0" style={{ borderBottom:'1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                style={{ background:'linear-gradient(135deg,#3b82f6,#22c55e)' }}>L</div>
              <div>
                <div className="text-sm font-semibold text-white">Lumina</div>
                <div className="text-[10px] leading-none" style={{ color:'rgba(255,255,255,0.4)' }}>{S.APP_TAGLINE}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <PhaseIcon phase={phase} />
              <div className="text-right">
                <div className="text-xs font-semibold text-white tabular-nums">{formatTime(now)}</div>
                <div className="text-[10px]" style={{ color:'rgba(255,255,255,0.4)' }}>{TILE[phase].label}</div>
              </div>
            </div>
          </div>

          {/* Sun strip */}
          <div className="rounded-xl px-3 py-2 mb-4 flex items-center gap-2" style={{ background:'rgba(255,255,255,0.05)' }}>
            <span style={{ color:'rgba(255,255,255,0.4)' }}><Icon name="sunrise" size={14} color="currentColor" /></span>
            <div className="flex-shrink-0">
              <div className="text-[10px]" style={{ color:'rgba(255,255,255,0.4)' }}>Rise</div>
              <div className="text-xs font-semibold text-white">{formatTime(sunTimes.sunrise)}</div>
            </div>
            <div className="flex-1 mx-2 h-1.5 rounded-full overflow-hidden" style={{ background:'rgba(255,255,255,0.08)' }}>
              <div className="h-full rounded-full" style={{
                width: `${sunTimes.sunrise && sunTimes.sunset ? Math.max(0, Math.min(100, (now.getTime() - sunTimes.sunrise.getTime()) / (sunTimes.sunset.getTime() - sunTimes.sunrise.getTime()) * 100)) : 0}%`,
                background: phase === 'night' ? 'rgba(148,163,184,0.4)' : phase === 'golden' ? 'linear-gradient(to right,#fb923c,#fbbf24)' : 'linear-gradient(to right,#fbbf24,#f59e0b)',
              }} />
            </div>
            <div className="flex-shrink-0 text-right">
              <div className="text-[10px]" style={{ color:'rgba(255,255,255,0.4)' }}>Set</div>
              <div className="text-xs font-semibold text-white">{formatTime(sunTimes.sunset)}</div>
            </div>
            <span style={{ color:'rgba(255,255,255,0.4)' }}><Icon name="sunset" size={14} color="currentColor" /></span>
          </div>

          {/* Location inputs */}
          <div className="space-y-2">
            <div className="flex items-center gap-2.5 rounded-xl px-3 py-2.5"
              style={{ background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.08)' }}>
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor:'#60a5fa' }} />
              <input
                value={fromLocation}
                onChange={e => setFromLocation(e.target.value)}
                aria-label={S.SIDEBAR_START} placeholder={S.SIDEBAR_START}
                disabled={navigating}
                className="flex-1 bg-transparent outline-none text-sm"
                style={{ color:'rgba(255,255,255,0.85)', caretColor:'#60a5fa' }}
              />
              {fromLocation && !navigating && (
                <button onClick={() => setFromLocation('')} style={{ color:'rgba(255,255,255,0.3)' }}>
                  <Icon name="x" size={12} color="currentColor" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2.5 rounded-xl px-3 py-2.5"
              style={{ background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.08)' }}>
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor:'#f87171' }} />
              <input
                value={toLocation}
                onChange={e => setToLocation(e.target.value)}
                aria-label={S.SIDEBAR_END} placeholder={S.SIDEBAR_END}
                disabled={navigating}
                className="flex-1 bg-transparent outline-none text-sm"
                style={{ color:'rgba(255,255,255,0.85)', caretColor:'#f87171' }}
              />
              {toLocation && !navigating && (
                <button onClick={() => setToLocation('')} style={{ color:'rgba(255,255,255,0.3)' }}>
                  <Icon name="x" size={12} color="currentColor" />
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="px-4 py-2 space-y-2 text-xs text-white">
          <select aria-label={S.SIDEBAR_MODE} disabled={navigating} value={mode} onChange={e => setMode(e.target.value)} className="w-full rounded-xl p-2 bg-[#1a1d29]">
            {S.MODE_OPTIONS.map(label => <option key={label} value={S.MODE_TO_KEY[label]}>{label}</option>)}
          </select>
          <input aria-label={S.SIDEBAR_PHONE} placeholder={S.SIDEBAR_PHONE} value={phone} disabled={navigating} onChange={e => setPhone(e.target.value)} className="w-full rounded-xl p-2 bg-white/5" />
          <label className="flex gap-2"><input type="checkbox" checked={overlayOn} onChange={e => setOverlayOn(e.target.checked)} />{S.SIDEBAR_OVERLAY}</label>
          <p role="status">{loading ? 'Loading routes...' : error}{error && <button onClick={onRetry} className="ml-2 underline">Retry</button>}</p>
          {navigating && <p>{S.ESCORT_POLL_LABEL}: {pollRate} s | {S.SIM_GPS} | {S.SIM_SMS} | {S.SIM_CLOUD}</p>}
        </div>
        {/* Legend */}
        <div className="px-4 py-2.5 flex items-center justify-between flex-shrink-0"
          style={{ background:'rgba(0,0,0,0.2)', borderBottom:'1px solid rgba(255,255,255,0.05)' }}>
          <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color:'rgba(255,255,255,0.3)' }}>{ROUTES.length} Routes Found</span>
          <div className="flex gap-3">
            {ROUTES.map(r => (
              <div key={r.id} className="flex items-center gap-1.5">
                <div className="w-4 h-0.5 rounded-full" style={{ backgroundColor:r.color }} />
                <span className="text-[10px]" style={{ color:'rgba(255,255,255,0.35)' }}>
                  {r.id === 'visibility' ? 'Vis.' : r.id === 'fastest' ? 'Fast' : 'Pract.'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Route cards */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5">
          {ROUTES.map(route => {
            const isActive = route.id === activeRoute;
            return (
              <button key={route.id} onClick={() => !navigating && setActiveRoute(route.id)}
                className="w-full text-left rounded-xl overflow-hidden transition-all duration-200"
                style={{
                  background: isActive ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.03)',
                  border: isActive ? `1.5px solid ${route.color}45` : '1.5px solid rgba(255,255,255,0.06)',
                  boxShadow: isActive ? `0 0 0 1px ${route.color}18,0 4px 20px rgba(0,0,0,0.3)` : 'none',
                  opacity: navigating && !isActive ? 0.4 : 1,
                  cursor: navigating && !isActive ? 'default' : 'pointer',
                }}>
                <div className="px-4 pt-3.5 pb-3">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      <span style={{ color: isActive ? route.color : 'rgba(255,255,255,0.4)' }}>
                        <RouteIcon id={route.id} />
                      </span>
                      <div>
                        <div className="text-sm font-semibold text-white">{route.name}</div>
                        <div className="text-[11px]" style={{ color:'rgba(255,255,255,0.4)' }}>{route.tagline}</div>
                      </div>
                    </div>
                    {isActive && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                        style={{ background:route.color+'22', color:route.color, border:`1px solid ${route.color}40` }}>
                        {navigating ? 'Navigating' : 'Active'}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-4 mb-3">
                    {[{ v:route.duration, l:S.METRIC_ETA },{ v:route.distance, l:S.METRIC_DISTANCE },{ v:String(route.safetyScore), l:S.METRIC_MEAN_SCORE, accent:true }].map((s,i) => (
                      <div key={i} className="flex-1">
                        <div className="text-base font-bold leading-none" style={{ color:(s as any).accent?route.color:'rgba(255,255,255,0.9)' }}>{s.v}</div>
                        <div className="text-[10px] mt-0.5" style={{ color:'rgba(255,255,255,0.35)' }}>{s.l}</div>
                      </div>
                    ))}
                  </div>
                  <ScoreBar score={route.safetyScore} color={route.color} />
                  {route.highlights.map((h,i) => (
                    <div key={i} className="flex items-center gap-2 text-[11px] mt-1.5" style={{ color:'rgba(255,255,255,0.5)' }}>
                      <div className="w-1 h-1 rounded-full flex-shrink-0" style={{ backgroundColor:route.color }} />{h}
                    </div>
                  ))}
                </div>
                <div className="h-[2px]" style={{ backgroundColor:route.color, opacity:isActive?0.65:0.18 }} />
              </button>
            );
          })}
        </div>

        {/* CTA */}
        <div className="px-4 pb-4 pt-3 flex-shrink-0" style={{ borderTop:'1px solid rgba(255,255,255,0.06)' }}>
          {navigating ? (
            <div className="space-y-2">
              <div className="rounded-xl px-4 py-2.5 text-center text-xs" style={{ background:'rgba(34,197,94,0.1)', border:'1px solid rgba(34,197,94,0.25)', color:'#22c55e' }}>
                Navigating · {active?.duration} estimated
              </div>
              <button onClick={onStopNav} className="w-full py-2.5 rounded-xl text-sm font-semibold"
                style={{ background:'rgba(239,68,68,0.12)', color:'#ef4444', border:'1px solid rgba(239,68,68,0.3)' }}>
                {S.NAV_STOP_BTN}
              </button>
            </div>
          ) : (
            <button disabled={!active || loading || !!error} onClick={onStartNav}
              className="w-full py-3 rounded-xl text-sm font-bold transition-all hover:brightness-110 active:scale-[0.98]"
              style={{ backgroundColor:active?.color, color:'#0f1117' }}>
              {S.NAV_START_BTN} →
            </button>
          )}
          <p className="text-[10px] text-center mt-2 leading-relaxed" style={{ color:'rgba(255,255,255,0.2)' }}>
            {S.APP_DESCRIPTION}
          </p>
        </div>
      </div>

      {/* Collapse tab */}
      <button onClick={() => setSidebarOpen(!sidebarOpen)}
        className="absolute top-1/2 z-40 flex items-center justify-center transition-all duration-300"
        style={{
          left: sidebarOpen ? `${SIDEBAR_W - 1}px` : '0px',
          transform: 'translateY(-50%)',
          width: '20px', height: '52px',
          background: '#1e2132',
          borderRadius: '0 8px 8px 0',
          border: '1px solid rgba(255,255,255,0.1)',
          borderLeft: sidebarOpen ? 'none' : '1px solid rgba(255,255,255,0.1)',
          color: 'rgba(255,255,255,0.45)',
        }}>
        <span style={{ transform: sidebarOpen ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.3s', display:'flex' }}>
          <Icon name="chevronL" size={11} color="currentColor" />
        </span>
      </button>
    </>
  );
}

// ─── ESCORT BANNER ────────────────────────────────────────────────────────────
function EscortModeBanner({ sidebarOpen, onDeactivate, route, notified }: { sidebarOpen: boolean; onDeactivate: () => void; route: Route; notified: boolean }) {
  const { config: { strings: S, constants: C } } = useData();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => { const id = setInterval(() => setElapsed(e => e+1), 1000); return () => clearInterval(id); }, []);
  const mins = Math.floor(elapsed/60).toString().padStart(2,'0');
  const secs = (elapsed%60).toString().padStart(2,'0');

  return (
    <div className={`escort-banner-position${sidebarOpen ? ' escort-sidebar-open' : ''}`}>
      <div aria-hidden="true" className="escort-viewport-glow" />
      <div className="escort-banner rounded-2xl overflow-hidden pointer-events-auto">
        <div className="flex flex-wrap items-start gap-3 px-4 py-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-2 mb-2">
              <span className="shrink-0" aria-hidden="true"><Icon name="warning" size={32} color="white" /></span>
              <h2 className="text-2xl font-bold uppercase leading-tight">Escort Mode Active</h2>
            </div>
            <p className="text-lg leading-relaxed">
              {ESCORT_MESSAGE}
            </p>
          </div>
          <div className="flex w-full items-center justify-end gap-3">
            <span className="text-base font-mono tabular-nums">{mins}:{secs}</span>
            <button onClick={onDeactivate} className="shrink-0 text-sm font-bold px-4 py-2 rounded-lg"
              style={{ background:'#750012', color:'#ffffff', border:'2px solid #ffffff', minHeight:44 }}>
              End
            </button>
          </div>
        </div>
        <div className="grid grid-cols-3" style={{ background:'#750012', borderTop:'1px solid #ffffff' }}>
          {[
            { icon:'gps',    label:S.SIM_GPS, value:`${C.POLL_ESCORT_S} s` },
            { icon:'signal', label:S.SIM_CLOUD, value:'Simulated'     },
            { icon:'bell',   label:S.SIM_SMS, value:notified ? 'Recorded' : 'Pending'    },
          ].map(({ icon, label, value }) => (
            <div key={label} className="flex min-w-0 flex-col items-center px-1 py-2.5 text-center" style={{ borderRight:'1px solid #ffffff' }}>
              <span className="mb-1"><Icon name={icon} size={16} color="currentColor" /></span>
              <span className="text-sm font-semibold">{value}</span>
              <span className="text-xs">{label}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 rounded-xl px-4 py-2.5 flex items-center gap-3"
        style={{ background:'#FFB300', color:'#211500', border:'1px solid #211500' }}>
        <span style={{ flexShrink:0 }}><Icon name="warning" size={15} color="currentColor" /></span>
        <div className="min-w-0 text-sm font-bold">
          <span>{S.METRIC_MIN_SCORE}: {route.min_score.toFixed(1)} / 100 </span>
          <span>— threshold {C.ESCORT_THRESHOLD}</span>
        </div>
      </div>
    </div>
  );
}

// ─── EYES UP ──────────────────────────────────────────────────────────────────
function EyesUpOverlay({ onUnlock }: { onUnlock: () => void }) {
  const { config: { strings: S } } = useData();
  const lastTap = useRef<number>(0);
  function handleDoubleTap(e: React.MouseEvent | React.TouchEvent) {
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTap.current < 350) { onUnlock(); lastTap.current = 0; }
    else lastTap.current = now;
  }
  return (
    <div className="absolute inset-0 z-[160] flex flex-col items-center justify-center select-none cursor-pointer"
      style={{ background:'rgba(8,10,18,0.94)', backdropFilter:'blur(8px)' }}
      onClick={handleDoubleTap} onTouchEnd={handleDoubleTap}>
      <div className="absolute top-0 left-0 right-0 h-1 bg-white/5">
        <div className="h-full bg-green-400/60" style={{ width:'100%' }} />
      </div>
      <div className="mb-8 relative">
        <div className="w-28 h-28 rounded-full flex items-center justify-center"
          style={{ background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.1)' }}>
          <Icon name="eye" size={52} color="rgba(255,255,255,0.75)" strokeWidth={0.8} />
        </div>
        <div className="absolute inset-0 rounded-full animate-ping opacity-10"
          style={{ background:'rgba(255,255,255,0.3)', animationDuration:'3s' }} />
      </div>
      <h2 className="text-2xl font-bold text-white mb-2 text-center">{S.EYES_UP_TITLE}</h2>
      <p className="text-base text-center mb-2 max-w-xs leading-relaxed" style={{ color:'rgba(255,255,255,0.55)' }}>
        {S.EYES_UP_BODY}
      </p>
      <p className="text-sm text-center mb-10" style={{ color:'rgba(255,255,255,0.35)' }}>{S.SIM_GPS}</p>
      <div className="flex items-center gap-2.5 px-5 py-2.5 rounded-full"
        style={{ background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.1)' }}>
        <Icon name="finger" size={15} color="rgba(255,255,255,0.5)" />
        <button onClick={e => { e.stopPropagation(); onUnlock(); }} className="text-sm" style={{ color:'rgba(255,255,255,0.5)' }}>{S.EYES_UP_UNLOCK}</button>
      </div>
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 rounded-2xl px-5 py-3 flex items-center gap-3"
        style={{ background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.1)', backdropFilter:'blur(12px)' }}>
        <Icon name="turnRight" size={18} color="rgba(255,255,255,0.6)" />
        <div>
          <div className="text-xs text-white font-semibold">{S.NAV_PROGRESS}</div>
          <div className="text-[10px]" style={{ color:'rgba(255,255,255,0.4)' }}>{S.ESCORT_SIMULATED_NOTE}</div>
        </div>
      </div>
    </div>
  );
}

// ─── ROUTE STATS ──────────────────────────────────────────────────────────────
function RouteStatsPanel({ activeRoute, setActiveRoute }: { activeRoute: string; setActiveRoute: (id: string) => void }) {
  const { routes: ROUTES, config: { strings: S } } = useData();
  const route = ROUTES.find(r => r.id === activeRoute);
  if (!route) return null;
  const scoreColor = route.safetyScore >= 80 ? '#22c55e' : route.safetyScore >= 60 ? '#fb923c' : '#ef4444';
  return (
    <div className="absolute right-0 top-0 bottom-16 z-30 w-[420px] flex flex-col"
      style={{ background:'#13151f', borderLeft:'1px solid rgba(255,255,255,0.06)' }}>
      <div className="px-6 pt-6 pb-5 flex-shrink-0" style={{ borderBottom:'1px solid rgba(255,255,255,0.06)' }}>
        <div className="text-[11px] font-semibold uppercase tracking-widest mb-3" style={{ color:'rgba(255,255,255,0.3)' }}>Route Analysis</div>
        <div className="flex gap-1 p-1 rounded-xl mb-5" style={{ background:'rgba(255,255,255,0.04)' }}>
          {ROUTES.map(r => (
            <button key={r.id} onClick={() => setActiveRoute(r.id)} className="flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5"
              style={r.id === activeRoute?{ background:r.color+'20', color:r.color, border:`1px solid ${r.color}40` }:{ color:'rgba(255,255,255,0.3)' }}>
              <RouteIcon id={r.id} />
              {r.id === 'visibility' ? 'Vis.' : r.id === 'fastest' ? 'Fast' : 'Pract.'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-5">
          <div className="relative flex-shrink-0">
            <svg width="90" height="90" viewBox="0 0 90 90">
              <circle cx="45" cy="45" r="38" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8"/>
              <circle cx="45" cy="45" r="38" fill="none" stroke={scoreColor} strokeWidth="8"
                strokeDasharray={`${2*Math.PI*38}`} strokeDashoffset={`${2*Math.PI*38*(1-route.safetyScore/100)}`}
                strokeLinecap="round" transform="rotate(-90 45 45)"/>
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-2xl font-bold text-white leading-none">{route.safetyScore}</span>
              <span className="text-[10px]" style={{ color:'rgba(255,255,255,0.4)' }}>/ 100</span>
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span style={{ color:route.color }}><RouteIcon id={route.id} /></span>
              <span className="text-base font-bold text-white">{route.name}</span>
            </div>
            <div className="text-xs mb-2.5" style={{ color:'rgba(255,255,255,0.45)' }}>{route.tagline}</div>
            <div className="flex gap-4">
              {[{ v:route.duration, l:'time' },{ v:route.distance, l:S.METRIC_DISTANCE }].map(({ v, l }) => (
                <div key={l}><div className="text-sm font-bold text-white">{v}</div><div className="text-[10px]" style={{ color:'rgba(255,255,255,0.35)' }}>{l}</div></div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-widest mb-3" style={{ color:'rgba(255,255,255,0.3)' }}>{S.METRIC_MEAN_SCORE}</div>
          <div className="space-y-3">
            {[{ label:S.METRIC_MEAN_SCORE, score:route.mean_score, icon:'eye' },{ label:S.METRIC_MIN_SCORE, score:route.min_score, icon:'eye' }].map(({ label, score, icon }) => (
              <div key={label}>
                <div className="flex justify-between items-center mb-1.5">
                  <div className="flex items-center gap-2 text-xs" style={{ color:'rgba(255,255,255,0.6)' }}>
                    <Icon name={icon} size={13} color="currentColor" /><span>{label}</span>
                  </div>
                  <span className="text-xs font-semibold" style={{ color:scoreColor }}>{Math.min(100,Math.max(0,score))}</span>
                </div>
                <ScoreBar score={Math.min(100,Math.max(0,score))} color={scoreColor} bg="rgba(255,255,255,0.06)" />
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-widest mb-3" style={{ color:'rgba(255,255,255,0.3)' }}>{S.METRIC_LOW_SEGS}: {route.n_low_segments}</div>
          <div className="space-y-2">
            {route.segments.map((seg, i) => {
              const c = seg.score>=80?'#22c55e':seg.score>=60?'#fb923c':'#ef4444';
              return (
                <div key={i} className="rounded-xl px-4 py-3" style={{ background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.06)' }}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium text-white">{seg.name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px]" style={{ color:'rgba(255,255,255,0.35)' }}>{seg.dist}</span>
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background:c+'20', color:c }}>{seg.status}</span>
                    </div>
                  </div>
                  <ScoreBar score={seg.score} color={c} bg="rgba(255,255,255,0.06)" />
                </div>
              );
            })}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-widest mb-3" style={{ color:'rgba(255,255,255,0.3)' }}>Compare All Routes</div>
          <div className="space-y-2">
            {ROUTES.map(r => (
              <div key={r.id} onClick={() => setActiveRoute(r.id)}
                className="rounded-xl px-4 py-3 flex items-center gap-3 cursor-pointer transition-all hover:bg-white/5"
                style={{ background:r.id===activeRoute?'rgba(255,255,255,0.07)':'rgba(255,255,255,0.03)', border:r.id===activeRoute?`1px solid ${r.color}40`:'1px solid rgba(255,255,255,0.05)' }}>
                <span style={{ color:r.color }}><RouteIcon id={r.id} /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-white truncate">{r.name}</div>
                  <div className="text-[10px]" style={{ color:'rgba(255,255,255,0.35)' }}>{r.duration} · {r.distance}</div>
                </div>
                <div className="text-sm font-bold" style={{ color:r.color }}>{r.safetyScore}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── BOTTOM NAV ───────────────────────────────────────────────────────────────
const NAV_ITEMS: { id: Screen; label: string; icon: string }[] = [
  { id:'map',    label:'Map',         icon:'map'   },
  { id:'escort', label:'Escort',      icon:'shield'},
  { id:'eyesup', label:'Eyes Up',     icon:'eye'   },
  { id:'stats',  label:'Stats',       icon:'chart' },
];

function BottomNav({ screen, setScreen, escortActive }: { screen: Screen; setScreen: (s: Screen) => void; escortActive: boolean }) {
  return (
    <div className="absolute bottom-0 left-0 right-0 z-50 flex"
      style={{ height:'64px', background:'#0f1117', borderTop:'1px solid rgba(255,255,255,0.08)' }}>
      {NAV_ITEMS.map(item => {
        const isActive = item.id === screen;
        const hasAlert = item.id === 'escort' && escortActive;
        return (
          <button key={item.id} onClick={() => setScreen(item.id)}
            className="relative flex-1 flex flex-col items-center justify-center gap-1.5 transition-all">
            <div className="relative">
              <span style={{ color: isActive ? 'white' : 'rgba(255,255,255,0.35)', display:'flex' }}>
                <Icon name={item.icon} size={18} color="currentColor" strokeWidth={isActive ? 1.8 : 1.4} />
              </span>
              {hasAlert && (
                <div className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500 border border-[#0f1117]" />
              )}
            </div>
            <span className="text-[10px] font-semibold" style={{ color: isActive?'rgba(255,255,255,0.9)':'rgba(255,255,255,0.35)' }}>
              {item.label}
            </span>
            {isActive && <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-white opacity-60" />}
          </button>
        );
      })}
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    getConfig(controller.signal).then(setConfig).catch(() => { if (!controller.signal.aborted) setError("Can't reach the server"); });
    return () => controller.abort();
  }, [attempt]);
  if (!config) return <div className="w-screen h-screen flex flex-col items-center justify-center text-white bg-[#0f1117]" role="status">
    {error || 'Loading...'}{error && <button className="mt-4 rounded-xl px-4 py-3 bg-white/10" onClick={() => setAttempt(a => a + 1)}>Retry</button>}
  </div>;
  return <Lumina config={config} />;
}

function Lumina({ config }: { config: Config }) {
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(true);
  const [screen, setScreen] = useState<Screen>('map');
  const [activeRoute, selectRoute] = useState('visibility');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountPanel, setAccountPanel] = useState<AccountPanel>(null);
  const [now, setNow] = useState(() => new Date());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [navigating, setNavigating] = useState(false);
  const [fromLocation, setFromLocation] = useState(config.default_start.join(', '));
  const [toLocation, setToLocation] = useState(config.default_end.join(', '));
  const [ROUTES, setRoutes] = useState<Route[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('walk');
  const [routeAttempt, setRouteAttempt] = useState(0);
  const [phone, setPhone] = useState('');
  const [overlayOn, setOverlayOn] = useState(false);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [overlayError, setOverlayError] = useState('');
  const [position, setPosition] = useState<Coordinate | null>(null);
  const [notified, setNotified] = useState(false);
  const [navError, setNavError] = useState('');
  const [unlockUntil, setUnlockUntil] = useState(0);
  const [eyesDim, setEyesDim] = useState(false);
  const navSession = useRef<AbortController | null>(null);
  const starting = useRef(false);
  const feedbackSession = useRef<{ context: FeedbackContext; opened: boolean } | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackContext, setFeedbackContext] = useState<FeedbackContext | null>(null);
  const closeFeedback = useCallback(() => setFeedbackOpen(false), []);
  const selected = ROUTES.find(r => r.id === activeRoute);
  const snapshotFeedback = (route: Route, escortTriggered: boolean): FeedbackContext => ({
    route_id: route.id as FeedbackContext['route_id'],
    mode: mode === 'bike' ? 'cyclist' : mode === 'run' ? 'runner' : 'pedestrian',
    hour: Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: 'numeric', hourCycle: 'h23' }).format(new Date())),
    escort_triggered: escortTriggered, min_score: route.min_score, length_m: route.length_m,
  });
  const openFeedback = () => {
    const session = feedbackSession.current;
    if (session) session.opened = true;
    setFeedbackContext(session?.context ?? (selected ? snapshotFeedback(selected, false) : null));
    setFeedbackOpen(true);
  };
  const escortActive = navigating && !!selected?.needs_escort;
  const pollRate = escortActive ? config.constants.POLL_ESCORT_S : config.constants.POLL_NORMAL_S;
  const setActiveRoute = (id: string) => { if (!navigating && !starting.current) { selectRoute(id); setPosition(null); } };
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!termsAccepted) return;
    const controller = new AbortController();
    setRoutes([]); setPosition(null); setError(''); setLoading(true);
    const timer = setTimeout(async () => {
      const start = parseCoordinate(fromLocation), end = parseCoordinate(toLocation);
      if (!start || !end) { setError('No route found'); setLoading(false); return; }
      try {
        const response = await getRoutes(start, end, mode, controller.signal);
        if (controller.signal.aborted) return;
        const routes = response.routes.filter(r => r.coords.length > 0).map(r => adaptRoute(r, config.strings));
        setRoutes(routes);
        selectRoute(current => routes.some(r => r.id === current) ? current : routes[0]?.id || 'visibility');
        if (!routes.length) setError('No route found');
      } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [fromLocation, toLocation, mode, config, termsAccepted, routeAttempt]);
  useEffect(() => {
    if (!overlayOn || !termsAccepted) return;
    const controller = new AbortController();
    setOverlayError('');
    getOverlay(controller.signal).then(data => { if (!controller.signal.aborted) setOverlay(data); })
      .catch((e: Error) => { if (!controller.signal.aborted) setOverlayError(e.message); });
    return () => controller.abort();
  }, [overlayOn, termsAccepted]);
  const center = config.map_center;
  const phase = useMemo(() => getDayPhase(now, center), [now, center]);
  const sunTimes = useMemo(() => getTimes(now, ...center), [now, center]);
  const stopNavigation = useCallback(() => {
    navSession.current?.abort(); starting.current = false;
    setNavigating(false); setSidebarOpen(true); setEyesDim(false); setScreen('map');
    const session = feedbackSession.current;
    if (session && !session.opened) {
      session.opened = true;
      setFeedbackContext(session.context); setFeedbackOpen(true);
    }
  }, []);
  const startNavigation = () => {
    if (!termsAccepted || !selected || loading || error || navigating || starting.current) return;
    starting.current = true;
    feedbackSession.current = { context: snapshotFeedback(selected, selected.needs_escort), opened: false };
    navSession.current?.abort();
    const controller = new AbortController(); navSession.current = controller;
    setNavError(''); setNotified(false); setPosition(selected.coords[0]);
    setUnlockUntil(0); setEyesDim(false); setNavigating(true); setSidebarOpen(false); setScreen('map');
    if (selected.needs_escort) {
      // This guarded start runs once per navigation session, independent of rerenders.
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate([200, 100, 200]);
      } catch { /* Optional device feedback must not interrupt navigation. */ }
      try {
        if (typeof window !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function' && typeof window.speechSynthesis?.speak === 'function') {
          window.speechSynthesis.speak(new window.SpeechSynthesisUtterance(ESCORT_MESSAGE));
        }
      } catch { /* Speech may be unavailable or blocked by the browser. */ }
      postNotify(phone, selected.id, controller.signal).then(() => {
        if (!controller.signal.aborted) setNotified(true);
      }).catch((e: Error) => { if (!controller.signal.aborted) setNavError(e.message + ' ? ' + config.strings.ERR_CONTACT); });
    }
  };
  useEffect(() => {
    if (!navigating || !selected) return;
    let index = 0;
    const controller = navSession.current!;
    const tick = setInterval(() => {
      if (controller.signal.aborted) return;
      if (index >= selected.coords.length) { stopNavigation(); return; }
      const point = selected.coords[index++];
      setPosition(point);
      postTelemetry({ lat: point[0], lon: point[1], route_id: selected.id, escort_active: selected.needs_escort }, controller.signal)
        .catch((e: Error) => {
          if (!controller.signal.aborted) { setNavError(e.message + ' ? ' + config.strings.ERR_TELEMETRY); stopNavigation(); }
        });
      if (index >= selected.coords.length) stopNavigation();
    }, 1000);
    return () => clearInterval(tick);
  }, [navigating, selected, config, stopNavigation]);
  useEffect(() => () => { navSession.current?.abort(); }, []);
  useEffect(() => {
    if (!navigating) return;
    const delay = unlockUntil ? Math.max(0, unlockUntil - Date.now()) : config.constants.EYES_UP_DELAY_S * 1000;
    const timer = setTimeout(() => {
      setEyesDim(true);
      if ('speechSynthesis' in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(config.strings.EYES_UP_AUDIO_CUE));
    }, delay);
    return () => { clearTimeout(timer); if ('speechSynthesis' in window) window.speechSynthesis.cancel(); };
  }, [navigating, unlockUntil, config]);
  const dismissEyesUp = () => { setEyesDim(false); setScreen('map'); if (navigating) setUnlockUntil(Date.now() + 10000); };
  const handleAcceptTerms = () => { setTermsAccepted(true); setShowTermsModal(false); };

  return (
    <DataContext.Provider value={{ config, routes: ROUTES }}>
    <div className="relative w-screen h-screen overflow-hidden"
      style={{ background:'#0f1117', fontFamily:"'DM Sans','Inter',sans-serif" }}>

      <div inert={!termsAccepted || showTermsModal || feedbackOpen} style={{ display: 'contents' }}>
      {/* Map */}
      {termsAccepted && <MapContainer center={config.map_center} zoom={15} zoomControl={false}
        style={{ position:'absolute', inset:0, zIndex:0 }}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' />
        <MapFocus activeId={activeRoute} />
        {overlayOn && overlay?.features.map((feature, i) => <Polyline key={`segment-${i}`} positions={feature.geometry.coordinates}
          pathOptions={{ color:`hsl(${Math.max(0, Math.min(100, feature.properties.mean_score)) * 1.2}, 80%, 45%)`, weight:4, opacity:0.65 }} />)}
        {ROUTES.filter(r => r.id === 'visibility').map(r => <Polyline key={`glow-${r.id}`} positions={r.coords} pathOptions={{ color:r.color, weight:18, opacity:0.25 }} />)}
        {[...ROUTES.filter(r => r.id !== activeRoute), ...ROUTES.filter(r => r.id === activeRoute)].map(r => <Polyline key={r.id} positions={r.coords}
          pathOptions={{ color:r.color, weight:r.id === activeRoute ? 7 : 5, opacity:r.id === activeRoute ? 1 : 0.55 }} eventHandlers={{ click:() => setActiveRoute(r.id) }} />)}
        {selected && <>
          <Marker position={selected.coords[0]} icon={dotIcon('#60a5fa')}><Popup>{config.strings.SIDEBAR_START}</Popup></Marker>
          <Marker position={selected.coords[selected.coords.length - 1]} icon={dotIcon('#f87171')}><Popup>{config.strings.SIDEBAR_END}</Popup></Marker>
        </>}
        {position && <Marker position={position} icon={dotIcon('#ffffff', 16)}><Popup>{config.strings.SIM_GPS}</Popup></Marker>}
      </MapContainer>}

      {eyesDim && (
        <div className="absolute inset-0 z-10" style={{ background:'rgba(8,10,18,0.82)', backdropFilter:'blur(3px)' }} />
      )}
      <div className="absolute bottom-[66px] right-2 z-20 text-[10px]" style={{ color:'rgba(255,255,255,0.6)' }}>
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
      </div>

      {/* Sidebar */}
      <LeftPanel
        loading={loading} error={error || overlayError} mode={mode} setMode={setMode}
        overlayOn={overlayOn} setOverlayOn={setOverlayOn} phone={phone} setPhone={setPhone} pollRate={pollRate} onRetry={() => { setNavError(''); setOverlayError(''); setOverlayOn(false); setRouteAttempt(a => a + 1); }}
        activeRoute={activeRoute} setActiveRoute={setActiveRoute}
        phase={phase} now={now} sunTimes={sunTimes}
        navigating={navigating} onStartNav={startNavigation} onStopNav={stopNavigation}
        sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen}
        fromLocation={fromLocation} setFromLocation={setFromLocation}
        toLocation={toLocation} setToLocation={setToLocation}
      />

      {escortActive && selected && (
        <EscortModeBanner route={selected} notified={notified} sidebarOpen={sidebarOpen} onDeactivate={stopNavigation} />
      )}
      {(eyesDim || screen === 'eyesup') && <EyesUpOverlay onUnlock={dismissEyesUp} />}
      {screen === 'stats'  && <RouteStatsPanel activeRoute={activeRoute} setActiveRoute={setActiveRoute} />}

      {/* Active route badge */}
      {screen === 'map' && !navigating && selected && (() => {
        const a = ROUTES.find(r => r.id === activeRoute)!;
        return (
          <div className="absolute top-4 z-30 pointer-events-none"
            style={{ left: sidebarOpen ? `${SIDEBAR_W+28}px` : '36px', right:'56px', transition:'left 0.3s cubic-bezier(0.4,0,0.2,1)' }}>
            <div className="rounded-2xl px-4 py-3 inline-block"
              style={{ background:'rgba(19,21,31,0.88)', backdropFilter:'blur(16px)', border:`1px solid ${a.color}28`, borderLeft:`3px solid ${a.color}` }}>
              <div className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color:'rgba(255,255,255,0.35)' }}>Active route</div>
              <div className="flex items-center gap-2 mb-1">
                <span style={{ color:a.color }}><RouteIcon id={a.id} /></span>
                <span className="text-sm font-semibold text-white">{a.name}</span>
              </div>
              <div className="flex items-center gap-2 text-xs" style={{ color:'rgba(255,255,255,0.5)' }}>
                <span className="font-semibold text-white">{a.duration}</span><span>·</span>
                <span>{a.distance}</span><span>·</span>
                <span className="font-semibold" style={{ color:a.color }}>Score {a.safetyScore}</span>
              </div>
            </div>
          </div>
        );
      })()}

      {screen === 'map' && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
          <div className="rounded-full px-4 py-1.5 flex items-center gap-2"
            style={{ background:'rgba(19,21,31,0.8)', backdropFilter:'blur(12px)', border:'1px solid rgba(255,255,255,0.1)' }}>
            <Icon name="pin" size={13} color="rgba(255,255,255,0.5)" />
            <span className="text-xs font-medium" style={{ color:'rgba(255,255,255,0.7)' }}>{config.map_center.join(', ')}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-1"
              style={{ background:'rgba(255,255,255,0.08)', color:'rgba(255,255,255,0.4)' }}>
              <PhaseIcon phase={phase} />{TILE[phase].label}
            </span>
          </div>
        </div>
      )}

      {/* Account button */}
      <button onClick={openFeedback} className="absolute top-4 right-[68px] z-[210] rounded-full px-3 py-2.5 text-xs font-medium text-white"
        style={{ background: 'rgba(19,21,31,0.88)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.1)' }}>Feedback</button>
      <div className="absolute top-4 right-4 z-[120]">
        <button onClick={() => setSettingsOpen(o => !o)}
          className="w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold text-white transition-all"
          style={{
            background: 'linear-gradient(135deg,#3b82f6,#8b5cf6)',
            boxShadow: settingsOpen ? '0 0 0 2px rgba(139,92,246,0.5)' : '0 2px 8px rgba(0,0,0,0.4)',
          }}>
          L
        </button>
        {settingsOpen && (
          <SettingsMenu
            onOpenTerms={() => setShowTermsModal(true)}
            onOpenPanel={p => setAccountPanel(p)}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>

      <BottomNav screen={screen} setScreen={s => { if (s !== 'eyesup' || navigating) setScreen(s); }} escortActive={escortActive} />

      {navigating && <div className="absolute bottom-20 left-4 z-30 rounded-xl px-4 py-3 text-xs text-white bg-[#13151f]">
        {config.strings.ESCORT_POLL_LABEL}: {pollRate} s | {config.strings.SIM_GPS} | {config.strings.SIM_SMS} | {config.strings.SIM_CLOUD}
        <button className="ml-3 text-red-400" onClick={stopNavigation}>{config.strings.NAV_STOP_BTN}</button>
      </div>}
      {navError && <div role="alert" className="absolute bottom-36 left-4 z-[170] rounded-xl px-4 py-3 text-sm text-red-400 bg-[#13151f]">{navError}</div>}
      {accountPanel && <AccountPanelModal panel={accountPanel} onClose={() => setAccountPanel(null)} />}
      </div>
      {feedbackOpen && <FeedbackModal strings={config.feedback} context={feedbackContext} onClose={closeFeedback} />}
      {showTermsModal && (
        <TermsModal
          onAccept={!termsAccepted ? handleAcceptTerms : undefined}
          onClose={() => { if (termsAccepted) setShowTermsModal(false); }}
        />
      )}
    </div>
    </DataContext.Provider>
  );
}
