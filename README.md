# GW2 Achievement Helper

Ein Web-Tool für Guild-Wars-2-Erfolge, das komplett im Browser läuft. Oberfläche und Spieldaten sind auf Englisch; die Spielsprache kannst du unter *Settings* umstellen.

- **Suche**: Du findest jeden Erfolg über Name, Beschreibung oder ID.
- **Run-Through**: Für einen Erfolg siehst du
  - offene **Voraussetzungen** (rekursiv, in der richtigen Reihenfolge),
  - alle **Einzelschritte** (Objekte, Items, Skins, Minis) mit deinem Stand aus der API. Erledigte Schritte werden abgehakt, die übrigen kannst du manuell abhaken,
  - pro offenem Schritt den **Wiki-Hinweis** (passende Zeile aus der Wiki-Tabelle, z. B. mit Fundort) oder auf Knopfdruck den Abschnitt „Erwerb/Acquisition“ der Item-Seite,
  - den **kompletten Wiki-Guide**, aufgeteilt in Abschnitte. Walkthrough, Ziele und Sammlung sind dabei aufgeklappt.
- **Leichte AP**: Alle offenen Erfolge, sortiert nach geschätzter Leichtigkeit (AP der nächsten Stufe ÷ √fehlende Schritte × Fortschritt). Du kannst nach Gruppe, PvP, Wiederholbarkeit, gesperrten Erfolgen und Mindest-Fortschritt filtern. Tägliche und nicht mehr kategorisierte (meist unerreichbare) Erfolge sind ausgeblendet.

## Weitere Funktionen

- **Tracked (Merkliste):** Erfolge mit „☆ Track“ anheften; die Startseite zeigt sie mit Fortschritt und nächstem Schritt.
- **Fortschritt:** Die Startseite zeigt deinen AP-Verlauf (täglich lokal gespeichert): heute, letzte 7 Tage, Schnitt pro Tag und eine Verlaufskurve.
- **Items im Account:** Mit den Key-Rechten `inventories` + `characters` zeigt das Tool bei Sammlungen, welche Items schon in Bank, Materiallager oder Taschen liegen.
- **Handelsposten-Kosten:** Preis der fehlenden handelbaren Items (Sofortkauf), bei „x von y“ die günstigsten nötigen.
- **Map:** Karte wählen und alle offenen Schritte dort sehen – mit Wegmarken, Weltbossen und Timern.
- **Event-Timer:** Bei Weltboss-Erfolgen der nächste Start in deiner Ortszeit (fester Tagesplan, Link zu den Wiki-Event-Timern).
- **Belohnungs-Filter:** In *Easy AP* nach Meisterschaftspunkt, Titel, Item oder Gold filtern.
- **Timegates:** Tageslimits aus dem Wiki, Fortschritt heute und Countdown bis zum Tagesreset (00:00 UTC).

## Desktop-Programm (Windows/Linux)

Das Programm bietet zusätzlich zur Web-Version:

- **Wiki direkt im Programm:** Wiki-Links (Wegmarken, Orte, NPCs, Items) öffnen sich im Programm. Mit *← Zurück* oder Alt+← kommst du zurück.
- **Bilder anklicken** öffnet sie groß, als Originalbild aus dem Wiki (z. B. Screenshots von Orten).
- **Chat-Codes** wie `[&BDAEAAA=]` (Wegmarken, Sehenswürdigkeiten) kopierst du per Klick und fügst sie im Spiel mit Strg+V in den Chat ein. Im Chat klickst du den Link an, dann zeigt dir die Karte den Ort.
- Links auf andere Seiten öffnen sich im normalen Browser.

**Herunterladen:** Auf GitHub unter *Actions* → *Desktop-App bauen* → neuester Lauf → Artefakt **GW2-Achievement-Helper-win**.
Das ZIP enthält den Installer (`…-Setup-….exe`) und eine portable Version (`…-Portable-….exe`, läuft ohne Installation).
Wenn du einen Tag `v…` pushst (z. B. `v0.1.0`), hängt der Workflow die Dateien außerdem an ein GitHub-Release.

> Das Programm ist nicht signiert. Windows SmartScreen warnt deshalb beim ersten Start: *Weitere Informationen* → *Trotzdem ausführen*.

**Selbst bauen:** Du brauchst [Node.js](https://nodejs.org) 20+.

```bash
npm install
npm start          # Programm direkt starten
npm run dist:win   # Windows-Installer + portable .exe nach dist/
```

## Starten (Web-Version)

Du brauchst keinen Build und keine Installation:

- `index.html` direkt im Browser öffnen, **oder**
- einen lokalen Server starten: `python3 -m http.server` und dann http://localhost:8000 öffnen, **oder**
- das Repo über GitHub Pages hosten.

## Als App installieren (Handy & PC)

Das Tool ist eine installierbare Web-App (PWA). Dafür muss es über `http(s)` laufen, also z. B. über GitHub Pages oder `python3 -m http.server`:

- **Android (Chrome):** Menü ⋮ → *App installieren* / *Zum Startbildschirm hinzufügen*
- **iPhone (Safari):** Teilen-Symbol → *Zum Home-Bildschirm*
- **PC (Chrome/Edge):** Installieren-Symbol rechts in der Adressleiste. Das Tool läuft danach als eigenes Programm im eigenen Fenster und hat einen Eintrag im Startmenü.

Die App-Dateien funktionieren auch offline. Für API- und Wiki-Daten brauchst du Internet.

### GitHub Pages einrichten

Repo auf GitHub → *Settings* → *Pages* → *Source: Deploy from a branch* → Branch wählen → *Save*.
Nach ein bis zwei Minuten läuft das Tool unter `https://<benutzername>.github.io/Gw2/`.
(Auf dem kostenlosen GitHub-Plan geht Pages nur mit öffentlichen Repos.)

## API-Key

Unter *Einstellungen* trägst du einen Key von https://account.arena.net/applications ein, mit den Rechten **account** und **progression**.
Der Key bleibt in deinem Browser (localStorage) und wird nur an `api.guildwars2.com` gesendet.

## Technik

| Datei | Inhalt |
|---|---|
| `js/api.js` | GW2-API (`/v2/achievements`, `/categories`, `/groups`, `/account/achievements`, Items/Skins/Minis) |
| `js/wiki.js` | Wiki-Suche (per Spiel-ID über Semantic MediaWiki, sonst per Name), Parsen, HTML-Bereinigung |
| `js/progress.js` | AP, Stufen, Fortschritt und Leichtigkeits-Score |
| `js/app.js` | Oberfläche und Routing (`#/`, `#/a/<id>`, `#/easy`, `#/settings`) |
| `electron/main.js` | Desktop-Hülle (Fenster, externe Links im Browser, Menü) |
| `js/db.js` | IndexedDB-Cache (die Erfolgsdaten werden 7 Tage gecacht) |

Die Wiki-Inhalte stammen aus dem [Guild Wars 2 Wiki](https://wiki.guildwars2.com) (CC BY-NC-SA 3.0).
Guild Wars 2 © ArenaNet. Dies ist ein inoffizielles Fan-Tool.
