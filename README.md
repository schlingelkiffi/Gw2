# GW2 Erfolgs-Helfer

Ein Web-Tool für Guild-Wars-2-Erfolge, das komplett im Browser läuft:

- **Suche**: Du findest jeden Erfolg über Name, Beschreibung oder ID.
- **Run-Through**: Für einen Erfolg siehst du
  - offene **Voraussetzungen** (rekursiv, in der richtigen Reihenfolge),
  - alle **Einzelschritte** (Objekte, Items, Skins, Minis) mit deinem Stand aus der API. Erledigte Schritte werden abgehakt, die übrigen kannst du manuell abhaken,
  - pro offenem Schritt den **Wiki-Hinweis** (passende Zeile aus der Wiki-Tabelle, z. B. mit Fundort) oder auf Knopfdruck den Abschnitt „Erwerb/Acquisition“ der Item-Seite,
  - den **kompletten Wiki-Guide**, aufgeteilt in Abschnitte. Walkthrough, Ziele und Sammlung sind dabei aufgeklappt.
- **Leichte AP**: Alle offenen Erfolge, sortiert nach geschätzter Leichtigkeit (AP der nächsten Stufe ÷ √fehlende Schritte × Fortschritt). Du kannst nach Gruppe, PvP, Wiederholbarkeit, gesperrten Erfolgen und Mindest-Fortschritt filtern. Tägliche und nicht mehr kategorisierte (meist unerreichbare) Erfolge sind ausgeblendet.

## Starten

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
| `js/db.js` | IndexedDB-Cache (die Erfolgsdaten werden 7 Tage gecacht) |

Die Wiki-Inhalte stammen aus dem [Guild Wars 2 Wiki](https://wiki.guildwars2.com) (CC BY-NC-SA 3.0).
Guild Wars 2 © ArenaNet. Dies ist ein inoffizielles Fan-Tool.
