// Acesso aos dados públicos da Anube Sport.
// - Lista de provas: página https://anubesport.com/es/events (dados embutidos no HTML)
// - Cronometragem: API JSON https://rest3.anube.es/rallyrest/timing/api/

export const API_BASE = 'https://rest3.anube.es/rallyrest/timing/api/';
export const EVENTS_URL = 'https://anubesport.com/es/events';

export async function api(path, { timeout = 15000 } = {}) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(API_BASE + path, { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return j?.event?.data;
  } finally {
    clearTimeout(tm);
  }
}

// Extrai um objeto JSON completo a partir da posição i (conta chavetas, respeita strings).
function extractObject(t, i) {
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < t.length; j++) {
    const c = t[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return t.slice(i, j + 1);
    }
  }
  return null;
}

// Lê a lista de provas do site (passadas, a decorrer e próximas).
export async function fetchEvents() {
  const r = await fetch(EVENTS_URL, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();

  // O site (Next.js) envia os dados em blocos self.__next_f.push([1,"..."]).
  let text = '';
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  for (const m of html.matchAll(re)) {
    try { text += JSON.parse(m[1]); } catch { /* bloco ignorado */ }
  }
  if (!text) text = html.replace(/\\"/g, '"').replace(/\\u0026/g, '&');

  const events = new Map();
  const rx = /\{"id":\d+,"name":"/g;
  let m;
  while ((m = rx.exec(text))) {
    const raw = extractObject(text, m.index);
    if (!raw) continue;
    try {
      const o = JSON.parse(raw);
      if (o && o.date && o.state && 'type' in o) events.set(o.id, o);
    } catch { /* objeto parcial */ }
  }
  return [...events.values()].sort((a, b) => (b.ut_ini || 0) - (a.ut_ini || 0));
}

// IDs de cronometragem (rallyId) associados a uma prova.
export function timingIds(ev) {
  const ids = new Set();
  for (const m of JSON.stringify(ev).matchAll(/rallyId=(\d+)/g)) ids.add(Number(m[1]));
  return [...ids];
}
