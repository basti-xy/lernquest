# Lernquest

Statische Lern-App (HTML/CSS/JS, kein Backend) zum spielerischen Auswendiglernen:
Lernstufen ohne feste Termine (schwache Karten zuerst, nie leer, Reihenfolge immer anders), verschiedene Abfragearten (Multiple Choice, Eintippen, Lückentext, Karteikarte,
Zuordnen, Reihenfolge, Ankreuzen, Prüfungsfragen mit Checkliste), XP, Level, Streak, Tagesquests,
Erfolge, Speed-Runde und eine Weltkarte pro Modul. In der Kapitelübersicht (Kapitel auf der Weltkarte
antippen) lässt sich jede Frage samt Lösung nachlesen, ohne abgefragt zu werden.

Die **Lerninhalte und der Fortschritt liegen nicht in diesem Repository**, sondern in einem privaten
Daten-Repository. Die App lädt sie über die GitHub-API mit einem persönlichen Token, den man pro Gerät
einmal in der App einträgt, und speichert sie für den Offline-Betrieb im Browser zwischen.
Hier liegt nur der Programmcode.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `docs/` | die Web-App (wird über GitHub Pages ausgeliefert) |
| `docs/sync.js` | app-unabhängiges Modul für den Abgleich über die GitHub-API |
| `server.py`, `certgen.py`, `start.bat` | optionaler lokaler Server (Python, ohne Zusatzpakete) |
| `ANLEITUNG.md` | Bedienung und Format der Moduldateien |

## Daten-Repository (privat)

| Pfad | Inhalt |
|---|---|
| `lernquest/decks/*.json` | Module (Format siehe `ANLEITUNG.md`) |
| `lernquest/media/…` | Bilder, in den Modulen als `![](media/…)` eingebunden |
| `lernquest/progress.json` | Fortschritt, wird von der App geschrieben |

Token: *Settings → Developer settings → Fine-grained tokens*. Bei *Repository access* nur das
Daten-Repository auswählen, bei *Contents* **Read and write** setzen. Der Token wird nur im Browser
des Geräts gespeichert und nur an `api.github.com` gesendet. Er gilt für alle eigenen Apps unter
derselben `*.github.io`-Adresse.

## Lernen

- Jede Karte hat eine Lernstufe 0–5: falsch → 0, schwer → eine Stufe runter, gut → +1, leicht → +2.
- Eine Runde (Standard 20 Karten) nimmt die schwächsten Karten zuerst, bei gleicher Stufe die am längsten nicht
  gesehenen – mit etwas Zufall, damit die Reihenfolge nie gleich ist. Es gibt keine Fälligkeiten nach Datum,
  „Lernen starten“ hat also immer etwas zu tun.
- Neue Karten (in Kapitelreihenfolge, höchstens 5 pro Runde) kommen nur dazu, solange weniger als 12 Karten
  auf Stufe 0–1 stehen: erst festigen, dann Neues. „+10 neue“ holt trotzdem mehr dazu.
- Falsch beantwortete Karten kommen in derselben Runde nach 2–4 Karten noch einmal.

## Abgleich

- Karten: der neuere Stand gewinnt (Zeitstempel pro Karte).
- Einstellungen: pro Wert der neuere Stand (Zeitstempel pro Wert).
- Tageswerte (XP, Antworten …) werden pro Gerät gezählt und zusammengeführt.
- Zurücksetzen wird als neuer Stand mit neuerem Zeitstempel gespeichert und kommt daher nicht von
  einem anderen Gerät zurück.

## Lokal starten

`start.bat` (bzw. `py server.py`), dann `http://localhost:8000`. Der Server liest Module und Bilder
aus einem lokalen Klon des Daten-Repositorys (`../app-daten/lernquest/`) oder aus `LERNQUEST_DATA`.
