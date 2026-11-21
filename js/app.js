// MotorTracker — interface, atualização periódica e alertas.
import { api, fetchEvents, timingIds, trackLinks } from './api.js';
import { Race, STATE_LABEL, attrsOf, isLive, posOf, fmtTime, fmtGap } from './race.js';
import { TrackSource, evaluate, siren, fmtKm, SIRENS, pushHistory, movement, haversine } from './proximity.js';
import { PLACE_TYPES, typeOf, wazeUrl, gmapsUrl, gmapsSearchUrl, wazeSearchUrl, parseCoords, loadCurated, fromSections, fuelNear, centerOf } from './places.js';

const LS_KEY = 'motortracker.v1';
const NEIGHBOURS = 3;

// ---------- Estado persistente ----------
const defaults = () => ({
  tracked: [],                 // [{rid, pid, ident}]
  event: null,                 // {id, name, rids}
  filter: { tab: 'ongoing', type: 'all', country: 'all', q: '' },
  cards: {},                   // estado de cada cartão por "rid:pid"
  settings: { interval: 15, alerts: { pos: true, time: true, ab: true }, sound: true, wake: false, theme: 'auto', sirenType: 'ambulancia' },
  prox: { on: false, useFixed: false, fixed: null, muted: [] }, // avisos de proximidade
  trackIds: {},                // rallyId de cronometragem -> id do mapa de tracking (0 = sem mapa)
  places: {},                  // locais acrescentados no aparelho, por prova
});
const S = (() => {
  const d = defaults();
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return {
      ...d, ...s,
      filter: { ...d.filter, ...(s.filter || {}) },
      prox: { ...d.prox, ...(s.prox || {}) },
      trackIds: { ...(s.trackIds || {}) },
      places: { ...(s.places || {}) },
      settings: { ...d.settings, ...(s.settings || {}), alerts: { ...d.settings.alerts, ...(s.settings?.alerts || {}) } },
    };
  } catch { return d; }
})();
const save = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch { /* sem armazenamento */ } };

// ---------- Estado em memória ----------
const races = new Map();       // rid -> Race
const raceNames = new Map();   // rid -> nome
let events = null, eventsAt = 0, eventsErr = null;
let view = S.tracked.length ? 'live' : 'events';
let pickRid = null;
let pollTimer = null, polling = false, lastUpdate = 0;
const snaps = new Map();
let wakeLock = null;

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const keyOf = t => `${t.rid}:${t.pid}`;
const isTracked = (rid, pid) => S.tracked.some(t => t.rid === rid && t.pid === pid);
const hhmmss = ts => new Date(ts).toLocaleTimeString('pt-PT');

function getRace(rid) {
  if (!races.has(rid)) races.set(rid, new Race(rid));
  return races.get(rid);
}

// ---------- Navegação ----------
function go(v) {
  view = v;
  render();
  window.scrollTo(0, 0);
}

$('#back').addEventListener('click', () => {
  if (view === 'live') go(S.event ? 'pick' : 'events');
  else if (view === 'pick') go('events');
});

function render() {
  $('#back').hidden = view === 'events';
  $('#title').textContent = view === 'events' ? 'MotorTracker' : view === 'pick' ? 'Escolher pilotos' : 'Ao vivo';
  $('#liveBtn').hidden = view === 'live' || !S.tracked.length;
  $('#liveBtn').textContent = `Ao vivo (${S.tracked.length})`;
  if (view === 'events') renderEvents();
  else if (view === 'pick') renderPick();
  else renderLive();
  updateWakeLock();
}

$('#liveBtn').addEventListener('click', () => go('live'));

// ---------- Ecrã 1: provas ----------
async function loadEvents(force = false) {
  if (!force && events && Date.now() - eventsAt < 60000) return;
  try {
    events = await fetchEvents();
    eventsAt = Date.now();
    eventsErr = null;
  } catch (e) {
    eventsErr = e.message || String(e);
  }
}

const TAB_LABEL = { ongoing: 'A decorrer', upcoming: 'Próximas', past: 'Passadas' };
const normType = t => String(t || '').trim().toUpperCase() || 'OUTRAS';

async function renderEvents() {
  const el = $('#view');
  if (!events) el.innerHTML = `<p class="muted center pad">A carregar provas…</p>`;
  await loadEvents();
  if (view !== 'events') return;
  if (!events) {
    el.innerHTML = `<div class="card pad"><p>Não foi possível obter as provas: ${esc(eventsErr)}</p><button class="btn" id="retry">Tentar outra vez</button></div>`;
    $('#retry').onclick = () => { loadEvents(true).then(renderEvents); };
    return;
  }
  const f = S.filter;
  const counts = { ongoing: 0, upcoming: 0, past: 0 };
  for (const e of events) if (e.state in counts) counts[e.state]++;
  const types = [...new Set(events.map(e => normType(e.type)))].sort();
  const countries = [...new Set(events.map(e => (e.country || '').toLowerCase()).filter(Boolean))].sort();
  const q = f.q.trim().toLowerCase();
  const list = events.filter(e => e.state === f.tab
    && (f.type === 'all' || normType(e.type) === f.type)
    && (f.country === 'all' || (e.country || '').toLowerCase() === f.country)
    && (!q || `${e.name} ${e.eventPlace}`.toLowerCase().includes(q)));
  if (f.tab === 'upcoming') list.reverse();

  el.innerHTML = `
    <div class="tabs">${Object.keys(TAB_LABEL).map(t =>
      `<button class="tab ${f.tab === t ? 'on' : ''}" data-tab="${t}">${TAB_LABEL[t]} <span class="cnt">${counts[t]}</span></button>`).join('')}</div>
    <div class="filters">
      <select id="fType"><option value="all">Todos os tipos</option>${types.map(t => `<option ${f.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <select id="fCountry"><option value="all">Todos os países</option>${countries.map(c => `<option value="${esc(c)}" ${f.country === c ? 'selected' : ''}>${esc(c.toUpperCase())}</option>`).join('')}</select>
      <input id="fQ" type="search" placeholder="Procurar prova…" value="${esc(f.q)}">
    </div>
    <div class="list">${list.length ? list.map(eventCard).join('') : `<p class="muted center pad">Sem provas ${TAB_LABEL[f.tab].toLowerCase()} com estes filtros.</p>`}</div>
    <p class="muted small center">Atualizado às ${hhmmss(eventsAt)} · <a href="#" id="reloadEv">recarregar</a></p>`;

  el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { f.tab = b.dataset.tab; save(); renderEvents(); });
  $('#fType').onchange = e => { f.type = e.target.value; save(); renderEvents(); };
  $('#fCountry').onchange = e => { f.country = e.target.value; save(); renderEvents(); };
  $('#fQ').oninput = e => {
    f.q = e.target.value; save();
    clearTimeout(renderEvents.t);
    renderEvents.t = setTimeout(() => { renderEvents().then(() => { const i = $('#fQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 250);
  };
  $('#reloadEv').onclick = e => { e.preventDefault(); loadEvents(true).then(renderEvents); };
  el.querySelectorAll('[data-rid]').forEach(b => b.onclick = () => {
    const ev = events.find(x => x.id === Number(b.dataset.ev));
    S.event = { id: ev.id, name: ev.name, rids: timingIds(ev) };
    for (const l of trackLinks(ev)) S.trackIds[l.rid] = l.sid;
    pickRid = Number(b.dataset.rid);
    save();
    go('pick');
  });
  // nomes das corridas (carros / motos) carregados à parte
  for (const ev of list) for (const rid of timingIds(ev)) if (!raceNames.has(rid)) loadRaceName(rid);
}

function raceIcon(name) {
  return /FMP|FIM|MOTO|BIKE|QUAD/i.test(name || '') ? '🏍️' : '🚙';
}

async function loadRaceName(rid) {
  raceNames.set(rid, null);
  try {
    const info = await api(`race/${rid}.json?add_subrallies_races=1`);
    raceNames.set(rid, info?.name || `Corrida ${rid}`);
  } catch { raceNames.set(rid, `Corrida ${rid}`); }
  document.querySelectorAll(`[data-rid="${rid}"] .rn`).forEach(n => { n.textContent = `${raceIcon(raceNames.get(rid))} ${raceNames.get(rid)}`; });
}

function eventCard(e) {
  const rids = timingIds(e);
  const d = new Date(`${e.date}T12:00:00`);
  const ds = isNaN(d) ? esc(e.date) : d.toLocaleDateString('pt-PT', { day: '2-digit', month: 'short', year: 'numeric' });
  return `<article class="card ev">
    <div class="ev-h"><span class="badge">${esc(normType(e.type))}</span><span class="muted small">${ds} · ${esc(e.eventPlace || '')} ${e.country ? '· ' + esc(e.country.toUpperCase()) : ''}</span>
    ${e.state === 'ongoing' ? '<span class="live-dot" title="A decorrer"></span>' : ''}</div>
    <h3>${esc(e.name)}</h3>
    ${rids.length ? `<div class="races">${rids.map(r => `<button class="btn race" data-ev="${e.id}" data-rid="${r}"><span class="rn">${raceNames.get(r) ? raceIcon(raceNames.get(r)) + ' ' + esc(raceNames.get(r)) : 'Corrida ' + r + '…'}</span><span>›</span></button>`).join('')}</div>`
      : `<p class="muted small">Sem cronometragem online nesta prova.</p>`}
  </article>`;
}

// ---------- Ecrã 2: escolher pilotos ----------
let pickQuery = '';

async function renderPick() {
  const el = $('#view');
  const rids = S.event?.rids || [];
  if (!rids.length) { go('events'); return; }
  if (!rids.includes(pickRid)) pickRid = rids[0];
  const race = getRace(pickRid);
  if (!race.loaded) {
    el.innerHTML = `<p class="muted center pad">A carregar inscritos…</p>`;
    try { await race.load(); } catch (e) {
      el.innerHTML = `<div class="card pad"><p>Erro a carregar a corrida: ${esc(e.message)}</p><button class="btn" id="retry">Tentar outra vez</button></div>`;
      $('#retry').onclick = renderPick;
      return;
    }
    // junta corridas irmãs (ex.: carros e motos) indicadas pela API
    for (const o of race.info.other_races || []) if (o.id && !rids.includes(o.id)) { rids.push(o.id); raceNames.set(o.id, o.name); }
    raceNames.set(pickRid, race.name);
    save();
    if (view !== 'pick') return;
  }
  const parts = [...race.parts.values()].sort((a, b) => (parseInt(a.ident, 10) || 1e9) - (parseInt(b.ident, 10) || 1e9) || String(a.ident).localeCompare(b.ident));
  const q = pickQuery.trim().toLowerCase();
  const shown = q ? parts.filter(p => `${p.ident} ${p.pilot} ${p.copilot} ${p.vehicle} ${p.class} ${p.category} ${p.competitor}`.toLowerCase().includes(q)) : parts;
  const n = S.tracked.length;

  el.innerHTML = `
    <div class="card pad"><div class="muted small">Prova</div><b>${esc(S.event.name)}</b></div>
    ${docsBlock([pickRid])}
    ${rids.length > 1 ? `<div class="tabs">${rids.map(r => `<button class="tab ${r === pickRid ? 'on' : ''}" data-r="${r}">${raceNames.get(r) ? raceIcon(raceNames.get(r)) + ' ' + esc(raceNames.get(r)) : 'Corrida ' + r}</button>`).join('')}</div>` : ''}
    <div class="filters">
      <input id="pQ" type="search" placeholder="N.º, nome, viatura, classe…" value="${esc(pickQuery)}">
      <input id="pNums" type="text" inputmode="numeric" placeholder="Adicionar n.º (ex.: 200, 215)">
      <button class="btn" id="pAdd">Adicionar</button>
    </div>
    ${parts.length ? '' : '<p class="muted center pad">Ainda não há inscritos publicados para esta corrida.</p>'}
    <div class="plist">${shown.map(p => `
      <label class="prow ${isTracked(pickRid, p.id) ? 'on' : ''}">
        <input type="checkbox" data-pid="${p.id}" ${isTracked(pickRid, p.id) ? 'checked' : ''}>
        <span class="num">${esc(p.ident)}</span>
        <span class="pinfo"><b>${esc(p.pilot)}</b>${p.copilot ? ' / ' + esc(p.copilot) : ''}<br>
          <small class="muted">${esc(p.vehicle)}${[p.category, p.class, p.group].filter(Boolean).length ? ' · ' + esc([p.category, p.class, p.group].filter(Boolean).join(' · ')) : ''}${race.abandoned(p.id) ? ' · <span class="bad">abandono</span>' : ''}</small></span>
      </label>`).join('')}</div>
    <div class="sticky-foot"><button class="btn primary" id="goLive" ${n ? '' : 'disabled'}>Acompanhar ao vivo (${n})</button></div>`;

  el.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { pickRid = Number(b.dataset.r); renderPick(); });
  bindDocs(el);
  $('#pQ').oninput = e => {
    pickQuery = e.target.value;
    clearTimeout(renderPick.t);
    renderPick.t = setTimeout(() => renderPick().then(() => { const i = $('#pQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }), 200);
  };
  const addNums = () => {
    const wanted = $('#pNums').value.split(/[^0-9A-Za-z]+/).filter(Boolean);
    const missing = [];
    for (const w of wanted) {
      const p = parts.find(x => String(x.ident).toLowerCase() === w.toLowerCase());
      if (p) track(pickRid, p, true); else missing.push(w);
    }
    if (missing.length) toast(`Número(s) não encontrado(s) nesta corrida: ${missing.join(', ')}`);
    renderPick();
  };
  $('#pAdd').onclick = addNums;
  $('#pNums').onkeydown = e => { if (e.key === 'Enter') addNums(); };
  el.querySelectorAll('input[data-pid]').forEach(cb => cb.onchange = () => {
    const p = race.parts.get(Number(cb.dataset.pid));
    track(pickRid, p, cb.checked);
    cb.closest('.prow').classList.toggle('on', cb.checked);
    const btn = $('#goLive');
    btn.disabled = !S.tracked.length;
    btn.textContent = `Acompanhar ao vivo (${S.tracked.length})`;
    $('#liveBtn').textContent = `Ao vivo (${S.tracked.length})`;
  });
  $('#goLive').onclick = () => { go('live'); poll(); };
}

function track(rid, p, on) {
  const i = S.tracked.findIndex(t => t.rid === rid && t.pid === p.id);
  if (on && i < 0) S.tracked.push({ rid, pid: p.id, ident: p.ident });
  if (!on && i >= 0) { S.tracked.splice(i, 1); snaps.delete(`${rid}:${p.id}`); }
  save();
  schedule();
  scheduleTrack();
}

// ---------- Ecrã 3: ao vivo ----------
function cardState(t, race) {
  const k = keyOf(t);
  const c = S.cards[k] || (S.cards[k] = { follow: true, mode: 'overall', group: 'all', itin: null, sid: null, k: null });
  if (!c.itin || !race.itins.some(i => i.id === c.itin) || (!race.members.get(c.itin)?.has(t.pid) && race.defaultItin(t.pid) !== c.itin)) {
    c.itin = race.defaultItin(t.pid);
  }
  const latest = race.latestPoint(c.itin, t.pid);
  if (c.follow || !c.sid) {
    const sps = race.startedSpecials(c.itin);
    c.sid = latest?.sid ?? sps[sps.length - 1]?.id ?? race.specialsOf(c.itin)[0]?.id ?? null;
    c.k = latest?.k ?? 'F';
  }
  return { c, latest };
}

function renderLive() {
  const el = $('#view');
  if (!S.tracked.length) {
    el.innerHTML = `<div class="card pad center"><p>Ainda não estás a acompanhar nenhum piloto.</p><button class="btn primary" id="toEv">Escolher prova</button></div>`;
    $('#toEv').onclick = () => go('events');
    return;
  }
  // guarda posição do scroll horizontal das grelhas
  const scrolls = {};
  el.querySelectorAll('[data-scroll]').forEach(n => { scrolls[n.dataset.scroll] = n.scrollLeft; });
  // guarda o que estiver a ser escrito no "Adicionar pilotos"
  const addInp = $('#addNums');
  const addKeep = addInp ? { v: addInp.value, f: document.activeElement === addInp, s: addInp.selectionStart } : null;

  const loading = S.tracked.some(t => !getRace(t.rid).lastOk && !getRace(t.rid).error);
  const errs = [...new Set(S.tracked.map(t => getRace(t.rid).error).filter(Boolean))];
  const head = `<div class="livebar">
      <span>${lastUpdate ? `Atualizado às ${hhmmss(lastUpdate)}` : 'A carregar…'} · a cada ${S.settings.interval}s</span>
      ${errs.length ? `<span class="bad">⚠ ${esc(errs[0])} — a tentar de novo</span>` : ''}
      <button class="btn small" id="refreshNow">Atualizar</button>
      ${S.event ? '<button class="btn small" id="addMore">+ Pilotos</button>' : ''}
    </div>${proxPanel()}`;

  if (loading && !lastUpdate) { el.innerHTML = head + '<p class="muted center pad">A obter tempos…</p>'; bindLiveHead(); return; }

  const cards = [], summary = [];
  for (const t of S.tracked) {
    const race = getRace(t.rid);
    if (!race.loaded) continue;
    const { c, latest } = cardState(t, race);
    const allGroups = race.groupsFor(t.pid);
    const groups = allGroups.filter(g => !(c.hidden || []).includes(g.key)); // só as classes ligadas
    const p = race.parts.get(t.pid) || { ident: t.ident, pilot: '(piloto não encontrado)' };
    // resumo
    let sumPos = '—', sumCls = '—';
    if (latest) {
      const ov = race.ranking(c.itin, latest.sid, latest.k, 'overall');
      sumPos = posOf(ov, t.pid) ?? '—';
      const g2 = groups.find(g => g.kind !== 'all');
      if (g2) sumCls = `${posOf(race.filter(ov, g2), t.pid) ?? '—'}º ${esc(g2.value)}`;
    }
    summary.push(`<tr data-jump="${keyOf(t)}"><td class="num">${esc(p.ident)}</td><td>${esc(p.pilot)}${race.abandoned(t.pid) ? ' <span class="bad">AB</span>' : ''}</td>
      <td class="muted small">${esc(race.pointLabel(c.itin, latest))}</td><td class="pos">${sumPos}${sumPos !== '—' ? 'º' : ''}</td><td class="small">${sumCls}</td></tr>`);
    cards.push(pilotCard(t, race, c, latest, groups, p, allGroups));
  }

  el.innerHTML = head + `
    ${S.tracked.length > 1 ? `<div class="card"><table class="sum"><thead><tr><th>N.º</th><th>Piloto</th><th>Último ponto</th><th>Geral</th><th>Classe</th></tr></thead><tbody>${summary.join('')}</tbody></table></div>` : ''}
    ${docsBlock([...new Set(S.tracked.map(t => t.rid))])}
    ${placesCard()}
    ${cards.join('')}
    ${addCard()}
    <p class="muted small center">Geral nos intermédios = acumulado oficial até à especial anterior + tempo no intermédio (provisória).</p>`;

  el.querySelectorAll('[data-scroll]').forEach(n => { if (scrolls[n.dataset.scroll] != null) n.scrollLeft = scrolls[n.dataset.scroll]; else n.scrollLeft = n.scrollWidth; });
  bindLiveHead();
  bindCards();
  bindDocs(el);
  bindAddCard();
  if (addKeep) {
    const i = $('#addNums');
    if (i) { i.value = addKeep.v; if (addKeep.f) { i.focus({ preventScroll: true }); try { i.setSelectionRange(addKeep.s, addKeep.s); } catch {} } }
  }
  el.querySelectorAll('[data-place]').forEach(b => b.onclick = () => openPlaces(b.dataset.place));
}

// ---------- Adicionar mais pilotos sem sair do ecrã ao vivo ----------
const addRids = () => [...new Set([...(S.event?.rids || []), ...S.tracked.map(t => t.rid)])];
let addRid = null;

function addCard() {
  const rids = addRids();
  if (!rids.includes(addRid)) addRid = S.tracked[S.tracked.length - 1]?.rid ?? rids[0];
  const nm = r => raceNames.get(r) || getRace(r).name || `Corrida ${r}`;
  return `<div class="card pad addcard"><b>➕ Adicionar pilotos</b>
    <div class="muted small">Os pilotos que já segues continuam na lista.</div>
    ${rids.length > 1 ? `<div class="tabs">${rids.map(r => `<button class="tab ${r === addRid ? 'on' : ''}" data-addr="${r}">${raceIcon(nm(r))} ${esc(nm(r))}</button>`).join('')}</div>` : ''}
    <div class="filters">
      <input id="addNums" type="text" inputmode="numeric" placeholder="N.º (ex.: 200, 215)">
      <button class="btn primary" id="addGo">Adicionar</button>
      ${S.event ? '<button class="btn" id="addList">Escolher na lista</button>' : ''}
    </div></div>`;
}

function bindAddCard() {
  const el = $('#view');
  el.querySelectorAll('[data-addr]').forEach(b => b.onclick = () => {
    addRid = Number(b.dataset.addr);
    el.querySelectorAll('[data-addr]').forEach(x => x.classList.toggle('on', x === b));
  });
  $('#addList')?.addEventListener('click', () => { pickRid = addRid; go('pick'); });
  // nomes das corridas que ainda não foram abertas (carros / motos)
  el.querySelectorAll('[data-addr]').forEach(b => {
    const r = Number(b.dataset.addr), race = getRace(r);
    if (raceNames.get(r) || race.loading) return;
    race.loading = true;
    race.load().then(() => {
      raceNames.set(r, race.name);
      const x = document.querySelector(`[data-addr="${r}"]`);
      if (x) x.textContent = `${raceIcon(race.name)} ${race.name}`;
    }).catch(() => {}).finally(() => { race.loading = false; });
  });
  const run = async () => {
    const inp = $('#addNums');
    const wanted = inp.value.split(/[^0-9A-Za-z]+/).filter(Boolean);
    if (!wanted.length) { inp.focus(); return; }
    const race = getRace(addRid);
    try { if (!race.loaded) await race.load(); } catch (e) { toast(`Erro a carregar a corrida: ${e.message}`); return; }
    const parts = [...race.parts.values()];
    const added = [], missing = [], already = [];
    for (const w of wanted) {
      const p = parts.find(x => String(x.ident).toLowerCase() === w.toLowerCase());
      if (!p) missing.push(w);
      else if (isTracked(addRid, p.id)) already.push(w);
      else { track(addRid, p, true); added.push(w); }
    }
    if (added.length) toast(`Adicionado(s): ${added.join(', ')}`);
    if (already.length) toast(`Já estavas a seguir: ${already.join(', ')}`);
    if (missing.length) toast(`Número(s) não encontrado(s) nesta corrida: ${missing.join(', ')}`);
    inp.value = missing.join(', ');
    if (added.length) { $('#liveBtn').textContent = `Ao vivo (${S.tracked.length})`; await poll(); }
  };
  $('#addGo')?.addEventListener('click', run);
  $('#addNums')?.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
}

// ---------- Locais da prova (parque fechado, partidas, chegadas, assistência, GAS, bombas, ZE) ----------
const placesKey = () => String(S.event?.id || 'geral');
const myPlaces = () => S.places[placesKey()] || [];
let curatedNow = [];   // locais da organização da prova atual

function placesCard() {
  return `<div class="card places"><div class="docs-h"><b>📍 Locais da prova</b><span class="muted small">toca para ver e ir lá com o Waze ou o Google Maps</span></div>
    <div class="pgrid">${PLACE_TYPES.map(t => `<button class="pbtn" data-place="${t.key}"><span class="pic">${t.icon}</span><span>${t.label}</span></button>`).join('')}</div></div>`;
}

// Garante dados de tracking (partidas/chegadas) para todas as corridas da prova.
async function eventTrackSources() {
  const rids = [...new Set([...(S.event?.rids || []), ...S.tracked.map(t => t.rid)])];
  const out = [];
  for (const rid of rids) {
    const sid = await resolveTrackId(rid);
    if (!sid) continue;
    if (!trackSrc.has(sid)) trackSrc.set(sid, new TrackSource(sid));
    const src = trackSrc.get(sid);
    if (!src.secAt) { try { await src.refresh(); } catch { /* sem dados */ } }
    try { await getRace(rid).load(); } catch { /* fica com o nome genérico */ }
    const name = getRace(rid).info?.name || raceNames.get(rid) || `Corrida ${rid}`;
    out.push({ src, label: `${raceIcon(name)} ${/FMP|FIM|MOTO/i.test(name) ? 'Motos' : 'Carros'}` });
  }
  return out;
}

async function openPlaces(type) {
  const t = typeOf(type);
  const dlg = $('#placesDlg');
  $('#placesTitle').textContent = `${t.icon} ${t.label}`;
  $('#placesBody').innerHTML = '<p class="muted pad">A procurar locais…</p>';
  if (!dlg.open) dlg.showModal();
  dlg.dataset.type = type;
  startGps(); // para ordenar pela distância a ti

  let list = [], extra = '';
  curatedNow = await loadCurated(S.event?.id);
  list.push(...curatedNow.filter(p => p.type === type));
  if (type === 'start' || type === 'finish') {
    list.push(...fromSections(await eventTrackSources()).filter(p => p.type === type));
  }
  list.push(...myPlaces().filter(p => p.type === type).map(p => ({ ...p, src: 'mine' })));

  if (type === 'fuel') {
    // centro da pesquisa: a tua posição, ou os locais conhecidos da prova
    const known = [...curatedNow, ...fromSections(await eventTrackSources()), ...myPlaces()];
    const center = userPos() || centerOf(known);
    if (center) {
      extra = `<div class="row wrap"><a class="btn small" target="_blank" rel="noopener" href="${gmapsSearchUrl('bombas de gasolina', center.lat, center.lon)}">🔎 Procurar no Google Maps</a>
        <a class="btn small" target="_blank" rel="noopener" href="${wazeSearchUrl('bomba de gasolina', center.lat, center.lon)}">🔎 Procurar no Waze</a></div>
        <div class="small muted">${userPos() ? 'Perto de ti.' : 'Perto dos locais da prova (liga a localização para procurar perto de ti).'}</div>`;
      $('#placesBody').innerHTML = `${extra}<p class="muted pad">A procurar bombas no OpenStreetMap…</p>`;
      try {
        const r = await fuelNear(center);
        list.push(...r.list);
      } catch {
        extra += '<div class="small warn-txt">O OpenStreetMap não respondeu agora — usa os botões de pesquisa acima.</div>';
      }
    } else {
      extra = '<div class="small muted">Liga a localização (📍 Onde estou) para procurar bombas perto de ti.</div>';
    }
  }
  if (dlg.dataset.type !== type) return; // entretanto escolheu outro tipo
  // o mesmo local vindo de várias fontes (organização, cronometragem, OpenStreetMap) aparece só uma vez
  const uniq = [];
  for (const p of list) if (!uniq.some(q => q.type === p.type && q.src !== p.src && haversine(q, p) < 0.06)) uniq.push(p);
  renderPlaces(type, uniq, extra);
}

function renderPlaces(type, list, extra) {
  const u = userPos();
  list.forEach(p => { p.dist = u ? haversine(u, p) : null; });
  const rankSrc = p => (p.src === 'org' ? 0 : p.src === 'mine' ? 1 : 2);
  list.sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9) || rankSrc(a) - rankSrc(b) || String(a.name).localeCompare(b.name));
  if (type === 'fuel') list = list.slice(0, 40);
  const srcLabel = { org: 'organização', timing: 'cronometragem', osm: 'OpenStreetMap', mine: 'acrescentado por ti' };
  const items = list.map((p, i) => `<div class="pitem">
      <div class="pinfo"><b>${esc(p.name)}</b>${p.dist != null ? ` <span class="pdist">${fmtKm(p.dist)}</span>` : ''}
        <div class="small muted">${[p.note, srcLabel[p.src]].filter(Boolean).map(esc).join(' · ')}</div></div>
      <div class="pgo">
        <a class="btn small primary" target="_blank" rel="noopener" href="${wazeUrl(p.lat, p.lon)}">Waze</a>
        <a class="btn small" target="_blank" rel="noopener" href="${gmapsUrl(p.lat, p.lon)}">Maps</a>
        ${p.src === 'mine' ? `<button class="icon-btn small" data-pdel="${esc(p.id)}" title="Apagar">🗑</button>` : ''}
      </div></div>`).join('');
  const empty = type === 'start' || type === 'finish'
    ? 'Estas coordenadas ainda não foram publicadas (costumam sair perto da hora da especial).'
    : type === 'fuel' ? '' : 'Ainda não há locais destes para esta prova.';
  $('#placesBody').innerHTML = `${extra || ''}
    ${items || (empty ? `<p class="muted small pad">${empty}</p>` : '')}
    ${type !== 'fuel' ? `<details class="padd"><summary>➕ Acrescentar local</summary>
      <input id="paName" type="text" placeholder="Nome (ex.: ZE 3 – Ribeira)" value="">
      <input id="paCoords" type="text" placeholder="Coordenadas ou link do Google Maps (ex.: 39.8236, -7.8718)">
      <div class="row wrap"><button class="btn small" id="paHere">📍 Usar a minha posição</button><button class="btn small primary" id="paSave">Guardar</button></div>
      <div class="small muted">Fica guardado só neste aparelho.</div></details>` : ''}`;

  $('#placesBody').querySelectorAll('[data-pdel]').forEach(b => b.onclick = () => {
    S.places[placesKey()] = myPlaces().filter(p => p.id !== b.dataset.pdel);
    save();
    openPlaces(type);
  });
  $('#paHere')?.addEventListener('click', () => {
    startGps();
    const me = userPos();
    if (me) $('#paCoords').value = `${me.lat.toFixed(6)}, ${me.lon.toFixed(6)}`;
    else toast('A obter a tua localização… tenta outra vez daqui a uns segundos.');
  });
  $('#paSave')?.addEventListener('click', () => {
    const c = parseCoords($('#paCoords').value);
    if (!c) { toast('Coordenadas inválidas. Ex.: 39.8236, -7.8718'); return; }
    const name = $('#paName').value.trim() || typeOf(type).label;
    S.places[placesKey()] = [...myPlaces(), { id: `${Date.now()}`, type, name, lat: c.lat, lon: c.lon, note: '' }];
    save();
    openPlaces(type);
  });
}

$('#placesClose').addEventListener('click', () => $('#placesDlg').close());

// ---------- Documentos oficiais (Sportity) ----------
// O link vem dos dados da prova (url_org_docs). No Sportity o código do evento é o nome do canal.
function docsInfo(rid) {
  const url = getRace(rid).info?.url_org_docs || '';
  if (!/^https?:\/\//i.test(url)) return null;
  const code = url.match(/sportity\.com\/(?:channel|event)\/([^/?#]+)/i)?.[1] || '';
  return { url, code: code ? decodeURIComponent(code) : '' };
}

function docsBlock(rids) {
  const rows = rids.map(rid => {
    const d = docsInfo(rid);
    if (!d) return '';
    const name = getRace(rid).name;
    return `<div class="docrow">
      <div class="docname"><span class="muted small">${raceIcon(name)} ${esc(name)}</span>
        ${d.code ? `<span class="small">Código Sportity: <b class="code">${esc(d.code)}</b></span>` : '<span class="small">Documentos no site da organização</span>'}</div>
      ${d.code ? `<button class="btn small" data-copy="${esc(d.code)}">Copiar</button>` : ''}
      <a class="btn small primary" href="${esc(d.url)}" target="_blank" rel="noopener">Abrir</a>
    </div>`;
  }).join('');
  return rows ? `<div class="card docs"><div class="docs-h"><b>📄 Documentos oficiais</b><span class="muted small">regulamento, direção de prova, CCD, classificações</span></div>${rows}</div>` : '';
}

function bindDocs(el) {
  el?.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    const code = b.dataset.copy;
    let ok = false;
    try { await navigator.clipboard.writeText(code); ok = true; } catch {
      // alternativa para browsers sem acesso à área de transferência
      const ta = document.createElement('textarea');
      ta.value = code; document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    toast(ok ? `Código ${code} copiado.` : `Código: ${code}`);
  });
}

function bindLiveHead() {
  $('#refreshNow')?.addEventListener('click', () => poll());
  $('#addMore')?.addEventListener('click', () => go('pick'));
  bindProxPanel();
}

function bindProxPanel() {
  $('#proxToggle')?.addEventListener('click', () => setProx(!S.prox.on));
  $('#proxFix')?.addEventListener('click', () => {
    if (!gpsPos) { toast('Ainda não há posição GPS para fixar.'); return; }
    S.prox.fixed = { lat: gpsPos.lat, lon: gpsPos.lon };
    S.prox.useFixed = true;
    save(); refreshProxPanel(); proxTick();
  });
  $('#proxGps')?.addEventListener('click', () => { S.prox.useFixed = false; save(); refreshProxPanel(); proxTick(); });
  $('#proxTest')?.addEventListener('click', () => {
    unlockAudio();
    const t = S.tracked[0];
    const p = t ? getRace(t.rid).parts.get(t.pid) : null;
    flashProx(2, `#${p?.ident ?? t?.ident ?? '000'} ${p?.pilot || 'Teste'}`, 'teste · pela estrada · 120 km/h');
  });
}

// Ritmo na especial (cronometragem): média e diferença para o melhor da classe no último ponto.
function paceHtml(t, race, c, latest, allGroups) {
  if (!latest) return '';
  const rows = race.ranking(c.itin, latest.sid, latest.k, 'stage');
  const mine = rows.find(r => r.pid === t.pid);
  if (!mine) return '';
  const g = allGroups.find(x => x.kind === 'cla') || allGroups.find(x => x.kind !== 'all') || allGroups[0];
  const cls = race.filter(rows, g);
  const best = cls[0];
  const sp = race.special(c.itin, latest.sid);
  const meters = latest.k === 'F' ? sp?.meters : race.intermediates(latest.sid)[latest.k];
  const kmh = meters && mine.v > 0 ? (meters / 1000) / (mine.v / 3600) : null;
  const pct = best && best.v > 0 ? (mine.v / best.v - 1) * 100 : null;
  const who = g?.kind === 'all' ? 'geral' : esc(g?.value || '');
  let cmp = '';
  if (best?.pid === t.pid) cmp = `<b class="good">melhor da ${g?.kind === 'all' ? 'geral' : 'classe ' + who}</b>`;
  else if (pct != null) cmp = `<b class="${pct <= 2 ? 'good' : pct >= 8 ? 'bad' : ''}">+${pct.toFixed(1).replace('.', ',')}%</b> vs melhor ${g?.kind === 'all' ? 'da geral' : who}`;
  return `<span>⏱ Ritmo ${esc(race.pointLabel(c.itin, latest))}: ${kmh ? `média ${Math.round(kmh)} km/h · ` : ''}${cmp}</span>`;
}

// Estado instantâneo pelo GPS (atualizado a cada 10 s).
function statusHtml(key) {
  const m = moveRes.get(key);
  if (!m) return '<span class="muted">📡 A obter posição GPS…</span>';
  if (m.kind === 'notrack') return '<span class="muted">📡 Sem tracking público para esta corrida</span>';
  if (m.kind === 'error') return '<span class="muted">📡 Tracking indisponível</span>';
  if (m.kind === 'nogps') return '<span class="muted">⚪ Sem posição GPS</span>';
  if (m.kind === 'stale') return `<span class="muted">⚪ Sem sinal GPS há ${fmtAge(m.age)}</span>`;
  const ago = m.age != null ? ` <span class="muted">· GPS há ${fmtAge(m.age)}</span>` : '';
  if (m.kind === 'stopped') return `<b class="st-stop">🔴 Parado${m.stillFor >= 60 ? ` há ${fmtAge(m.stillFor)}` : ''}</b>${ago}`;
  let pace = '';
  if (m.pace === 'fast') pace = ` · <b class="st-fast">🚀 rápido</b> <span class="muted">(+${Math.round((m.ratio - 1) * 100)}% vs média em pista)</span>`;
  else if (m.pace === 'slow') pace = ` · <b class="st-slow">🐢 lento</b> <span class="muted">(${Math.round((m.ratio - 1) * 100)}% vs média em pista)</span>`;
  else if (m.pace === 'normal') pace = ' · ritmo normal';
  return `<b class="st-move">🟢 A andar · ${Math.round(m.speed)} km/h</b>${pace}${ago}`;
}

function pilotCard(t, race, c, latest, groups, p, allGroups = groups) {
  const key = keyOf(t);
  const dec = race.dec;
  const itins = race.itinsOf(t.pid);
  const sps = race.specialsOf(c.itin);
  const sp = sps.find(s => s.id === c.sid);
  const ints = c.sid ? race.intermediates(c.sid) : [];
  const cols = [...ints.map((m, i) => ({ k: i, h: `I${i + 1}`, sub: `km ${(m / 1000).toFixed(2)}` })), { k: 'F', h: 'Final', sub: sp ? `${(sp.meters / 1000).toFixed(1)} km` : '' }];
  const pens = race.pensOf(t.pid);
  const penTotal = pens.reduce((a, x) => a + (Number(x.time) || 0), 0);
  const ab = race.abandoned(t.pid);
  const abSp = ab && p.abandon_special_id ? race.specialsOf(c.itin).find(s => s.id === p.abandon_special_id) : null;

  // grelha de posições: linhas = classificações, colunas = pontos da especial
  const rankCache = new Map();
  const rk = k => { if (!rankCache.has(k)) rankCache.set(k, race.ranking(c.itin, c.sid, k, c.mode)); return rankCache.get(k); };
  const gridRows = groups.map(g => {
    let prev = null;
    const cells = cols.map(col => {
      const pos = c.sid ? posOf(race.filter(rk(col.k), g), t.pid) : null;
      let arrow = '';
      if (pos && prev) arrow = pos < prev ? `<i class="up">▲${prev - pos}</i>` : pos > prev ? `<i class="down">▼${pos - prev}</i>` : '';
      if (pos) prev = pos;
      return `<td class="cell ${col.k === c.k ? 'colsel' : ''}" data-card="${key}" data-k="${col.k}" data-g="${esc(g.key)}">${pos ? `${pos}º` : '·'}${arrow}</td>`;
    }).join('');
    return `<tr><th class="gl" data-card="${key}" data-g="${esc(g.key)}" data-k="${c.k}"><span>${esc(g.label)}</span>${g.value ? `<b>${esc(g.value)}</b>` : ''}</th>${cells}</tr>`;
  }).join('');

  // vizinhança: 3 à frente e 3 atrás, uma tabela por classificação
  const nbTable = g => {
    const rows = c.sid ? race.filter(rk(c.k), g) : [];
    if (!rows.length) return '<p class="muted small">Ainda não há tempos neste ponto.</p>';
    const me = rows.findIndex(r => r.pid === t.pid);
    const from = me < 0 ? 0 : Math.max(0, me - NEIGHBOURS);
    const to = me < 0 ? Math.min(rows.length, NEIGHBOURS * 2 + 1) : Math.min(rows.length, me + NEIGHBOURS + 1);
    const myV = me >= 0 ? rows[me].v : null;
    const leadV = rows[0]?.v;
    const body = rows.slice(from, to).map((r, i) => {
      const q = race.parts.get(r.pid) || {};
      const mine = r.pid === t.pid;
      const other = !mine && isTracked(t.rid, r.pid);
      const miss = r.missing ? `<span class="bad small">−${r.missing} esp.</span>` : '';
      return `<tr class="${mine ? 'me' : ''} ${other ? 'other' : ''}">
        <td class="pos">${from + i + 1}º</td><td class="num">${esc(q.ident)}</td>
        <td class="nm">${esc(q.pilot)}<br><small class="muted">${esc([q.class, q.vehicle].filter(Boolean).join(' · '))}</small></td>
        <td class="t">${fmtTime(r.v, dec)}${r.pen ? `<br><small class="bad">pen ${fmtTime(r.pen, 0)}</small>` : ''}</td>
        <td class="t">${mine ? '—' : r.missing || (me >= 0 && rows[me].missing) ? miss || '—' : fmtGap(myV != null ? r.v - myV : null, dec)}</td>
        <td class="t muted">${from + i === 0 ? 'líder' : r.missing ? '' : fmtGap(r.v - leadV, dec)}</td></tr>`;
    }).join('');
    return `<table class="nb"><thead><tr><th>Pos</th><th>N.º</th><th>Piloto</th><th>Tempo</th><th>Dif.</th><th>Líder</th></tr></thead><tbody>${body}</tbody></table>
      ${me < 0 ? '<p class="muted small">O piloto ainda não tem tempo neste ponto — mostro os primeiros.</p>' : ''}`;
  };
  const closed = c.closed || [];
  const nbSections = groups.map(g => {
    const pos = c.sid ? posOf(race.filter(rk(c.k), g), t.pid) : null;
    return `<details class="nbsec" id="nb-${key}-${esc(g.key)}" data-fold="${key}" data-gk="${esc(g.key)}" ${closed.includes(g.key) ? '' : 'open'}>
      <summary title="Mostrar / esconder esta classificação"><span>${esc(g.label)}${g.value ? ' <b>' + esc(g.value) + '</b>' : ''}</span><span class="pos">${pos ? pos + 'º' : '—'}</span></summary>
      ${nbTable(g)}</details>`;
  }).join('');

  const ptLabel = race.pointLabel(c.itin, { sid: c.sid, k: c.k });
  const modeLabel = c.mode === 'stage' ? 'na especial' : (c.k === 'F' ? 'à geral' : 'à geral (provisória)');

  return `<section class="card pilot" id="card-${key}">
    <div class="ph">
      <span class="num big">${esc(p.ident)}</span>
      <div class="pinfo"><b>${esc(p.pilot)}</b>${p.copilot ? ' / ' + esc(p.copilot) : ''}<br><small class="muted">${esc(p.vehicle || '')}${p.competitor && p.competitor !== p.pilot ? ' · ' + esc(p.competitor) : ''}</small>
      <br><small class="muted">${esc(race.name)}</small></div>
      <div class="ph-btns">
        <button class="icon-btn" data-map="${key}" title="Ver no mapa">🗺️</button>
        <button class="icon-btn" data-remove="${key}" title="Deixar de acompanhar">✕</button>
      </div>
    </div>
    <div class="pstatus" id="st-${key}">${statusHtml(key)}</div>
    ${paceHtml(t, race, c, latest, allGroups) ? `<div class="pstatus pace">${paceHtml(t, race, c, latest, allGroups)}</div>` : ''}
    <div class="chips">${allGroups.map(g => {
      const on = !(c.hidden || []).includes(g.key);
      return `<button class="chip tog ${on ? 'on' : 'off'}" data-gtog="${key}" data-gk="${esc(g.key)}" title="${esc(g.label)} — ${on ? 'toca para esconder' : 'toca para mostrar'}">${on ? '✓ ' : ''}${esc(g.kind === 'all' ? 'Geral' : g.value)}</button>`;
    }).join('')}</div>
    ${ab ? `<div class="alert bad">Abandono${abSp ? ` em ${esc(abSp.special_name)}` : ''}${p.abandon_reason ? ' — ' + esc(p.abandon_reason) : ''}</div>` : ''}
    ${p.superrally_special_id ? '<div class="alert warn">Em Super Rali</div>' : ''}
    ${pens.length ? `<details class="pens"><summary>Penalizações: ${fmtTime(penTotal, 0)} (${pens.length})</summary>${pens.map(x => `<div class="small">${esc(race.specialsOf(c.itin).find(s => s.id === x.special_id)?.special_name || '')} · ${fmtTime(Number(x.time), 0)} — ${esc(x.reason)}</div>`).join('')}</details>` : ''}
    <div class="latest">${latest ? `Último registo: <b>${esc(race.pointLabel(c.itin, latest))}</b>` : 'Ainda sem tempos registados.'}
      ${c.follow ? '<span class="tag live">a seguir ao vivo</span>' : `<button class="btn small" data-follow="${key}">↺ Seguir ao vivo</button>`}</div>
    ${S.prox.on ? `<div class="proxline" id="prox-${key}">${proxLine(key)}</div>` : ''}
    ${itins.length > 1 ? `<div class="row"><label class="small muted">Classificação:</label>
      <select data-itin="${key}">${itins.map(it => `<option value="${it.id}" ${it.id === c.itin ? 'selected' : ''}>${esc(it.name)}</option>`).join('')}</select></div>` : ''}
    <div class="strip" data-scroll="sp-${key}">${sps.map(s => `<button class="sp ${s.id === c.sid ? 'on' : ''} ${isLive(s) ? 'livesp' : ''} st${s.state}" data-card="${key}" data-sid="${s.id}" ${s.state === 0 && !isLive(s) ? 'disabled' : ''} title="${esc(s.name_extra || '')} · ${STATE_LABEL[s.state] || ''}">
      <b>${esc(s.special_name)}</b><small>${isLive(s) ? '● ao vivo' : esc(STATE_LABEL[s.state] || '')}</small></button>`).join('') || '<span class="muted small">Sem especiais publicadas.</span>'}</div>
    ${sp ? `<div class="sphead small muted">${esc(sp.special_name)}${sp.name_extra && sp.name_extra.trim() !== sp.special_name ? ' — ' + esc(sp.name_extra) : ''} · ${(sp.meters / 1000).toFixed(2)} km${sp.compute === 0 ? ' · não conta para a geral' : ''}</div>` : ''}
    <div class="seg"><button class="${c.mode === 'stage' ? 'on' : ''}" data-mode="stage" data-card="${key}">Na especial</button><button class="${c.mode === 'overall' ? 'on' : ''}" data-mode="overall" data-card="${key}">À geral</button></div>
    ${c.sid ? `<div class="gridwrap" data-scroll="g-${key}"><table class="grid">
      <thead><tr><th></th>${cols.map(col => `<th class="${col.k === c.k ? 'colsel' : ''}" data-card="${key}" data-k="${col.k}">${col.h}<small>${esc(col.sub)}</small></th>`).join('')}</tr></thead>
      <tbody>${gridRows}</tbody></table></div>` : ''}
    <h4>3 à frente e 3 atrás · ${esc(ptLabel)} · ${modeLabel}</h4>
    ${groups.length ? nbSections : '<p class="muted small">Todas as classificações estão desligadas — toca numa etiqueta acima para a mostrar.</p>'}
  </section>`;
}

function bindCards() {
  const el = $('#view');
  bindProxLines(el);
  el.querySelectorAll('[data-gtog]').forEach(b => b.onclick = () => {
    const c = S.cards[b.dataset.gtog];
    const set = new Set(c.hidden || []);
    if (set.has(b.dataset.gk)) set.delete(b.dataset.gk); else set.add(b.dataset.gk);
    c.hidden = [...set];
    save();
    renderLive();
  });
  el.querySelectorAll('[data-map]').forEach(b => b.onclick = () => openMap(b.dataset.map));
  const st = k => S.cards[k];
  el.querySelectorAll('[data-jump]').forEach(r => r.onclick = () => document.getElementById(`card-${r.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth' }));
  el.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => {
    const [rid, pid] = b.dataset.remove.split(':').map(Number);
    const race = getRace(rid);
    track(rid, race.parts.get(pid) || { id: pid }, false);
    delete S.cards[b.dataset.remove];
    save();
    render();
  });
  el.querySelectorAll('[data-follow]').forEach(b => b.onclick = () => { st(b.dataset.follow).follow = true; save(); renderLive(); });
  el.querySelectorAll('[data-sid]').forEach(b => b.onclick = () => {
    const c = st(b.dataset.card);
    const [rid, pid] = b.dataset.card.split(':').map(Number);
    const race = getRace(rid);
    c.sid = Number(b.dataset.sid);
    c.follow = false;
    const lp = race.latestPoint(c.itin, pid);
    c.k = lp && lp.sid === c.sid ? lp.k : 'F';
    save(); renderLive();
  });
  el.querySelectorAll('[data-k][data-card]').forEach(b => b.onclick = () => {
    const c = st(b.dataset.card);
    const k = b.dataset.k === 'F' ? 'F' : Number(b.dataset.k);
    if (k !== c.k) { c.k = k; c.follow = false; }
    const gk = b.dataset.g;
    if (gk) c.closed = (c.closed || []).filter(x => x !== gk); // abre a tabela escolhida
    save(); renderLive();
    if (gk) document.getElementById(`nb-${b.dataset.card}-${gk}`)?.scrollIntoView({ block: 'start' });
  });
  el.querySelectorAll('details[data-fold]').forEach(d => d.addEventListener('toggle', () => {
    const c = st(d.dataset.fold);
    const set = new Set(c.closed || []);
    if (d.open) set.delete(d.dataset.gk); else set.add(d.dataset.gk);
    c.closed = [...set];
    save();
  }));
  el.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { st(b.dataset.card).mode = b.dataset.mode; save(); renderLive(); });
  el.querySelectorAll('[data-itin]').forEach(s => s.onchange = () => {
    const c = st(s.dataset.itin);
    c.itin = Number(s.value);
    c.follow = true;
    save(); renderLive();
  });
}

// ---------- Atualização periódica ----------
async function poll() {
  if (polling || !S.tracked.length) return;
  polling = true;
  try {
    const rids = [...new Set(S.tracked.map(t => t.rid))];
    await Promise.all(rids.map(async rid => {
      const race = getRace(rid);
      try { await race.refresh(); } catch (e) { race.error = e.message || 'erro de ligação'; }
    }));
    lastUpdate = Date.now();
    checkAlerts();
    if (view === 'live') renderLive();
  } finally {
    polling = false;
  }
}

function schedule() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (S.tracked.length) pollTimer = setInterval(poll, Math.max(5, S.settings.interval) * 1000);
}

// ---------- Alertas ----------
function snapshot(t, race) {
  const itin = S.cards[keyOf(t)]?.itin || race.defaultItin(t.pid);
  const latest = race.latestPoint(itin, t.pid);
  const groups = race.groupsFor(t.pid);
  const pos = {}, stage = {};
  if (latest) {
    const ov = race.ranking(itin, latest.sid, latest.k, 'overall');
    const sg = race.ranking(itin, latest.sid, latest.k, 'stage');
    for (const g of groups) { pos[g.key] = posOf(race.filter(ov, g), t.pid); stage[g.key] = posOf(race.filter(sg, g), t.pid); }
  }
  return {
    latestKey: latest ? `${latest.sid}:${latest.k}` : '', label: race.pointLabel(itin, latest),
    groups: Object.fromEntries(groups.map(g => [g.key, g.value ? `${g.label} ${g.value}` : g.label])),
    pos, stage, ab: race.abandoned(t.pid), pens: race.pensOf(t.pid),
  };
}

function checkAlerts() {
  const A = S.settings.alerts;
  for (const t of S.tracked) {
    const race = getRace(t.rid);
    if (!race.lastOk) continue;
    const s = snapshot(t, race);
    const old = snaps.get(keyOf(t));
    snaps.set(keyOf(t), s);
    if (!old) continue; // primeira leitura: só guarda a referência
    const msgs = [];
    if (A.ab && s.ab && !old.ab) msgs.push('🚩 Abandono');
    if (A.ab) for (const x of s.pens) if (!old.pens.some(o => o.id === x.id)) msgs.push(`⚠ Penalização ${fmtTime(Number(x.time), 0)} — ${x.reason}`);
    const changes = [];
    const hiddenG = S.cards[keyOf(t)]?.hidden || [];
    for (const g in s.pos) {
      if (hiddenG.includes(g)) continue; // classe desligada: sem alertas
      const a = old.pos[g], b = s.pos[g];
      if (a && b && a !== b) changes.push(`${s.groups[g]}: ${a}º → ${b}º ${b < a ? '▲' : '▼'}`);
    }
    if (s.latestKey !== old.latestKey && s.latestKey) {
      if (A.time) msgs.push(`⏱ ${s.label}: ${s.stage.all ?? '—'}º na especial · ${s.pos.all ?? '—'}º à geral`);
      if (A.pos && changes.length) msgs.push(...changes);
    } else if (A.pos && changes.length) {
      msgs.push(...changes);
    }
    if (msgs.length) {
      const p = race.parts.get(t.pid) || {};
      notify(`#${p.ident ?? t.ident} ${p.pilot || ''}`, msgs.join('\n'), keyOf(t));
    }
  }
}

function toast(text, title = '') {
  const box = document.createElement('div');
  box.className = 'toast';
  box.innerHTML = `${title ? `<b>${esc(title)}</b><br>` : ''}${esc(text).replace(/\n/g, '<br>')}`;
  box.onclick = () => box.remove();
  $('#toasts').appendChild(box);
  setTimeout(() => box.remove(), 9000);
}

let audioCtx = null;
function beep() {
  if (!S.settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.18);
  } catch { /* sem som */ }
}

async function notify(title, body, tag) {
  toast(body, title);
  beep();
  try { navigator.vibrate?.([120, 60, 120]); } catch { /* sem vibração */ }
  if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) reg.showNotification(title, { body, tag, renotify: true, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
      else new Notification(title, { body, tag });
    } catch { /* notificação falhou */ }
  }
}

// ---------- Avisos de proximidade (5 · 2 · 1 km) ----------
const PROX_EVERY_MS = 10000;
const trackSrc = new Map();   // id do mapa -> TrackSource
const proxRes = new Map();    // "rid:pid" -> último resultado
const proxState = new Map();  // "rid:pid" -> avisos já dados
const moveHist = new Map();   // "rid:pid" -> posições recentes
const moveRes = new Map();    // "rid:pid" -> estado (parado / a andar / ritmo)
const vehPos = new Map();     // "rid:pid" -> última posição GPS do piloto
let gpsPos = null, gpsErr = null, geoId = null, trackTimer = null, proxBusy = false;

// O tracking corre sempre que há pilotos (estado e mapa); os avisos só com a proximidade ligada.
function scheduleTrack() {
  clearInterval(trackTimer);
  trackTimer = null;
  if (S.tracked.length) trackTimer = setInterval(proxTick, PROX_EVERY_MS);
}

function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state !== 'running') audioCtx.resume();
  } catch { /* sem som */ }
}
// os browsers só deixam tocar som depois de um toque no ecrã
document.addEventListener('pointerdown', () => { if (S.prox.on || audioCtx) unlockAudio(); }, { passive: true });

function userPos() {
  return S.prox.useFixed && S.prox.fixed ? S.prox.fixed : gpsPos;
}

function startGps() {
  if (geoId != null || !('geolocation' in navigator)) {
    if (!('geolocation' in navigator)) gpsErr = 'Este aparelho não tem localização.';
    return;
  }
  geoId = navigator.geolocation.watchPosition(
    p => { gpsPos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, ts: Date.now() }; gpsErr = null; refreshProxPanel(); if (mapKey) updateMap(false); },
    e => { gpsErr = e.code === 1 ? 'Localização bloqueada — autoriza nas definições do browser.' : 'Sem sinal GPS.'; refreshProxPanel(); },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
}

function stopGps() {
  if (geoId != null) navigator.geolocation.clearWatch(geoId);
  geoId = null;
}

function setProx(on) {
  S.prox.on = on;
  save();
  if (on) {
    unlockAudio();
    startGps();
    proxTick();
  } else if (!mapKey) {
    stopGps();
  }
  if (view === 'live') renderLive();
}

async function resolveTrackId(rid) {
  if (rid in S.trackIds) return S.trackIds[rid];
  await loadEvents();
  let sid = 0;
  for (const ev of events || []) {
    const l = trackLinks(ev).find(x => x.rid === rid);
    if (l) { sid = l.sid; break; }
  }
  if (events) { S.trackIds[rid] = sid; save(); }
  return sid;
}

async function proxTick() {
  if (proxBusy || !S.tracked.length) return;
  proxBusy = true;
  try {
    const sids = new Map();
    for (const t of S.tracked) sids.set(t.rid, await resolveTrackId(t.rid));
    const used = new Set([...sids.values()].filter(Boolean));
    await Promise.all([...used].map(sid => {
      if (!trackSrc.has(sid)) trackSrc.set(sid, new TrackSource(sid));
      return trackSrc.get(sid).refresh();
    }));
    const user = userPos();
    for (const t of S.tracked) {
      const key = keyOf(t);
      const sid = sids.get(t.rid);
      const p = getRace(t.rid).parts.get(t.pid);
      const ident = p?.ident ?? t.ident;
      const src = sid ? trackSrc.get(sid) : null;

      // estado instantâneo: parado / a andar / ritmo
      const veh = src?.vehicle(ident);
      if (!sid) moveRes.set(key, { kind: 'notrack' });
      else if (src.error && !src.ok) moveRes.set(key, { kind: 'error' });
      else if (!veh) moveRes.set(key, { kind: 'nogps' });
      else {
        vehPos.set(key, veh);
        const hist = pushHistory(moveHist.get(key) || [], veh);
        moveHist.set(key, hist);
        moveRes.set(key, movement(hist, veh, src.peerSpeeds(veh.onTrack, ident)));
      }
      const stEl = document.getElementById(`st-${key}`);
      if (stEl) stEl.innerHTML = statusHtml(key);

      // avisos de proximidade
      if (S.prox.on) {
        const st = proxState.get(key) || {};
        proxState.set(key, st);
        const res = sid ? evaluate(st, src, ident, user) : { status: 'notrack' };
        proxRes.set(key, res);
        if (res.alert && !S.prox.muted.includes(key)) {
          const how = `${res.mode === 'estrada' ? 'pela estrada' : 'em linha reta'}${res.speed ? ` · ${Math.round(res.speed)} km/h` : ''}`;
          flashProx(res.alert, `#${ident} ${p?.pilot || ''}`, `a ${fmtKm(res.dist)} · ${how}`);
        }
        const line = document.getElementById(`prox-${key}`);
        if (line) line.innerHTML = proxLine(key);
      }
    }
    bindProxLines($('#view'));
    if (mapKey) updateMap(false);
  } finally {
    proxBusy = false;
  }
}

function proxPanel() {
  const on = S.prox.on;
  return `<div class="card prox ${on ? 'on' : ''}" id="proxPanel">${proxPanelInner()}</div>`;
}

function proxPanelInner() {
  const on = S.prox.on;
  const u = userPos();
  let where = '';
  if (on) {
    if (S.prox.useFixed && S.prox.fixed) where = `📌 Ponto fixo (${S.prox.fixed.lat.toFixed(5)}, ${S.prox.fixed.lon.toFixed(5)})`;
    else if (gpsErr) where = `<span class="bad">${esc(gpsErr)}</span>`;
    else if (u) where = `🛰 GPS ativo${u.acc ? ` (±${Math.round(u.acc)} m)` : ''}`;
    else where = 'À espera da tua localização…';
  }
  const sound = audioCtx && audioCtx.state === 'running';
  return `<div class="row prox-h"><b>📍 Avisos de proximidade</b><span class="muted small">5 · 2 · 1 km</span>
      <button class="btn small ${on ? '' : 'primary'}" id="proxToggle">${on ? 'Desligar' : 'Ligar'}</button></div>
    ${on ? `<div class="small">${where}</div>
      ${sound ? '' : '<div class="small warn-txt">Toca em qualquer sítio do ecrã para ativar o som.</div>'}
      <div class="row wrap">
        <button class="btn small" id="proxFix" ${gpsPos ? '' : 'disabled'}>📌 Fixar aqui</button>
        ${S.prox.useFixed ? '<button class="btn small" id="proxGps">🛰 Usar GPS</button>' : ''}
        <button class="btn small" id="proxTest">🔊 Testar sirene</button>
      </div>
      <div class="small muted">Posições dos pilotos atualizadas a cada ${PROX_EVERY_MS / 1000} s. Mantém a app aberta e o ecrã ligado.</div>`
    : '<div class="small muted">Sirene e aviso no ecrã quando um piloto que acompanhas estiver a 5, 2 e 1 km de ti.</div>'}`;
}

function refreshProxPanel() {
  const el = $('#proxPanel');
  if (!el) return;
  el.innerHTML = proxPanelInner();
  bindProxPanel();
}

function proxLine(key) {
  const r = proxRes.get(key);
  const muted = S.prox.muted.includes(key);
  const bell = `<button class="icon-btn bell" data-proxmute="${key}" title="${muted ? 'Ligar avisos deste piloto' : 'Silenciar este piloto'}">${muted ? '🔕' : '🔔'}</button>`;
  let txt;
  if (!r) txt = '<span class="muted">A obter posição do piloto…</span>';
  else if (r.status === 'notrack') txt = '<span class="muted">Sem mapa público para esta corrida.</span>';
  else if (r.status === 'error') txt = '<span class="bad">Mapa indisponível.</span>';
  else if (r.status === 'nogps') txt = '<span class="muted">Sem posição GPS do piloto.</span>';
  else if (r.status === 'stale') txt = `<span class="muted">GPS do piloto sem atualizar há ${fmtAge(r.age)}.</span>`;
  else if (r.status === 'nouser') txt = '<span class="muted">À espera da tua localização…</span>';
  else {
    const near = r.dist > 0 && r.dist <= 1 ? 'near1' : r.dist > 0 && r.dist <= 2 ? 'near2' : r.dist > 0 && r.dist <= 5 ? 'near5' : '';
    txt = r.passed ? `✅ Já passou por ti (${fmtKm(r.dist)})`
      : `<b class="${near}">📍 a ${fmtKm(r.dist)}</b> ${r.mode === 'estrada' ? 'pela estrada' : 'em linha reta'}`;
    if (r.speed) txt += ` · ${Math.round(r.speed)} km/h`;
    if (r.age != null) txt += ` <span class="muted">· GPS há ${Math.round(r.age)} s</span>`;
  }
  return `<span class="ptxt">${txt}</span>${bell}`;
}

function fmtAge(s) {
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} dias`;
}

function bindProxLines(el) {
  el?.querySelectorAll('[data-proxmute]').forEach(b => b.onclick = () => {
    const k = b.dataset.proxmute;
    const m = new Set(S.prox.muted);
    if (m.has(k)) m.delete(k); else m.add(k);
    S.prox.muted = [...m];
    save();
    b.parentElement.innerHTML = proxLine(k);
    bindProxLines(el);
  });
}

// ---------- Mapa do piloto ----------
const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
let mapKey = null, lmap = null, mapLayers = null, mapFollow = true, leafletP = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletP) return leafletP;
  leafletP = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${LEAFLET}leaflet.css`;
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = `${LEAFLET}leaflet.js`;
    s.onload = resolve;
    s.onerror = () => { leafletP = null; reject(new Error('Sem ligação para carregar o mapa.')); };
    document.head.appendChild(s);
  });
  return leafletP;
}

async function openMap(key) {
  mapKey = key;
  mapFollow = true;
  const dlg = $('#mapDlg');
  $('#mapTitle').innerHTML = mapTitle();
  $('#mapFoot').innerHTML = '<span class="muted small">A carregar o mapa…</span>';
  if (!dlg.open) dlg.showModal();
  try { await loadLeaflet(); } catch (e) { $('#mapFoot').innerHTML = `<span class="bad">${esc(e.message)}</span>`; return; }
  if (!lmap) {
    lmap = L.map('map', { zoomControl: true, attributionControl: true });
    const road = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagens © Esri' });
    road.addTo(lmap);
    L.control.layers({ 'Estradas': road, 'Satélite': sat }, null, { position: 'topright' }).addTo(lmap);
    lmap.on('dragstart', () => { mapFollow = false; });
    lmap.setView([39.5, -8.0], 7);
  }
  setTimeout(() => lmap.invalidateSize(), 50);
  if (!moveRes.has(key)) await proxTick();
  updateMap(true);
}

function closeMap() {
  mapKey = null;
  $('#mapDlg').close();
  if (!S.prox.on) stopGps();
}

function mapTitle() {
  const t = S.tracked.find(x => keyOf(x) === mapKey);
  if (!t) return '';
  const p = getRace(t.rid).parts.get(t.pid) || {};
  return `<span class="num big">${esc(p.ident ?? t.ident)}</span><div><b>${esc(p.pilot || '')}</b><div class="small" id="mapStatus">${statusHtml(mapKey)}</div></div>`;
}

function markerIcon(ident, sel) {
  return L.divIcon({ className: '', html: `<div class="mk ${sel ? 'sel' : ''}">${esc(ident)}</div>`, iconSize: null });
}

function updateMap(fit) {
  if (!mapKey || !lmap) return;
  if (mapLayers) mapLayers.remove();
  mapLayers = L.layerGroup().addTo(lmap);
  const t = S.tracked.find(x => keyOf(x) === mapKey);
  if (!t) { closeMap(); return; }
  const sid = S.trackIds[t.rid];
  const src = sid ? trackSrc.get(sid) : null;

  // traçado das especiais (se estiver publicado)
  for (const path of src?.paths.values() || []) {
    L.polyline(path.pts.map(q => [q.lat, q.lon]), { color: '#ff7a1a', weight: 4, opacity: 0.75 }).addTo(mapLayers);
  }
  // outros pilotos que acompanhas, na mesma corrida ou noutra
  for (const o of S.tracked) {
    const k = keyOf(o);
    const v = vehPos.get(k);
    if (!v || k === mapKey) continue;
    const q = getRace(o.rid).parts.get(o.pid) || {};
    L.marker([v.lat, v.lon], { icon: markerIcon(q.ident ?? o.ident, false) }).addTo(mapLayers);
  }
  // a tua posição
  const u = userPos();
  if (u) {
    if (u.acc) L.circle([u.lat, u.lon], { radius: u.acc, color: '#2f80ed', weight: 1, fillOpacity: 0.12 }).addTo(mapLayers);
    L.circleMarker([u.lat, u.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#2f80ed', fillOpacity: 1 }).addTo(mapLayers).bindTooltip('Tu');
  }
  // o piloto escolhido
  const v = vehPos.get(mapKey);
  const p = getRace(t.rid).parts.get(t.pid) || {};
  if (v) L.marker([v.lat, v.lon], { icon: markerIcon(p.ident ?? t.ident, true), zIndexOffset: 1000 }).addTo(mapLayers);

  const st = document.getElementById('mapStatus');
  if (st) st.innerHTML = statusHtml(mapKey);
  $('#mapFoot').innerHTML = v ? `
      <button class="btn small" id="mapCenter">🎯 Centrar no piloto</button>
      <button class="btn small" id="mapMe">📍 Onde estou</button>
      <a class="btn small" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${v.lat},${v.lon}">Google Maps</a>
      <a class="btn small" target="_blank" rel="noopener" href="https://waze.com/ul?ll=${v.lat},${v.lon}&navigate=yes">Waze</a>`
    : `<span class="muted small">Ainda não há posição GPS deste piloto.</span> <button class="btn small" id="mapMe">📍 Onde estou</button>`;
  $('#mapCenter')?.addEventListener('click', () => { mapFollow = true; lmap.setView([v.lat, v.lon], Math.max(lmap.getZoom(), 13)); });
  $('#mapMe')?.addEventListener('click', () => {
    startGps();
    const me = userPos();
    if (me) { mapFollow = false; lmap.setView([me.lat, me.lon], Math.max(lmap.getZoom(), 13)); }
    else toast('A obter a tua localização…');
  });

  if (v && (fit || mapFollow)) {
    if (fit && u) lmap.fitBounds(L.latLngBounds([[v.lat, v.lon], [u.lat, u.lon]]).pad(0.25), { maxZoom: 14 });
    else lmap.setView([v.lat, v.lon], fit ? 13 : lmap.getZoom());
  }
}

$('#mapClose').addEventListener('click', closeMap);
$('#mapDlg').addEventListener('cancel', e => { e.preventDefault(); closeMap(); });

let flashTimer = null;
function flashProx(km, who, sub) {
  const f = $('#flash');
  f.innerHTML = `<div class="fl-km">${km} km</div><div class="fl-who">${esc(who)}</div><div class="fl-sub">${esc(sub)}</div><div class="fl-hint">toca para fechar</div>`;
  f.className = `flash show k${km}`;
  f.onclick = () => { f.className = 'flash'; };
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { f.className = 'flash'; }, 5000);
  if (S.settings.sound !== false) { unlockAudio(); siren(audioCtx, km === 1 ? 6 : km === 2 ? 4.5 : 3, S.settings.sirenType); }
  try { navigator.vibrate?.(km === 1 ? [600, 200, 600, 200, 600] : [400, 150, 400]); } catch { /* sem vibração */ }
  if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    navigator.serviceWorker?.getRegistration().then(reg => reg?.showNotification(`🚨 ${who} a ${km} km`, { body: sub, tag: `prox-${who}`, renotify: true, icon: 'icons/icon-192.png', vibrate: [400, 150, 400] })).catch(() => {});
  }
}

// ---------- Ecrã sempre ligado ----------
async function updateWakeLock() {
  const want = S.settings.wake && view === 'live' && document.visibilityState === 'visible';
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  updateWakeLock();
  if (document.visibilityState === 'visible' && Date.now() - lastUpdate > S.settings.interval * 1000) poll();
});

// ---------- Definições ----------
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const effectiveTheme = () => S.settings.theme === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : S.settings.theme;

function applyTheme() {
  document.documentElement.dataset.theme = S.settings.theme === 'auto' ? '' : S.settings.theme;
  const dark = effectiveTheme() === 'dark';
  const btn = $('#themeBtn');
  btn.textContent = dark ? '☀' : '☾';
  btn.title = dark ? 'Mudar para modo dia' : 'Mudar para modo noite';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0e1116' : '#f3f4f6';
}
darkQuery.addEventListener?.('change', applyTheme);

// Botão dia/noite: alterna entre claro e escuro.
$('#themeBtn').addEventListener('click', () => {
  S.settings.theme = effectiveTheme() === 'dark' ? 'light' : 'dark';
  save();
  applyTheme();
});

function openSettings() {
  const d = $('#settings');
  const st = S.settings;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  d.innerHTML = `<form method="dialog" class="settings">
    <h3>Definições</h3>
    <label>Atualizar a cada
      <select id="sInt">${[5, 10, 15, 30, 60].map(v => `<option value="${v}" ${st.interval === v ? 'selected' : ''}>${v} segundos</option>`).join('')}</select></label>
    <fieldset><legend>Alertas</legend>
      <label class="chk"><input type="checkbox" id="aPos" ${st.alerts.pos ? 'checked' : ''}> Mudança de posição</label>
      <label class="chk"><input type="checkbox" id="aTime" ${st.alerts.time ? 'checked' : ''}> Novo tempo registado</label>
      <label class="chk"><input type="checkbox" id="aAb" ${st.alerts.ab ? 'checked' : ''}> Abandono / penalização</label>
      <label class="chk"><input type="checkbox" id="aSound" ${st.sound ? 'checked' : ''}> Som</label>
      <div class="small muted">Notificações do sistema: ${perm === 'granted' ? 'ativas' : perm === 'denied' ? 'bloqueadas no browser' : perm === 'unsupported' ? 'não suportadas aqui' : 'por ativar'}</div>
      ${perm === 'default' ? '<button type="button" class="btn" id="aPerm">Ativar notificações</button>' : ''}
      <button type="button" class="btn small" id="aTest">Testar alerta</button>
    </fieldset>
    <fieldset><legend>Som dos avisos de proximidade (5 · 2 · 1 km)</legend>
      <div class="row"><select id="sSiren">${Object.entries(SIRENS).map(([v, l]) => `<option value="${v}" ${st.sirenType === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button type="button" class="btn small" id="sSirenTest">▶ Ouvir</button></div>
    </fieldset>
    <label class="chk"><input type="checkbox" id="sWake" ${st.wake ? 'checked' : ''}> Manter o ecrã ligado no ecrã "Ao vivo"</label>
    <label>Tema
      <select id="sTheme">${[['auto', 'Automático'], ['dark', 'Escuro'], ['light', 'Claro (melhor ao sol)']].map(([v, l]) => `<option value="${v}" ${st.theme === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <p class="small muted">A app só atualiza enquanto está aberta. No Android, com o ecrã desligado ou a app em segundo plano, o sistema pode pausar as atualizações.</p>
    <div class="row end"><button class="btn primary" value="ok">Fechar</button></div>
  </form>`;
  const upd = () => {
    st.interval = Number($('#sInt').value);
    st.alerts = { pos: $('#aPos').checked, time: $('#aTime').checked, ab: $('#aAb').checked };
    st.sound = $('#aSound').checked;
    st.wake = $('#sWake').checked;
    st.sirenType = $('#sSiren').value;
    st.theme = $('#sTheme').value;
    save(); applyTheme(); schedule(); updateWakeLock();
    if (view === 'live') renderLive();
  };
  d.querySelectorAll('select,input').forEach(i => i.onchange = upd);
  $('#aPerm')?.addEventListener('click', async () => { await Notification.requestPermission(); openSettings(); });
  $('#sSirenTest').onclick = () => { unlockAudio(); siren(audioCtx, 3, $('#sSiren').value); };
  $('#aTest').onclick = () => notify('#000 Teste', '⏱ SS1 · I2: 3º na especial · 5º à geral\nClasse T1+: 3º → 2º ▲', 'teste');
  d.showModal();
}
$('#settingsBtn').addEventListener('click', openSettings);

// ---------- Arranque ----------
window.MotorTracker = { S, races, snaps, poll, trackSrc, proxRes, proxTick, flashProx }; // diagnóstico na consola
applyTheme();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
render();
if (S.tracked.length) { poll(); }
schedule();
scheduleTrack();
if (S.prox.on) setProx(true); else if (S.tracked.length) proxTick();
