'use strict';
/* Lernquest – spielerisch auswendig lernen.
   Inhalte (Module, Bilder) und Fortschritt liegen nicht hier, sondern in einem privaten
   GitHub-Repository (Ordner lernquest/). Die App lädt sie über die GitHub-API, speichert sie
   für den Offline-Betrieb im Browser zwischen und gleicht den Fortschritt zwischen Geräten ab.
   Alternativ liefert der lokale server.py Module und Fortschritt. */

// =====================================================================
// Hilfsfunktionen
// =====================================================================

const DAY = 864e5;
const app = document.getElementById('app');

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* privater Modus o. Ä. */ } },
};

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
const fmt = s => esc(s).replace(/\n/g, '<br>');
const pad2 = n => String(n).padStart(2, '0');
const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const parseDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const startOfDay = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = a => a[Math.floor(Math.random() * a.length)];
const days = n => (n === 1 ? '1 Tag' : `${n} Tage`);
const isNum = s => /^-?\d+([.,]\d+)?$/.test(String(s).trim());

function shuffle(a, r = Math.random) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function seeded(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function weightedPick(pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of pairs) { if ((r -= w) < 0) return v; }
  return pairs[pairs.length - 1][0];
}

// ---------- Antworten prüfen ----------

// Kleinschreibung, Umlaute vereinheitlichen, Satzzeichen/Leerzeichen und führende Artikel ignorieren.
function norm(s) {
  return String(s).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/^(der|die|das|den|dem|des|ein|eine|einen|einem|einer|the|a|an) /, '')
    .replace(/ /g, '');
}

function lev(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// 'right' | 'near' (Tippfehler) | 'wrong'
function grade(given, accepted) {
  const g = norm(given);
  if (!g) return 'wrong';
  let near = false;
  for (const a of accepted) {
    const n = norm(a);
    if (!n) continue;
    if (n === g) return 'right';
    if (n.length >= 4 && !isNum(a) && lev(n, g) <= Math.max(1, Math.floor(n.length * 0.2))) near = true;
  }
  return near ? 'near' : 'wrong';
}

function clozeParts(text) {
  const parts = [], re = /\{\{(.+?)\}\}/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    parts.push({ t: text.slice(last, m.index) });
    parts.push({ gap: m[1].split('|').map(s => s.trim()) });
    last = re.lastIndex;
  }
  parts.push({ t: text.slice(last) });
  return parts;
}

// ---------- Formatierte Inhalte (Mini-Markdown) ----------
// Absätze, "- " und "1. " Listen, | Tabellen |, ![Bild](pfad), **fett**,
// Kästen ":::zusatz Titel" / ":::erl Titel" … ":::", sowie [Hinweise] und {Erläuterungen} im Text.

function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\{([^{}]+)\}/g, '<span class="erl">{$1}</span>')
    .replace(/\[([^[\]]+)\]/g, '<span class="note">[$1]</span>');
}

function mdTable(rows) {
  const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const [head, ...body] = rows.filter(r => !/^\|[\s:|-]+\|$/.test(r.trim())).map(cells);
  return `<div class="table-wrap"><table>
    <thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead>
    <tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

function md(src) {
  const lines = Array.isArray(src) ? src : String(src ?? '').split('\n');
  const isBullet = l => /^\s*[-•] /.test(l), isNumbered = l => /^\s*\d+\. /.test(l);
  let html = '', i = 0, m;
  while (i < lines.length) {
    const line = lines[i];
    if ((m = line.match(/^:::(zusatz|erl)\s*(.*)$/))) {
      const title = m[2] || (m[1] === 'zusatz' ? 'Zusatzwissen' : 'Erläuterung');
      html += `<div class="box ${m[1]}"><div class="box-title">${m[1] === 'zusatz' ? '📎' : '💬'} ${inline(title)}</div>`;
      i++;
    } else if (line.trim() === ':::') {
      html += '</div>';
      i++;
    } else if ((m = line.match(/^!\[(.*?)\]\((.+?)\)\s*$/))) {
      html += `<figure><img data-src="${esc(m[2])}" alt="${esc(m[1])}" data-act="zoom">${m[1] ? `<figcaption>${inline(m[1])}</figcaption>` : ''}</figure>`;
      i++;
    } else if (line.trim().startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++]);
      html += mdTable(rows);
    } else if (isBullet(line)) {
      const items = [];
      while (i < lines.length && isBullet(lines[i])) items.push(lines[i++].replace(/^\s*[-•] /, ''));
      html += `<ul>${items.map(t => `<li>${inline(t)}</li>`).join('')}</ul>`;
    } else if (isNumbered(line)) {
      const start = parseInt(line, 10), items = [];
      while (i < lines.length && isNumbered(lines[i])) items.push(lines[i++].replace(/^\s*\d+\. /, ''));
      html += `<ol start="${start}">${items.map(t => `<li>${inline(t)}</li>`).join('')}</ol>`;
    } else {
      if (line.trim()) html += `<p>${inline(line)}</p>`;
      i++;
    }
  }
  return html;
}

// =====================================================================
// Fortschritt
// Format v2: { v: 2, cards: { key: {…, last} }, log: { gerät: { tag: { feld: zahl } } },
//              settings: { name: { v, t } } }
// Zusammenführen (gleiche Logik wie merge() in server.py):
//  - Karten: der neuere Stand gewinnt (Zeitstempel last)
//  - Einstellungen: pro Eintrag gewinnt der neuere (Zeitstempel t)
//  - Tageswerte: zählen pro Gerät nur hoch → Maximum
// Zurücksetzen ist ein neuer Eintrag mit neuerem Zeitstempel (wirkt wie eine Löschmarkierung).
// =====================================================================

let DEVICE = LS.get('lq-device', null);
if (!DEVICE) { DEVICE = 'd' + Math.random().toString(36).slice(2, 10); LS.set('lq-device', DEVICE); }

const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
// JSON mit sortierten Schlüsseln – für Vergleiche unabhängig von der Reihenfolge
const canon = v => JSON.stringify(v, (k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));
const isEntry = x => isObj(x) && 'v' in x && 't' in x;

// Bringt jeden (auch alten) Stand ins aktuelle Format.
function normP(p) {
  p = isObj(p) ? p : {};
  const src = isObj(p.settings) ? p.settings : {};
  const legacyT = typeof src.updated === 'number' ? src.updated : 0; // altes Format: ein Zeitstempel für alles
  const settings = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'updated') continue;
    if (isEntry(v)) settings[k] = v;
    else if (k === 'exams' && isObj(v)) for (const [id, d] of Object.entries(v)) settings[`exam:${id}`] = { v: d, t: legacyT };
    else settings[k] = { v, t: legacyT };
  }
  return { v: 2, cards: isObj(p.cards) ? p.cards : {}, log: isObj(p.log) ? p.log : {}, settings };
}

// x ersetzt y, wenn x neuer ist (bei Gleichstand entscheidet der Inhalt, damit alle Geräte gleich zusammenführen)
const newer = (x, y, time) => !y || time(x) > time(y) || (time(x) === time(y) && canon(x) > canon(y));

function mergeP(a, b) {
  a = normP(a);
  b = normP(b);
  const out = { v: 2, cards: { ...a.cards }, log: {}, settings: { ...a.settings } };
  for (const [k, c] of Object.entries(b.cards)) if (isObj(c) && newer(c, out.cards[k], x => x.last || 0)) out.cards[k] = c;
  for (const [k, e] of Object.entries(b.settings)) if (newer(e, out.settings[k], x => x.t || 0)) out.settings[k] = e;
  for (const src of [a, b]) {
    for (const [dev, ds] of Object.entries(src.log)) {
      if (!isObj(ds)) continue;
      for (const [day, vals] of Object.entries(ds)) {
        if (!isObj(vals)) continue;
        const tgt = ((out.log[dev] ||= {})[day] ||= {});
        for (const [f, v] of Object.entries(vals)) if (typeof v === 'number') tgt[f] = Math.max(tgt[f] || 0, v);
      }
    }
  }
  return out;
}
const sameP = (a, b) => canon(normP(a)) === canon(normP(b));

let P = normP(LS.get('lq-progress', {}));

// ---------- Synchronisierung ----------

const SYNC_PATH = 'lernquest/progress.json';
const sync = { state: 'off', message: '', timer: null, busy: false, again: false, dirty: LS.get('lq-dirty', false) };

// github = privates Repository · local = server.py · off = nur dieser Browser
const syncMode = () => (GHSync.getConfig() ? 'github' : SOURCE === 'local' ? 'local' : 'off');

function setDirty(v) { sync.dirty = v; LS.set('lq-dirty', v); }

function save() {
  LS.set('lq-progress', P);
  setDirty(true);
  // Während einer Runde gebündelt (nicht jede Antwort ein eigener Commit), sonst zügig.
  scheduleSync(view === 'session' || view === 'speed' ? 45000 : 3000);
  updateSyncUI();
}

function scheduleSync(delay = 500) {
  if (syncMode() === 'off') return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(runSync, delay);
}

async function runSync() {
  const mode = syncMode();
  clearTimeout(sync.timer);
  if (mode === 'off') { setSync('off', ''); return; }
  if (sync.busy) { sync.again = true; return; }
  if (navigator.onLine === false) { setSync('offline', 'Offline – wird abgeglichen, sobald wieder Internet da ist.'); return; }
  sync.busy = true;
  setSync('busy', '');
  const before = canon(P);
  try {
    let remote;
    if (mode === 'github') {
      remote = (await GHSync.syncFile(SYNC_PATH, { local: P, merge: mergeP, equals: sameP, message: 'Lernquest: Fortschritt' })).data;
    } else {
      let r;
      try {
        r = await fetch('api/progress', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(P) });
      } catch {
        throw new GHSync.SyncError('network', 'Lokaler Server nicht erreichbar.');
      }
      if (!r.ok) throw new GHSync.SyncError('other', `Lokaler Server: Fehler ${r.status}`, r.status);
      remote = await r.json();
    }
    // Mit dem aktuellen Stand zusammenführen – falls während des Abgleichs weitergelernt wurde
    P = mergeP(P, remote);
    LS.set('lq-progress', P);
    setDirty(!sameP(P, remote));
    if (sync.dirty) sync.again = true;
    LS.set('lq-sync-meta', { lastSyncAt: Date.now() });
    setSync('ok', '');
    if (canon(P) !== before) refreshAfterSync();
  } catch (e) {
    setSync(e?.code === 'network' ? 'offline' : 'error', e?.message || 'Unbekannter Fehler beim Abgleich.');
  } finally {
    sync.busy = false;
    if (sync.again) { sync.again = false; scheduleSync(1500); }
  }
}

function refreshAfterSync() {
  if ((view === 'home' && !mapSel && !modSheet) || view === 'settings') render();
}

function setSync(state, message = '') {
  sync.state = state;
  sync.message = message;
  updateSyncUI();
}

function updateSyncUI() {
  const pill = document.getElementById('sync');
  if (pill) pill.outerHTML = syncBadge();
  const dot = document.getElementById('sync-dot');
  if (dot) dot.className = `sync-dot s-${syncDotState()}`;
  const box = document.getElementById('sync-status');
  if (box) box.innerHTML = syncStatusHTML();
}

const syncDotState = () => (sync.state === 'ok' && sync.dirty ? 'pending' : sync.state);

function syncTitle() {
  const last = LS.get('lq-sync-meta', {}).lastSyncAt;
  const label = { ok: sync.dirty ? 'Änderungen warten auf den Abgleich' : 'Synchronisiert', busy: 'Gleicht ab …', offline: 'Offline', error: 'Sync-Fehler', off: 'Nur in diesem Browser gespeichert' }[sync.state];
  return label + (last ? ` · zuletzt ${new Date(last).toLocaleString('de-DE', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '') + (sync.message ? ` · ${sync.message}` : '');
}

function syncBadge() {
  const label = sync.state === 'busy' ? '⟳ Gleicht ab'
    : sync.state === 'offline' ? '⚠ Offline'
    : sync.state === 'error' ? '⚠ Sync-Fehler'
    : sync.state === 'off' ? 'Nur lokal'
    : sync.dirty ? '● Ausstehend' : '✓ Synchron';
  return `<button id="sync" class="pill sync ${syncDotState()}" data-act="settings" title="${esc(syncTitle())}">${label}</button>`;
}

// ---------- Einstellungen (jeder Wert mit eigenem Zeitstempel) ----------

const DEFAULTS = { newPerDay: 10, dailyGoal: 15, sound: true, examWrite: false };
const setting = k => { const e = P.settings[k]; return e && e.v !== null && e.v !== undefined ? e.v : DEFAULTS[k]; };
function setSetting(k, v) { P.settings = { ...P.settings, [k]: { v, t: Date.now() } }; save(); }

// =====================================================================
// Datenquelle: privates GitHub-Repository → lokaler Server (server.py) → Zwischenspeicher
// =====================================================================

const DATA_DIR = 'lernquest';
const CACHE_NAME = 'lernquest-data-v1';
let SOURCE = null;     // 'github' | 'local' | 'cache'
let DATA_ERROR = null;
let MEDIA = LS.get('lq-media-index', {}); // 'media/…' → SHA im Repository

// Module und Bilder im Cache Storage (localStorage wäre mit ~5 MB zu klein).
// Die Schlüssel sind nur Namen – unter dieser Adresse wird nie etwas aus dem Netz geladen.
const cacheKey = path => new URL(`__daten/${path}`, location.href).href;
const DataCache = {
  async open() {
    try { return 'caches' in window ? await caches.open(CACHE_NAME) : null; } catch { return null; }
  },
  async put(path, body, type) {
    const c = await this.open();
    if (!c) return false;
    try { await c.put(cacheKey(path), new Response(body, { headers: { 'Content-Type': type } })); return true; } catch { return false; }
  },
  async get(path) {
    const c = await this.open();
    if (!c) return null;
    try { return (await c.match(cacheKey(path))) || null; } catch { return null; }
  },
  async del(path) {
    const c = await this.open();
    if (c) { try { await c.delete(cacheKey(path)); } catch { /* egal */ } }
  },
};
// Welche Datei mit welcher SHA im Zwischenspeicher liegt
const cacheIndex = () => LS.get('lq-cache-index', {});
const setCacheIndex = idx => LS.set('lq-cache-index', idx);

const REQUIRED_FIELD = { qa: 'a', exam: 'answer', order: 'items', pairs: 'pairs', grid: 'rows' };

// Prüft Moduldateien (gleiche Regeln wie load_decks() in server.py).
function validateDecks(files) {
  const decks = [], warnings = [], seen = new Set();
  for (const { name, data: raw } of files) {
    if (!isObj(raw)) { warnings.push(`${name}: konnte nicht gelesen werden (kein gültiges JSON)`); continue; }
    const id = String(raw.id || name.replace(/\.json$/, ''));
    if (seen.has(id)) { warnings.push(`${name}: Modul-ID „${id}“ gibt es doppelt – übersprungen`); continue; }
    seen.add(id);
    const ids = new Set();
    const chapters = (Array.isArray(raw.chapters) ? raw.chapters : []).map((ch, ci) => {
      const chId = String(ch.id || `kap${ci + 1}`);
      const cards = [];
      for (const c of Array.isArray(ch.cards) ? ch.cards : []) {
        const type = c.type || 'qa', need = REQUIRED_FIELD[type];
        if (!c.id || !c.q || !need || !c[need]) {
          warnings.push(`${name}: Karte „${c.id || '?'}“ (${type}) unvollständig in „${ch.title || chId}“ – übersprungen`);
          continue;
        }
        const cid = String(c.id);
        if (ids.has(cid)) { warnings.push(`${name}: Karten-ID „${cid}“ doppelt – übersprungen`); continue; }
        ids.add(cid);
        cards.push({ ...c, id: cid, q: String(c.q), ...(type === 'qa' ? { a: String(c.a) } : {}) });
      }
      return { id: chId, title: String(ch.title || chId), cards };
    });
    decks.push({ id, title: String(raw.title || id), description: String(raw.description || ''), examDate: String(raw.examDate || ''), chapters });
  }
  decks.sort((x, y) => x.title.toLowerCase().localeCompare(y.title.toLowerCase()));
  return { decks, warnings };
}

// Lädt alle Module aus lernquest/decks/ – nur geänderte Dateien (SHA) werden neu heruntergeladen.
async function loadFromGitHub(cfg) {
  const files = await GHSync.listTree(cfg, DATA_DIR);
  const rel = p => p.slice(DATA_DIR.length + 1);
  const idx = cacheIndex();
  const deckFiles = files.filter(f => /^decks\/[^/]+\.json$/.test(rel(f.path)));
  const out = [];
  for (const f of deckFiles) {
    const r = rel(f.path);
    let text = null;
    if (idx[r] === f.sha) { const hit = await DataCache.get(r); if (hit) text = await hit.text(); }
    if (text == null) {
      text = await GHSync.readBlobText(cfg, f.sha);
      if (await DataCache.put(r, text, 'application/json')) idx[r] = f.sha;
    }
    let data = null;
    try { data = JSON.parse(text); } catch { /* wird als Warnung gemeldet */ }
    out.push({ name: r.slice('decks/'.length), data });
  }
  for (const r of Object.keys(idx)) {
    if (r.startsWith('decks/') && !deckFiles.some(f => rel(f.path) === r)) { delete idx[r]; DataCache.del(r); }
  }
  setCacheIndex(idx);
  LS.set('lq-deck-files', out.map(f => f.name));
  MEDIA = Object.fromEntries(files.filter(f => rel(f.path).startsWith('media/')).map(f => [rel(f.path), f.sha]));
  LS.set('lq-media-index', MEDIA);
  return out;
}

async function loadFromCache() {
  const out = [];
  for (const name of LS.get('lq-deck-files', [])) {
    const hit = await DataCache.get(`decks/${name}`);
    if (!hit) continue;
    try { out.push({ name, data: JSON.parse(await hit.text()) }); } catch { /* defekt → überspringen */ }
  }
  return out.length ? out : null;
}

/** Module laden: GitHub (wenn eingerichtet und online) → lokaler Server → Zwischenspeicher. */
async function loadDecks() {
  DATA_ERROR = null;
  const cfg = GHSync.getConfig();
  if (cfg && navigator.onLine !== false) {
    try { return useDecks(validateDecks(await loadFromGitHub(cfg)), 'github'); }
    catch (e) { DATA_ERROR = e?.message || 'Module konnten nicht von GitHub geladen werden.'; }
  }
  try {
    const r = await fetch('api/decks', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      INFO = await fetch('api/info').then(x => x.json()).catch(() => ({}));
      return useDecks(d, 'local');
    }
  } catch { /* kein lokaler Server (z. B. auf GitHub Pages) */ }
  const cached = await loadFromCache();
  if (cached) return useDecks(validateDecks(cached), 'cache');
  return false;
}

function useDecks({ decks, warnings }, source) {
  DECKS = decks.map(prepDeck);
  DECK_WARN = warnings || [];
  SOURCE = source;
  return true;
}

// ---------- Bilder (privat → über die API als Blob-URL) ----------

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const mimeOf = p => MIME[p.split('.').pop().toLowerCase()] || 'application/octet-stream';
const mediaURLs = new Map(); // Pfad → Promise<URL>

function mediaURL(path) {
  const rel = path.replace(/^\.?\//, '');
  if (!mediaURLs.has(rel)) {
    const p = (async () => {
      if (SOURCE === 'local') return rel; // server.py liefert media/ direkt
      const sha = MEDIA[rel], idx = cacheIndex();
      let blob = null;
      if (!sha || idx[rel] === sha) { const hit = await DataCache.get(rel); if (hit) blob = await hit.blob(); }
      const cfg = GHSync.getConfig();
      if (!blob && cfg && sha && navigator.onLine !== false) {
        blob = new Blob([await GHSync.readBlob(cfg, sha)], { type: mimeOf(rel) });
        if (await DataCache.put(rel, blob, mimeOf(rel))) setCacheIndex({ ...cacheIndex(), [rel]: sha });
      }
      return blob ? URL.createObjectURL(blob) : null;
    })().catch(() => null);
    mediaURLs.set(rel, p);
    p.then(url => { if (!url) mediaURLs.delete(rel); });
  }
  return mediaURLs.get(rel);
}

// Bilder in der aktuellen Ansicht nachladen (md() setzt data-src statt src).
function hydrateImages(root = app) {
  for (const img of root.querySelectorAll('img[data-src]:not([src])')) {
    mediaURL(img.dataset.src).then(url => {
      if (url) { img.src = url; return; }
      const box = document.createElement('div');
      box.className = 'img-missing';
      box.textContent = 'Bild nicht verfügbar – es wird geladen, sobald das Gerät online ist.';
      img.replaceWith(box);
    });
  }
}

// Nach dem Laden alle Bilder für den Offline-Betrieb vorab speichern (nur geänderte).
const mediaStatus = { total: 0, cached: 0, busy: false };
async function prefetchMedia() {
  const cfg = GHSync.getConfig();
  if (!cfg || SOURCE !== 'github' || mediaStatus.busy) return;
  mediaStatus.busy = true;
  const idx = cacheIndex();
  const entries = Object.entries(MEDIA);
  mediaStatus.total = entries.length;
  mediaStatus.cached = entries.filter(([r, sha]) => idx[r] === sha).length;
  try {
    for (const [r, sha] of entries) {
      if (idx[r] === sha) continue;
      if (navigator.onLine === false) break;
      const blob = new Blob([await GHSync.readBlob(cfg, sha)], { type: mimeOf(r) });
      if (await DataCache.put(r, blob, mimeOf(r))) { idx[r] = sha; setCacheIndex(idx); mediaStatus.cached++; }
    }
    for (const r of Object.keys(idx)) {
      if (r.startsWith('media/') && !(r in MEDIA)) { delete idx[r]; DataCache.del(r); }
    }
    setCacheIndex(idx);
  } catch { /* nächster Versuch beim nächsten Start */ }
  mediaStatus.busy = false;
  if (view === 'settings') render();
}

// ---------- Tageslog (pro Gerät, Werte zählen nur hoch) ----------

function todayLog() {
  const dev = (P.log[DEVICE] ||= {});
  return (dev[dayKey()] ||= {});
}
function bump(f, n = 1) { const d = todayLog(); d[f] = (d[f] || 0) + n; }
function bumpMax(f, v) { const d = todayLog(); if (v > (d[f] || 0)) d[f] = v; }

const SUM_FIELDS = ['xp', 'answers', 'correct', 'wrong', 'new', 'fixed'];
const MAX_FIELDS = ['bestCombo', 'speedBest', 'night', 'early'];

function dayAgg() {
  const out = {};
  for (const ds of Object.values(P.log)) {
    for (const [day, v] of Object.entries(ds)) {
      const o = (out[day] ||= {});
      for (const f of SUM_FIELDS) o[f] = (o[f] || 0) + (v[f] || 0);
      for (const f of MAX_FIELDS) o[f] = Math.max(o[f] || 0, v[f] || 0);
    }
  }
  return out;
}

// =====================================================================
// Lernmodule
// =====================================================================

let DECKS = [], DECK_WARN = [], INFO = {};

function prepDeck(d) {
  const cards = [];
  d.chapters.forEach((ch, ci) => ch.cards.forEach(c => cards.push({ ...c, type: c.type || 'qa', key: `${d.id}/${c.id}`, ch: ch.id, chIndex: ci, chTitle: ch.title })));
  d._cards = cards;
  d._byKey = Object.fromEntries(cards.map(c => [c.key, c]));
  for (const c of cards) c._mcOk = c.type === 'qa' && distractors(c, d, 3).length >= 3;
  return d;
}

function activeDeck() {
  const id = LS.get('lq-deck', null);
  return DECKS.find(d => d.id === id) || DECKS[0] || null;
}

// Falsche Antwortoptionen: erst die aus der Karte ("wrong"), dann Zahlen in der Nähe,
// dann Antworten anderer Karten (gleiches Kapitel und ähnliche Länge bevorzugt).
function distractors(c, deck, n) {
  const used = new Set([c.a, ...(c.alt || [])].map(norm));
  const out = [];
  const add = s => { const k = norm(s); if (!k || used.has(k)) return; used.add(k); out.push(String(s)); };
  for (const w of shuffle([...(c.wrong || [])])) { if (out.length >= n) break; add(w); }
  const numeric = isNum(c.a);
  if (out.length < n && numeric) {
    const v = parseFloat(c.a.replace(',', '.'));
    const cands = shuffle([v + 1, v - 1, v + 2, v - 2, v * 2, Math.round(v / 2), v + 10, v - 10].filter(x => x > 0 && x !== v));
    for (const x of cands) { if (out.length >= n) break; add(String(x)); }
  }
  if (out.length < n) {
    const others = deck._cards
      .filter(o => o.type === 'qa' && o.key !== c.key && isNum(o.a) === numeric)
      .map(o => ({ a: o.a, score: (o.ch === c.ch ? 0 : 25) + Math.abs(o.a.length - c.a.length) + Math.random() * 15 }))
      .sort((x, y) => x.score - y.score);
    for (const o of others) { if (out.length >= n) break; add(o.a); }
  }
  return out;
}

// =====================================================================
// Spaced Repetition (vereinfachtes SM-2)
// Bewertung: 0 = nochmal, 1 = schwer, 2 = gut, 3 = leicht
// =====================================================================

// Prüfungsdatum: eigenes Datum des Moduls (Einstellungen) → Angabe in der Moduldatei → Standard für alle Module
// (Einstellung „examDefault“, wird mit dem Fortschritt synchronisiert) → keins.
const examStd = deck => (deck && deck.examDate) || setting('examDefault') || null;
const examDate = deck => (deck && setting(`exam:${deck.id}`)) || examStd(deck);
const fmtDate = k => k.split('-').reverse().join('.');
const daysUntil = k => (k ? Math.round((parseDay(k) - startOfDay()) / DAY) : null);

function examCap(deckId) {
  const left = daysUntil(examDate(DECKS.find(d => d.id === deckId)));
  return left > 0 ? Math.max(1, Math.floor(left / 2)) : 365;
}

function computeNext(prev, rating, cap) {
  const s = { ease: 2.5, interval: 0, reps: 0, lapses: 0, ...prev };
  if (s.state !== 'review') {
    if (rating <= 1) return { ...s, state: 'learning' };
    const base = s.relearnIv || 1;
    const iv = rating === 3 ? Math.max(base + 2, 3) : base;
    const n = { ...s, state: 'review', interval: Math.min(iv, cap) };
    delete n.relearnIv;
    return n;
  }
  if (rating === 0) {
    return { ...s, state: 'learning', lapses: s.lapses + 1, ease: Math.max(1.3, s.ease - 0.2), relearnIv: Math.max(1, Math.round(s.interval * 0.3)) };
  }
  let iv, ease = s.ease;
  if (rating === 1) { iv = Math.max(s.interval + 1, Math.round(s.interval * 1.2)); ease = Math.max(1.3, ease - 0.15); }
  else if (rating === 2) iv = Math.max(s.interval + 1, Math.round(s.interval * ease));
  else { iv = Math.max(s.interval + 2, Math.round(s.interval * ease * 1.3)); ease += 0.15; }
  return { ...s, state: 'review', ease, interval: Math.min(iv, cap, 365) };
}

function applyRating(key, rating, deckId) {
  const prev = P.cards[key];
  const now = Date.now();
  const n = computeNext(prev || { state: 'new' }, rating, examCap(deckId));
  n.due = n.state === 'review' ? addDays(startOfDay(now), n.interval) : now;
  n.last = now;
  n.reps = (n.reps || 0) + 1;
  n.intro ??= now;
  if (rating === 0) n.miss = true;
  else if (rating >= 2) { if (prev?.miss) bump('fixed'); n.miss = false; }
  P.cards[key] = n;
  return n;
}

const isDueState = s => !!s && (s.state === 'learning' || (s.state === 'review' && s.due <= Date.now()));

function cardLevel(s) {
  if (!s || s.state === 'new') return 'fresh';
  if (s.state === 'learning') return 'learn';
  if (s.interval >= 10) return 'master';
  if (s.interval >= 3) return 'good';
  return 'learn';
}
const LEVEL_SCORE = { fresh: 0, learn: 0.25, good: 0.65, master: 1 };

function deckStatus(deck, chapter) {
  const now = Date.now(), sod = startOfDay();
  let due = 0, learning = 0, fresh = 0, newToday = 0;
  for (const c of deck._cards) {
    if (chapter && c.ch !== chapter) continue;
    const s = P.cards[c.key];
    if (!s || s.state === 'new') { fresh++; continue; }
    if (s.state === 'learning') learning++;
    else if (s.due <= now) due++;
    if ((s.intro || 0) >= sod) newToday++;
  }
  const newAvail = Math.min(fresh, Math.max(0, setting('newPerDay') - newToday));
  return { due, learning, fresh, newToday, newAvail };
}

function chapterStats(deck, chId) {
  const cs = deck._cards.filter(c => c.ch === chId);
  const seg = { master: 0, good: 0, learn: 0, fresh: 0 };
  let score = 0;
  for (const c of cs) { const l = cardLevel(P.cards[c.key]); seg[l]++; score += LEVEL_SCORE[l]; }
  return { n: cs.length, seg, pct: cs.length ? Math.round((score / cs.length) * 100) : 0 };
}

// =====================================================================
// XP, Level, Streak, Quests, Erfolge
// =====================================================================

const xpFor = (correct, combo) => (correct ? 10 + (combo >= 10 ? 10 : combo >= 5 ? 5 : 0) : 2);

function levelInfo(xp) {
  let level = 1, need = 100, rest = xp;
  while (rest >= need) { rest -= need; level++; need = 100 + 25 * (level - 1); }
  return { level, into: rest, need };
}

const TITLES = [[1, 'Erstsemester'], [3, 'Bücherwurm'], [5, 'Karteikarten-Profi'], [8, 'Tutor:in'], [12, 'Hilfskraft'], [16, 'Doktorand:in'], [20, 'Professor:in'], [30, 'Nobelpreis-Anwärter:in']];
const levelTitle = l => TITLES.filter(([min]) => l >= min).pop()[1];

const QUESTS_MAIN = [
  { id: 'ans20', t: 'Beantworte 20 Fragen', f: a => a.answers, goal: 20 },
  { id: 'ans30', t: 'Beantworte 30 Fragen', f: a => a.answers, goal: 30 },
  { id: 'cor20', t: 'Gib 20 richtige Antworten', f: a => a.correct, goal: 20 },
];
const QUESTS_SIDE = [
  { id: 'new5', t: 'Lerne 5 neue Karten', f: a => a.new, goal: 5 },
  { id: 'combo8', t: 'Schaffe eine 8er-Combo', f: a => a.bestCombo, goal: 8 },
  { id: 'combo12', t: 'Schaffe eine 12er-Combo', f: a => a.bestCombo, goal: 12 },
  { id: 'speed8', t: 'Speed-Runde: mindestens 8 Punkte', f: a => a.speedBest, goal: 8 },
  { id: 'speed12', t: 'Speed-Runde: mindestens 12 Punkte', f: a => a.speedBest, goal: 12 },
  { id: 'xp150', t: 'Sammle 150 XP', f: a => a.xp, goal: 150 },
];
const QUEST_XP = 25, QUEST_ALL_XP = 25;

// Pro Tag immer dieselben Quests (auf allen Geräten), abhängig vom Datum.
function questsFor(day) {
  const r = seeded(hashStr(day));
  const main = QUESTS_MAIN[Math.floor(r() * QUESTS_MAIN.length)];
  const family = q => q.id.replace(/\d+/, '');
  const side = [];
  for (const q of shuffle([...QUESTS_SIDE], r)) {
    if (side.length < 2 && !side.some(s => family(s) === family(q))) side.push(q);
  }
  return [main, ...side];
}
const questDone = (q, a) => (q.f(a) || 0) >= q.goal;
function questBonus(day, a) {
  const n = questsFor(day).filter(q => questDone(q, a)).length;
  return n * QUEST_XP + (n === 3 ? QUEST_ALL_XP : 0);
}

const ACH = [
  { id: 'first', icon: '🌱', t: 'Erste Schritte', d: 'Erste Frage beantwortet', ok: s => s.answers >= 1 },
  { id: 'a100', icon: '📚', t: 'Fleißig', d: '100 Antworten', ok: s => s.answers >= 100 },
  { id: 'a500', icon: '🧠', t: 'Lernmaschine', d: '500 Antworten', ok: s => s.answers >= 500 },
  { id: 'a2000', icon: '🏛️', t: 'Bibliothekar:in', d: '2000 Antworten', ok: s => s.answers >= 2000 },
  { id: 'learn25', icon: '🃏', t: 'Sammler:in', d: '25 Karten gelernt', ok: s => s.learned >= 25 },
  { id: 'learn100', icon: '🗂️', t: 'Archivar:in', d: '100 Karten gelernt', ok: s => s.learned >= 100 },
  { id: 'combo10', icon: '🔥', t: 'Heißgelaufen', d: '10er-Combo', ok: s => s.bestCombo >= 10 },
  { id: 'combo25', icon: '☄️', t: 'Unaufhaltsam', d: '25er-Combo', ok: s => s.bestCombo >= 25 },
  { id: 'streak3', icon: '📅', t: 'Dranbleiben', d: '3 Tage Streak', ok: s => s.bestStreak >= 3 },
  { id: 'streak7', icon: '🗓️', t: 'Eine Woche!', d: '7 Tage Streak', ok: s => s.bestStreak >= 7 },
  { id: 'streak30', icon: '🏆', t: 'Eiserne Disziplin', d: '30 Tage Streak', ok: s => s.bestStreak >= 30 },
  { id: 'speed10', icon: '⚡', t: 'Flinke Finger', d: '10 Punkte Speed-Runde', ok: s => s.speedBest >= 10 },
  { id: 'speed20', icon: '🚀', t: 'Lichtgeschwindigkeit', d: '20 Punkte Speed-Runde', ok: s => s.speedBest >= 20 },
  { id: 'fix10', icon: '🩹', t: 'Aus Fehlern lernen', d: '10 Fehler korrigiert', ok: s => s.fixed >= 10 },
  { id: 'master', icon: '👑', t: 'Kapitel-Meister:in', d: 'Ein Kapitel gemeistert', ok: s => s.masterCh },
  { id: 'lvl5', icon: '⭐', t: 'Aufsteiger:in', d: 'Level 5 erreicht', ok: s => s.lv.level >= 5 },
  { id: 'lvl10', icon: '🌟', t: 'Überflieger:in', d: 'Level 10 erreicht', ok: s => s.lv.level >= 10 },
  { id: 'night', icon: '🦉', t: 'Nachteule', d: 'Nach 23 Uhr gelernt', ok: s => s.night > 0 },
  { id: 'early', icon: '🐦', t: 'Frühaufsteher:in', d: 'Vor 7 Uhr gelernt', ok: s => s.early > 0 },
];

function computeStats() {
  const agg = dayAgg();
  const t = { xp: 0, answers: 0, correct: 0, fixed: 0, bestCombo: 0, speedBest: 0, night: 0, early: 0 };
  for (const [day, a] of Object.entries(agg)) {
    t.xp += (a.xp || 0) + questBonus(day, a);
    for (const f of ['answers', 'correct', 'fixed']) t[f] += a[f] || 0;
    for (const f of ['bestCombo', 'speedBest', 'night', 'early']) t[f] = Math.max(t[f], a[f] || 0);
  }
  let learned = 0;
  for (const s of Object.values(P.cards)) if (s.state === 'review') learned++;
  const masterCh = DECKS.some(d => d.chapters.some(ch => {
    const cs = d._cards.filter(c => c.ch === ch.id);
    return cs.length > 0 && cs.every(c => cardLevel(P.cards[c.key]) === 'master');
  }));

  const goal = setting('dailyGoal');
  const ok = k => (agg[k]?.answers || 0) >= goal;
  const todayDone = ok(dayKey());
  let streak = 0, tt = todayDone ? Date.now() : addDays(Date.now(), -1);
  while (ok(dayKey(tt))) { streak++; tt = addDays(tt, -1); }
  let bestStreak = 0, run = 0, prev = null;
  for (const k of Object.keys(agg).filter(ok).sort()) {
    run = prev && dayKey(addDays(parseDay(prev), 1)) === k ? run + 1 : 1;
    bestStreak = Math.max(bestStreak, run);
    prev = k;
  }
  return { ...t, agg, learned, masterCh, streak, todayDone, bestStreak, lv: levelInfo(t.xp), today: agg[dayKey()] || {} };
}

const questsDoneToday = st => questsFor(dayKey()).filter(q => questDone(q, st.today)).length;
const unlockedIds = st => ACH.filter(a => a.ok(st)).map(a => a.id);

// =====================================================================
// Effekte: Sound, Konfetti, Toasts
// =====================================================================

let actx = null;
function beep(notes) {
  if (!setting('sound')) return;
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const t0 = actx.currentTime;
    for (const [f, d, delay = 0] of notes) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + delay);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + delay + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + d);
      o.connect(g).connect(actx.destination);
      o.start(t0 + delay); o.stop(t0 + delay + d + 0.02);
    }
  } catch { /* kein Audio verfügbar */ }
}
const SFX = {
  good: () => beep([[660, 0.12], [880, 0.18, 0.08]]),
  bad: () => beep([[200, 0.28]]),
  level: () => beep([[523, 0.15], [659, 0.15, 0.12], [784, 0.15, 0.24], [1047, 0.35, 0.36]]),
};

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function confetti() {
  if (reducedMotion()) return;
  const cv = document.createElement('canvas');
  cv.className = 'confetti';
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d'), dpr = window.devicePixelRatio || 1;
  const W = (cv.width = innerWidth * dpr), H = (cv.height = innerHeight * dpr);
  const colors = ['#5b5bd6', '#e0a400', '#1e9e57', '#d64545', '#3aa0e8', '#e05fae'];
  const parts = Array.from({ length: 150 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.2, y: H * 0.35,
    vx: (Math.random() - 0.5) * W * 0.03, vy: -Math.random() * H * 0.028 - H * 0.006,
    s: (5 + Math.random() * 6) * dpr, c: pick(colors), r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
  }));
  let frame = 0;
  (function step() {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.vy += H * 0.0007; p.vx *= 0.99; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
    }
    if (++frame < 160) requestAnimationFrame(step); else cv.remove();
  })();
}

function toast(html, cls = '') {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  el.innerHTML = html;
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), 2400);
  setTimeout(() => el.remove(), 2900);
}

function floatXP(n) {
  const el = document.createElement('div');
  el.className = 'xpfloat';
  el.textContent = `+${n} XP`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1100);
}

// =====================================================================
// Lern-Session
// =====================================================================

let view = 'home';
let S = null;

const MODE_LABEL = { mc: '🔘 Multiple Choice', type: '⌨️ Eintippen', cloze: '🧩 Lückentext', flip: '🃏 Karteikarte', match: '🔗 Zuordnen' };

function buildLearnQueue(deck, opts) {
  const now = Date.now(), reviews = [], learning = [], fresh = [];
  for (const c of deck._cards) {
    if (opts.chapter && c.ch !== opts.chapter) continue;
    const s = P.cards[c.key];
    if (!s || s.state === 'new') fresh.push(c);
    else if (s.state === 'learning') learning.push(c);
    else if (s.due <= now) reviews.push(c);
  }
  const st = deckStatus(deck, opts.chapter);
  const nNew = opts.extraNew ?? (opts.chapter ? Math.min(fresh.length, 10) : st.newAvail);
  const news = fresh.slice(0, nNew);
  const quiz = [...learning, ...shuffle(reviews.slice(0, 200))].map(c => ({ type: 'quiz', key: c.key }));
  // Neue Karten zwischen die Wiederholungen streuen.
  // Fragen und Prüfungsfragen werden erst vorgestellt; Teilübungen (Inhalt kennt man aus der Prüfungsfrage) starten direkt.
  const newItem = c => ({ type: c.type === 'exam' || (c.type === 'qa' && !c.parent) ? 'intro' : 'quiz', key: c.key });
  const out = [];
  let ni = 0;
  quiz.forEach((q, i) => {
    out.push(q);
    if (i % 2 === 1 && ni < news.length) out.push(newItem(news[ni++]));
  });
  while (ni < news.length) out.push(newItem(news[ni++]));
  return out;
}

function startSession(kind, opts = {}) {
  const deck = activeDeck();
  if (!deck) return;
  let queue;
  if (kind === 'mistakes') {
    queue = shuffle(deck._cards.filter(c => P.cards[c.key]?.miss)).slice(0, 30).map(c => ({ type: 'quiz', key: c.key }));
  } else {
    queue = buildLearnQueue(deck, opts);
    if (!queue.length && opts.chapter) {
      // Nichts fällig: Kapitel frei üben (ohne den Lernplan zu verändern).
      kind = 'drill';
      queue = shuffle(deck._cards.filter(c => c.ch === opts.chapter && P.cards[c.key] && P.cards[c.key].state !== 'new'))
        .slice(0, 20).map(c => ({ type: 'quiz', key: c.key }));
    }
  }
  if (!queue.length) { toast('Gerade gibt es hier nichts zu tun – super! 🎉'); return; }
  const st = computeStats();
  S = {
    kind, opts, deck, queue, cur: null, done: 0, combo: 0,
    stats: { answers: 0, correct: 0, bestCombo: 0, newCards: 0 },
    startXP: st.xp, startLevel: st.lv.level, lastLevel: st.lv.level,
    questsDone: questsDoneToday(st), achBefore: unlockedIds(st),
  };
  view = 'session';
  next();
}

const cardOf = key => S.deck._byKey[key];
const itemSize = it => (it.type === 'match' ? it.keys.length : 1);
const isPractice = s => (S.kind === 'mistakes' || S.kind === 'drill') && !isDueState(s);

function next() {
  if (!S) return;
  commitPending();
  if (S.cur) S.done += itemSize(S.cur);
  S.cur = S.queue.shift() || null;
  if (!S.cur) return finishSession(true);
  maybeMatch();
  if (S.cur.type === 'quiz') prepQuiz(S.cur);
  render();
  window.scrollTo(0, 0);
}

function requeue(key, minGap = 2, maxGap = 4) {
  if (S.queue.some(it => it.key === key || it.keys?.includes(key))) return;
  S.queue.splice(Math.min(S.queue.length, rand(minGap, maxGap)), 0, { type: 'quiz', key });
}

function pickMode(c, s) {
  if (c.type !== 'qa') return c.type;
  const allowed = m => !c.modes || c.modes.includes(m);
  const iv = s && s.state === 'review' ? s.interval : 0;
  const w = [];
  if (c.cloze && allowed('cloze')) w.push(['cloze', iv >= 2 ? 3 : 1.5]);
  if (c._mcOk && allowed('mc')) w.push(['mc', iv < 3 ? 4 : 1.5]);
  if (c.a.length <= 40 && allowed('type')) w.push(['type', iv >= 3 ? 4 : iv >= 1 ? 2 : 1]);
  if (allowed('flip')) w.push(['flip', c.a.length > 40 ? 4 : 1]);
  return w.length ? weightedPick(w) : 'flip';
}

function prepQuiz(it) {
  const c = cardOf(it.key);
  const s = P.cards[it.key];
  it.mode ||= pickMode(c, s);
  if (it.mode === 'mc' && !it.options) prepMC(it, c);
  else if (it.mode === 'exam' && it.write == null) {
    // Textfeld: im Klausurmodus immer, sonst sobald die Frage „sicher“ sitzt.
    it.write = !!setting('examWrite') || (s?.state === 'review' && s.interval >= 3);
    it.checked = [];
  } else if (it.mode === 'order' && !it.pool) {
    it.seq = [];
    it.pool = shuffledIdx(c.items.length);
  } else if (it.mode === 'pairs' && !it.qs) {
    Object.assign(it, { qs: shuffledIdx(c.pairs.length), as: shuffledIdx(c.pairs.length), matched: [], errors: 0, sel: null });
  } else if (it.mode === 'grid' && !it.sel) {
    it.sel = c.rows.map(() => []);
    it.rowOrder = c.shuffle ? shuffledIdx(c.rows.length) : c.rows.map((_, i) => i);
  }
}

// Gemischte Indexliste, aber nie zufällig schon in der richtigen Reihenfolge.
function shuffledIdx(n) {
  const a = shuffle([...Array(n).keys()]);
  if (n > 1 && a.every((v, i) => v === i)) [a[0], a[1]] = [a[1], a[0]];
  return a;
}

// Anteil richtig → Bewertung (2 = gut ab `pass`, 1 = schwer, 0 = nochmal)
const shareRating = (share, pass = 0.9) => (share >= pass ? 2 : share >= pass * 0.66 ? 1 : 0);

function prepMC(it, c) {
  it.correctOpt = c.a;
  it.options = shuffle([c.a, ...distractors(c, S.deck, 3)]);
}

const matchable = c => c.type === 'qa' && c.q.length <= 90 && c.a.length <= 45 && (!c.modes || c.modes.includes('match'));

// Ab und zu werden vier anstehende Karten zu einer Zuordnen-Runde gebündelt.
function maybeMatch() {
  const it = S.cur;
  if (it.type !== 'quiz' || Math.random() > 0.22) return;
  const c0 = cardOf(it.key);
  if (!matchable(c0)) return;
  const picked = [it], answers = new Set([norm(c0.a)]);
  for (const q of S.queue) {
    if (picked.length >= 4) break;
    if (q.type !== 'quiz' || picked.some(p => p.key === q.key)) continue;
    const c = cardOf(q.key);
    if (!matchable(c) || answers.has(norm(c.a))) continue;
    picked.push(q); answers.add(norm(c.a));
  }
  if (picked.length < 4) return;
  S.queue = S.queue.filter(q => !picked.includes(q));
  const keys = picked.map(p => p.key);
  S.cur = { type: 'match', keys, qs: shuffle([...keys]), as: shuffle([...keys]), matched: [], failed: [], sel: null, xp: 0 };
}

// Verbucht eine Antwort: Lernplan, Combo, XP, Tageslog.
function commitAnswer(key, rating) {
  const correct = rating >= 1;
  S.stats.answers++; bump('answers');
  if (correct) { S.combo++; S.stats.correct++; bump('correct'); } else { S.combo = 0; bump('wrong'); }
  S.stats.bestCombo = Math.max(S.stats.bestCombo, S.combo);
  bumpMax('bestCombo', S.combo);
  const h = new Date().getHours();
  if (h >= 23 || h < 4) bumpMax('night', 1);
  else if (h < 7) bumpMax('early', 1);

  const prev = P.cards[key];
  if (!prev || prev.state === 'new') { bump('new'); S.stats.newCards++; } // Teilübungen ohne Vorstellung
  if (isPractice(prev)) {
    const s = { ...prev, last: Date.now() };
    if (correct) { if (s.miss) bump('fixed'); s.miss = false; } else s.miss = true;
    P.cards[key] = s;
    if (!correct) requeue(key);
  } else {
    const s = applyRating(key, rating, S.deck.id);
    if (s.state === 'learning' || (S.kind !== 'learn' && !correct)) requeue(key);
  }
  const xp = xpFor(correct, S.combo) + (correct && cardOf(key).type !== 'qa' ? 10 : 0); // Bonus für große Aufgaben
  bump('xp', xp);
  floatXP(xp);
  save();
  afterProgress();
  return xp;
}

function commitPending() {
  const it = S?.cur;
  if (it && it.pending != null && !it.committed) { it.committed = true; commitAnswer(it.key, it.pending); }
}

function afterProgress() {
  const st = computeStats();
  if (st.lv.level > S.lastLevel) {
    S.lastLevel = st.lv.level;
    SFX.level(); confetti();
    toast(`⭐ Level ${st.lv.level}! <small>${esc(levelTitle(st.lv.level))}</small>`, 'gold');
  }
  const qd = questsDoneToday(st);
  if (qd > S.questsDone) {
    S.questsDone = qd;
    toast(`✅ Tagesquest geschafft! <small>+${QUEST_XP} XP${qd === 3 ? ` und +${QUEST_ALL_XP} Bonus` : ''}</small>`, 'good');
  }
}

function autoNext(ms) {
  const cur = S.cur;
  setTimeout(() => { if (S && S.cur === cur && view === 'session') next(); }, ms);
}

// ---------- Antworten ----------

function introOk() {
  const it = S.cur;
  if (it.type !== 'intro' || it.done) return;
  it.done = true;
  const now = Date.now();
  P.cards[it.key] = { state: 'learning', ease: 2.5, interval: 0, reps: 0, lapses: 0, intro: now, last: now, due: now };
  bump('new'); bump('xp', 5); floatXP(5);
  S.stats.newCards++;
  save();
  requeue(it.key, 1, 3);
  afterProgress();
  next();
}

function answerMC(i) {
  const it = S.cur;
  if (it.mode !== 'mc' || it.result) return;
  const ok = it.options[i] === it.correctOpt;
  ok ? SFX.good() : SFX.bad();
  it.result = { ok, chosen: i, at: Date.now() };
  it.result.xp = commitAnswer(it.key, ok ? 2 : 0);
  render();
  if (ok && !cardOf(it.key).hint) autoNext(800);
}

function answerTyped(values) {
  const it = S.cur;
  if (!it || it.result || (it.mode !== 'type' && it.mode !== 'cloze')) return;
  const c = cardOf(it.key);
  let g;
  if (it.mode === 'cloze') {
    const gaps = clozeParts(c.cloze).filter(p => p.gap);
    const grades = gaps.map((p, i) => grade(values[i] || '', p.gap));
    g = grades.includes('wrong') ? 'wrong' : grades.includes('near') ? 'near' : 'right';
    it.result = { grade: g, grades, given: gaps.map((_, i) => values[i] || ''), at: Date.now() };
  } else {
    g = grade(values[0] || '', [c.a, ...(c.alt || [])]);
    it.result = { grade: g, given: values[0] || '', at: Date.now() };
  }
  if (g === 'right') {
    SFX.good();
    it.result.xp = commitAnswer(it.key, 2);
    render();
    if (!c.hint) autoNext(900);
  } else {
    g === 'near' ? SFX.good() : SFX.bad();
    it.pending = g === 'near' ? 1 : 0; // erst bei „Weiter“ verbuchen, damit „Ich hatte recht“ möglich ist
    render();
  }
}

function override() {
  const it = S.cur;
  if (!it?.result || it.committed || it.pending == null) return;
  it.pending = 2;
  SFX.good();
  next();
}

function reveal() {
  const it = S.cur;
  if ((it.mode !== 'flip' && it.mode !== 'exam') || it.revealed) return;
  if (it.mode === 'exam') {
    const ta = app.querySelector('[data-write]');
    if (ta) it.text = ta.value;
  }
  it.revealed = true;
  render();
}

// ---------- Prüfungsfrage: Checkliste ----------

function examToggle(i, el) {
  const it = S.cur;
  if (it.mode !== 'exam' || !it.revealed || it.result) return;
  const k = it.checked.indexOf(i);
  if (k >= 0) it.checked.splice(k, 1); else it.checked.push(i);
  // direkt im DOM umschalten, damit die lange Lösung nicht neu aufgebaut wird
  el.classList.toggle('on', k < 0);
  el.setAttribute('aria-pressed', String(k < 0));
  const cnt = document.getElementById('check-count');
  if (cnt) cnt.textContent = `${it.checked.length}/${cardOf(it.key).checklist.length}`;
}

function examDone() {
  const it = S.cur;
  if (it.mode !== 'exam' || !it.revealed || it.result) return;
  const c = cardOf(it.key), n = c.checklist.length;
  const r = shareRating(it.checked.length / n, c.pass);
  it.result = { ok: r >= 1 };
  r >= 1 ? SFX.good() : SFX.bad();
  toast(`${it.checked.length}/${n} Punkte gewusst – ${['das üben wir nochmal', 'fast geschafft', 'stark!'][r]}`, ['bad', '', 'good'][r]);
  commitAnswer(it.key, r);
  next();
}

// ---------- Teilübung: Reihenfolge ----------

function ordAdd(i) {
  const it = S.cur;
  if (it.mode !== 'order' || it.result || it.seq.includes(i)) return;
  it.seq.push(i);
  render();
}

function ordRemove(pos) {
  const it = S.cur;
  if (it.mode !== 'order' || it.result) return;
  it.seq.splice(pos, 1);
  render();
}

function ordCheck() {
  const it = S.cur, c = cardOf(it.key);
  if (it.mode !== 'order' || it.result || it.seq.length !== c.items.length) return;
  const wrong = it.seq.filter((v, pos) => v !== pos).length;
  const r = wrong === 0 ? 2 : wrong <= Math.max(2, Math.floor(c.items.length / 3)) ? 1 : 0;
  it.result = { ok: r === 2, grade: ['wrong', 'near', 'right'][r], at: Date.now() };
  r === 2 ? SFX.good() : SFX.bad();
  it.result.xp = commitAnswer(it.key, r);
  render();
}

// ---------- Teilübung: Zuordnen ----------

function pairTap(side, idx) {
  const it = S.cur, c = cardOf(it.key);
  if (it.mode !== 'pairs' || it.result || it.matched.includes(idx)) return;
  if (!it.sel || it.sel.side === side) { it.sel = { side, idx }; render(); return; }
  const other = it.sel;
  it.sel = null;
  if (other.idx === idx) {
    it.matched.push(idx);
    SFX.good();
  } else {
    it.errors++;
    it.flash = { [side]: idx, [other.side]: other.idx };
    SFX.bad();
    setTimeout(() => { if (S?.cur === it) { it.flash = null; render(); } }, 500);
  }
  if (it.matched.length === c.pairs.length) {
    const r = it.errors === 0 ? 2 : it.errors <= 2 ? 1 : 0;
    it.result = { ok: r === 2, grade: ['wrong', 'near', 'right'][r], at: Date.now() };
    it.result.xp = commitAnswer(it.key, r);
  }
  render();
}

// ---------- Teilübung: Einordnen / Ankreuzen ----------

function gridTap(r, i) {
  const it = S.cur, c = cardOf(it.key);
  if (it.mode !== 'grid' || it.result) return;
  const sel = it.sel[r];
  if (c.multi) { const k = sel.indexOf(i); if (k >= 0) sel.splice(k, 1); else sel.push(i); }
  else it.sel[r] = sel[0] === i ? [] : [i];
  render();
}

function gridCheck() {
  const it = S.cur, c = cardOf(it.key);
  if (it.mode !== 'grid' || it.result || it.sel.some(s => !s.length)) return;
  // Zeile richtig, wenn nur richtige Felder gewählt sind („bzw.“-Alternativen zählen alle als richtig)
  const okRows = c.rows.map((row, r) => it.sel[r].every(i => [].concat(row.correct).includes(i)));
  const share = okRows.filter(Boolean).length / c.rows.length;
  const r = shareRating(share, 1);
  it.result = { ok: r === 2, okRows, grade: ['wrong', 'near', 'right'][r], at: Date.now() };
  r === 2 ? SFX.good() : SFX.bad();
  it.result.xp = commitAnswer(it.key, r);
  render();
}

function zoom(src) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = `<img src="${esc(src)}" alt=""><span class="lightbox-hint">Tippen zum Schließen</span>`;
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
}

function rate(r) {
  const it = S.cur;
  if (it.mode !== 'flip' || !it.revealed || it.result) return;
  it.result = { ok: r >= 1 };
  r >= 1 ? SFX.good() : SFX.bad();
  commitAnswer(it.key, r);
  next();
}

function matchTap(side, key) {
  const it = S.cur;
  if (it.type !== 'match' || it.matched.includes(key)) return;
  if (!it.sel || it.sel.side === side) { it.sel = { side, key }; render(); return; }
  const other = it.sel;
  it.sel = null;
  if (other.key === key) {
    it.matched.push(key);
    SFX.good();
    it.xp += commitAnswer(key, it.failed.includes(key) ? 0 : 2);
  } else {
    const qk = side === 'q' ? key : other.key, ak = side === 'a' ? key : other.key;
    if (!it.failed.includes(qk)) it.failed.push(qk);
    it.flash = { q: qk, a: ak };
    SFX.bad();
    setTimeout(() => { if (S?.cur === it) { it.flash = null; render(); } }, 500);
  }
  render();
  if (it.matched.length === it.keys.length) autoNext(900);
}

function quitSession() {
  if (!S) return goHome();
  commitPending();
  if (S.stats.answers > 0 || S.stats.newCards > 0) finishSession(false);
  else goHome();
}

function finishSession(natural) {
  commitPending();
  const st = computeStats();
  S.summary = { natural, st, xp: st.xp - S.startXP, newAch: ACH.filter(a => a.ok(st) && !S.achBefore.includes(a.id)) };
  view = 'summary';
  render();
  if (natural && S.stats.answers > 0) { confetti(); SFX.level(); }
  if (sync.dirty) scheduleSync(500); // Rundenende: jetzt hochladen
}

function goHome() {
  if (S?.timer) clearInterval(S.timer);
  S = null;
  view = 'home';
  render();
  window.scrollTo(0, 0);
  if (sync.dirty) scheduleSync(500);
}

// ---------- Speed-Runde ----------

const SPEED_MS = 60000;

function startSpeed() {
  const deck = activeDeck();
  if (!deck) return;
  const all = deck._cards.filter(c => c._mcOk && (!c.modes || c.modes.includes('mc')));
  const seen = all.filter(c => P.cards[c.key] && P.cards[c.key].state !== 'new');
  const pool = seen.length >= 6 ? seen : all;
  if (pool.length < 4) { toast('Für die Speed-Runde braucht das Modul mindestens 4 passende Karten.'); return; }
  const st = computeStats();
  S = { kind: 'speed', deck, pool, end: Date.now() + SPEED_MS, score: 0, wrong: 0, xp: 0, recent: [], cur: null, over: false, startBest: st.speedBest, achBefore: unlockedIds(st), questsDone: questsDoneToday(st) };
  view = 'speed';
  speedNext();
  S.timer = setInterval(speedTick, 100);
}

function speedNext() {
  let c;
  for (let i = 0; i < 20; i++) { c = pick(S.pool); if (!S.recent.includes(c.key)) break; }
  S.recent.push(c.key);
  if (S.recent.length > Math.min(5, S.pool.length - 1)) S.recent.shift();
  S.cur = { type: 'quiz', key: c.key, mode: 'mc' };
  prepMC(S.cur, c);
  render();
}

function speedTick() {
  const left = S.end - Date.now();
  if (left <= 0) return endSpeed(false);
  const bar = document.getElementById('speedbar'), txt = document.getElementById('speedtime');
  if (bar) { bar.style.width = `${(left / SPEED_MS) * 100}%`; bar.classList.toggle('low', left < 10000); }
  if (txt) txt.textContent = `${Math.ceil(left / 1000)} s`;
}

function speedAnswer(i) {
  const it = S.cur;
  if (S.over || it.result) return;
  const ok = it.options[i] === it.correctOpt;
  it.result = { ok, chosen: i };
  if (ok) { S.score++; S.xp += 3; bump('xp', 3); SFX.good(); }
  else { S.wrong++; S.end -= 3000; SFX.bad(); toast('−3 Sekunden', 'bad'); }
  bumpMax('speedBest', S.score);
  save();
  render();
  setTimeout(() => { if (S && !S.over && S.cur === it) speedNext(); }, ok ? 250 : 900);
}

function endSpeed(quit) {
  clearInterval(S.timer);
  S.over = true;
  if (quit && S.score === 0) return goHome();
  save();
  const st = computeStats();
  S.newAch = ACH.filter(a => a.ok(st) && !S.achBefore.includes(a.id));
  S.st = st;
  view = 'speedEnd';
  render();
  if (S.score > S.startBest) { confetti(); SFX.level(); }
  if (sync.dirty) scheduleSync(500);
}

// =====================================================================
// Ansichten
// =====================================================================

function render() {
  if (view !== 'home') { mapSel = null; modSheet = false; }
  document.body.classList.toggle('noscroll', !!mapSel || modSheet);
  ({ home: renderHome, session: renderSession, summary: renderSummary, settings: renderSettings, speed: renderSpeed, speedEnd: renderSpeedEnd, setup: renderSetup })[view]();
  hydrateImages();
}

// Zahnrad mit Statuspunkt für die Synchronisierung
const gearHTML = () => `<button class="icon-btn has-dot" data-act="settings" aria-label="Einstellungen">⚙️${syncMode() !== 'off' ? `<i id="sync-dot" class="sync-dot s-${syncDotState()}"></i>` : ''}</button>`;

const bar = (pct, cls = '') => `<div class="bar ${cls}"><i style="width:${clamp(pct, 0, 100)}%"></i></div>`;

function levelBlock(lv, up = false) {
  return `<div class="level-row ${up ? 'up' : ''}">
    <div class="level-badge">${lv.level}</div>
    <div class="grow">
      <div class="level-title">${esc(levelTitle(lv.level))}${up ? ' <span class="pill gold">Level up!</span>' : ''}</div>
      ${bar((lv.into / lv.need) * 100, 'xp')}
      <div class="muted small">${lv.into} / ${lv.need} XP bis Level ${lv.level + 1}</div>
    </div>
  </div>`;
}

function questsHTML(st) {
  const a = st.today, qs = questsFor(dayKey());
  const n = qs.filter(q => questDone(q, a)).length;
  return `<section class="card">
    <div class="sec-head"><h2>Tagesquests</h2><span class="muted small">${n}/3 · je +${QUEST_XP} XP${n === 3 ? ' · Bonus kassiert 🎁' : `, alle drei +${QUEST_ALL_XP} Bonus`}</span></div>
    ${qs.map(q => {
      const v = Math.min(q.goal, q.f(a) || 0), ok = v >= q.goal;
      return `<div class="quest ${ok ? 'ok' : ''}"><span class="q-check">${ok ? '✓' : ''}</span>
        <div class="grow"><div>${esc(q.t)}</div>${bar((v / q.goal) * 100, 'thin')}</div>
        <span class="muted small num">${v}/${q.goal}</span></div>`;
    }).join('')}
  </section>`;
}

function achHTML(list, title = 'Erfolge') {
  const n = list.filter(a => a.done).length;
  return `<section class="card">
    <div class="sec-head"><h2>${title}</h2>${title === 'Erfolge' ? `<span class="muted small">${n}/${list.length}</span>` : ''}</div>
    <div class="ach-grid">${list.map(a => `<div class="ach ${a.done ? 'ok' : ''}">
      <div class="ach-icon">${a.done ? a.icon : '🔒'}</div>
      <div class="ach-name">${esc(a.t)}</div><div class="ach-desc">${esc(a.d)}</div></div>`).join('')}</div>
  </section>`;
}

function segBar(cs) {
  const w = k => (cs.n ? (cs.seg[k] / cs.n) * 100 : 0);
  // Reihenfolge: gemeistert, sicher, lernend – der Rest (neu) bleibt als grauer Hintergrund.
  return `<div class="seg"><i class="s-master" style="width:${w('master')}%"></i><i class="s-good" style="width:${w('good')}%"></i><i class="s-learn" style="width:${w('learn')}%"></i></div>`;
}

function renderHome() {
  if (!DECKS.length) {
    app.innerHTML = `<header class="top"><div class="brand">🎓 Lernquest</div><div class="top-right">${syncBadge()}${gearHTML()}</div></header>
      <section class="card center"><h1>Noch kein Lernmodul</h1>
      <p>${SOURCE === 'local'
        ? 'Lege eine Moduldatei (.json) in den Ordner <code>decks/</code> des Daten-Ordners und lade die Seite neu.'
        : `Lege Moduldateien (.json) im privaten Daten-Repository unter <code>${DATA_DIR}/decks/</code> ab und tippe in den Einstellungen auf „Jetzt abgleichen“.`}</p>
      ${DECK_WARN.map(w => `<p class="warn">${esc(w)}</p>`).join('')}</section>`;
    return;
  }
  const st = computeStats(), deck = activeDeck(), ds = deckStatus(deck);
  const reviewN = ds.due + ds.learning, todo = reviewN + ds.newAvail;
  const mistakes = deck._cards.filter(c => P.cards[c.key]?.miss).length;
  const goal = setting('dailyGoal'), todayAns = st.today.answers || 0;
  const examDays = daysUntil(examDate(deck));
  const learnedInDeck = deck._cards.filter(c => P.cards[c.key]?.state === 'review').length;

  const hero = todo > 0
    ? `<h1>Bereit für deine Runde?</h1>
       <div class="chips">
         ${reviewN ? `<span class="chip">🔁 ${reviewN} ${reviewN === 1 ? 'Wiederholung' : 'Wiederholungen'}</span>` : ''}
         ${ds.newAvail ? `<span class="chip new">✨ ${ds.newAvail} neue</span>` : ''}
       </div>
       <button class="btn primary big" data-act="start">Lernen starten</button>`
    : `<h1>Alles erledigt für heute 🎉</h1>
       <p class="muted">Deine Wiederholungen sind durch. ${ds.fresh ? 'Lust auf mehr?' : 'Du hast alle Karten dieses Moduls schon kennengelernt.'}</p>
       <div class="row">
         ${ds.fresh ? `<button class="btn primary" data-act="extra">+10 neue Karten</button>` : ''}
         <button class="btn" data-act="speed">⚡ Speed-Runde</button>
       </div>`;

  app.innerHTML = `
  <header class="top">
    <div class="brand">🎓 Lernquest</div>
    <div class="top-right">
      <span class="pill streak ${st.todayDone ? 'lit' : ''}" title="Streak: Tage in Folge mit erreichtem Tagesziel">🔥 ${st.streak}</span>
      ${syncBadge()}
      ${gearHTML()}
    </div>
  </header>

  ${DECK_WARN.length ? `<section class="card warn-box">${DECK_WARN.map(w => `<div>⚠ ${esc(w)}</div>`).join('')}</section>` : ''}
  ${DATA_ERROR && SOURCE !== 'github' ? `<section class="card warn-box">⚠ ${esc(DATA_ERROR)} – du siehst den zuletzt geladenen Stand.</section>` : ''}

  <button class="module-btn" data-act="modules" aria-label="Modul wechseln">
    <span class="module-ic">📚</span>
    <span class="grow"><span class="muted small">Modul${DECKS.length > 1 ? ` · ${DECKS.length} verfügbar` : ''}</span><b>${esc(deck.title)}</b></span>
    <span class="module-switch">Wechseln ▾</span>
  </button>

  <section class="card">${levelBlock(st.lv)}</section>

  <section class="card hero">
    <div class="deck-line">
      <span class="muted small">${deck.chapters.length} Kapitel · ${deckPct(deck)} % beherrscht</span>
      <span class="muted small">${learnedInDeck}/${deck._cards.length} gelernt</span>
    </div>
    ${hero}
    <div class="goal">
      <div class="goal-label"><span>Tagesziel</span><span class="num">${Math.min(todayAns, goal)}/${goal}${st.todayDone ? ' ✓' : ''}</span></div>
      ${bar((todayAns / goal) * 100, st.todayDone ? 'done' : '')}
    </div>
    ${examDays != null && examDays >= 0 ? `<div class="exam-line">📅 ${examDays === 0 ? 'Heute ist Prüfung – viel Erfolg!' : `Noch ${days(examDays)} bis zur Prüfung`}</div>` : ''}
  </section>

  <div class="tiles">
    <button class="tile" data-act="mistakes" ${mistakes ? '' : 'disabled'}>
      <span class="tile-icon">🩹</span><span class="tile-title">Fehler-Training</span>
      <span class="muted small">${mistakes ? `${mistakes} ${mistakes === 1 ? 'Karte' : 'Karten'} zum Ausbessern` : 'Keine offenen Fehler'}</span>
    </button>
    <button class="tile" data-act="speed">
      <span class="tile-icon">⚡</span><span class="tile-title">Speed-Runde</span>
      <span class="muted small">60 Sekunden · Rekord ${st.speedBest}</span>
    </button>
  </div>

  ${questsHTML(st)}

  ${mapHTML(deck, examDays)}

  ${achHTML(ACH.map(a => ({ ...a, done: !!a.ok(st) })))}

  <footer class="muted small center foot">${st.xp} XP gesamt · ${st.answers} Antworten · beste Streak ${st.bestStreak}</footer>

  ${mapSel ? sheetHTML(deck, mapSel) : ''}
  ${modSheet ? modulesSheetHTML(deck) : ''}`;
}

// ---------- Modul-Auswahl ----------

let modSheet = false;

function deckPct(deck) {
  const stats = deck.chapters.map(ch => chapterStats(deck, ch.id));
  const total = stats.reduce((a, s) => a + s.n, 0);
  return total ? Math.round(stats.reduce((a, s) => a + s.pct * s.n, 0) / total) : 0;
}

function modulesSheetHTML(cur) {
  return `<div class="sheet-back" data-act="modules-close"></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Modul wählen">
    <div class="sheet-head">
      <div class="grow"><div class="muted small">${DECKS.length} ${DECKS.length === 1 ? 'Modul' : 'Module'}</div><h2>Modul wählen</h2></div>
      <button class="icon-btn" data-act="modules-close" aria-label="Schließen">✕</button>
    </div>
    ${DECKS.map(d => {
      const ds = deckStatus(d), pct = deckPct(d), due = ds.due + ds.learning, active = d.id === cur.id;
      const learned = d._cards.filter(c => P.cards[c.key]?.state === 'review').length;
      const ex = examDate(d), left = daysUntil(ex);
      return `<button class="module ${active ? 'active' : ''}" data-act="pick-deck" data-deck="${esc(d.id)}" aria-pressed="${active}">
        <div class="module-title">${esc(d.title)}${active ? ' <span class="pill">aktiv</span>' : ''}${due ? ` <span class="pill due">${due} fällig</span>` : ''}</div>
        ${d.description ? `<div class="muted small">${esc(d.description)}</div>` : ''}
        ${bar(pct)}
        <div class="muted small">${d.chapters.length} Kapitel · ${learned}/${d._cards.length} Karten gelernt · ${pct} % beherrscht${ex ? ` · Prüfung ${fmtDate(ex)}${left >= 0 ? ` (in ${days(left)})` : ''}` : ''}</div>
      </button>`;
    }).join('')}
    <p class="muted small">Neue Module erscheinen hier automatisch, sobald ihre Datei im privaten Daten-Repository unter <code>${DATA_DIR}/decks/</code> liegt. XP, Level, Streak und Erfolge gelten für alle Module zusammen.</p>
  </div>`;
}

// ---------- Weltkarte ----------

let mapSel = null; // geöffnetes Kapitel in der Weltkarte
const MAP_STEP = 165, MAP_TOP = 64;
const LEVEL_NAME = { master: 'gemeistert', good: 'sicher', learn: 'lernend', fresh: 'neu' };
const LEGEND = `<span class="legend small"><i class="s-master"></i>gemeistert <i class="s-good"></i>sicher <i class="s-learn"></i>lernend <i class="s-fresh"></i>neu</span>`;

// ★ alle Karten gesehen · ★★ alle mindestens sicher · ★★★ alle gemeistert
function chapterStars(cs) {
  if (!cs.n) return 0;
  if (cs.seg.master === cs.n) return 3;
  if (cs.seg.master + cs.seg.good === cs.n) return 2;
  return cs.seg.fresh === 0 ? 1 : 0;
}
const starsHTML = n => `<span class="mstars" aria-label="${n} von 3 Sternen">${'★'.repeat(n)}<i>${'★'.repeat(3 - n)}</i></span>`;

// Aktuelle Position: erstes Kapitel mit ungesehenen Karten, sonst erstes nicht gemeistertes.
function currentChapter(deck, stats) {
  const i = stats.findIndex(s => s.seg.fresh > 0);
  return i >= 0 ? i : stats.findIndex(s => s.seg.master < s.n);
}

function ringStyle(cs) {
  const p = k => (cs.n ? (cs.seg[k] / cs.n) * 100 : 0);
  const a = p('master'), b = a + p('good'), c = b + p('learn');
  return `background:conic-gradient(var(--s-master) 0 ${a}%, var(--s-good) ${a}% ${b}%, var(--s-learn) ${b}% ${c}%, var(--track) ${c}% 100%)`;
}

function mapHTML(deck, examDays) {
  const stats = deck.chapters.map(ch => chapterStats(deck, ch.id));
  const cur = currentChapter(deck, stats);
  const nodes = deck.chapters.map((ch, i) => ({ ch, cs: stats[i], st: deckStatus(deck, ch.id), x: i % 2 ? 70 : 30, y: MAP_TOP + i * MAP_STEP }));
  const goal = { x: 50, y: MAP_TOP + nodes.length * MAP_STEP };
  const pts = [...nodes, goal];
  const height = goal.y + 135;
  const curve = (a, b) => `M${a.x} ${a.y} C${a.x} ${a.y + MAP_STEP / 2} ${b.x} ${b.y - MAP_STEP / 2} ${b.x} ${b.y}`;
  const reached = i => cur < 0 || i <= cur; // Knoten i ist erreicht

  const paths = pts.slice(1).map((b, i) => `<path d="${curve(pts[i], b)}" class="${reached(i + 1) ? 'done' : ''}"/>`).join('');

  const nodeHTML = nodes.map((n, i) => {
    const s = chapterStars(n.cs), due = n.st.due + n.st.learning;
    const cls = [i === cur ? 'current' : '', s === 3 ? 'mastered' : '', reached(i) ? '' : 'ahead'].join(' ');
    return `<button class="mnode ${cls}" style="left:${n.x}%;top:${n.y}px" data-act="node" data-ch="${esc(n.ch.id)}">
      ${i === cur ? '<span class="mhere">📍 Du bist hier</span>' : ''}
      <span class="mring" style="${ringStyle(n.cs)}"><span class="minner">${s === 3 ? '👑' : i + 1}</span>${due ? `<span class="mdue">${due}</span>` : ''}</span>
      <span class="mlabel"><b>${esc(n.ch.title)}</b>${starsHTML(s)}<span class="muted small">${n.cs.pct} % beherrscht</span></span>
    </button>`;
  }).join('');

  const overall = deckPct(deck);
  const examText = examDays == null ? 'Datum in ⚙️ eintragen'
    : examDays >= 0 ? `${fmtDate(examDate(deck))} · ${examDays === 0 ? 'heute!' : `in ${days(examDays)}`}` : 'vorbei';
  const goalHTML = `<div class="mnode mgoal ${cur < 0 ? 'current' : ''}" style="left:${goal.x}%;top:${goal.y}px">
      <span class="mring goal"><span class="minner">🎓</span></span>
      <span class="mlabel"><b>Prüfung</b><span class="muted small">${examText} · Modul ${overall} % beherrscht</span></span>
    </div>`;

  return `<section class="card">
    <div class="sec-head"><h2>Weltkarte</h2>${LEGEND}</div>
    <div class="map" style="height:${height}px">
      <svg class="map-path" viewBox="0 0 100 ${height}" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>
      ${nodeHTML}${goalHTML}
    </div>
    <p class="muted small center">Tippe ein Kapitel an · ★ alles gesehen · ★★ alles sicher · ★★★ alles gemeistert</p>
  </section>`;
}

function sheetHTML(deck, chId) {
  const i = deck.chapters.findIndex(c => c.id === chId);
  if (i < 0) return '';
  const ch = deck.chapters[i], cs = chapterStats(deck, ch.id), st = deckStatus(deck, ch.id);
  const due = st.due + st.learning, fresh = Math.min(st.fresh, 10);
  const parts = [due && `${due} fällig`, fresh && `${fresh} neue`].filter(Boolean).join(', ');
  const cards = deck._cards.filter(c => c.ch === ch.id);
  return `<div class="sheet-back" data-act="sheet-close"></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(ch.title)}">
    <div class="sheet-head">
      <div class="grow"><div class="muted small">Kapitel ${i + 1} · ${cs.pct} % beherrscht</div><h2>${esc(ch.title)}</h2></div>
      <button class="icon-btn" data-act="sheet-close" aria-label="Schließen">✕</button>
    </div>
    <div class="sheet-stars">${starsHTML(chapterStars(cs))}</div>
    ${segBar(cs)}
    <div class="seg-counts small">${['master', 'good', 'learn', 'fresh'].map(k => `<span><i class="s-${k}"></i>${cs.seg[k]} ${LEVEL_NAME[k]}</span>`).join('')}</div>
    <button class="btn primary big" data-act="chapter" data-ch="${esc(ch.id)}">${parts ? `Kapitel lernen <span class="small">(${parts})</span>` : 'Kapitel frei üben'}</button>
    <div class="clist">${cards.map(c => {
      const l = cardLevel(P.cards[c.key]);
      const pre = c.type === 'exam' ? `<b>${esc(c.label || '')}</b> ` : c.parent ? `<span class="muted">↳ ${typeLabel(c) || ''}</span> ` : '';
      return `<div class="crow ${c.parent ? 'sub' : ''}"><i class="dot s-${l}"></i><span class="grow">${pre}${inline(c.q)}</span><span class="muted small">${LEVEL_NAME[l]}</span></div>`;
    }).join('')}</div>
  </div>`;
}

function renderSession() {
  const it = S.cur;
  const total = S.done + S.queue.reduce((n, q) => n + itemSize(q), 0) + itemSize(it);
  const head = `<header class="sess-top">
    <button class="icon-btn" data-act="quit" aria-label="Runde beenden">✕</button>
    ${bar((S.done / total) * 100, 'grow')}
    <span class="combo ${S.combo >= 3 ? 'on' : ''} ${S.combo >= 10 ? 'hot' : ''}">🔥 ${S.combo}</span>
  </header>`;
  const body = it.type === 'intro' ? introHTML(it) : it.type === 'match' ? matchHTML(it) : quizHTML(it);
  app.innerHTML = `<div class="session">${head}${body}</div>`;
  const input = app.querySelector('[data-gap]');
  if (input && !it.result) input.focus({ preventScroll: true });
  app.querySelector('.fb')?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
}

const hintHTML = c => (c.hint ? `<div class="hint">💡 ${fmt(c.hint)}</div>` : '');
const parentChip = c => (c.parent ? `<span class="chip">Teilübung zu ${esc(c.parent)}</span>` : '');
const chips = (c, label, extra = '') => `<div class="chips">${extra}<span class="chip">${esc(c.chTitle)}</span>${parentChip(c)}<span class="chip mode">${label}</span></div>`;
const TYPE_LABEL = { order: '🔢 Reihenfolge', pairs: '🔗 Zuordnen' };
const typeLabel = c => (c.type === 'exam' ? `📝 Prüfungsfrage ${esc(c.label || '')}` : c.type === 'grid' ? (c.multi ? '☑️ Ankreuzen' : '🗂️ Einordnen') : TYPE_LABEL[c.type]);

function introHTML(it) {
  const c = cardOf(it.key);
  if (c.type === 'exam') {
    return `${chips(c, `✨ Neue Prüfungsfrage ${esc(c.label || '')}`)}
      <div class="qcard exam"><div class="q">${inline(c.q)}</div></div>
      <div class="card md">${md(c.answer)}</div>
      <div class="card"><h2>Darauf kommt es an</h2><ul class="keypoints">${c.checklist.map(p => `<li>${inline(p)}</li>`).join('')}</ul></div>
      <p class="muted center small">Lies dir die Lösung in Ruhe durch – gleich wird abgefragt.</p>
      <button class="btn primary big" data-act="intro-ok">Durchgelesen ⏎</button>`;
  }
  return `${chips(c, '✨ Neue Karte')}
    <div class="qcard intro">
      <div class="q">${fmt(c.q)}</div>
      <div class="divider"></div>
      <div class="a">${fmt(c.a)}</div>
      ${hintHTML(c)}
    </div>
    <p class="muted center small">Präg sie dir ein – gleich wird abgefragt.</p>
    <button class="btn primary big" data-act="intro-ok">Verstanden ⏎</button>`;
}

function examHTML(it, c) {
  const head = `${chips(c, typeLabel(c))}<div class="qcard exam"><div class="q">${inline(c.q)}</div></div>`;
  if (!it.revealed) {
    return `${head}
      ${it.write
        ? `<textarea class="write" data-write rows="8" placeholder="Schreib deine Antwort wie in der Klausur …">${esc(it.text || '')}</textarea>`
        : '<p class="muted center small">Überleg dir die vollständige Antwort. Dann aufdecken und abhaken, was du wusstest.</p>'}
      <div class="row end">
        ${it.write ? '' : '<button class="btn ghost" data-act="exam-write">✍️ Antwort aufschreiben</button>'}
        <button class="btn primary" data-act="reveal">Lösung aufdecken <span class="kbd">Leertaste</span></button>
      </div>`;
  }
  const n = c.checklist.length;
  return `${head}
    ${it.text ? `<div class="mytext"><div class="muted small">Deine Antwort</div><div>${fmt(it.text)}</div></div>` : ''}
    <div class="card md">${md(c.answer)}</div>
    <div class="card checklist">
      <div class="sec-head"><h2>Was wusstest du?</h2><span class="muted small"><span id="check-count">${it.checked.length}/${n}</span> abgehakt</span></div>
      ${c.checklist.map((p, i) => {
        const on = it.checked.includes(i);
        return `<button class="check ${on ? 'on' : ''}" data-act="check" data-i="${i}" aria-pressed="${on}"><span class="tick"></span><span>${inline(p)}</span></button>`;
      }).join('')}
      <button class="btn primary big" data-act="exam-done">Fertig – bewerten</button>
    </div>`;
}

function structFeedback(it, c, extra = '') {
  const r = it.result;
  const cls = r.grade === 'right' ? 'good' : r.grade === 'near' ? 'near' : 'bad';
  const title = { good: '✓ Alles richtig!', near: '≈ Fast – schau dir die Fehler an', bad: '✗ Das sitzt noch nicht' }[cls];
  return `<div class="fb ${cls}"><div class="fb-title">${title}${r.xp ? ` <span class="xp">+${r.xp} XP</span>` : ''}</div>
    ${extra}${hintHTML(c)}<div class="row end"><button class="btn primary" data-act="next">Weiter ⏎</button></div></div>`;
}

function orderHTML(it, c) {
  const r = it.result, n = c.items.length;
  const seq = it.seq.map((idx, pos) => `<button class="seq-item ${r ? (idx === pos ? 'right' : 'wrong') : ''}" data-act="ord-remove" data-pos="${pos}" ${r ? 'disabled' : ''}>
      <span class="key">${pos + 1}</span><span>${inline(c.items[idx])}</span></button>`).join('');
  const slots = Array.from({ length: n - it.seq.length }, (_, k) => `<div class="seq-slot"><span class="key">${it.seq.length + k + 1}</span></div>`).join('');
  const pool = it.pool.filter(i => !it.seq.includes(i))
    .map(i => `<button class="opt" data-act="ord-add" data-i="${i}"><span>${inline(c.items[i])}</span></button>`).join('');
  return `${chips(c, typeLabel(c))}
    <div class="qcard"><div class="q">${inline(c.q)}</div></div>
    <div class="seq">${seq}${r ? '' : slots}</div>
    ${r
      ? structFeedback(it, c, r.ok ? '' : `<div class="solution">Richtige Reihenfolge:</div><ol class="sol-list">${c.items.map(t => `<li>${inline(t)}</li>`).join('')}</ol>`)
      : `<p class="muted small center">Tippe die Einträge in der richtigen Reihenfolge an. Oben antippen nimmt einen wieder heraus.</p>
         <div class="options one">${pool}</div>
         <div class="row end">
           <button class="btn ghost" data-act="ord-reset" ${it.seq.length ? '' : 'disabled'}>Zurücksetzen</button>
           <button class="btn primary" data-act="ord-check" ${it.seq.length === n ? '' : 'disabled'}>Prüfen</button>
         </div>`}`;
}

function pairsHTML(it, c) {
  const btn = (side, idx) => {
    const done = it.matched.includes(idx);
    const cls = [done ? 'done' : '', it.sel?.side === side && it.sel.idx === idx ? 'sel' : '', it.flash?.[side] === idx ? 'wrong' : ''].join(' ');
    return `<button class="mbtn ${cls}" data-act="pair" data-side="${side}" data-i="${idx}" ${done ? 'disabled' : ''}>${inline(c.pairs[idx][side === 'q' ? 0 : 1])}</button>`;
  };
  return `${chips(c, typeLabel(c))}
    <div class="qcard"><div class="q">${inline(c.q)}</div></div>
    <div class="match">
      <div class="col">${it.qs.map(i => btn('q', i)).join('')}</div>
      <div class="col">${it.as.map(i => btn('a', i)).join('')}</div>
    </div>
    ${it.result
      ? structFeedback(it, c, it.errors ? `<div>${it.errors} ${it.errors === 1 ? 'Fehlversuch' : 'Fehlversuche'}</div>` : '')
      : '<p class="muted small center">Tippe links einen Eintrag und dann rechts das passende Gegenstück.</p>'}`;
}

function gridHTML(it, c) {
  const r = it.result;
  const rows = it.rowOrder.map(ri => {
    const row = c.rows[ri], opts = row.options || c.options, corr = [].concat(row.correct), sel = it.sel[ri];
    const btns = opts.map((o, i) => {
      let cls = sel.includes(i) ? 'sel' : '';
      if (r) cls = corr.includes(i) ? (sel.includes(i) ? 'right' : 'alt') : sel.includes(i) ? 'wrong' : 'dim';
      return `<button class="gopt ${cls}" data-act="grid" data-r="${ri}" data-i="${i}" ${r ? 'disabled' : ''}>${inline(o)}</button>`;
    }).join('');
    return `<div class="grid-row ${r ? (r.okRows[ri] ? 'ok' : 'bad') : ''}"><div class="grid-label">${inline(row.label)}</div><div class="grid-opts">${btns}</div></div>`;
  }).join('');
  const complete = it.sel.every(s => s.length);
  return `${chips(c, typeLabel(c))}
    <div class="qcard"><div class="q">${inline(c.q)}</div></div>
    <div class="gridx">${rows}</div>
    ${r
      ? structFeedback(it, c, `<div>${r.okRows.filter(Boolean).length}/${c.rows.length} Zeilen richtig${c.multi ? ' · grün umrandet = ebenfalls richtig' : ''}</div>`)
      : `<div class="row end"><span class="muted small grow">${c.multi ? 'Mehrere Kreuze pro Zeile möglich.' : 'Ein Feld pro Zeile.'}</span>
         <button class="btn primary" data-act="grid-check" ${complete ? '' : 'disabled'}>Prüfen</button></div>`}`;
}

function quizHTML(it) {
  const c = cardOf(it.key), r = it.result;
  if (it.mode === 'exam') return examHTML(it, c);
  if (it.mode === 'order') return orderHTML(it, c);
  if (it.mode === 'pairs') return pairsHTML(it, c);
  if (it.mode === 'grid') return gridHTML(it, c);
  const label = MODE_LABEL[it.mode] + (S.kind === 'mistakes' ? ' · Fehler-Training' : S.kind === 'drill' ? ' · Freies Üben' : '');

  if (it.mode === 'mc') {
    return `${chips(c, label)}
      <div class="qcard"><div class="q">${fmt(c.q)}</div></div>
      <div class="options">${it.options.map((o, i) => {
        const cls = !r ? '' : o === it.correctOpt ? 'right' : i === r.chosen ? 'wrong' : 'dim';
        return `<button class="opt ${cls}" data-act="mc" data-i="${i}" ${r ? 'disabled' : ''}><span class="key">${i + 1}</span><span>${fmt(o)}</span></button>`;
      }).join('')}</div>
      ${feedbackHTML(it, c)}`;
  }

  if (it.mode === 'type') {
    return `${chips(c, label)}
      <form data-form="type" autocomplete="off">
        <div class="qcard"><div class="q">${fmt(c.q)}</div></div>
        <input class="answer-input ${r ? r.grade : ''}" data-gap="0" placeholder="Deine Antwort …" value="${r ? esc(r.given) : ''}" ${r ? 'disabled' : ''}
          autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done">
        ${r ? '' : `<div class="row end"><button type="button" class="btn ghost" data-act="dunno">Weiß ich nicht</button><button class="btn primary">Prüfen ⏎</button></div>`}
      </form>
      ${feedbackHTML(it, c)}`;
  }

  if (it.mode === 'cloze') {
    let gi = 0;
    const text = clozeParts(c.cloze).map(p => {
      if (!p.gap) return fmt(p.t);
      const i = gi++;
      if (!r) {
        return `<input class="gap" data-gap="${i}" style="width:${clamp(p.gap[0].length + 2, 6, 24)}ch" aria-label="Lücke ${i + 1}"
          autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done">`;
      }
      const g = r.grades[i];
      return g === 'right'
        ? `<span class="gap-res right">${esc(r.given[i])}</span>`
        : `<span class="gap-res ${g}">${r.given[i] ? `<s>${esc(r.given[i])}</s> ` : ''}${esc(p.gap[0])}</span>`;
    }).join('');
    return `${chips(c, label)}
      <form data-form="type" autocomplete="off">
        <div class="qcard"><div class="cloze">${text}</div></div>
        ${r ? '' : `<div class="row end"><button type="button" class="btn ghost" data-act="dunno">Weiß ich nicht</button><button class="btn primary">Prüfen ⏎</button></div>`}
      </form>
      ${feedbackHTML(it, c)}`;
  }

  // Karteikarte mit Selbstbewertung
  const s = P.cards[it.key];
  const practice = isPractice(s);
  const labels = [0, 1, 2, 3].map(rt => {
    if (practice) return '';
    const n = computeNext(s || { state: 'new' }, rt, examCap(S.deck.id));
    return n.state === 'review' ? days(n.interval) : 'gleich nochmal';
  });
  const names = ['Nochmal', 'Schwer', 'Gut', 'Leicht'];
  return `${chips(c, label)}
    <div class="qcard ${it.revealed ? 'revealed' : ''}">
      <div class="q">${fmt(c.q)}</div>
      ${it.revealed ? `<div class="divider"></div><div class="a">${fmt(c.a)}</div>${hintHTML(c)}` : ''}
    </div>
    ${!it.revealed
      ? `<button class="btn primary big" data-act="reveal">Antwort zeigen <span class="kbd">Leertaste</span></button>`
      : `<p class="muted center small">Wie gut wusstest du es?</p>
         <div class="rate">${names.map((nm, i) => `<button class="btn rate-${i}" data-act="rate" data-r="${i}"><b>${nm}</b><span class="small">${labels[i] || '&nbsp;'}</span></button>`).join('')}</div>`}`;
}

function feedbackHTML(it, c) {
  const r = it.result;
  if (!r) return '';
  if (r.ok === true || r.grade === 'right') {
    return `<div class="fb good"><div class="fb-title">✓ Richtig!${r.xp ? ` <span class="xp">+${r.xp} XP</span>` : ''}</div>
      ${hintHTML(c)}<div class="row end"><button class="btn primary" data-act="next">Weiter ⏎</button></div></div>`;
  }
  const near = r.grade === 'near';
  const given = it.mode === 'type' && r.given ? `<div>Deine Antwort: <s>${esc(r.given)}</s></div>` : '';
  const solution = it.mode === 'cloze' ? '' : `<div class="solution">Richtig: <b>${fmt(c.a)}</b></div>`;
  const canOverride = (it.mode === 'type' || it.mode === 'cloze') && it.pending != null && !it.committed;
  return `<div class="fb ${near ? 'near' : 'bad'}">
    <div class="fb-title">${near ? '≈ Fast richtig – achte auf die Schreibweise' : '✗ Leider falsch'}</div>
    ${given}${solution}${hintHTML(c)}
    <div class="row end">${canOverride ? `<button class="btn ghost" data-act="override">Ich hatte recht</button>` : ''}<button class="btn primary" data-act="next">Weiter ⏎</button></div>
  </div>`;
}

function matchHTML(it) {
  const btn = (side, key) => {
    const c = cardOf(key);
    const cls = [
      it.matched.includes(key) ? 'done' : '',
      it.sel && it.sel.side === side && it.sel.key === key ? 'sel' : '',
      it.flash && it.flash[side] === key ? 'wrong' : '',
    ].join(' ');
    return `<button class="mbtn ${cls}" data-act="match" data-side="${side}" data-key="${esc(key)}" ${it.matched.includes(key) ? 'disabled' : ''}>${fmt(side === 'q' ? c.q : c.a)}</button>`;
  };
  const done = it.matched.length === it.keys.length;
  return `<div class="chips"><span class="chip mode">${MODE_LABEL.match}</span></div>
    <p class="muted center small">Tippe eine Frage und dann die passende Antwort.</p>
    <div class="match">
      <div class="col">${it.qs.map(k => btn('q', k)).join('')}</div>
      <div class="col">${it.as.map(k => btn('a', k)).join('')}</div>
    </div>
    ${done ? `<div class="fb good"><div class="fb-title">✓ Alle zugeordnet!${it.xp ? ` <span class="xp">+${it.xp} XP</span>` : ''}</div><div class="row end"><button class="btn primary" data-act="next">Weiter ⏎</button></div></div>` : ''}`;
}

function statTile(label, value) {
  return `<div class="stat"><div class="stat-v">${value}</div><div class="muted small">${label}</div></div>`;
}

function renderSummary() {
  const s = S.stats, sm = S.summary, lv = sm.st.lv;
  const rate = s.answers ? Math.round((s.correct / s.answers) * 100) : 0;
  const ds = deckStatus(S.deck);
  const offerMore = S.kind === 'learn' && !S.opts.chapter && ds.fresh > 0 && ds.due + ds.learning === 0;
  app.innerHTML = `<div class="summary">
    <section class="card center">
      <div class="big-emoji">${sm.natural ? (rate >= 80 ? '🏆' : '🎉') : '👋'}</div>
      <h1>${sm.natural ? 'Runde geschafft!' : 'Pause gemacht'}</h1>
      <div class="stat-grid">
        ${statTile('Antworten', s.answers)}${statTile('Richtig', `${rate} %`)}${statTile('Beste Combo', `🔥 ${s.bestCombo}`)}${statTile('XP', `+${sm.xp}`)}
      </div>
      ${s.newCards ? `<p class="muted">✨ ${s.newCards} neue ${s.newCards === 1 ? 'Karte' : 'Karten'} kennengelernt</p>` : ''}
      ${levelBlock(lv, lv.level > S.startLevel)}
    </section>
    ${sm.newAch.length ? achHTML(sm.newAch.map(a => ({ ...a, done: true })), 'Neue Erfolge 🎖️') : ''}
    ${questsHTML(sm.st)}
    <div class="row center">
      ${offerMore ? `<button class="btn" data-act="extra">+10 neue Karten</button>` : ''}
      <button class="btn primary" data-act="home">Zur Übersicht</button>
    </div>
  </div>`;
}

function renderSpeed() {
  const it = S.cur, c = cardOf(it.key), r = it.result;
  const left = Math.max(0, S.end - Date.now());
  app.innerHTML = `<div class="session speed">
    <header class="sess-top">
      <button class="icon-btn" data-act="speed-quit" aria-label="Beenden">✕</button>
      <div class="bar grow timer"><i id="speedbar" class="${left < 10000 ? 'low' : ''}" style="width:${(left / SPEED_MS) * 100}%"></i></div>
      <span class="pill num" id="speedtime">${Math.ceil(left / 1000)} s</span>
      <span class="pill gold num">⚡ ${S.score}</span>
    </header>
    <div class="chips"><span class="chip mode">⚡ Speed-Runde</span><span class="chip">Rekord ${Math.max(S.startBest, S.score)}</span></div>
    <div class="qcard"><div class="q">${fmt(c.q)}</div></div>
    <div class="options">${it.options.map((o, i) => {
      const cls = !r ? '' : o === it.correctOpt ? 'right' : i === r.chosen ? 'wrong' : 'dim';
      return `<button class="opt ${cls}" data-act="speed-mc" data-i="${i}" ${r ? 'disabled' : ''}><span class="key">${i + 1}</span><span>${fmt(o)}</span></button>`;
    }).join('')}</div>
  </div>`;
}

function renderSpeedEnd() {
  const record = S.score > S.startBest;
  app.innerHTML = `<div class="summary">
    <section class="card center">
      <div class="big-emoji">${record ? '🚀' : '⏱️'}</div>
      <h1>${record ? 'Neuer Rekord!' : 'Zeit um!'}</h1>
      <div class="stat-grid">
        ${statTile('Punkte', S.score)}${statTile('Fehler', S.wrong)}${statTile('Rekord', Math.max(S.score, S.startBest))}${statTile('XP', `+${S.xp}`)}
      </div>
      ${levelBlock(S.st.lv)}
    </section>
    ${S.newAch.length ? achHTML(S.newAch.map(a => ({ ...a, done: true })), 'Neue Erfolge 🎖️') : ''}
    <div class="row center">
      <button class="btn" data-act="speed">Nochmal</button>
      <button class="btn primary" data-act="home">Zur Übersicht</button>
    </div>
  </div>`;
}

function renderSettings() {
  const deck = activeDeck();
  const urls = INFO.urls || [];
  app.innerHTML = `
  <header class="top">
    <button class="btn ghost" data-act="home">← Zurück</button>
    <div class="brand">Einstellungen</div><span></span>
  </header>
  <section class="card form">
    <h2>Lernen</h2>
    <label class="field"><span>Neue Karten pro Tag</span>
      <input type="number" inputmode="numeric" min="1" max="200" data-set="newPerDay" value="${setting('newPerDay')}"></label>
    <label class="field"><span>Tagesziel <small class="muted">(Antworten pro Tag für die Streak)</small></span>
      <input type="number" inputmode="numeric" min="1" max="500" data-set="dailyGoal" value="${setting('dailyGoal')}"></label>
    <label class="field check"><span>Soundeffekte</span><input type="checkbox" data-set="sound" ${setting('sound') ? 'checked' : ''}></label>
    <label class="field check"><span>Klausurmodus <small class="muted">– Prüfungsfragen immer mit Textfeld beantworten (sonst erst, wenn eine Frage „sicher“ sitzt)</small></span>
      <input type="checkbox" data-set="examWrite" ${setting('examWrite') ? 'checked' : ''}></label>
    <label class="field"><span>Standard-Prüfungsdatum <small class="muted">– gilt für alle Module ohne eigenes Datum</small></span>
      <input type="date" data-set="examDefault" value="${esc(setting('examDefault') || '')}"></label>
  </section>
  ${deck ? `<section class="card form">
    <h2>Modul: ${esc(deck.title)}</h2>
    <label class="field"><span>Prüfungsdatum <small class="muted">– Wiederholungen werden so geplant, dass vor der Prüfung alles nochmal drankommt.${examStd(deck) ? ` Standard: ${fmtDate(examStd(deck))}, Feld leeren setzt darauf zurück.` : ''}</small></span>
      <input type="date" data-set="exam" data-deck="${esc(deck.id)}" value="${esc(examDate(deck) || '')}"></label>
    <button class="btn danger" data-act="reset-deck">Fortschritt dieses Moduls zurücksetzen</button>
  </section>` : ''}
  ${syncSectionHTML()}
  ${SOURCE === 'local' ? `<section class="card form">
    <h2>Auf dem iPad öffnen (lokaler Server)</h2>
    ${urls.length
      ? `<p>iPad im selben WLAN, dann in Safari diese Adresse öffnen (mit <b>http://</b> am Anfang):</p>${urls.map(u => `<code class="url">${esc(u)}</code>`).join('')}`
      : '<p class="muted">Keine Netzwerkadresse gefunden – ist der PC mit dem WLAN/LAN verbunden?</p>'}
    ${(INFO.httpsUrls || []).length
      ? `<p class="muted small">Falls Safari meldet, es könne „keine sichere Verbindung herstellen“: Die https-Variante geht auch, z. B. <code>${esc(INFO.httpsUrls[0])}</code>. Bei der Zertifikatswarnung auf „Details einblenden → diese Website besuchen“ tippen.</p>`
      : ''}
    <p class="muted small">Tipp: In Safari auf „Teilen → Zum Home-Bildschirm“ tippen, dann startet Lernquest wie eine App. Der PC muss laufen und das Lernquest-Fenster (start.bat) geöffnet sein.</p>
  </section>` : ''}
  <section class="card form">
    <h2>Datensicherung</h2>
    <div class="row">
      <button class="btn" data-act="export">Fortschritt exportieren</button>
      <label class="btn">Importieren<input type="file" id="import" accept=".json,application/json" hidden></label>
    </div>
    <p class="muted small">${{
      github: `Der Fortschritt liegt in deinem privaten Repository unter <code>${SYNC_PATH}</code>. Der Export ist eine zusätzliche Sicherung als Datei.`,
      local: 'Der Fortschritt liegt auf dem PC in <code>data/progress.json</code>, mit täglichem Backup in <code>data/backups/</code>.',
      off: 'Ohne Synchronisierung liegt der Fortschritt nur in <b>diesem Browser auf diesem Gerät</b>.',
    }[syncMode()]}</p>
  </section>`;
}

// ---------- Synchronisierung: Einstellungen & Einrichtung ----------

function syncStatusHTML() {
  const last = LS.get('lq-sync-meta', {}).lastSyncAt;
  const lastTxt = last ? new Date(last).toLocaleString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'noch nie';
  const label = {
    ok: sync.dirty ? '<b>Änderungen ausstehend</b>' : '<b class="ok">synchronisiert</b>',
    busy: '<b>gleicht ab …</b>', offline: '<b>offline</b>', error: '<b class="warn">Fehler</b>', off: '<b>aus</b>',
  }[sync.state];
  return `<li><span class="muted">Status</span>${label}</li>
    <li><span class="muted">Letzter Abgleich</span><b>${esc(lastTxt)}</b></li>
    ${sync.message && sync.state !== 'busy' ? `<li class="sync-msg ${sync.state === 'error' ? 'warn' : 'muted'}">${esc(sync.message)}</li>` : ''}`;
}

function syncSectionHTML() {
  const cfg = GHSync.getConfig();
  if (cfg) {
    const srcLabel = { github: 'von GitHub', local: 'lokaler Server', cache: 'Zwischenspeicher (offline)' }[SOURCE] || 'nicht geladen';
    return `<section class="card form">
      <h2>Synchronisierung</h2>
      <p class="muted small">Module, Bilder und Fortschritt kommen aus deinem privaten GitHub-Repository und werden zwischen deinen Geräten abgeglichen.</p>
      <ul class="status-list small">
        <li><span class="muted">Repository</span><b>${esc(cfg.owner)}/${esc(cfg.repo)}</b></li>
        <li><span class="muted">Ordner</span><b>${DATA_DIR}/</b></li>
        <li><span class="muted">Module</span><b>${srcLabel}</b></li>
        <li><span class="muted">Bilder offline</span><b>${mediaStatus.total ? `${mediaStatus.cached}/${mediaStatus.total}${mediaStatus.busy ? ' (lädt …)' : ''}` : Object.keys(MEDIA).length ? '–' : 'keine'}</b></li>
      </ul>
      <ul class="status-list small" id="sync-status">${syncStatusHTML()}</ul>
      ${DATA_ERROR ? `<p class="warn small">⚠ ${esc(DATA_ERROR)}</p>` : ''}
      <div class="row">
        <button class="btn primary" data-act="sync-now">Jetzt abgleichen</button>
        <button class="btn ghost" data-act="sync-disconnect">Trennen</button>
      </div>
    </section>`;
  }
  return `<section class="card form">
    <h2>Synchronisierung</h2>
    <p class="muted small">Lädt Module und Bilder aus einem <b>privaten GitHub-Repository</b> (Ordner <code>${DATA_DIR}/</code>) und gleicht den Fortschritt zwischen deinen Geräten ab. Pro Gerät einmal einrichten.</p>
    <details>
      <summary>Anleitung</summary>
      <ol class="small">
        <li>Auf github.com ein Repository anlegen, z. B. <code>app-daten</code>, Sichtbarkeit <b>Private</b>.</li>
        <li>Unter <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Settings → Developer settings → Fine-grained tokens</a> einen Token erstellen:
          <i>Repository access</i> → „Only select repositories“ → das Daten-Repository; <i>Permissions</i> → „Contents“ → <b>Read and write</b>.</li>
        <li>Token kopieren und hier mit deinem GitHub-Benutzernamen eintragen.</li>
      </ol>
    </details>
    <input id="sync-owner" class="text-in" type="text" placeholder="GitHub-Benutzername" autocomplete="username" autocapitalize="off" spellcheck="false" aria-label="GitHub-Benutzername">
    <input id="sync-repo" class="text-in" type="text" value="app-daten" placeholder="Repository" autocapitalize="off" spellcheck="false" aria-label="Repository">
    <input id="sync-token" class="text-in" type="password" placeholder="Token (github_pat_…)" autocomplete="off" spellcheck="false" aria-label="Token">
    <p class="muted small">Der Token wird nur auf diesem Gerät gespeichert und nur an api.github.com gesendet. Er gilt für alle eigenen Apps unter derselben Adresse.</p>
    <button class="btn primary" data-act="sync-connect">Verbinden</button>
  </section>`;
}

// Einrichtung: noch keine Module auf diesem Gerät
function renderSetup() {
  app.innerHTML = `
  <header class="top"><div class="brand">🎓 Lernquest</div></header>
  ${DATA_ERROR ? `<section class="card warn-box">⚠ ${esc(DATA_ERROR)}</section>` : ''}
  <section class="card">
    <h1>Willkommen</h1>
    <p class="muted">Deine Lernmodule und dein Fortschritt liegen privat in deinem GitHub-Repository.
      Verbinde dieses Gerät einmal – danach lädt die App alles und funktioniert auch offline.</p>
    ${location.protocol === 'file:' ? '<p class="warn small">Die Seite wurde direkt als Datei geöffnet. Bitte über die Web-Adresse öffnen.</p>' : ''}
  </section>
  ${syncSectionHTML()}`;
}

async function connectSync(owner, repo, token) {
  const cfg = { owner: owner.trim().replace(/^@/, ''), repo: repo.trim(), token: token.trim() };
  if (!cfg.owner || !cfg.repo || !cfg.token) return 'Bitte Benutzername, Repository und Token ausfüllen.';
  let info;
  try {
    info = await GHSync.testRepo(cfg);
  } catch (e) {
    return e?.message || 'Verbindung fehlgeschlagen.';
  }
  if (!info.private && !confirm(`${info.fullName} ist öffentlich – jeder könnte deine Lerninhalte und deinen Fortschritt sehen. Empfohlen: das Repository auf „Private“ stellen.\n\nTrotzdem verbinden?`)) return null;
  if (!GHSync.setConfig(cfg)) return 'Konnte die Zugangsdaten nicht speichern.';
  await reloadAll();
  return null;
}

// Module neu laden, Fortschritt abgleichen, Bilder vorab speichern
async function reloadAll() {
  const ok = await loadDecks();
  if (view === 'setup' && ok) view = 'home';
  render();
  await runSync();
  prefetchMedia();
  return ok;
}

// ---------- Daten-Aktionen ----------

function resetDeck() {
  const deck = activeDeck();
  if (!deck || !confirm(`Fortschritt für „${deck.title}“ wirklich zurücksetzen? XP und Erfolge bleiben erhalten.`)) return;
  const now = Date.now();
  // Als "neu" markieren statt löschen, damit die Synchronisation den alten Stand nicht zurückholt.
  for (const c of deck._cards) if (P.cards[c.key]) P.cards[c.key] = { state: 'new', last: now };
  save();
  toast('Fortschritt zurückgesetzt');
  render();
}

function exportProgress() {
  const blob = new Blob([JSON.stringify(P, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lernquest-fortschritt-${dayKey()}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function importProgress(file) {
  if (!file) return;
  try {
    P = mergeP(P, normP(JSON.parse(await file.text())));
    save();
    toast('Import erfolgreich ✓', 'good');
    render();
  } catch {
    toast('Datei konnte nicht gelesen werden', 'bad');
  }
}

// =====================================================================
// Ereignisse
// =====================================================================

const ACTIONS = {
  start: () => startSession('learn'),
  extra: () => startSession('learn', { extraNew: 10 }),
  chapter: el => { mapSel = null; startSession('learn', { chapter: el.dataset.ch }); },
  node: el => { mapSel = el.dataset.ch; render(); },
  'sheet-close': () => { mapSel = null; render(); },
  modules: () => { modSheet = true; render(); },
  'modules-close': () => { modSheet = false; render(); },
  'pick-deck': el => {
    const changed = el.dataset.deck !== activeDeck()?.id;
    LS.set('lq-deck', el.dataset.deck);
    modSheet = false;
    mapSel = null;
    render();
    window.scrollTo(0, 0);
    if (changed) toast(`📚 ${esc(activeDeck().title)}`);
  },
  mistakes: () => startSession('mistakes'),
  speed: () => startSpeed(),
  settings: () => { view = 'settings'; render(); window.scrollTo(0, 0); },
  home: () => goHome(),
  quit: () => quitSession(),
  next: () => next(),
  mc: el => answerMC(+el.dataset.i),
  reveal: () => reveal(),
  rate: el => rate(+el.dataset.r),
  'intro-ok': () => introOk(),
  dunno: () => answerTyped([]),
  override: () => override(),
  match: el => matchTap(el.dataset.side, el.dataset.key),
  'speed-mc': el => speedAnswer(+el.dataset.i),
  'speed-quit': () => endSpeed(true),
  export: () => exportProgress(),
  'reset-deck': () => resetDeck(),
  'exam-write': () => { S.cur.write = true; render(); app.querySelector('[data-write]')?.focus(); },
  check: el => examToggle(+el.dataset.i, el),
  'exam-done': () => examDone(),
  'ord-add': el => ordAdd(+el.dataset.i),
  'ord-remove': el => ordRemove(+el.dataset.pos),
  'ord-reset': () => { S.cur.seq = []; render(); },
  'ord-check': () => ordCheck(),
  pair: el => pairTap(el.dataset.side, +el.dataset.i),
  grid: el => gridTap(+el.dataset.r, +el.dataset.i),
  'grid-check': () => gridCheck(),
  zoom: el => { if (el.getAttribute('src')) zoom(el.getAttribute('src')); },
  'sync-connect': async el => {
    el.disabled = true;
    el.textContent = 'Verbinde …';
    const err = await connectSync(
      document.getElementById('sync-owner').value,
      document.getElementById('sync-repo').value,
      document.getElementById('sync-token').value,
    );
    if (err) { toast(esc(err), 'bad'); el.disabled = false; el.textContent = 'Verbinden'; return; }
    if (!GHSync.getConfig()) { el.disabled = false; el.textContent = 'Verbinden'; return; }
    toast(esc(DATA_ERROR || (sync.state === 'ok' ? 'Verbunden und abgeglichen ✓' : sync.message || 'Verbunden.')));
  },
  'sync-now': async el => {
    el.disabled = true;
    await reloadAll();
    toast(esc(DATA_ERROR || (sync.state === 'ok' ? 'Abgeglichen ✓' : sync.message)), DATA_ERROR || sync.state === 'error' ? 'bad' : '');
  },
  'sync-disconnect': () => {
    if (!confirm('Sync trennen?\n\nDer Token wird von diesem Gerät entfernt (auch für deine anderen Apps unter derselben Adresse). Fortschritt und Module bleiben auf GitHub und im Zwischenspeicher dieses Geräts erhalten.')) return;
    GHSync.clearConfig();
    setSync('off', '');
    render();
  },
};

// Text im Klausur-Textfeld merken (überlebt das Neuzeichnen)
app.addEventListener('input', e => {
  if (e.target.dataset.write !== undefined && S?.cur) S.cur.text = e.target.value;
});

app.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  ACTIONS[el.dataset.act]?.(el, e);
});

app.addEventListener('submit', e => {
  e.preventDefault();
  if (e.target.dataset.form === 'type') answerTyped([...e.target.querySelectorAll('[data-gap]')].map(i => i.value));
});

app.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.change === 'deck') { LS.set('lq-deck', el.value); render(); return; }
  if (el.id === 'import') { importProgress(el.files[0]); return; }
  const k = el.dataset.set;
  if (!k) return;
  if (k === 'exam') {
    // eigenes Datum des Moduls; leer oder gleich dem Standard → zurück auf den Standard (null mit Zeitstempel)
    const deck = DECKS.find(d => d.id === el.dataset.deck);
    const std = examStd(deck);
    setSetting(`exam:${el.dataset.deck}`, el.value && el.value !== std ? el.value : null);
    if (!el.value && std) el.value = std;
  } else if (k === 'examDefault') {
    setSetting('examDefault', el.value || null);
  } else if (el.type === 'checkbox') {
    setSetting(k, el.checked);
  } else {
    const v = clamp(parseInt(el.value, 10) || DEFAULTS[k], +el.min, +el.max);
    el.value = v;
    setSetting(k, v);
  }
  toast('Gespeichert ✓');
});

document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (view === 'home' && (mapSel || modSheet) && e.key === 'Escape') { mapSel = null; modSheet = false; render(); return; }
  if (view === 'speed' && S && /^[1-4]$/.test(e.key)) { speedAnswer(+e.key - 1); return; }
  if (view !== 'session' || !S?.cur) return;
  const it = S.cur, inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
  if (e.key === 'Escape') { quitSession(); return; }
  if (e.key === 'Enter') {
    if (it.type === 'intro') { e.preventDefault(); introOk(); return; }
    const finished = it.result || (it.type === 'match' && it.matched.length === it.keys.length);
    if (finished && Date.now() - (it.result?.at || 0) > 250) { e.preventDefault(); next(); return; }
  }
  if (inInput) return;
  if (it.mode === 'mc' && !it.result && /^[1-4]$/.test(e.key)) answerMC(+e.key - 1);
  else if ((it.mode === 'flip' || it.mode === 'exam') && !it.revealed && e.key === ' ') { e.preventDefault(); reveal(); }
  else if (it.mode === 'flip' && it.revealed && /^[1-4]$/.test(e.key)) rate(+e.key - 1);
});

// Beim Zurückkehren in die App (z. B. Wechsel PC ↔ iPad) Änderungen der anderen Geräte holen,
// beim Verlassen noch ausstehende Änderungen hochladen.
document.addEventListener('visibilitychange', () => {
  if (view === 'setup') return;
  if (document.visibilityState === 'visible') {
    if (view === 'home' && !mapSel && !modSheet) render(); // Datumswechsel über Nacht
    scheduleSync(300);
  } else if (sync.dirty) {
    if (syncMode() === 'local') navigator.sendBeacon?.('api/progress', new Blob([JSON.stringify(P)], { type: 'application/json' }));
    else runSync();
  }
});
window.addEventListener('online', () => scheduleSync(300));
setInterval(() => { if (sync.dirty && !sync.busy) runSync(); }, 5 * 60000);

// =====================================================================
// Start
// =====================================================================

async function init() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* ohne Offline-Hülle weiter */ });
  }
  navigator.storage?.persist?.().catch(() => {});
  if (!(await loadDecks())) { view = 'setup'; render(); return; }
  render();
  await runSync();
  prefetchMedia();
}

init();
