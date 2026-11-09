// Modelo de uma corrida (rallyId) e cálculo de classificações.
import { api } from './api.js';

const SLOW_REFRESH_MS = 120000; // especiais terminadas: refresca de 2 em 2 minutos

export const STATE_LABEL = { 0: 'Por iniciar', 1: 'A decorrer', 2: 'Terminada', '-2': 'Neutralizada', '-1': 'Anulada' };

export function attrsOf(p) {
  return String(p?.attributes || '').split('||').map(s => s.trim()).filter(Boolean);
}

export function isStarted(s) {
  if (s.state !== 0) return true;
  return !!(s.ut_activation && Date.now() / 1000 >= s.ut_activation);
}

export function isLive(s) {
  return s.state === 1 || (s.state === 0 && isStarted(s));
}

export class Race {
  constructor(rid) {
    this.rid = rid;
    this.info = null;
    this.itins = [];
    this.specials = new Map();   // itinId -> [special]
    this.parts = new Map();      // pid -> participante
    this.pens = [];
    this.chronos = new Map();    // sid -> Map("pid:run" -> registo)
    this.partials = new Map();   // sid -> {intermediates_meter, times}
    this.cls = new Map();        // "itin:sid" -> {special, accumulated}
    this.fetched = new Map();    // sid -> timestamp
    this.lastState = new Map();  // sid -> state
    this.members = new Map();    // itinId -> Set(pid)
    this.tick = 0;
    this.loaded = false;
    this.error = null;
    this.lastOk = 0;
  }

  get dec() { return this.info?.decimals ?? 1; }
  get name() { return this.info?.name || `Corrida ${this.rid}`; }

  async load() {
    if (this.loaded) return;
    const [info, itins, parts] = await Promise.all([
      api(`race/${this.rid}.json?add_subrallies_races=1`),
      api(`itineraries/${this.rid}.json`),
      api(`participants/${this.rid}.json`),
    ]);
    this.info = info || {};
    this.itins = itins || [];
    this.setParticipants(parts);
    this.loaded = true;
  }

  setParticipants(list) {
    this.parts = new Map((list || []).map(p => [p.id, p]));
  }

  async refresh() {
    await this.load();
    this.tick++;
    const errors = [];
    const sp = await Promise.all(this.itins.map(it =>
      api(`specials/${this.rid}.json?itinerary_id=${it.id}`).catch(e => { errors.push(e); return null; })));
    this.itins.forEach((it, i) => { if (sp[i]) this.specials.set(it.id, sp[i]); });

    const jobs = [api(`penalizations/${this.rid}.json`).then(d => { this.pens = d || []; })];
    if (this.tick % 4 === 0) jobs.push(api(`participants/${this.rid}.json`).then(d => this.setParticipants(d)));

    const now = Date.now();
    const all = new Map();
    for (const list of this.specials.values()) for (const s of list) all.set(s.id, s);

    for (const s of all.values()) {
      if (!isStarted(s)) continue;
      const prev = this.lastState.get(s.id);
      this.lastState.set(s.id, s.state);
      const last = this.fetched.get(s.id) || 0;
      if (!(isLive(s) || prev !== s.state || now - last > SLOW_REFRESH_MS)) continue;
      this.fetched.set(s.id, now);
      const fail = e => { this.fetched.set(s.id, 0); throw e; };
      jobs.push(api(`chronos2/${this.rid}.json?special_id=${s.id}`)
        .then(d => this.chronos.set(s.id, new Map((d || []).map(c => [`${c.participant_id}:${c.run}`, c])))).catch(fail));
      jobs.push(api(`partials/${this.rid}.json?special_id=${s.id}`)
        .then(d => { if (d) this.partials.set(s.id, d); }).catch(() => {}));
      for (const it of this.itins) {
        if (!(this.specials.get(it.id) || []).some(x => x.id === s.id)) continue;
        jobs.push(api(`classification/${this.rid}.json?itinerary_id=${it.id}&special_id=${s.id}`)
          .then(d => { if (d) this.cls.set(`${it.id}:${s.id}`, d); }).catch(fail));
      }
    }
    const res = await Promise.allSettled(jobs);
    for (const r of res) if (r.status === 'rejected') errors.push(r.reason);
    this.computeMembers();
    this.error = errors.length ? (errors[0]?.message || 'erro de ligação') : null;
    if (!errors.length) this.lastOk = Date.now();
  }

  computeMembers() {
    for (const it of this.itins) {
      const set = new Set();
      for (const s of this.specialsOf(it.id)) {
        const c = this.clsOf(it.id, s.id);
        if (!c) continue;
        for (const e of c.special || []) set.add(e.participant_id);
        for (const e of c.accumulated || []) set.add(e.participant_id);
      }
      this.members.set(it.id, set);
    }
  }

  // Itinerário por omissão de um piloto: o primeiro em que aparece.
  defaultItin(pid) {
    for (const it of this.itins) if (this.members.get(it.id)?.has(pid)) return it.id;
    return this.itins[0]?.id;
  }

  itinsOf(pid) {
    const l = this.itins.filter(it => this.members.get(it.id)?.has(pid));
    return l.length ? l : this.itins.slice(0, 1);
  }

  specialsOf(itin) { return this.specials.get(itin) || []; }
  startedSpecials(itin) { return this.specialsOf(itin).filter(isStarted); }
  clsOf(itin, sid) { return this.cls.get(`${itin}:${sid}`); }
  intermediates(sid) { return this.partials.get(sid)?.intermediates_meter || []; }
  special(itin, sid) { return this.specialsOf(itin).find(s => s.id === sid); }

  // Acumulado oficial depois da especial anterior a sid.
  prevAcc(itin, sid) {
    const list = this.specialsOf(itin);
    const i = list.findIndex(s => s.id === sid);
    for (let j = i - 1; j >= 0; j--) {
      const c = this.clsOf(itin, list[j].id);
      if (c?.accumulated?.length) return { first: false, map: new Map(c.accumulated.map(e => [e.participant_id, e])) };
    }
    return { first: true, map: null };
  }

  // Classificação num ponto. k = índice do intermédio (0..n-1) ou 'F' (final).
  // mode: 'stage' (tempo na especial) | 'overall' (geral; nos intermédios é provisória).
  ranking(itin, sid, k, mode) {
    const f = 10 ** this.dec;
    const round = v => Math.round(v * f) / f;
    const members = this.members.get(itin) || new Set();
    let rows = [];

    if (k === 'F') {
      const c = this.clsOf(itin, sid);
      const list = (mode === 'stage' ? c?.special : c?.accumulated) || [];
      rows = list.filter(e => e.total > 0).map(e => ({
        pid: e.participant_id, v: e.total, pen: e.penalization || 0, runs: e.runs, pos: e.position,
      }));
      rows.sort((a, b) => a.pos - b.pos || a.v - b.v);
      if (mode === 'overall' && rows.length) {
        const maxR = Math.max(...rows.map(r => r.runs || 0));
        rows.forEach(r => { r.missing = maxR - (r.runs || 0); });
      }
      return rows;
    }

    const p = this.partials.get(sid);
    if (!p?.times) return [];
    const ch = this.chronos.get(sid);
    const prev = mode === 'overall' ? this.prevAcc(itin, sid) : null;
    let maxRuns = 0;
    if (prev?.map) for (const e of prev.map.values()) maxRuns = Math.max(maxRuns, e.runs || 0);

    for (const [pidS, t] of Object.entries(p.times)) {
      const pid = Number(pidS);
      if (members.size && !members.has(pid)) continue;
      const up = t.uts_partial?.[k];
      if (!(up > 0)) continue;
      // Tal como o site oficial: tempo = passagem no intermédio - partida oficial.
      const st = ch?.get(`${pid}:${t.run}`)?.ut_start || t.ut_start;
      if (!(st > 0)) continue;
      let v = round(up - st);
      if (v <= 0) continue;
      if (prev && !prev.first) {
        const e = prev.map.get(pid);
        if (!e || (e.runs || 0) < maxRuns) continue; // falhou especiais: não comparável
        v = round(v + e.total);
      }
      rows.push({ pid, v });
    }
    rows.sort((a, b) => a.v - b.v);
    return rows;
  }

  // Classificações em que o piloto entra (geral, categoria, classe, grupo, campeonatos).
  groupsFor(pid) {
    const p = this.parts.get(pid) || {};
    const defs = [];
    const add = (key, kind, label, value, test) => { if (value) defs.push({ key, kind, label, value, test }); };
    const main = String(this.info?.uppermost || '').slice(0, 3); // cla | cat | grp
    const base = [
      ['cat', 'Categoria', p.category, x => x.category === p.category],
      ['cla', 'Classe', p.class, x => x.class === p.class],
      ['grp', 'Grupo', p.group, x => x.group === p.group],
    ];
    base.sort((a, b) => (b[0] === main) - (a[0] === main));
    for (const [key, label, value, test] of base) add(key, key, label, value, test);
    for (const a of attrsOf(p)) add(`att:${a}`, 'att', 'Campeonato', a, x => attrsOf(x).includes(a));

    // Remove classificações com exatamente os mesmos pilotos (ex.: categoria = classe).
    const out = [{ key: 'all', kind: 'all', label: 'Geral', value: '', test: () => true, sig: '*' }];
    const total = this.parts.size;
    for (const d of defs) {
      const ids = [...this.parts.values()].filter(d.test).map(x => x.id).sort((a, b) => a - b);
      d.sig = ids.length === total ? '*' : ids.join(',');
      const dup = out.find(o => o.sig === d.sig);
      if (dup) { if (dup.kind !== 'all' && dup.value !== d.value) dup.value += ` / ${d.value}`; continue; }
      out.push(d);
    }
    return out;
  }

  filter(rows, group) {
    if (!group || group.kind === 'all') return rows;
    return rows.filter(r => group.test(this.parts.get(r.pid) || {}));
  }

  // Último ponto com tempo do piloto.
  latestPoint(itin, pid) {
    const sps = this.startedSpecials(itin);
    for (let i = sps.length - 1; i >= 0; i--) {
      const s = sps[i];
      const c = this.clsOf(itin, s.id);
      if (c?.special?.some(e => e.participant_id === pid && e.total > 0)) return { sid: s.id, k: 'F' };
      const t = this.partials.get(s.id)?.times?.[pid];
      if (t?.uts_partial) {
        for (let k = t.uts_partial.length - 1; k >= 0; k--) if (t.uts_partial[k] > 0) return { sid: s.id, k };
      }
    }
    return null;
  }

  pointLabel(itin, pt) {
    if (!pt) return '—';
    const s = this.special(itin, pt.sid);
    const name = s?.special_name || '';
    if (pt.k === 'F') return `${name} · Final`;
    const m = this.intermediates(pt.sid)[pt.k];
    return `${name} · I${pt.k + 1}${m ? ` (km ${(m / 1000).toFixed(2)})` : ''}`;
  }

  pensOf(pid) { return this.pens.filter(x => x.participant_id === pid); }

  abandoned(pid) {
    const p = this.parts.get(pid);
    return !!p && (p.abandon_special_id > 0 || p.active === 0);
  }
}

export function posOf(rows, pid) {
  const i = rows.findIndex(r => r.pid === pid);
  return i < 0 ? null : i + 1;
}

const pad = n => String(n).padStart(2, '0');

export function fmtTime(s, dec = 1) {
  if (s == null || !isFinite(s)) return '—';
  const neg = s < 0;
  const f = 10 ** dec;
  let t = Math.round(Math.abs(s) * f);
  const fr = t % f;
  t = (t - fr) / f;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const frac = dec ? '.' + String(fr).padStart(dec, '0') : '';
  return (neg ? '-' : '') + (h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`) + frac;
}

export function fmtGap(d, dec = 1) {
  if (d == null || !isFinite(d)) return '—';
  if (Math.abs(d) < 0.5 / 10 ** dec) return '=';
  const a = Math.abs(d);
  return (d > 0 ? '+' : '−') + (a < 60 ? a.toFixed(dec) : fmtTime(a, dec));
}
