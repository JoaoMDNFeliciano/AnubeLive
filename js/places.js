// Locais da prova: partidas/chegadas (cronometragem), bombas de gasolina (OpenStreetMap),
// e locais da organização (ficheiro por prova + locais acrescentados no aparelho).
import { haversine } from './proximity.js';

export const PLACE_TYPES = [
  { key: 'pf', icon: '🅿️', label: 'Parque fechado' },
  { key: 'start', icon: '🟢', label: 'Partidas SS / Prólogo' },
  { key: 'finish', icon: '🏁', label: 'Chegadas SS / Prólogo' },
  { key: 'assist', icon: '🔧', label: 'Zonas de assistência' },
  { key: 'gas', icon: '⛽', label: 'GAS (reabastecimento)' },
  { key: 'fuel', icon: '🛢️', label: 'Bombas de gasolina' },
  { key: 'ze', icon: '👀', label: 'Zonas espetáculo' },
];

export const typeOf = key => PLACE_TYPES.find(t => t.key === key);

// Links que abrem a navegação na app do telemóvel.
export const wazeUrl = (lat, lon) => `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
export const gmapsUrl = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;
export const gmapsSearchUrl = (q, lat, lon) => `https://www.google.com/maps/search/${encodeURIComponent(q)}/@${lat},${lon},13z`;
export const wazeSearchUrl = (q, lat, lon) => `https://waze.com/ul?q=${encodeURIComponent(q)}&ll=${lat},${lon}`;

// Aceita "39.82, -7.49", "39,82 -7,49" (vírgula decimal) ou um link do Google Maps / Waze.
export function parseCoords(text) {
  const s = String(text || '').trim();
  let m = s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || s.match(/[?&](?:q|ll|query|destination)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i);
  if (!m) m = s.match(/(-?\d{1,2}[.,]\d+)\s*[,;\s]\s*(-?\d{1,3}[.,]\d+)/);
  if (!m) return null;
  const lat = Number(m[1].replace(',', '.')), lon = Number(m[2].replace(',', '.'));
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// Ficheiro com os locais da organização: places/<id da prova>.json (no próprio site da app).
// Formato: [{ "type": "pf", "name": "Parque Fechado", "lat": 39.82, "lon": -7.49, "note": "..." }]
const curatedCache = new Map();
export async function loadCurated(eventId) {
  if (!eventId) return [];
  if (curatedCache.has(eventId)) return curatedCache.get(eventId);
  let list = [];
  try {
    const r = await fetch(`places/${eventId}.json`, { cache: 'no-cache' });
    if (r.ok) list = (await r.json()).filter(p => typeOf(p.type) && isFinite(p.lat) && isFinite(p.lon));
  } catch { /* sem ficheiro */ }
  list.forEach(p => { p.src = 'org'; });
  curatedCache.set(eventId, list);
  return list;
}

// Partidas e chegadas das especiais já publicadas (latitude/longitude_ini e _fin).
export function fromSections(sources) {
  const out = [];
  const add = (type, lat, lon, name, note) => {
    if (!lat || !lon) return;
    const same = out.find(p => p.type === type && haversine(p, { lat, lon }) < 0.05);
    if (same) { if (!same.note.includes(note)) same.note += ` · ${note}`; return; }
    out.push({ type, lat, lon, name, note, src: 'timing' });
  };
  for (const { src, label } of sources) {
    for (const s of src.sections || []) {
      const nm = s.name_timing || s.name || '';
      const what = /^PRL|prol/i.test(nm) ? 'Prólogo' : nm;
      add('start', Number(s.latitude_ini), Number(s.longitude_ini), `Partida ${what}`, label);
      add('finish', Number(s.latitude_fin), Number(s.longitude_fin), `Chegada ${what}`, label);
    }
  }
  return out;
}

// Bombas de gasolina perto de um ponto (OpenStreetMap / Overpass), com memória no aparelho.
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const FUEL_KEY = 'motortracker.fuel';

function fuelCacheGet(center) {
  try {
    const all = JSON.parse(localStorage.getItem(FUEL_KEY) || '[]');
    return all.find(c => haversine(c.center, center) < 5 && Date.now() - c.at < 7 * 864e5) || null;
  } catch { return null; }
}

function fuelCacheSet(center, list) {
  try {
    const all = JSON.parse(localStorage.getItem(FUEL_KEY) || '[]').filter(c => haversine(c.center, center) >= 5).slice(-5);
    all.push({ center, at: Date.now(), list });
    localStorage.setItem(FUEL_KEY, JSON.stringify(all));
  } catch { /* sem armazenamento */ }
}

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS) {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 12000);
    try {
      const r = await fetch(`${url}?data=${encodeURIComponent(query)}`, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { lastErr = e; } finally { clearTimeout(tm); }
  }
  throw lastErr || new Error('sem resposta');
}

// Nominatim (pesquisa do OpenStreetMap): rápido e fiável; um pedido por pesquisa, guardado 7 dias.
async function nominatimFuel(center, radiusKm) {
  const d = radiusKm / 111;
  const dl = d / Math.cos(center.lat * Math.PI / 180);
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent('[fuel]')}`
    + `&viewbox=${center.lon - dl},${center.lat + d},${center.lon + dl},${center.lat - d}&bounded=1&limit=50&accept-language=pt`;
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return j.filter(x => x.type === 'fuel').map(x => {
      const parts = String(x.display_name || '').split(',').map(s => s.trim());
      return { type: 'fuel', lat: Number(x.lat), lon: Number(x.lon), name: x.name || 'Bomba de gasolina', note: parts.slice(1, 3).join(', '), src: 'osm' };
    }).filter(p => isFinite(p.lat) && isFinite(p.lon));
  } finally { clearTimeout(tm); }
}

export async function fuelNear(center, radiusKm = 20) {
  const cached = fuelCacheGet(center);
  if (cached) return { list: cached.list, cached: true };
  try {
    const list = await nominatimFuel(center, radiusKm);
    if (list.length) { fuelCacheSet(center, list); return { list, cached: false }; }
  } catch { /* tenta o Overpass */ }
  const q = `[out:json][timeout:15];nwr["amenity"="fuel"](around:${Math.round(radiusKm * 1000)},${center.lat},${center.lon});out center 80;`;
  const j = await overpass(q);
  const list = (j.elements || []).map(e => {
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    const t = e.tags || {};
    const name = t.brand && t.name && !t.name.includes(t.brand) ? `${t.brand} · ${t.name}` : (t.name || t.brand || 'Bomba de gasolina');
    const where = [t['addr:street'], t['addr:city'] || t['addr:place']].filter(Boolean).join(', ');
    return { type: 'fuel', lat, lon, name, note: [where, t.opening_hours === '24/7' ? 'aberta 24h' : ''].filter(Boolean).join(' · '), src: 'osm' };
  }).filter(p => isFinite(p.lat) && isFinite(p.lon));
  fuelCacheSet(center, list);
  return { list, cached: false };
}

export function centerOf(points) {
  const ok = points.filter(p => p && isFinite(p.lat) && isFinite(p.lon) && (p.lat || p.lon));
  if (!ok.length) return null;
  return { lat: ok.reduce((a, p) => a + p.lat, 0) / ok.length, lon: ok.reduce((a, p) => a + p.lon, 0) / ok.length };
}
