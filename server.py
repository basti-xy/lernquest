"""Lernquest – optionaler lokaler Server (die App läuft normalerweise über GitHub Pages).

Liefert die Web-App aus docs/, die Lernmodule und Bilder aus dem Daten-Ordner und
speichert den Lernfortschritt in data/progress.json. Daten-Ordner ist – falls
vorhanden – der lokale Klon des privaten Daten-Repositorys (../app-daten/lernquest),
sonst dieser Ordner (decks/, media/). Läuft im ganzen WLAN, per http:// und https://
auf demselben Port.

Start: start.bat doppelklicken (oder: py server.py)
"""

import json
import os
import shutil
import socket
import ssl
import sys
import threading
import time
import webbrowser
from datetime import date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import certgen

BASE = Path(__file__).resolve().parent
PUBLIC = BASE / "docs"
_PRIVATE_CLONE = BASE.parent / "app-daten" / "lernquest"
CONTENT = Path(os.environ.get("LERNQUEST_DATA") or (_PRIVATE_CLONE if _PRIVATE_CLONE.is_dir() else BASE))
DECKS = CONTENT / "decks"
MEDIA = CONTENT / "media"
DATA = BASE / "data"
BACKUPS = DATA / "backups"
PROGRESS = DATA / "progress.json"
CERT = DATA / "cert.pem"
KEY = DATA / "key.pem"
CERT_DER = DATA / "lernquest.cer"
CERT_META = DATA / "cert.json"
PORT = int(os.environ.get("LERNQUEST_PORT", "8000"))
MAX_BODY = 20 * 1024 * 1024
KEEP_BACKUPS = 14

lock = threading.Lock()


# ---------- Fortschritt ----------

def load_progress():
    try:
        return json.loads(PROGRESS.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError:
        # Kaputte Datei nicht überschreiben, sondern zur Seite legen.
        broken = PROGRESS.with_name(f"progress.kaputt-{date.today()}.json")
        PROGRESS.replace(broken)
        print(f"WARNUNG: progress.json war beschädigt und wurde nach {broken.name} verschoben.")
        return {}


def save_progress(p):
    DATA.mkdir(exist_ok=True)
    tmp = PROGRESS.with_suffix(".tmp")
    tmp.write_text(json.dumps(p, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, PROGRESS)
    daily_backup()


def daily_backup():
    BACKUPS.mkdir(parents=True, exist_ok=True)
    target = BACKUPS / f"progress-{date.today()}.json"
    if not target.exists():
        shutil.copyfile(PROGRESS, target)
        for old in sorted(BACKUPS.glob("progress-*.json"))[:-KEEP_BACKUPS]:
            old.unlink()


def _canon(v):
    return json.dumps(v, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _is_entry(x):
    return isinstance(x, dict) and "v" in x and "t" in x


def normalize(p):
    """Bringt einen (auch alten) Fortschrittsstand ins aktuelle Format v2 (wie normP in app.js)."""
    p = p if isinstance(p, dict) else {}
    src = p.get("settings") if isinstance(p.get("settings"), dict) else {}
    legacy_t = src.get("updated") if isinstance(src.get("updated"), (int, float)) else 0
    settings = {}
    for k, v in src.items():
        if k == "updated":
            continue
        if _is_entry(v):
            settings[k] = v
        elif k == "exams" and isinstance(v, dict):
            for deck_id, d in v.items():
                settings[f"exam:{deck_id}"] = {"v": d, "t": legacy_t}
        else:
            settings[k] = {"v": v, "t": legacy_t}
    cards = p.get("cards") if isinstance(p.get("cards"), dict) else {}
    log = p.get("log") if isinstance(p.get("log"), dict) else {}
    return {"v": 2, "cards": cards, "log": log, "settings": settings}


def _newer(x, y, time_key):
    if y is None:
        return True
    tx, ty = x.get(time_key, 0) or 0, y.get(time_key, 0) or 0
    return tx > ty or (tx == ty and _canon(x) > _canon(y))


def merge(a, b):
    """Führt zwei Fortschrittsstände zusammen (gleiche Logik wie mergeP in app.js).

    Karten: der neuere Stand gewinnt (Zeitstempel "last"). Einstellungen: pro Eintrag
    der neuere ("t"). Tageslog: pro Gerät und Tag zählen die Werte nur hoch → Maximum.
    """
    a, b = normalize(a), normalize(b)
    out = {"v": 2, "cards": dict(a["cards"]), "log": {}, "settings": dict(a["settings"])}
    for key, card in b["cards"].items():
        if isinstance(card, dict) and _newer(card, out["cards"].get(key), "last"):
            out["cards"][key] = card
    for key, entry in b["settings"].items():
        if _newer(entry, out["settings"].get(key), "t"):
            out["settings"][key] = entry
    for src in (a, b):
        for dev, days in src["log"].items():
            if not isinstance(days, dict):
                continue
            for day, vals in days.items():
                if not isinstance(vals, dict):
                    continue
                tgt = out["log"].setdefault(dev, {}).setdefault(day, {})
                for field, v in vals.items():
                    if isinstance(v, (int, float)) and not isinstance(v, bool):
                        tgt[field] = max(tgt.get(field, 0), v)
    return out


# ---------- Lernmodule ----------

# Kartentyp -> Feld, das zusätzlich zu id und q vorhanden sein muss
REQUIRED_FIELD = {"qa": "a", "exam": "answer", "order": "items", "pairs": "pairs", "grid": "rows"}

def load_decks():
    decks, warnings, seen_ids = [], [], set()
    for f in sorted(DECKS.glob("*.json")):
        try:
            raw = json.loads(f.read_text(encoding="utf-8-sig"))
        except Exception as e:  # noqa: BLE001 – Fehler soll in der App sichtbar werden
            warnings.append(f"{f.name}: konnte nicht gelesen werden ({e})")
            continue
        deck_id = str(raw.get("id") or f.stem)
        if deck_id in seen_ids:
            warnings.append(f"{f.name}: Modul-ID „{deck_id}“ gibt es doppelt – übersprungen")
            continue
        seen_ids.add(deck_id)
        chapters, card_ids = [], set()
        for ci, ch in enumerate(raw.get("chapters") or []):
            ch_id = str(ch.get("id") or f"kap{ci + 1}")
            cards = []
            for c in ch.get("cards") or []:
                cid, q, ctype = c.get("id"), c.get("q"), c.get("type", "qa")
                needed = REQUIRED_FIELD.get(ctype)
                if not cid or not q or not needed or not c.get(needed):
                    warnings.append(f"{f.name}: Karte „{cid or '?'}“ ({ctype}) unvollständig in „{ch.get('title', ch_id)}“ – übersprungen")
                    continue
                cid = str(cid)
                if cid in card_ids:
                    warnings.append(f"{f.name}: Karten-ID „{cid}“ doppelt – übersprungen")
                    continue
                card_ids.add(cid)
                card = {**c, "id": cid, "q": str(q)}
                if ctype == "qa":
                    card["a"] = str(c["a"])
                cards.append(card)
            chapters.append({"id": ch_id, "title": str(ch.get("title") or ch_id), "cards": cards})
        decks.append({
            "id": deck_id,
            "title": str(raw.get("title") or deck_id),
            "description": str(raw.get("description") or ""),
            "examDate": str(raw.get("examDate") or ""),  # optional, Format JJJJ-MM-TT
            # optional: zusätzliche Fragengruppen (Karten mit "extra": "<id>"), nur auf Wunsch dabei
            "extras": [e for e in (raw.get("extras") or []) if isinstance(e, dict) and e.get("id")],
            "chapters": chapters,
        })
    decks.sort(key=lambda d: d["title"].lower())
    return {"decks": decks, "warnings": warnings}


# ---------- Netzwerk ----------

def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))  # sendet nichts, ermittelt nur die Route
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith(("127.", "169.254.")))


def urls(scheme="http"):
    return [f"{scheme}://{ip}:{PORT}" for ip in lan_ips()]


# ---------- HTTPS-Zertifikat ----------

def ensure_cert():
    """Legt bei Bedarf ein selbstsigniertes Zertifikat für alle aktuellen IP-Adressen an."""
    ips = set(lan_ips()) | {"127.0.0.1"}
    try:
        meta = json.loads(CERT_META.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        meta = {}
    fresh = meta.get("expires", 0) - time.time() > 30 * 86400
    if CERT.exists() and KEY.exists() and fresh and ips <= set(meta.get("ips", [])):
        return
    all_ips = sorted(ips | (set(meta.get("ips", [])) if fresh else set()))
    print("Erzeuge HTTPS-Zertifikat (einmalig, dauert ein paar Sekunden) …")
    cert_pem, key_pem, cert_der = certgen.generate(all_ips)
    DATA.mkdir(exist_ok=True)
    KEY.write_text(key_pem, encoding="ascii")
    CERT.write_text(cert_pem, encoding="ascii")
    CERT_DER.write_bytes(cert_der)
    CERT_META.write_text(json.dumps({"ips": all_ips, "expires": time.time() + 820 * 86400}), encoding="utf-8")


def make_ssl_context():
    try:
        ensure_cert()
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(CERT, KEY)
        return ctx
    except Exception as e:  # noqa: BLE001 – ohne https läuft die App trotzdem
        print(f"WARNUNG: HTTPS nicht verfügbar ({e}). http:// funktioniert weiterhin.")
        return None


# ---------- HTTP ----------

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".png": "image/png",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/decks":
            return self.send_json(load_decks())
        if path == "/api/progress":
            with lock:
                return self.send_json(load_progress())
        if path == "/api/info":
            return self.send_json({"urls": urls(), "httpsUrls": urls("https") if self.server.ssl_ctx else [], "port": PORT})
        if path == "/lernquest.cer" and CERT_DER.exists():
            body = CERT_DER.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/x-x509-ca-cert")
            self.send_header("Content-Disposition", 'attachment; filename="lernquest.cer"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return None
        if path.startswith("/media/"):
            return self.send_media(path[len("/media/"):])
        return super().do_GET()

    def send_media(self, rel):
        """Bilder aus dem Daten-Ordner (media/) – nur Dateien innerhalb dieses Ordners."""
        from urllib.parse import unquote
        try:
            target = (MEDIA / unquote(rel)).resolve()
            target.relative_to(MEDIA.resolve())
        except (ValueError, OSError):
            return self.send_error(404)
        if not target.is_file():
            return self.send_error(404)
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(str(target)))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return None

    def do_PUT(self):
        if urlsplit(self.path).path != "/api/progress":
            return self.send_error(404)
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self.send_error(400)
        try:
            incoming = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            return self.send_error(400)
        with lock:
            merged = merge(load_progress(), incoming)
            save_progress(merged)
        return self.send_json(merged)

    do_POST = do_PUT  # navigator.sendBeacon schickt POST


class DualServer(ThreadingHTTPServer):
    """Nimmt auf einem Port sowohl http:// als auch https:// an.

    Am ersten Byte einer Verbindung erkennt man einen TLS-Handshake (0x16);
    dann wird die Verbindung verschlüsselt, sonst normal als HTTP behandelt.
    """

    daemon_threads = True

    def __init__(self, addr, handler, ssl_ctx):
        super().__init__(addr, handler)
        self.ssl_ctx = ssl_ctx

    def finish_request(self, request, client_address):
        conn = request
        try:
            request.settimeout(15)
            if self.ssl_ctx and request.recv(1, socket.MSG_PEEK) == b"\x16":
                conn = self.ssl_ctx.wrap_socket(request, server_side=True)
            conn.settimeout(60)
            super().finish_request(conn, client_address)
        except (OSError, ssl.SSLError):
            pass  # z. B. Zertifikat abgelehnt oder Verbindung abgebrochen
        finally:
            if conn is not request:
                conn.close()


def main():
    DATA.mkdir(exist_ok=True)
    ssl_ctx = make_ssl_context()
    try:
        server = DualServer(("0.0.0.0", PORT), Handler, ssl_ctx)
    except OSError:
        print(f"Port {PORT} ist schon belegt – läuft Lernquest vielleicht schon in einem anderen Fenster?")
        input("Enter zum Schließen …")
        sys.exit(1)

    print("=" * 60)
    print("  Lernquest läuft (lokaler Server)!")
    print(f"  Daten-Ordner: {CONTENT}")
    print(f"  Am PC:        http://localhost:{PORT}")
    for u in urls():
        print(f"  iPad (WLAN):  {u}")
    if ssl_ctx:
        for u in urls("https"):
            print(f"  oder:         {u}  (Zertifikatswarnung bestätigen)")
    print("  Fenster offen lassen. Beenden mit Strg+C.")
    print("=" * 60)

    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBeendet.")


if __name__ == "__main__":
    main()
