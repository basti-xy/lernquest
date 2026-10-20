# Lernquest – Anleitung

## Starten (normal: über GitHub Pages, kein PC als Server nötig)
1. Adresse öffnen: **https://basti-xy.github.io/lernquest/**
2. Beim ersten Mal auf einem Gerät: in der App GitHub-Benutzername, Daten-Repository und Token
   eintragen (Einrichtungsseite bzw. ⚙️ → Synchronisierung). Unter derselben `*.github.io`-Adresse
   ist ein bereits eingetragener Token (z. B. aus einer anderen eigenen App) automatisch da.
3. Danach lädt die App Module, Bilder und Fortschritt aus dem privaten Daten-Repository,
   speichert alles für den Offline-Betrieb zwischen und gleicht den Fortschritt zwischen den
   Geräten ab: beim Start, nach dem Lernen, beim Zurückkehren in die App und wenn das Gerät
   wieder online ist. Der Punkt am Zahnrad zeigt den Status.

## Auf dem iPad
- In Safari **https://basti-xy.github.io/lernquest/** öffnen.
- Teilen → „Zum Home-Bildschirm“ → Lernquest startet wie eine App. Als Home-Bildschirm-App bleiben
  die zwischengespeicherten Module und Bilder dauerhaft erhalten (Safari löscht Website-Daten sonst
  nach längerer Nichtnutzung).
- Einmal online öffnen und warten, bis unter ⚙️ → Synchronisierung „Bilder offline“ voll ist –
  dann funktioniert alles auch ohne Internet.

## Wo liegt was?
| Was | Wo | Sichtbarkeit |
|---|---|---|
| Programmcode | Repository `lernquest`, Web-App im Ordner `docs/` | öffentlich |
| Module (Karten, Fragen, Lösungen) | Daten-Repository `app-daten`, Ordner `lernquest/decks/` | privat |
| Bilder zu den Lösungen | `app-daten/lernquest/media/…` | privat |
| Fortschritt, XP, Streak, Einstellungen | `app-daten/lernquest/progress.json` | privat |
| Token | nur im Browser des jeweiligen Geräts | – |

## Neue Karten oder Module
1. Im lokalen Klon des Daten-Repositorys (`app-daten`) die Modul-Datei in `lernquest/decks/`
   anlegen oder bearbeiten, Bilder nach `lernquest/media/<modul>/` legen.
2. Committen und pushen.
3. In der App: ⚙️ → „Jetzt abgleichen“ (oder App neu öffnen). Geänderte Dateien werden neu geladen.

Am einfachsten: Skript/Folien/Notizen an Claude geben und die Datei erzeugen lassen.

```json
{
  "id": "modulname",
  "title": "Anzeigename des Moduls",
  "chapters": [
    {
      "id": "k1",
      "title": "Kapitel 1",
      "cards": [
        {
          "id": "k1-01",
          "q": "Frage",
          "a": "Antwort",
          "alt": ["weitere akzeptierte Schreibweise"],
          "wrong": ["falsche Option 1", "falsche Option 2", "falsche Option 3"],
          "cloze": "Satz mit {{Lücke}} und {{zweiter Lücke|Alternative}}",
          "hint": "Eselsbrücke, wird nach der Antwort angezeigt",
          "modes": ["mc", "flip"]
        }
      ]
    }
  ]
}
```

Auf Modulebene optional: `"examDate": "JJJJ-MM-TT"` – Prüfungsdatum dieses Moduls. Ohne Angabe gilt
das Standard-Prüfungsdatum aus ⚙️ (wird mit dem Fortschritt synchronisiert); pro Modul in ⚙️ änderbar.

Pflicht sind nur `id`, `q` und `a`. Alles andere ist optional:
- `alt` – weitere richtige Antworten fürs Eintippen
- `wrong` – gute falsche Antworten für Multiple Choice (sonst werden Antworten anderer Karten genommen)
- `cloze` – Lückentext-Variante der Karte
- `hint` – Eselsbrücke/Erklärung
- `modes` – erlaubte Abfragearten einschränken: `mc`, `type`, `cloze`, `flip`, `match`
  (sinnvoll bei langen Antworten, die man nicht exakt eintippen kann)

### Weitere Kartentypen (Feld `type`)
- `exam` – Prüfungsfrage: `q` (Aufgabenstellung 1:1), `answer` (Lösung als Zeilenliste, siehe unten),
  `checklist` (Kernpunkte zum Abhaken), optional `label` (z. B. „1.2“) und `pass` (Anteil für „gut“, Standard 0,9)
- `order` – Reihenfolge: `items` in richtiger Reihenfolge
- `pairs` – Zuordnen: `pairs` als Liste von `[links, rechts]`
- `grid` – Einordnen/Ankreuzen: `rows` mit `label`, `correct` (Index oder Liste), Optionen je Zeile
  (`options` in der Zeile) oder gemeinsam (`options` auf Kartenebene); `multi: true` = mehrere Kreuze,
  `shuffle: true` = Zeilen mischen
- `parent` (z. B. „1.2“) markiert eine Karte als Teilübung zu einer Prüfungsfrage.

Lösungstexte (`answer`) verstehen: `- ` Listen, `1. ` Listen, `| Tabellen |` (erste Zeile = Kopf),
`![](media/<modul>/bild.png)` Bilder (liegen in `lernquest/media/` im Daten-Repository), `**fett**`,
`[Hinweis]`, `{Erläuterung}`, sowie Kästen `:::zusatz Titel` … `:::` (Zusatzwissen) und
`:::erl Titel` … `:::` (Erläuterung).

**Wichtig:** Die `id` einer Karte nie ändern, sonst geht ihr Lernfortschritt verloren.
Text ändern ist kein Problem.

## Lokaler Server (optional, z. B. ohne Internet am PC)
`start.bat` startet `server.py`. Er liefert die App aus `docs/` und liest Module und Bilder aus dem
lokalen Klon `../app-daten/lernquest/` (Ordner neben diesem). Der Fortschritt landet dann lokal in
`data/progress.json` und wird **nicht** mit GitHub abgeglichen, solange auf `localhost` kein Token
eingetragen ist (⚙️ → Synchronisierung; danach gleicht auch diese Adresse über GitHub ab).

Im WLAN ist der lokale Server auch fürs iPad erreichbar (Adresse steht im Server-Fenster), per
`http://` oder `https://` mit selbst erzeugtem Zertifikat (liegt in `data/`, wird nie hochgeladen).
Beim ersten Start fragt Windows evtl. nach der Firewall: „Private Netzwerke“ erlauben.

## Datensicherung
- Das Daten-Repository auf GitHub enthält jeden Stand als Commit (Versionsverlauf).
- In ⚙️ gibt es zusätzlich Export/Import als Datei.
- Lokaler Server: tägliche Backups in `data/backups/` (14 Tage).
