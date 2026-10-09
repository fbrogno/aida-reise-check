'use strict';
/* AIDA Reise-Radar – Frontend ohne Build-Schritt */

const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
const S = { meta: null, cat: null, byId: new Map(), ports: {}, merk: new Set(), ships: new Map(), cabins: new Map(), hist: new Map(), changes: undefined, lastList: '#/', map: null, shown: 40 };

/* ---------- Helfer ---------- */
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eurF = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eur = v => (typeof v === 'number' && isFinite(v)) ? eurF.format(v).replace(/ /g, ' ') : '–';
const numF = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
const num = v => (typeof v === 'number' && isFinite(v)) ? numF.format(v) : '–';
const isNum = v => typeof v === 'number' && isFinite(v);
const pad = n => String(n).padStart(2, '0');
function dDE(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso || '–'); }
function dtDE(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso || '');
  if (!m) return iso || '–';
  return `${m[3]}.${m[2]}.${m[1]}` + (m[4] ? `, ${m[4]}:${m[5]} Uhr` : '');
}
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const monthLabel = ym => { const [y, m] = ym.split('-'); return `${MONTHS[(+m) - 1] || m} ${y}`; };
const safeUrl = u => /^https?:\/\//i.test(u || '') ? u : '';
const arr = v => Array.isArray(v) ? v : [];
const obj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
const cmpDe = (a, b) => String(a).localeCompare(String(b), 'de');

async function getJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
function toast(msg, ms = 4500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}
const title = id => S.byId.get(id)?.title || id;
const tripLink = id => `<a href="#/reise/${esc(id)}">${esc(title(id))}</a>`;

/* ---------- Daten laden ---------- */
async function loadCore() {
  const [meta, cat, ports, mk] = await Promise.all([getJson('data/meta.json'), getJson('data/catalog.json'), getJson('data/ports.json'), getJson('merkliste.json')]);
  S.meta = obj(meta); S.cat = obj(cat); S.ports = obj(ports);
  S.journeys = arr(S.cat.journeys);
  S.journeys.forEach(j => S.byId.set(j.id, j));
  S.merk = new Set(arr(obj(mk).reisen));
  $('#stand').textContent = `Datenstand: ${dtDE(S.meta.updated || S.cat.updated)} · ${S.journeys.length.toLocaleString('de-DE')} Reisen`;
  updateBadge();
}
const updateBadge = () => { $('#mk-count').textContent = S.merk.size ? `(${S.merk.size})` : ''; };

async function cabinsOf(id) {
  // Nur laden, wenn der Katalog gezählte Kabinen meldet (vermeidet 404-Meldungen in der Konsole)
  if (!isNum(S.byId.get(id)?.freeCabins)) return null;
  if (!S.cabins.has(id)) S.cabins.set(id, await getJson(`data/cabins/${encodeURIComponent(id)}.json`));
  return S.cabins.get(id);
}
async function histOf(id) {
  if (!S.hist.has(id)) S.hist.set(id, await getJson(`data/history/${encodeURIComponent(id)}.json`));
  return S.hist.get(id);
}
async function shipOf(j) {
  const k = `${j.ship}-${j.shipVariation}`;
  if (!S.ships.has(k)) {
    const d = await getJson(`data/ships/${encodeURIComponent(k)}.json`);
    let byN = null, byDeck = null;
    if (d) {
      byN = new Map(); byDeck = new Map();
      arr(d.cabins).forEach(c => {
        byN.set(String(c.n), c);
        const dk = String(parseInt(c.deck, 10));
        byDeck.set(dk, (byDeck.get(dk) || 0) + 1);
      });
    }
    S.ships.set(k, byN ? { byN, byDeck } : null);
  }
  return S.ships.get(k);
}

/* ---------- Merkliste ---------- */
async function toggleMerk(id) {
  const next = new Set(S.merk);
  next.has(id) ? next.delete(id) : next.add(id);
  try {
    const r = await fetch('/api/merkliste', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reisen: [...next] }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.fehler || 'Merkliste konnte nicht gespeichert werden.'); return false; }
    S.merk = new Set(arr(d.reisen).length || next.size === 0 ? arr(d.reisen) : [...next]);
    updateBadge();
    toast(d.warnung || (next.has(id) ? 'Auf die Merkliste gesetzt.' : 'Von der Merkliste entfernt.'));
    return true;
  } catch (e) { toast('Server nicht erreichbar – Merkliste nicht gespeichert.'); return false; }
}
document.addEventListener('click', async ev => {
  const b = ev.target.closest('[data-star]');
  if (!b) return;
  ev.preventDefault();
  b.disabled = true;
  const ok = await toggleMerk(b.dataset.star);
  b.disabled = false;
  if (ok) {
    const id = b.dataset.star, on = S.merk.has(id);
    document.querySelectorAll(`[data-star="${CSS.escape(id)}"]`).forEach(x => setStar(x, on));
    if (route().name === 'merkliste') render();
  }
});
function setStar(x, on) {
  x.classList.toggle('on', on);
  x.textContent = on ? '★' : '☆';
  x.setAttribute('aria-pressed', on);
  x.title = on ? 'Von der Merkliste entfernen' : 'Auf die Merkliste setzen';
  x.setAttribute('aria-label', x.title);
}
const starBtn = (id, cls = '') => {
  const on = S.merk.has(id);
  return `<button type="button" class="star ${cls} ${on ? 'on' : ''}" data-star="${esc(id)}" aria-pressed="${on}" title="${on ? 'Von der Merkliste entfernen' : 'Auf die Merkliste setzen'}" aria-label="${on ? 'Von der Merkliste entfernen' : 'Auf die Merkliste setzen'}">${on ? '★' : '☆'}</button>`;
};

/* ---------- Router ---------- */
function route() {
  const h = location.hash || '#/';
  const [path, q = ''] = h.slice(1).split('?');
  const p = path.split('/').filter(Boolean);
  const params = new URLSearchParams(q);
  if (p[0] === 'reise' && p[1]) return { name: 'detail', id: decodeURIComponent(p[1]), params };
  if (p[0] === 'aenderungen') return { name: 'aenderungen', params };
  if (p[0] === 'merkliste') return { name: 'merkliste', params };
  return { name: 'uebersicht', params };
}
let renderToken = 0;
async function render() {
  const r = route();
  const tok = ++renderToken;
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === (r.name === 'detail' ? 'uebersicht' : r.name)));
  if (S.map) { S.map.remove(); S.map = null; }
  if (!S.cat) { view.innerHTML = '<div class="empty">Daten werden geladen …</div>'; return; }
  try {
    if (r.name === 'uebersicht') { S.lastList = location.hash || '#/'; viewList(r); }
    else if (r.name === 'detail') await viewDetail(r, () => tok === renderToken);
    else if (r.name === 'aenderungen') await viewChanges(() => tok === renderToken);
    else await viewMerk();
  } catch (e) {
    console.warn('Darstellungsfehler', e);
    view.innerHTML = '<div class="card note">Beim Anzeigen ist ein Fehler aufgetreten. Bitte Seite neu laden.</div>';
  }
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); S.shown = 40; render(); });

/* ---------- Übersicht ---------- */
const FKEYS = ['q', 'region', 'ship', 'von', 'bis', 'nmin', 'nmax', 'preis', 'kat', 'gez', 'sort'];
function filtersFrom(params) { const f = {}; FKEYS.forEach(k => f[k] = params.get(k) || ''); return f; }
function uniq(fn) { return [...new Set(S.journeys.map(fn).filter(Boolean))].sort(cmpDe); }
function catNames() {
  const m = new Map();
  S.journeys.forEach(j => arr(j.categories).forEach(c => { if (c && c.code && !m.has(c.code)) m.set(c.code, c.name || c.code); }));
  return m;
}
const hasStates = x => Object.keys(obj(x && x.states)).length > 0;
function noChoice(j, cd) {
  if (j && j.cabinChoice === false) return true;
  if (j && j.cabinChoice === true) return false;
  const subs = Object.values(obj(cd && cd.subcategories));
  return subs.length > 0 && subs.every(x => !hasStates(x));
}
const REGION_COL = new Map();
function regionVar(r) {
  if (!REGION_COL.size) uniq(j => j.region).forEach((x, i) => REGION_COL.set(x, `var(${COLORS[i % 8]})`));
  return REGION_COL.get(r) || 'var(--line)';
}
const minFree = j => isNum(j.freeCabins) ? j.freeCabins : null;
function applyFilters(f) {
  const q = f.q.trim().toLowerCase();
  const nmin = f.nmin !== '' ? +f.nmin : null, nmax = f.nmax !== '' ? +f.nmax : null, pmax = f.preis !== '' ? +f.preis : null;
  let r = S.journeys.filter(j => {
    if (q) {
      const hay = `${j.title || ''} ${j.from || ''} ${j.to || ''} ${arr(j.ports).join(' ')} ${arr(j.itinerary).map(i => i.name).join(' ')}`.toLowerCase();
      if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    if (f.region && j.region !== f.region) return false;
    if (f.ship && j.ship !== f.ship) return false;
    const ym = (j.start || '').slice(0, 7);
    if (f.von && ym < f.von) return false;
    if (f.bis && ym > f.bis) return false;
    if (nmin !== null && !(j.nights >= nmin)) return false;
    if (nmax !== null && !(j.nights <= nmax)) return false;
    if (pmax !== null && !(j.fromPricePP <= pmax)) return false;
    if (f.kat && !arr(j.categories).some(c => c.code === f.kat)) return false;
    if (f.gez && !isNum(j.freeCabins)) return false;
    return true;
  });
  const s = f.sort || 'start';
  const key = {
    start: j => j.start || '9999', preis: j => isNum(j.fromPricePP) ? j.fromPricePP : Infinity,
    frei: j => isNum(j.freeCabins) ? -j.freeCabins : Infinity, dauer: j => isNum(j.nights) ? j.nights : Infinity
  }[s] || (j => j.start || '');
  r.sort((a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : (a.start || '').localeCompare(b.start || ''); });
  return r;
}
function tripCard(j) {
  const camps = arr(j.campaigns).map(c => `<span class="pill warn">${esc(c)}</span>`).join('');
  const free = isNum(j.freeCabins) && j.cabinChoice === false
    ? `<span class="pill grey" title="Gezählt am ${esc(dtDE(j.freeCountedAt))}">Kabine wird zugeteilt</span> <span class="small muted">gezählt am ${esc(dDE(j.freeCountedAt))}</span>`
    : isNum(j.freeCabins)
    ? `<span class="pill ${j.freeCabins > 0 ? 'good' : 'bad'}" title="Gezählt am ${esc(dtDE(j.freeCountedAt))}">${j.freeCabins} ${j.freeCabins === 1 ? 'freie Kabine' : 'freie Kabinen'}</span> <span class="small muted">gezählt am ${esc(dDE(j.freeCountedAt))}</span>`
    : '<span class="small muted">Freie Kabinen nicht gezählt</span>';
  return `<article class="trip" style="border-top:5px solid ${regionVar(j.region)}">
    ${starBtn(j.id)}
    <div class="body">
      <h3><a href="#/reise/${esc(j.id)}">${esc(j.title || j.id)}</a></h3>
      <div class="meta">${esc(j.ship || '–')} · ${esc(dDE(j.start))} – ${esc(dDE(j.end))} · ${isNum(j.nights) ? j.nights + ' Nächte' : '–'}</div>
      <div class="pills"><span class="pill grey">${esc(j.region || 'Ohne Fahrgebiet')}</span>${j.stale ? '<span class="pill bad">veraltet</span>' : ''}${j.available === false ? '<span class="pill bad">nicht buchbar</span>' : ''}${camps}</div>
      <div class="small">${free}</div>
      <div class="foot"><div class="price"><small>ab </small>${eur(j.fromPricePP)}<small> p. P.</small></div><a class="btn ghost" href="#/reise/${esc(j.id)}">Details</a></div>
    </div></article>`;
}
function viewList(r) {
  const f = filtersFrom(r.params);
  const regions = uniq(j => j.region), ships = uniq(j => j.ship);
  const months = [...new Set(S.journeys.map(j => (j.start || '').slice(0, 7)).filter(x => /^\d{4}-\d{2}$/.test(x)))].sort();
  const cn = catNames();
  const sel = (arrx, cur, lab) => `<option value="">${lab}</option>` + arrx.map(([v, t]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t)}</option>`).join('');
  view.innerHTML = `
  <section class="card"><form id="ff" class="filters" autocomplete="off">
    <label class="wide">Suche (Titel, Häfen)<input type="search" name="q" value="${esc(f.q)}" placeholder="z. B. Mallorca"></label>
    <label>Fahrgebiet<select name="region">${sel(regions.map(x => [x, x]), f.region, 'Alle')}</select></label>
    <label>Schiff<select name="ship">${sel(ships.map(x => [x, x]), f.ship, 'Alle')}</select></label>
    <label>Abreise ab<select name="von">${sel(months.map(m => [m, monthLabel(m)]), f.von, 'Beliebig')}</select></label>
    <label>Abreise bis<select name="bis">${sel(months.map(m => [m, monthLabel(m)]), f.bis, 'Beliebig')}</select></label>
    <label>Nächte min.<input type="number" name="nmin" min="0" value="${esc(f.nmin)}"></label>
    <label>Nächte max.<input type="number" name="nmax" min="0" value="${esc(f.nmax)}"></label>
    <label>Max. Preis p. P. (€)<input type="number" name="preis" min="0" step="50" value="${esc(f.preis)}"></label>
    <label>Kabinenart<select name="kat">${sel([...cn].sort((a, b) => cmpDe(a[1], b[1])).map(([c, n]) => [c, `${n} (${c})`]), f.kat, 'Alle')}</select></label>
    <label>Sortierung<select name="sort">${sel([['start', 'Abreise'], ['preis', 'Preis p. P.'], ['frei', 'Freie Kabinen'], ['dauer', 'Dauer']], f.sort || 'start', '').replace('<option value=""></option>', '')}</select></label>
    <label class="chk"><input type="checkbox" name="gez" value="1" ${f.gez ? 'checked' : ''}> nur mit gezählten freien Kabinen</label>
    <div><button type="button" class="btn ghost" id="reset">Filter zurücksetzen</button></div>
  </form></section>
  <div class="bar"><strong id="cnt"></strong><span class="muted small">Preise: günstigster Tarif pro Person</span></div>
  <div id="items" class="list"></div><div id="more" style="text-align:center;margin:18px 0"></div>`;
  const form = $('#ff');
  const read = () => { const fd = new FormData(form), o = {}; FKEYS.forEach(k => o[k] = (fd.get(k) || '').toString()); return o; };
  const paint = () => {
    const cur = read();
    const p = new URLSearchParams(); FKEYS.forEach(k => { if (cur[k] && !(k === 'sort' && cur[k] === 'start')) p.set(k, cur[k]); });
    const h = '#/' + (p.toString() ? '?' + p : '');
    history.replaceState(null, '', h); S.lastList = h;
    const list = applyFilters(cur);
    $('#cnt').textContent = `${list.length.toLocaleString('de-DE')} von ${S.journeys.length.toLocaleString('de-DE')} Reisen`;
    const shown = list.slice(0, S.shown);
    $('#items').innerHTML = shown.length ? shown.map(tripCard).join('') : '<div class="empty card" style="grid-column:1/-1">Keine Reisen für diese Filter.</div>';
    $('#more').innerHTML = list.length > shown.length ? `<button type="button" class="btn" id="mbtn">Weitere ${Math.min(40, list.length - shown.length)} anzeigen (${(list.length - shown.length).toLocaleString('de-DE')} übrig)</button>` : '';
    const mb = $('#mbtn'); if (mb) mb.onclick = () => { S.shown += 40; paint(); };
  };
  let t; form.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { S.shown = 40; paint(); }, 150); });
  form.addEventListener('change', () => { clearTimeout(t); S.shown = 40; paint(); });
  form.addEventListener('submit', e => e.preventDefault());
  $('#reset').onclick = () => { form.reset(); [...form.elements].forEach(el => { if (el.name === 'sort') el.value = 'start'; else if (el.type === 'checkbox') el.checked = false; else if (el.name) el.value = ''; }); S.shown = 40; paint(); };
  paint();
}

/* ---------- Detail ---------- */
let leafletP = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(true);
  if (leafletP) return leafletP;
  leafletP = new Promise(res => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'; document.head.appendChild(css);
    const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    s.onload = () => res(!!window.L); s.onerror = () => { leafletP = null; res(false); }; document.head.appendChild(s);
  });
  return leafletP;
}
function routeStops(j) {
  const out = [];
  arr(j.itinerary).forEach(i => {
    const p = S.ports[i.code];
    if (p && isNum(p.lat) && isNum(p.lon)) out.push({ day: i.day, name: i.name || p.name || i.code, code: i.code, lat: p.lat, lon: p.lon });
  });
  return out;
}
async function drawMap(j, alive) {
  const box = $('#mapbox'); if (!box) return;
  const stops = routeStops(j);
  const fallback = () => {
    const mi = safeUrl(j.mapImage);
    box.innerHTML = mi ? `<img class="mapimg" src="${esc(mi)}" alt="Routenkarte">` : '<p class="muted">Keine Kartendaten verfügbar.</p>';
  };
  if (!stops.length) return fallback();
  const ok = await loadLeaflet();
  if (!alive() || !$('#mapbox')) return;
  if (!ok) return fallback();
  box.innerHTML = '<div id="map"></div>';
  const map = L.map('map', { scrollWheelZoom: false });
  S.map = map;
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende' }).addTo(map);
  const pts = stops.map(s => [s.lat, s.lon]);
  L.polyline(pts, { color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0b5c8a', weight: 3, opacity: .8, dashArray: '6 6' }).addTo(map);
  const groups = new Map();
  stops.forEach(s => { const g = groups.get(s.code) || { s, days: [] }; g.days.push(s.day); groups.set(s.code, g); });
  groups.forEach(({ s, days }) => {
    const label = days.join('/');
    const icon = L.divIcon({ className: '', html: `<div class="pin ${label.length > 2 ? 'wide' : ''}">${esc(label)}</div>`, iconSize: null, iconAnchor: [13, 13] });
    L.marker([s.lat, s.lon], { icon }).addTo(map).bindPopup(`<strong>${esc(s.name)}</strong><br>Tag ${esc(days.join(', '))}`);
  });
  if (pts.length > 1) map.fitBounds(pts, { padding: [30, 30] }); else map.setView(pts[0], 7);
  setTimeout(() => map.invalidateSize(), 50);
}
function itineraryTable(j) {
  const it = arr(j.itinerary);
  if (!it.length) return '<p class="muted">Kein Reiseverlauf vorhanden.</p>';
  const rows = it.map(i => {
    const sea = i.code === 'SEE';
    const scenic = i.scenic || /^XX/.test(i.code || '');
    const hint = [i.tender ? '<span class="pill warn">Tenderhafen</span>' : '', scenic ? '<span class="pill">Panoramafahrt</span>' : '', sea ? '<span class="pill grey">Seetag</span>' : ''].join(' ');
    const l = safeUrl(i.link);
    const nm = sea ? 'Seetag' : esc(i.name || i.code || '–');
    return `<tr><td class="nowrap">${esc(i.day ?? '–')}</td><td>${l && !sea ? `<a href="${esc(l)}" target="_blank" rel="noopener">${nm}</a>` : nm}</td><td class="nowrap">${esc(i.arr || '–')}</td><td class="nowrap">${esc(i.dep || '–')}</td><td>${hint}</td></tr>`;
  }).join('');
  return `<div class="tw"><table><thead><tr><th>Tag</th><th>Hafen</th><th>Ankunft</th><th>Abfahrt</th><th>Hinweis</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function priceMatrix(j) {
  const cats = arr(j.categories);
  if (!cats.length) return '<p class="muted">Keine Preise vorhanden.</p>';
  const tariffs = []; cats.forEach(c => Object.keys(obj(c.tariffs)).forEach(t => { if (!tariffs.includes(t)) tariffs.push(t); }));
  const order = ['CLASSIC', 'PREMIUM', 'CLASSIC ALL IN', 'PREMIUM ALL IN', 'LIGHT', 'IND'];
  tariffs.sort((a, b) => { const x = order.indexOf(a), y = order.indexOf(b); return (x < 0 ? 99 : x) - (y < 0 ? 99 : y) || cmpDe(a, b); });
  const head = tariffs.map(t => `<th class="num">${esc(t)}</th>`).join('');
  const rows = cats.map(c => {
    const tr = obj(c.tariffs);
    const vals = tariffs.map(t => tr[t] && isNum(tr[t].cabin) ? tr[t].cabin : null);
    const min = Math.min(...vals.filter(isNum));
    const tds = tariffs.map((t, i) => {
      const x = tr[t]; if (!x) return '<td class="num muted">–</td>';
      const best = isNum(vals[i]) && vals[i] === min;
      const fl = isNum(x.withFlight) ? `<div class="cellsub">mit Flug${x.flightFrom ? ' ab ' + esc(x.flightFrom) : ''}: ${eur(x.withFlight)}</div>` : '';
      const ca = arr(x.campaigns).length ? `<div class="cellsub">${arr(x.campaigns).map(esc).join(', ')}</div>` : '';
      return `<td class="num ${best ? 'best' : ''}">${eur(x.cabin)}<div class="cellsub">${isNum(x.cabin) ? eur(x.cabin / 2) + ' p. P.' : ''}</div>${fl}${ca}</td>`;
    }).join('');
    return `<tr><th scope="row" style="text-transform:none;font-size:.9rem;color:var(--text)">${esc(c.name || c.code)} <span class="muted small">(${esc(c.code)})</span></th>${tds}</tr>`;
  }).join('');
  return `<div class="tw"><table><thead><tr><th>Kabinenart</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
  <p class="small muted">Kabinenpreis gesamt für 2 Erwachsene ohne Flug; grün = günstigster Tarif je Zeile.</p>`;
}
function cabinInfoHtml(n, deck, attrs, ship) {
  const sp = ship && ship.byN.get(String(n));
  const rows = [];
  if (sp) {
    if (isNum(sp.size)) rows.push(['Größe', num(sp.size) + ' m²']);
    rows.push(['Balkon', sp.balcony ? ['ja', sp.balconyType, isNum(sp.balconySize) ? num(sp.balconySize) + ' m²' : ''].filter(Boolean).join(', ') : 'nein']);
    if (isNum(sp.maxPax)) rows.push(['Max. Personen', sp.maxPax]);
    rows.push(['Doppelbett', sp.doubleBed ? 'ja' : 'nein']);
    rows.push(['Verbindungstür', sp.connecting ? 'ja' : 'nein']);
    rows.push(['Nahe Treppe', sp.nearStairs ? 'ja' : 'nein']);
  }
  if (arr(attrs).length) rows.push(['Lage/Merkmale', arr(attrs).join(', ')]);
  return { rows, found: !!sp };
}
function cabinsSection(j, cd, ship, hist) {
  if (!cd) return '<div class="note">Freie Kabinen noch nicht gezählt – Reise auf die Merkliste setzen, dann wird sie täglich gezählt.</div>';
  const subs = Object.entries(obj(cd.subcategories));
  if (!subs.length) return `<p class="muted">Keine Unterkategorien vorhanden (Stand ${esc(dtDE(cd.fetched))}).</p>`;
  subs.sort((a, b) => (isNum(a[1].price) ? a[1].price : Infinity) - (isNum(b[1].price) ? b[1].price : Infinity));
  const body = subs.map(([code, s]) => {
    const cl = arr(s.cabins);
    const dk = new Map(); cl.forEach(c => { const d = String(parseInt(c.deck, 10)); dk.set(d, (dk.get(d) || 0) + 1); });
    const decks = [...dk.entries()].sort((a, b) => a[0] - b[0]).map(([d, n]) => `<span class="pill">Deck ${esc(d)}: ${n}</span>`).join('');
    const chips = cl.map(c => {
      const inf = cabinInfoHtml(c.n, c.deck, c.attrs, ship);
      const tip = [`Kabine ${c.n}, Deck ${parseInt(c.deck, 10)}`, ...inf.rows.map(r => `${r[0]}: ${r[1]}`)].join('\n');
      return `<button type="button" class="chip" data-cn="${esc(c.n)}" data-sub="${esc(code)}" title="${esc(tip)}">${esc(c.n)}</button>`;
    }).join('');
    const nochoice = !hasStates(s);
    const empty = cl.length === 0 && (s.free > 0 || nochoice);
    const freeCell = nochoice ? '<span class="pill grey">Wunschkabine nicht wählbar</span>' : (s.free === 0 ? '<span class="pill bad">0 frei</span>' : `<strong>${isNum(s.free) ? s.free : '–'}</strong>`);
    return `<details class="sub"><summary><span><strong>${esc(code)}</strong> ${esc(s.name || '')}</span><span>${eur(s.price)}${isNum(s.priceWithFlight) ? `<span class="cellsub"> · mit Flug ${eur(s.priceWithFlight)}</span>` : ''}</span><span class="${nochoice ? '' : 'num'}">${freeCell}</span><span class="small muted">Stand ${esc(dtDE(cd.fetched))}</span></summary>
      <div class="subbody">${cl.length ? `<div class="decks">${decks}</div><div class="chips" data-chips="${esc(code)}">${chips}</div><div class="cinfo" data-info="${esc(code)}" hidden></div>`
        : (empty ? '<p class="small muted">Keine Wunschkabinen-Wahl möglich – die Kabine wird zugeteilt.</p>' : '<p class="small muted">Keine freien Kabinen.</p>')}</div></details>`;
  }).join('');
  const top = noChoice(j, cd) ? '<div class="info" style="margin-bottom:10px">Kabine wird zugeteilt – eine Wunschkabinen-Wahl ist für diese Reise nicht (mehr) möglich.</div>' : '';
  let hint = '<p class="small muted">Zählung der buchbaren PREMIUM-Unterkategorien (Tarif ' + esc(cd.tariff || 'PREMIUM') + '); Kabinen-Details aus dem Schiffsplan' + (ship ? '' : ' (nicht vorhanden)') + '.</p>';
  return `${top}<div class="subhead"><span>Unterkategorie</span><span>Preis (2 Pers.)</span><span>Frei</span><span>Stand</span></div>${body}${hint}`;
}
function deckOverview(cd, ship) {
  if (!cd || !ship) return '';
  const free = new Map();
  Object.values(obj(cd.subcategories)).forEach(s => arr(s.cabins).forEach(c => { const d = String(parseInt(c.deck, 10)); free.set(d, (free.get(d) || 0) + 1); }));
  if (!free.size) return '';
  const decks = [...new Set([...ship.byDeck.keys(), ...free.keys()])].sort((a, b) => a - b);
  const rows = decks.map(d => {
    const y = ship.byDeck.get(d) || 0, x = free.get(d) || 0, pct = y ? Math.min(100, x / y * 100) : 0;
    return `<div class="deckrow"><span>Deck ${esc(d)}</span><div class="track" title="${x} von ${y}"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div><span class="small">frei <strong>${x}</strong> von ${y}</span></div>`;
  }).join('');
  return `<section class="card"><h2>Deck-Übersicht</h2>${rows}<p class="small muted">Gezählt sind nur die buchbaren PREMIUM-Unterkategorien; Gesamtzahl je Deck laut Schiffsplan.</p></section>`;
}
/* Liniendiagramm */
const COLORS = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'];
function lineChart(series, fmt) {
  series = series.filter(s => s.pts.length);
  if (!series.length) return '<p class="muted small">Noch keine Daten.</p>';
  const legend = series.map((s, i) => `<span><i style="background:var(${COLORS[i % 8]})"></i>${esc(s.name)}</span>`).join('');
  if (series.every(s => s.pts.length === 1)) {
    return `<div class="pills">${series.map((s, i) => `<span class="pill" style="background:var(--surface-2);color:var(--text)"><i style="display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;background:var(${COLORS[i % 8]})"></i>${esc(s.name)}: <strong>${fmt(s.pts[0][1])}</strong> <span class="muted">(${esc(dDE(s.pts[0][0]))})</span></span>`).join('')}</div>`;
  }
  const W = 640, H = 220, L = 54, R = 12, T = 12, B = 26;
  const all = series.flatMap(s => s.pts);
  const ts = all.map(p => Date.parse(p[0])), t0 = Math.min(...ts), t1 = Math.max(...ts);
  let v0 = Math.min(...all.map(p => p[1])), v1 = Math.max(...all.map(p => p[1]));
  if (v0 === v1) { v0 -= 1; v1 += 1; }
  const pd = (v1 - v0) * .1; v0 -= pd; v1 += pd;
  const X = t => L + (t1 === t0 ? (W - L - R) / 2 : (t - t0) / (t1 - t0) * (W - L - R));
  const Y = v => T + (1 - (v - v0) / (v1 - v0)) * (H - T - B);
  let g = '';
  for (let i = 0; i <= 4; i++) { const v = v0 + (v1 - v0) * i / 4, y = Y(v); g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text x="${L - 6}" y="${y + 4}" text-anchor="end">${esc(fmt(v))}</text>`; }
  g += `<text x="${L}" y="${H - 6}">${esc(dDE(all.find(p => Date.parse(p[0]) === t0)[0]))}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${esc(dDE(all.find(p => Date.parse(p[0]) === t1)[0]))}</text>`;
  const lines = series.map((s, i) => {
    const c = `var(${COLORS[i % 8]})`;
    const pts = s.pts.map(p => `${X(Date.parse(p[0])).toFixed(1)},${Y(p[1]).toFixed(1)}`);
    return `<polyline fill="none" stroke="${c}" stroke-width="2" points="${pts.join(' ')}"/>` + s.pts.map((p, k) => `<circle cx="${pts[k].split(',')[0]}" cy="${pts[k].split(',')[1]}" r="3" fill="${c}"><title>${esc(s.name)} · ${esc(dDE(p[0]))}: ${esc(fmt(p[1]))}</title></circle>`).join('');
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Verlauf">${g}${lines}</svg><div class="legend">${legend}</div>`;
}
function historySection(j, h) {
  if (!h) return '<p class="muted">Noch kein Verlauf vorhanden.</p>';
  const build = src => {
    const days = Object.keys(obj(src)).sort(), keys = new Set();
    days.forEach(d => Object.keys(src[d] || {}).forEach(k => keys.add(k)));
    return [...keys].sort(cmpDe).map(k => ({ name: k, pts: days.filter(d => isNum(src[d]?.[k])).map(d => [d, src[d][k]]) }));
  };
  const cn = catNames();
  const ps = build(h.prices).map(s => ({ ...s, name: `${cn.get(s.name) || s.name} (${s.name})` }));
  const fs = build(h.free);
  return `<div class="grid2"><div><h3>Preise je Kategorie</h3>${lineChart(ps, eur)}</div><div><h3>Freie Kabinen je Unterkategorie</h3>${lineChart(fs, v => String(Math.round(v)))}</div></div>`;
}
async function viewDetail(r, alive) {
  const j = S.byId.get(r.id);
  if (!j) { view.innerHTML = `<a class="back" href="${esc(S.lastList)}">← Zur Übersicht</a><div class="card note">Reise ${esc(r.id)} wurde nicht gefunden (evtl. nicht mehr im Katalog).</div>`; return; }
  const bl = safeUrl(j.bookingLink);
  view.innerHTML = `<a class="back" href="${esc(S.lastList)}">← Zur Übersicht</a>
  <section class="card"><div class="hdr"><div><h2>${esc(j.title || j.id)}</h2>
    <div class="facts"><span>🚢 ${esc(j.ship || '–')}</span><span>${esc(dDE(j.start))} – ${esc(dDE(j.end))}</span><span>${isNum(j.nights) ? j.nights + ' Nächte' : '–'}</span><span>${esc(j.region || '–')}</span><span>${esc(j.from || '')}${j.to && j.to !== j.from ? ' → ' + esc(j.to) : ''}</span></div>
    <div class="pills" style="margin-top:8px">${arr(j.campaigns).map(c => `<span class="pill warn">${esc(c)}</span>`).join('')}${arr(j.notes).map(c => `<span class="pill grey">${esc(c)}</span>`).join('')}${j.stale ? '<span class="pill bad">Daten veraltet</span>' : ''}${j.available === false ? '<span class="pill bad">nicht buchbar</span>' : ''}</div></div>
    <div style="display:flex;gap:10px;align-items:center">${starBtn(j.id, 'inline')}${bl ? `<a class="btn" href="${esc(bl)}" target="_blank" rel="noopener">Bei AIDA buchen</a>` : ''}</div></div>
    <div class="price" style="margin-top:10px"><small>ab </small>${eur(j.fromPricePP)}<small> p. P.${j.fromTariff ? ' · Tarif ' + esc(j.fromTariff) : ''}${j.flightIncluded ? ' · inkl. Flug' : ''}</small></div></section>
  <section class="card"><h2>Route</h2><div id="mapbox"><div class="muted">Karte wird geladen …</div></div></section>
  <section class="card"><h2>Reiseverlauf</h2>${itineraryTable(j)}</section>
  <section class="card"><h2>Preise nach Kabinenart und Tarif</h2>${priceMatrix(j)}</section>
  <div id="dyn"><div class="card muted">Kabinen und Verlauf werden geladen …</div></div>`;
  drawMap(j, alive);
  const [cd, ship, hist] = await Promise.all([cabinsOf(j.id), shipOf(j), histOf(j.id)]);
  if (!alive()) return;
  const dyn = $('#dyn'); if (!dyn) return;
  dyn.innerHTML = `<section class="card"><h2>Freie Kabinen</h2>${cabinsSection(j, cd, ship, hist)}</section>${deckOverview(cd, ship)}<section class="card"><h2>Verlauf</h2>${historySection(j, hist)}</section>`;
  dyn.addEventListener('click', ev => {
    const b = ev.target.closest('.chip'); if (!b) return;
    const code = b.dataset.sub, box = dyn.querySelector(`[data-info="${CSS.escape(code)}"]`);
    const c = arr(obj(cd.subcategories[code]).cabins).find(x => String(x.n) === b.dataset.cn); if (!c || !box) return;
    dyn.querySelectorAll(`[data-chips="${CSS.escape(code)}"] .chip`).forEach(x => x.classList.toggle('on', x === b));
    const inf = cabinInfoHtml(c.n, c.deck, c.attrs, ship);
    box.hidden = false;
    box.innerHTML = `<strong>Kabine ${esc(c.n)}</strong> · Deck ${esc(parseInt(c.deck, 10))}${inf.found ? '' : ' <span class="muted">(nicht im Schiffsplan gefunden)</span>'}<dl>${inf.rows.map(r => `<dt>${esc(r[0])}</dt><dd>${esc(r[1])}</dd>`).join('')}</dl>`;
  });
}

/* ---------- Änderungen ---------- */
async function viewChanges(alive) {
  const lr = S.meta.lastRun;
  view.innerHTML = '<div class="empty">Änderungen werden geladen …</div>';
  const ch = lr ? await getJson(`data/changes/${encodeURIComponent(lr)}.json`) : null;
  if (!alive()) return;
  if (!ch) { view.innerHTML = `<h2>Änderungen</h2><div class="card info">Für den letzten Lauf${lr ? ' (' + esc(dDE(lr)) + ')' : ''} liegt noch keine Änderungsliste vor. Sobald der nächste Abgleich gelaufen ist, erscheinen die Änderungen hier.</div>`; return; }
  const price = arr(ch.price), cg = arr(ch.categoryGone), cb = arr(ch.categoryBack), nw = arr(ch.new), gone = arr(ch.gone);
  const row = {
    price: p => { const d = (p.new ?? 0) - (p.old ?? 0); return `<div class="chg"><div>${tripLink(p.id)}<div class="small muted">${esc(p.name || p.cat)} (${esc(p.cat)}) · ${eur(p.old)} → ${eur(p.new)}</div></div><div class="${d < 0 ? 'down' : 'up'} nowrap">${d > 0 ? '+' : ''}${eur(d)}</div></div>`; },
    cg: p => `<div class="chg"><div>${tripLink(p.id)}<div class="small muted">${esc(p.name || p.cat)} (${esc(p.cat)})</div></div><div><span class="pill bad">ausgebucht</span></div></div>`,
    cb: p => `<div class="chg"><div>${tripLink(p.id)}<div class="small muted">${esc(p.name || p.cat)} (${esc(p.cat)})</div></div><div><span class="pill good">wieder buchbar${isNum(p.price) ? ' · ' + eur(p.price) : ''}</span></div></div>`,
    nw: id => `<div class="chg"><div>${tripLink(id)}<div class="small muted">${esc(S.byId.get(id)?.ship || '')} · ${esc(dDE(S.byId.get(id)?.start))}</div></div><div><span class="pill">neu</span></div></div>`,
    gone: g => `<div class="chg"><div>${S.byId.has(g.id) ? tripLink(g.id) : '<strong>' + esc(g.title || g.id) + '</strong>'}<div class="small muted">${esc(g.ship || '')} · ${esc(dDE(g.start))}</div></div><div><span class="pill grey">entfallen</span></div></div>`
  };
  const sec = (t, items, f) => items.length ? `<section class="card"><h3>${t} <span class="muted small">(${items.length})</span></h3>${items.map(f).join('')}</section>` : '';
  const m = S.merk;
  const mk = [
    ...price.filter(p => m.has(p.id)).map(row.price), ...cg.filter(p => m.has(p.id)).map(row.cg), ...cb.filter(p => m.has(p.id)).map(row.cb),
    ...nw.filter(id => m.has(id)).map(row.nw), ...gone.filter(g => m.has(g.id)).map(row.gone)
  ];
  const sav = p => (p.new ?? 0) - (p.old ?? 0);
  const down = price.filter(p => sav(p) < 0).sort((a, b) => sav(a) - sav(b)), up = price.filter(p => sav(p) > 0).sort((a, b) => sav(b) - sav(a));
  const total = price.length + cg.length + cb.length + nw.length + gone.length;
  view.innerHTML = `<h2>Änderungen vom ${esc(dDE(ch.date || lr))}</h2>
  ${mk.length ? `<section class="card" style="border-color:var(--star)"><h3>★ Deine Merkliste <span class="muted small">(${mk.length})</span></h3>${mk.join('')}</section>` : (m.size ? '<div class="card muted">Keine Änderungen bei Reisen auf der Merkliste.</div>' : '')}
  ${sec('Preissenkungen', down, row.price)}${sec('Preiserhöhungen', up, row.price)}${sec('Kategorien ausgebucht', cg, row.cg)}${sec('Wieder buchbar', cb, row.cb)}${sec('Neue Reisen', nw, row.nw)}${sec('Entfallene Reisen', gone, row.gone)}
  ${total ? '' : '<div class="card empty">Keine Änderungen im letzten Lauf.</div>'}`;
}

/* ---------- Merkliste ---------- */
async function viewMerk() {
  const ids = [...S.merk];
  if (!ids.length) { view.innerHTML = '<h2>Merkliste</h2><div class="card empty">Noch keine Reisen gemerkt. Mit dem Stern ☆ bei einer Reise merken – gemerkte Reisen werden täglich gezählt.</div>'; return; }
  const rows = await Promise.all(ids.map(async id => {
    const j = S.byId.get(id);
    if (!j) return `<tr><td colspan="7">${esc(id)} <span class="muted">(nicht mehr im Katalog)</span></td><td>${starBtn(id)}</td></tr>`;
    const cd = await cabinsOf(id);
    let free = isNum(j.freeCabins) ? j.freeCabins : null;
    if (cd) { const s = Object.values(obj(cd.subcategories)).reduce((a, x) => a + (isNum(x.free) ? x.free : 0), 0); free = s; }
    const cheap = arr(j.categories).map(c => {
      const v = Object.values(obj(c.tariffs)).map(t => t && t.cabin).filter(isNum);
      return v.length ? `<span class="nowrap">${esc(c.name || c.code)}: <strong>${eur(Math.min(...v))}</strong></span>` : '';
    }).filter(Boolean).join('<br>');
    return `<tr><td><a href="#/reise/${esc(id)}"><strong>${esc(j.title || id)}</strong></a><div class="small muted">${esc(j.region || '')}</div></td><td>${esc(j.ship || '–')}</td><td class="nowrap">${esc(dDE(j.start))} – ${esc(dDE(j.end))}<div class="small muted">${isNum(j.nights) ? j.nights + ' Nächte' : ''}</div></td><td class="num nowrap">${eur(j.fromPricePP)} <span class="small muted">p. P.</span></td><td class="num">${free === null ? '<span class="muted">nicht gezählt</span>' : (noChoice(j, cd) ? '<span class="pill grey">Kabine wird zugeteilt</span>' : '<strong>' + free + '</strong>')}${cd ? `<div class="small muted">Stand ${esc(dDE(cd.fetched))}</div>` : ''}</td><td class="small">${cheap || '–'}<div class="muted">Kabinenpreis gesamt, 2 Pers.</div></td><td>${starBtn(id)}</td></tr>`;
  }));
  view.innerHTML = `<h2>Merkliste <span class="muted small">(${ids.length})</span></h2><div class="card"><div class="tw"><table><thead><tr><th>Reise</th><th>Schiff</th><th>Reisezeit</th><th class="num">ab</th><th class="num">Freie Kabinen</th><th>Günstigster Preis je Kabinenart</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div></div>`;
}

/* ---------- Start ---------- */
(async function init() {
  view.innerHTML = '<div class="empty">Daten werden geladen …</div>';
  await loadCore();
  if (!S.journeys.length) { view.innerHTML = '<div class="card note">Keine Daten gefunden (data/catalog.json). Bitte zuerst den Datenabruf ausführen.</div>'; return; }
  render();
})();
