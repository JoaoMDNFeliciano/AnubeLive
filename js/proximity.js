// Avisos de proximidade: cruza o GPS do piloto (tracking Anube) com a posição do telemóvel.
// Distância pela estrada quando a Anube publica o traçado da especial; senão em linha reta.

const TRACK_BASE = 'https://rest.anube.es/rallyrest/default/api/';
export const THRESHOLDS = [5, 2, 1];          // km
const MAX_GPS_AGE = 300;                      // s: GPS do piloto mais antigo é ignorado
const NEAR_TRACK_KM = 0.5;                    // distância máxima ao traçado para usar "pela estrada"

async function tapi(path, sid) {
  const r = await fetch(`${TRACK_BASE}${path}?rally=rally${sid}&port=auto`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json())?.event?.data;
}

export function haversine(a, b) {
  const R = 6371, k = Math.PI / 180;
  const dLat = (b.lat - a.lat) * k, dLon = (b.lon - a.lon) * k;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * k) * Math.cos(b.lat * k) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Pontos chegam como [longitude, latitude]; aceita também objetos {latitude, longitude}.
export function preparePath(points, name = '') {
  const pts = [];
  for (const p of points || []) {
    let lat, lon;
    if (Array.isArray(p)) { lon = Number(p[0]); lat = Number(p[1]); }
    else { lat = Number(p?.latitude ?? p?.lat); lon = Number(p?.longitude ?? p?.lon ?? p?.lng); }
    if (isFinite(lat) && isFinite(lon) && (lat || lon)) pts.push({ lat, lon });
  }
  if (pts.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
  return { pts, cum, name };
}

// Projeta uma posição no traçado: off = distância ao traçado, s = km desde o início.
function project(path, pos) {
  const kx = 111.32 * Math.cos(pos.lat * Math.PI / 180), ky = 110.574;
  const P = path.pts;
  let best = { off: Infinity, s: 0 };
  for (let i = 0; i < P.length - 1; i++) {
    const ax = (P[i].lon - pos.lon) * kx, ay = (P[i].lat - pos.lat) * ky;
    const bx = (P[i + 1].lon - pos.lon) * kx, by = (P[i + 1].lat - pos.lat) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (off < best.off) best = { off, s: path.cum[i] + t * (path.cum[i + 1] - path.cum[i]) };
  }
  return best;
}

// Dados de tracking de um mapa Anube (subrally).
export class TrackSource {
  constructor(sid) {
    this.sid = sid;
    this.parts = new Map();   // dorsal -> participante
    this.sections = [];
    this.paths = new Map();   // section -> traçado preparado
    this.secAt = 0;
    this.pathAt = new Map();
    this.error = null;
    this.ok = 0;
  }

  async refresh() {
    const now = Date.now();
    try {
      const d = await tapi(`participants/${this.sid}.json`, this.sid);
      this.parts = new Map((d?.participants || []).map(p => [String(p.dorsal ?? '').trim().toLowerCase(), p]));
      this.error = null;
      this.ok = now;
    } catch (e) {
      this.error = e.message || 'erro de ligação';
      return;
    }
    if (now - this.secAt > 60000) {
      try { this.sections = (await tapi(`sections/${this.sid}.json`, this.sid))?.sections || []; this.secAt = now; } catch { /* tenta depois */ }
    }
    const t = now / 1000;
    for (const s of this.sections) {
      if (s.track_visible === 0) continue;
      if (s.ut_ini && s.ut_fin && (t < s.ut_ini - 3600 || t > s.ut_fin + 3600)) continue;
      const have = this.paths.get(s.section);
      if (now - (this.pathAt.get(s.section) || 0) < (have ? 600000 : 120000)) continue;
      this.pathAt.set(s.section, now);
      try {
        const d = await tapi(`section_path/${s.section}.json`, this.sid);
        const p = preparePath(d?.points, s.name_timing || s.name);
        if (p) this.paths.set(s.section, p);
      } catch { /* sem traçado */ }
    }
  }

  vehicle(ident) {
    const p = this.parts.get(String(ident ?? '').trim().toLowerCase());
    const lat = Number(p?.latitude), lon = Number(p?.longitude);
    if (!p || !isFinite(lat) || !isFinite(lon) || (!lat && !lon)) return null;
    return { lat, lon, speed: Number(p.speed) || 0, ts: Number(p.unixtime_gps) || 0 };
  }

  routeDistance(user, veh) {
    let best = null;
    for (const path of this.paths.values()) {
      const pu = project(path, user), pv = project(path, veh);
      if (pu.off > NEAR_TRACK_KM || pv.off > NEAR_TRACK_KM) continue;
      const c = { d: pu.s - pv.s, off: pu.off + pv.off, name: path.name };
      if (!best || c.off < best.off) best = c;
    }
    return best;
  }
}

// Avalia um piloto. state guarda os avisos já dados nesta aproximação.
export function evaluate(state, src, ident, user) {
  if (!src) return { status: 'notrack' };
  if (src.error && !src.ok) return { status: 'error', error: src.error };
  const veh = src.vehicle(ident);
  if (!veh) return { status: 'nogps' };
  const age = veh.ts ? Math.max(0, Date.now() / 1000 - veh.ts) : null;
  if (age != null && age > MAX_GPS_AGE) return { status: 'stale', age, speed: veh.speed };
  if (!user) return { status: 'nouser', age, speed: veh.speed };

  const r = src.routeDistance(user, veh);
  const mode = r ? 'estrada' : 'reta';
  const dist = r ? r.d : haversine(user, veh);
  state.fired = state.fired || new Set();
  // nova aproximação: o piloto afastou-se ou já passou por ti
  if (dist > THRESHOLDS[0] + 1 || (mode === 'estrada' && dist < -0.2)) state.fired = new Set();
  let alert = null;
  if (dist > 0) {
    const crossed = THRESHOLDS.filter(t => dist <= t && !state.fired.has(t));
    if (crossed.length) {
      alert = Math.min(...crossed);
      THRESHOLDS.filter(t => t >= alert).forEach(t => state.fired.add(t));
    }
  }
  return { status: 'ok', dist, mode, speed: veh.speed, age, alert, passed: mode === 'estrada' && dist < 0 };
}

// Sirene tipo ambulância (dois tons alternados).
export function siren(ctx, seconds = 4) {
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const g = ctx.createGain();
  g.connect(ctx.destination);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.05);
  g.gain.setValueAtTime(0.3, t0 + seconds - 0.1);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds);
  for (const [type, mult] of [['square', 1], ['sawtooth', 2]]) {
    const o = ctx.createOscillator();
    o.type = type;
    for (let t = 0; t < seconds; t += 0.9) {
      o.frequency.setValueAtTime(960 * mult, t0 + t);
      o.frequency.setValueAtTime(770 * mult, t0 + t + 0.45);
    }
    o.connect(g);
    o.start(t0);
    o.stop(t0 + seconds + 0.05);
  }
}

export function fmtKm(d) {
  if (d == null || !isFinite(d)) return '—';
  const a = Math.abs(d);
  return a < 1 ? `${Math.round(a * 1000)} m` : `${a.toFixed(1).replace('.', ',')} km`;
}
