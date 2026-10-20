'use strict';

/* =========================================================================
   GitHub-Sync – app-unabhängiges Modul
   Speichert eine JSON-Datei pro App in einem (privaten) GitHub-Repository
   über die Contents-API. Die Zugangsdaten liegen unter einem gemeinsamen
   Schlüssel, damit alle eigenen Apps unter derselben Adresse
   (z. B. <name>.github.io/…) denselben Token nutzen – pro Gerät nur einmal eingeben.
   Erweiterung: Ordner auflisten (Trees-API) und Dateien per SHA laden (Blob-API),
   auch binär (z. B. Bilder).
   ========================================================================= */

const GHSync = (() => {
  const CONFIG_KEY = 'ghsync.config.v1';
  const API = 'https://api.github.com';

  class SyncError extends Error {
    constructor(code, message, status) {
      super(message);
      this.code = code; // auth | notfound | conflict | network | ratelimit | invalid | other
      this.status = status;
    }
  }

  function getConfig() {
    try {
      const c = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
      return c && c.owner && c.repo && c.token ? c : null;
    } catch {
      return null;
    }
  }
  function setConfig(c) {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(c)); return true; } catch { return false; }
  }
  function clearConfig() {
    try { localStorage.removeItem(CONFIG_KEY); } catch { /* egal */ }
  }

  const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
  const repoBase = (cfg) => `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;

  function b64encodeUtf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decodeBytes(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  const b64decodeUtf8 = (b64) => new TextDecoder().decode(b64decodeBytes(b64));

  async function api(cfg, method, url, body) {
    let res;
    try {
      res = await fetch(`${API}${url}`, {
        method,
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${cfg.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new SyncError('network', 'Keine Verbindung zu GitHub.');
    }
    if (res.ok) return res.status === 204 ? null : res.json();
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* egal */ }
    if (res.status === 401) throw new SyncError('auth', 'Token ungültig oder abgelaufen.', 401);
    if (res.status === 403 && /rate limit/i.test(detail)) throw new SyncError('ratelimit', 'GitHub-Limit erreicht, später erneut versuchen.', 403);
    if (res.status === 403) throw new SyncError('auth', 'Token hat keine Schreibrechte (Contents: Read and write).', 403);
    if (res.status === 404) throw new SyncError('notfound', 'Repository oder Datei nicht gefunden – oder der Token hat keinen Zugriff darauf.', 404);
    if (res.status === 409 || res.status === 422) throw new SyncError('conflict', 'Gleichzeitige Änderung – erneuter Versuch.', res.status);
    throw new SyncError('other', `GitHub-Fehler ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
  }

  /** Prüft Zugriff auf das Repository. Liefert { private, fullName, defaultBranch }. */
  async function testRepo(cfg) {
    const r = await api(cfg, 'GET', repoBase(cfg));
    return { private: !!r.private, fullName: r.full_name, defaultBranch: r.default_branch || 'main' };
  }

  /** Liest die JSON-Datei. Liefert { data, sha } oder null, wenn sie noch nicht existiert. */
  async function readFile(cfg, path) {
    const base = repoBase(cfg);
    let meta;
    try {
      meta = await api(cfg, 'GET', `${base}/contents/${encPath(path)}`);
    } catch (e) {
      if (e.code === 'notfound') {
        await testRepo(cfg); // wirft, falls das Repo selbst fehlt → sonst existiert nur die Datei noch nicht
        return null;
      }
      throw e;
    }
    let text;
    if (meta.content && meta.encoding === 'base64') {
      text = b64decodeUtf8(meta.content);
    } else {
      // Dateien > 1 MB liefert die Contents-API ohne Inhalt → über die Blob-API holen
      const blob = await api(cfg, 'GET', `${base}/git/blobs/${meta.sha}`);
      text = b64decodeUtf8(blob.content);
    }
    try {
      return { data: JSON.parse(text), sha: meta.sha };
    } catch {
      throw new SyncError('invalid', `${path} im Repository ist kein gültiges JSON.`);
    }
  }

  async function writeFile(cfg, path, data, sha, message) {
    const r = await api(cfg, 'PUT', `${repoBase(cfg)}/contents/${encPath(path)}`, {
      message,
      content: b64encodeUtf8(JSON.stringify(data, null, 1)),
      ...(sha ? { sha } : {}),
    });
    return r.content.sha;
  }

  /**
   * Listet alle Dateien unterhalb eines Ordners (rekursiv, ein einziger Aufruf).
   * @returns {Promise<Array<{ path: string, sha: string, size: number }>>} – leer, wenn der Ordner fehlt
   */
  async function listTree(cfg, dir) {
    const { defaultBranch } = await testRepo(cfg);
    const r = await api(cfg, 'GET', `${repoBase(cfg)}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`);
    const prefix = dir.replace(/\/?$/, '/');
    return (r.tree || [])
      .filter((e) => e.type === 'blob' && e.path.startsWith(prefix))
      .map((e) => ({ path: e.path, sha: e.sha, size: e.size || 0 }));
  }

  /** Lädt eine Datei über ihre SHA (Blob-API, bis 100 MB). Liefert die Rohdaten als Uint8Array. */
  async function readBlob(cfg, sha) {
    const r = await api(cfg, 'GET', `${repoBase(cfg)}/git/blobs/${encodeURIComponent(sha)}`);
    return b64decodeBytes(r.content || '');
  }
  const readBlobText = async (cfg, sha) => new TextDecoder().decode(await readBlob(cfg, sha));

  /**
   * Holt den Stand, führt ihn mit dem lokalen zusammen und schreibt zurück, falls sich etwas geändert hat.
   * @param {string} path  Datei im Repo, z. B. "dehn.json"
   * @param {object} opts  { local, merge(local, remote) → merged, equals(a, b) → bool, message }
   * @returns {Promise<{ data: object, pushed: boolean, pulled: boolean }>}
   */
  async function syncFile(path, { local, merge, equals, message = 'Sync' }) {
    const cfg = getConfig();
    if (!cfg) throw new SyncError('auth', 'Sync ist nicht eingerichtet.');
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await readFile(cfg, path);
      const merged = remote ? merge(local, remote.data) : local;
      const pulled = !!remote && !equals(merged, local);
      if (remote && equals(merged, remote.data)) return { data: merged, pushed: false, pulled };
      try {
        await writeFile(cfg, path, merged, remote?.sha, message);
        return { data: merged, pushed: true, pulled };
      } catch (e) {
        if (e.code === 'conflict' && attempt < 2) continue; // anderes Gerät war schneller → neu lesen und mergen
        throw e;
      }
    }
    throw new SyncError('conflict', 'Abgleich fehlgeschlagen (mehrfache gleichzeitige Änderung).');
  }

  return { getConfig, setConfig, clearConfig, testRepo, readFile, writeFile, listTree, readBlob, readBlobText, syncFile, SyncError };
})();
