import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import { getTimes } from 'suncalc';

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const BANGALORE_LAT = 12.9716;
const BANGALORE_LNG = 77.5946;
const SIDEBAR_W = 380;

type DayPhase = 'day' | 'golden' | 'twilight' | 'night';
type Screen = 'map' | 'escort' | 'eyesup' | 'stats';
type AccountPanel = 'account' | 'notifications' | 'savedroutes' | null;

function ts(d: Date | null) { return d ? d.getTime() : 0; }

function getDayPhase(now: Date): DayPhase {
  const t = getTimes(now, BANGALORE_LAT, BANGALORE_LNG);
  const ms = now.getTime();
  if (ms >= ts(t.goldenHourEnd) && ms < ts(t.goldenHour)) return 'day';
  if ((ms >= ts(t.goldenHour) && ms < ts(t.sunsetStart)) || (ms >= ts(t.sunriseEnd) && ms < ts(t.goldenHourEnd))) return 'golden';
  if ((ms >= ts(t.sunsetStart) && ms < ts(t.dusk)) || (ms >= ts(t.dawn) && ms < ts(t.sunriseEnd))) return 'twilight';
  return 'night';
}

const TILE: Record<DayPhase, { url: string; label: string }> = {
  day:      { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',          label: 'Daylight'    },
  golden:   { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',          label: 'Golden Hour' },
  twilight: { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_dark_all/{z}/{x}/{y}{r}.png', label: 'Twilight'    },
  night:    { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',                     label: 'Night'       },
};

const ROUTES = [
  {
    id: 'visibility', name: 'Visibility-Optimized', tagline: 'Well-lit · High vitality',
    color: '#22c55e', duration: '18 min', distance: '1.8 km', safetyScore: 92, safetyLabel: 'Excellent',
    coords: [[12.976,77.607],[12.9762,77.6055],[12.9758,77.604],[12.9748,77.603],[12.9735,77.6035],[12.9722,77.6045],[12.9712,77.6065],[12.9702,77.609],[12.9692,77.6118],[12.9685,77.6145]],
    highlights: ['Brigade Road (well-lit)', '3 transit stops nearby', 'High foot traffic'],
    segments: [
      { name: 'MG Road Metro → St Marks Rd', score: 94, dist: '0.4 km', status: 'Excellent' },
      { name: 'St Marks Rd → Brigade Rd',    score: 91, dist: '0.6 km', status: 'Excellent' },
      { name: 'Brigade Rd → Trinity Circle', score: 88, dist: '0.8 km', status: 'Good'      },
    ],
    dangerSegment: false,
  },
  {
    id: 'fastest', name: 'Fastest Route', tagline: 'Shortest path · Direct',
    color: '#60a5fa', duration: '12 min', distance: '1.2 km', safetyScore: 65, safetyLabel: 'Moderate',
    coords: [[12.976,77.607],[12.9748,77.6082],[12.973,77.6098],[12.9714,77.6118],[12.9685,77.6145]],
    highlights: ['Along MG Road', '2 crossings', 'Moderate lighting'],
    segments: [
      { name: 'MG Road Metro → Infantry Rd',  score: 72, dist: '0.5 km', status: 'Good'   },
      { name: 'Infantry Rd → Trinity Circle', score: 24, dist: '0.7 km', status: 'Danger' },
    ],
    dangerSegment: true,
  },
  {
    id: 'practical', name: 'Practical Route', tagline: 'Balanced · Time & visibility',
    color: '#fb923c', duration: '15 min', distance: '1.5 km', safetyScore: 78, safetyLabel: 'Good',
    coords: [[12.976,77.607],[12.9755,77.606],[12.9744,77.6072],[12.973,77.609],[12.9715,77.6108],[12.9698,77.6126],[12.9685,77.6145]],
    highlights: ['Church Street stretch', '1 transit stop nearby', 'Mixed lighting'],
    segments: [
      { name: 'MG Road Metro → Church St',     score: 82, dist: '0.5 km', status: 'Good' },
      { name: 'Church St → Residency Rd',      score: 76, dist: '0.5 km', status: 'Good' },
      { name: 'Residency Rd → Trinity Circle', score: 74, dist: '0.5 km', status: 'Good' },
    ],
    dangerSegment: false,
  },
];

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
  useEffect(() => {
    const r = ROUTES.find(r => r.id === activeId);
    if (!r) return;
    map.fitBounds(L.latLngBounds(r.coords as [number, number][]), { padding: [80, 120] });
  }, [activeId, map]);
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
          <h1 className="text-xl font-bold text-white mb-1">Terms &amp; Conditions</h1>
          <p className="text-sm" style={{ color:'rgba(255,255,255,0.4)' }}>Lumina · Visibility-aware navigation</p>
        </div>
        <div className="relative px-8 py-6 overflow-y-auto flex-1">
          <p className="text-sm font-semibold text-white mb-3">Please read carefully before you start:</p>
          <div className="rounded-xl p-4 mb-5 text-sm leading-relaxed space-y-3"
            style={{ background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.06)' }}>
            <p style={{ color:'rgba(255,255,255,0.7)' }}>Lumina <strong className="text-white">aggregates environmental data</strong> to calculate route visibility scores based on lighting, foot traffic, and proximity to active establishments.</p>
            <p style={{ color:'rgba(255,255,255,0.7)' }}>Urban conditions change rapidly. Scores reflect data at query time and <strong className="text-white">may not reflect real-time hazards</strong>.</p>
            <p style={{ color:'rgba(255,255,255,0.6)' }}>This is an <strong className="text-white">informational tool only</strong> — not a substitute for personal vigilance or emergency services.</p>
          </div>
          {[
            { icon:'shield', text:'Visibility-Optimized routes optimize for environmental factors, not guaranteed safety' },
            { icon:'signal', text:'Escort Mode logging requires consent and may share location with emergency contacts' },
            { icon:'warning',text:'Always trust your instincts over any app recommendation' },
          ].map(({ icon, text }) => (
            <div key={text} className="flex items-start gap-3 text-xs mb-3" style={{ color:'rgba(255,255,255,0.5)' }}>
              <span className="flex-shrink-0 mt-0.5" style={{ color:'rgba(255,255,255,0.35)' }}><Icon name={icon} size={14} color="currentColor" /></span>
              <span>{text}</span>
            </div>
          ))}
          {isInitial && (
            <>
              <label className="flex items-start gap-3 cursor-pointer mt-5 mb-6">
                <div onClick={() => setChecked(!checked)}
                  className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0 mt-0.5 transition-all"
                  style={{ background:checked?'#22c55e':'transparent', border:checked?'2px solid #22c55e':'2px solid rgba(255,255,255,0.25)' }}>
                  {checked && <Icon name="check" size={10} color="white" strokeWidth={2.5} />}
                </div>
                <span className="text-sm" style={{ color:'rgba(255,255,255,0.7)' }}>I understand this is an informational tool and accept full responsibility for my personal safety.</span>
              </label>
              <div className="flex gap-3">
                <button className="flex-1 py-3 rounded-xl text-sm font-medium"
                  style={{ background:'rgba(255,255,255,0.06)', color:'rgba(255,255,255,0.4)', border:'1px solid rgba(255,255,255,0.08)' }}>Decline</button>
                <button onClick={() => checked && onAccept?.()} className="flex-1 py-3 rounded-xl text-sm font-bold transition-all"
                  style={{ background:checked?'#22c55e':'rgba(34,197,94,0.12)', color:checked?'#0f1117':'rgba(34,197,94,0.35)', cursor:checked?'pointer':'not-allowed' }}>
                  I Agree &amp; Continue
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
                style={{ background:'linear-gradient(135deg,#3b82f6,#8b5cf6)' }}>AK</div>
              <div>
                <div className="text-sm font-semibold text-white">Ananya Kumar</div>
                <div className="text-xs" style={{ color:'rgba(255,255,255,0.45)' }}>ananya.k@email.com</div>
              </div>
            </div>
            {[['Emergency Contact','Priya Kumar · +91 98765 43210'],['Home Address','Koramangala, Bengaluru'],['Member Since','September 2026']].map(([label, val]) => (
              <div key={label} className="rounded-xl px-4 py-3" style={{ background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.06)' }}>
                <div className="text-[10px] uppercase tracking-wider mb-0.5" style={{ color:'rgba(255,255,255,0.35)' }}>{label}</div>
                <div className="text-sm text-white">{val}</div>
              </div>
            ))}
            <button className="w-full py-2.5 rounded-xl text-sm font-semibold mt-1"
              style={{ background:'rgba(59,130,246,0.12)', color:'#60a5fa', border:'1px solid rgba(59,130,246,0.25)' }}>Edit Profile</button>
          </div>
        )}

        {panel === 'notifications' && (
          <div className="px-6 py-5 space-y-2.5">
            {[
              { label:'Escort Mode Alerts',     sub:'Notify emergency contact automatically',      on:true  },
              { label:'Low Visibility Warnings', sub:'Alert when segment score drops below 30',    on:true  },
              { label:'Route Updates',           sub:'Real-time route condition changes',          on:false },
              { label:'Daily Safety Digest',     sub:'Morning summary of your area',              on:false },
            ].map(({ label, sub, on }) => (
              <div key={label} className="flex items-center justify-between rounded-xl px-4 py-3"
                style={{ background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.06)' }}>
                <div>
                  <div className="text-sm text-white">{label}</div>
                  <div className="text-[10px]" style={{ color:'rgba(255,255,255,0.4)' }}>{sub}</div>
                </div>
                <div className="w-10 h-6 rounded-full flex-shrink-0 relative cursor-pointer transition-all"
                  style={{ background:on?'#22c55e':'rgba(255,255,255,0.1)' }}>
                  <div className="absolute top-1 w-4 h-4 rounded-full bg-white transition-all" style={{ left:on?'22px':'2px' }} />
                </div>
              </div>
            ))}
          </div>
        )}

        {panel === 'savedroutes' && (
          <div className="px-6 py-5 space-y-2">
            {[
              { from:'MG Road Metro', to:'Trinity Circle', type:'Visibility-Optimized', color:'#22c55e', date:'Today'       },
              { from:'Koramangala',   to:'Indiranagar',    type:'Practical Route',       color:'#fb923c', date:'Yesterday'  },
              { from:'Whitefield',    to:'MG Road',        type:'Fastest Route',         color:'#60a5fa', date:'3 days ago' },
            ].map(({ from, to, type, color, date }) => (
              <div key={from+to} className="rounded-xl px-4 py-3" style={{ background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold" style={{ color }}>{type}</span>
                  <span className="text-[10px]" style={{ color:'rgba(255,255,255,0.35)' }}>{date}</span>
                </div>
                <div className="text-sm text-white">{from} → {to}</div>
              </div>
            ))}
            <button className="w-full py-2.5 rounded-xl text-sm font-semibold mt-1"
              style={{ background:'rgba(255,255,255,0.05)', color:'rgba(255,255,255,0.5)', border:'1px solid rgba(255,255,255,0.08)' }}>
              + Plan New Route
            </button>
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
            style={{ background:'linear-gradient(135deg,#3b82f6,#8b5cf6)' }}>AK</div>
          <div>
            <div className="text-sm font-semibold text-white">Ananya Kumar</div>
            <div className="text-[11px]" style={{ color:'rgba(255,255,255,0.4)' }}>ananya.k@email.com</div>
          </div>
        </div>
      </div>
      <div className="py-2">
        {([
          { icon:'person',   label:'My Account',    sub:'Profile & preferences',    panel:'account'       },
          { icon:'bell',     label:'Notifications', sub:'Alerts & escort contacts', panel:'notifications' },
          { icon:'bookmark', label:'Saved Routes',  sub:'3 routes saved',           panel:'savedroutes'   },
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
  sidebarOpen, setSidebarOpen, fromLocation, setFromLocation, toLocation, setToLocation,
}: {
  activeRoute: string; setActiveRoute: (id: string) => void;
  phase: DayPhase; now: Date; sunTimes: ReturnType<typeof getTimes>;
  navigating: boolean; onStartNav: () => void; onStopNav: () => void;
  sidebarOpen: boolean; setSidebarOpen: (v: boolean) => void;
  fromLocation: string; setFromLocation: (v: string) => void;
  toLocation: string; setToLocation: (v: string) => void;
}) {
  const active = ROUTES.find(r => r.id === activeRoute)!;

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
                <div className="text-[10px] leading-none" style={{ color:'rgba(255,255,255,0.4)' }}>Visibility-aware navigation</div>
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
                placeholder="Starting point"
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
                placeholder="Where to?"
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

        {/* Legend */}
        <div className="px-4 py-2.5 flex items-center justify-between flex-shrink-0"
          style={{ background:'rgba(0,0,0,0.2)', borderBottom:'1px solid rgba(255,255,255,0.05)' }}>
          <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color:'rgba(255,255,255,0.3)' }}>3 Routes Found</span>
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
                    {[{ v:route.duration, l:'walk time' },{ v:route.distance, l:'distance' },{ v:String(route.safetyScore), l:'vis. score', accent:true }].map((s,i) => (
                      <div key={i} className="flex-1">
                        <div className="text-base font-bold leading-none" style={{ color:(s as any).accent?route.color:'rgba(255,255,255,0.9)' }}>{s.v}</div>
                        <div className="text-[10px] mt-0.5" style={{ color:'rgba(255,255,255,0.35)' }}>{s.l}</div>
                      </div>
                    ))}
                  </div>
                  <ScoreBar score={route.safetyScore} color={route.color} />
                  {isActive && route.highlights.map((h,i) => (
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
                Navigating · {active.duration} remaining
              </div>
              <button onClick={onStopNav} className="w-full py-2.5 rounded-xl text-sm font-semibold"
                style={{ background:'rgba(239,68,68,0.12)', color:'#ef4444', border:'1px solid rgba(239,68,68,0.3)' }}>
                Stop Navigation
              </button>
            </div>
          ) : (
            <button onClick={onStartNav}
              className="w-full py-3 rounded-xl text-sm font-bold transition-all hover:brightness-110 active:scale-[0.98]"
              style={{ backgroundColor:active.color, color:'#0f1117' }}>
              Start {active.name} →
            </button>
          )}
          <p className="text-[10px] text-center mt-2 leading-relaxed" style={{ color:'rgba(255,255,255,0.2)' }}>
            Lumina calculates environmental visibility factors. Not a substitute for personal vigilance.
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
function EscortModeBanner({ sidebarOpen, onDeactivate }: { sidebarOpen: boolean; onDeactivate: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => { const id = setInterval(() => setElapsed(e => e+1), 1000); return () => clearInterval(id); }, []);
  const mins = Math.floor(elapsed/60).toString().padStart(2,'0');
  const secs = (elapsed%60).toString().padStart(2,'0');

  return (
    <div className="absolute top-4 right-4 z-40 pointer-events-none"
      style={{ left: sidebarOpen ? `${SIDEBAR_W+16}px` : '16px', transition:'left 0.3s cubic-bezier(0.4,0,0.2,1)' }}>
      <div className="rounded-2xl overflow-hidden pointer-events-auto"
        style={{ background:'rgba(239,68,68,0.12)', border:'1.5px solid rgba(239,68,68,0.45)', backdropFilter:'blur(16px)', boxShadow:'0 4px 32px rgba(239,68,68,0.18)' }}>
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="relative flex-shrink-0 mt-1">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
            <div className="absolute inset-0 w-2.5 h-2.5 rounded-full bg-red-500 animate-ping opacity-60" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-sm font-bold text-red-400">Escort Mode Active</span>
              <span className="text-xs font-mono text-red-400/70 tabular-nums">{mins}:{secs}</span>
            </div>
            <p className="text-xs leading-relaxed" style={{ color:'rgba(255,255,255,0.6)' }}>
              Entering low-visibility area. Stay vigilant. Location shared with emergency contact.
            </p>
          </div>
          <button onClick={onDeactivate} className="flex-shrink-0 text-xs px-2.5 py-1 rounded-lg"
            style={{ background:'rgba(239,68,68,0.2)', color:'rgba(239,68,68,0.8)', border:'1px solid rgba(239,68,68,0.3)' }}>
            End
          </button>
        </div>
        <div className="grid grid-cols-3" style={{ borderTop:'1px solid rgba(239,68,68,0.18)' }}>
          {[
            { icon:'gps',    label:'GPS Overdrive', value:'3s interval' },
            { icon:'signal', label:'Telemetry',     value:'Logging'     },
            { icon:'bell',   label:'Contact',       value:'Notified'    },
          ].map(({ icon, label, value }) => (
            <div key={label} className="flex flex-col items-center py-2.5 text-center" style={{ borderRight:'1px solid rgba(239,68,68,0.12)' }}>
              <span className="mb-1" style={{ color:'rgba(239,68,68,0.6)' }}><Icon name={icon} size={13} color="currentColor" /></span>
              <span className="text-[10px] font-semibold" style={{ color:'rgba(239,68,68,0.8)' }}>{value}</span>
              <span className="text-[9px]" style={{ color:'rgba(255,255,255,0.35)' }}>{label}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 rounded-xl px-4 py-2.5 flex items-center gap-3"
        style={{ background:'rgba(251,146,60,0.1)', border:'1px solid rgba(251,146,60,0.28)', backdropFilter:'blur(12px)' }}>
        <span style={{ color:'rgba(251,146,60,0.7)', flexShrink:0 }}><Icon name="warning" size={15} color="currentColor" /></span>
        <div>
          <span className="text-xs font-semibold text-orange-400">Segment visibility score: 24 / 100 </span>
          <span className="text-xs" style={{ color:'rgba(255,255,255,0.4)' }}>— below threshold of 30</span>
        </div>
      </div>
    </div>
  );
}

// ─── EYES UP ──────────────────────────────────────────────────────────────────
function EyesUpOverlay({ onUnlock }: { onUnlock: () => void }) {
  const lastTap = useRef<number>(0);
  function handleDoubleTap(e: React.MouseEvent | React.TouchEvent) {
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTap.current < 350) { onUnlock(); lastTap.current = 0; }
    else lastTap.current = now;
  }
  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center select-none cursor-pointer"
      style={{ background:'rgba(8,10,18,0.94)', backdropFilter:'blur(8px)' }}
      onClick={handleDoubleTap} onTouchEnd={handleDoubleTap}>
      <div className="absolute top-0 left-0 right-0 h-1 bg-white/5">
        <div className="h-full bg-green-400/60" style={{ width:'42%' }} />
      </div>
      <div className="mb-8 relative">
        <div className="w-28 h-28 rounded-full flex items-center justify-center"
          style={{ background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.1)' }}>
          <Icon name="eye" size={52} color="rgba(255,255,255,0.75)" strokeWidth={0.8} />
        </div>
        <div className="absolute inset-0 rounded-full animate-ping opacity-10"
          style={{ background:'rgba(255,255,255,0.3)', animationDuration:'3s' }} />
      </div>
      <h2 className="text-2xl font-bold text-white mb-2 text-center">Route Active</h2>
      <p className="text-base text-center mb-2 max-w-xs leading-relaxed" style={{ color:'rgba(255,255,255,0.55)' }}>
        Keep your head up and stay aware of your surroundings.
      </p>
      <p className="text-sm text-center mb-10" style={{ color:'rgba(255,255,255,0.35)' }}>Audio turn-by-turn cues are enabled.</p>
      <div className="flex items-center gap-2.5 px-5 py-2.5 rounded-full"
        style={{ background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.1)' }}>
        <Icon name="finger" size={15} color="rgba(255,255,255,0.5)" />
        <span className="text-sm" style={{ color:'rgba(255,255,255,0.5)' }}>Double-tap anywhere to view map</span>
      </div>
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 rounded-2xl px-5 py-3 flex items-center gap-3"
        style={{ background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.1)', backdropFilter:'blur(12px)' }}>
        <Icon name="turnRight" size={18} color="rgba(255,255,255,0.6)" />
        <div>
          <div className="text-xs text-white font-semibold">Turn right in 120m</div>
          <div className="text-[10px]" style={{ color:'rgba(255,255,255,0.4)' }}>onto Brigade Road</div>
        </div>
      </div>
    </div>
  );
}

// ─── ROUTE STATS ──────────────────────────────────────────────────────────────
function RouteStatsPanel({ activeRoute, setActiveRoute }: { activeRoute: string; setActiveRoute: (id: string) => void }) {
  const route = ROUTES.find(r => r.id === activeRoute)!;
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
              {[{ v:route.duration, l:'time' },{ v:route.distance, l:'distance' }].map(({ v, l }) => (
                <div key={l}><div className="text-sm font-bold text-white">{v}</div><div className="text-[10px]" style={{ color:'rgba(255,255,255,0.35)' }}>{l}</div></div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-widest mb-3" style={{ color:'rgba(255,255,255,0.3)' }}>Visibility Factors</div>
          <div className="space-y-3">
            {[{ label:'Street Lighting', score:route.safetyScore-4, icon:'bulb' },{ label:'Active Businesses', score:route.safetyScore+2, icon:'store' },{ label:'Foot Traffic', score:route.safetyScore-8, icon:'walk' },{ label:'Transit Proximity', score:route.safetyScore-2, icon:'bus' }].map(({ label, score, icon }) => (
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
          <div className="text-[11px] font-semibold uppercase tracking-widest mb-3" style={{ color:'rgba(255,255,255,0.3)' }}>Segment Breakdown</div>
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
  const [termsAccepted, setTermsAccepted]     = useState(false);
  const [showTermsModal, setShowTermsModal]   = useState(true);
  const [screen, setScreen]                   = useState<Screen>('map');
  const [activeRoute, setActiveRoute]         = useState('visibility');
  const [settingsOpen, setSettingsOpen]       = useState(false);
  const [accountPanel, setAccountPanel]       = useState<AccountPanel>(null);
  const [now, setNow]                         = useState(() => new Date());
  const [sidebarOpen, setSidebarOpen]         = useState(true);
  const [navigating, setNavigating]           = useState(false);
  const [escortActive, setEscortActive]       = useState(false);
  const [fromLocation, setFromLocation]       = useState('MG Road Metro Station');
  const [toLocation, setToLocation]           = useState('Trinity Circle');
  const navTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const escortTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const phase    = useMemo(() => getDayPhase(now), [now]);
  const sunTimes = useMemo(() => getTimes(now, BANGALORE_LAT, BANGALORE_LNG), [now]);

  const startNavigation = useCallback(() => {
    setNavigating(true);
    setSidebarOpen(false);
    setScreen('map');

    navTimerRef.current = setTimeout(() => {
      setScreen('eyesup');
    }, 7_000);

    const route = ROUTES.find(r => r.id === activeRoute);
    if (route?.dangerSegment) {
      escortTimerRef.current = setTimeout(() => {
        setEscortActive(true);
        setScreen('escort');
      }, 8_000);
    }
  }, [activeRoute]);

  const rearmRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopNavigation = useCallback(() => {
    setNavigating(false);
    setEscortActive(false);
    setSidebarOpen(true);
    setScreen('map');
    if (navTimerRef.current)    clearTimeout(navTimerRef.current);
    if (escortTimerRef.current) clearTimeout(escortTimerRef.current);
    if (rearmRef.current)       clearTimeout(rearmRef.current);
  }, []);

  useEffect(() => {
    if (screen === 'escort') setEscortActive(true);
  }, [screen]);

  const dismissEyesUp = useCallback(() => {
    setScreen('map');
    if (rearmRef.current) clearTimeout(rearmRef.current);
    rearmRef.current = setTimeout(() => { setScreen('eyesup'); }, 7_000);
  }, []);
  const handleAcceptTerms = () => { setTermsAccepted(true); setShowTermsModal(false); };

  return (
    <div className="relative w-screen h-screen overflow-hidden"
      style={{ background:'#0f1117', fontFamily:"'DM Sans','Inter',sans-serif" }}>

      {/* Map */}
      <MapContainer center={[12.972, 77.6095]} zoom={15} zoomControl={false}
        style={{ position:'absolute', inset:0, zIndex:0 }} attributionControl={false}>
        <TileLayer url={TILE[phase].url} />
        <MapFocus activeId={activeRoute} />
        {ROUTES.filter(r => r.id !== activeRoute).map(r => (
          <Polyline key={r.id} positions={r.coords as [number,number][]}
            pathOptions={{ color:r.color, weight:5, opacity:0.28, dashArray:'8 6' }}
            eventHandlers={{ click: () => !navigating && setActiveRoute(r.id) }} />
        ))}
        <Polyline positions={ROUTES.find(r => r.id === activeRoute)!.coords as [number,number][]}
          pathOptions={{ color:ROUTES.find(r => r.id === activeRoute)!.color, weight:7, opacity:1 }} />
        <Marker position={[12.976, 77.607]} icon={dotIcon('#60a5fa')}><Popup>MG Road Metro Station</Popup></Marker>
        <Marker position={[12.9685, 77.6145]} icon={dotIcon('#f87171')}><Popup>Trinity Circle</Popup></Marker>
      </MapContainer>

      {screen === 'eyesup' && (
        <div className="absolute inset-0 z-10" style={{ background:'rgba(8,10,18,0.82)', backdropFilter:'blur(3px)' }} />
      )}
      <div className="absolute bottom-2 right-2 z-10 text-[10px] pointer-events-none" style={{ color:'rgba(255,255,255,0.2)' }}>
        © OpenStreetMap · © CARTO
      </div>

      {/* Sidebar */}
      <LeftPanel
        activeRoute={activeRoute} setActiveRoute={setActiveRoute}
        phase={phase} now={now} sunTimes={sunTimes}
        navigating={navigating} onStartNav={startNavigation} onStopNav={stopNavigation}
        sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen}
        fromLocation={fromLocation} setFromLocation={setFromLocation}
        toLocation={toLocation} setToLocation={setToLocation}
      />

      {screen === 'escort' && escortActive && (
        <EscortModeBanner sidebarOpen={sidebarOpen} onDeactivate={() => { setEscortActive(false); setScreen('map'); }} />
      )}
      {screen === 'eyesup' && <EyesUpOverlay onUnlock={dismissEyesUp} />}
      {screen === 'stats'  && <RouteStatsPanel activeRoute={activeRoute} setActiveRoute={setActiveRoute} />}

      {/* Active route badge */}
      {screen === 'map' && !navigating && (() => {
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
            <span className="text-xs font-medium" style={{ color:'rgba(255,255,255,0.7)' }}>MG Road, Bengaluru</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-1"
              style={{ background:'rgba(255,255,255,0.08)', color:'rgba(255,255,255,0.4)' }}>
              <PhaseIcon phase={phase} />{TILE[phase].label}
            </span>
          </div>
        </div>
      )}

      {/* Account button */}
      <div className="absolute top-4 right-4 z-[120]">
        <button onClick={() => setSettingsOpen(o => !o)}
          className="w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold text-white transition-all"
          style={{
            background: 'linear-gradient(135deg,#3b82f6,#8b5cf6)',
            boxShadow: settingsOpen ? '0 0 0 2px rgba(139,92,246,0.5)' : '0 2px 8px rgba(0,0,0,0.4)',
          }}>
          AK
        </button>
        {settingsOpen && (
          <SettingsMenu
            onOpenTerms={() => setShowTermsModal(true)}
            onOpenPanel={p => setAccountPanel(p)}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>

      <BottomNav screen={screen} setScreen={setScreen} escortActive={escortActive} />

      {accountPanel && <AccountPanelModal panel={accountPanel} onClose={() => setAccountPanel(null)} />}
      {showTermsModal && (
        <TermsModal
          onAccept={!termsAccepted ? handleAcceptTerms : undefined}
          onClose={() => setShowTermsModal(false)}
        />
      )}
    </div>
  );
}
