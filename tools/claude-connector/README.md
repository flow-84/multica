# Multica-Connector für Claude

Mit diesem Connector steuert fl0w den Multica-Workspace `m2s` aus claude.ai im Browser und aus der Claude-App auf Android, auch im Sprachmodus. Es ist ein Remote-MCP-Server (Streamable HTTP, zustandslos) mit OAuth 2.1, PKCE und Dynamic Client Registration. Er läuft als LaunchAgent auf dem MacBook und ist über einen Cloudflare-Tunnel erreichbar. (MS-2400)

## Connector-URL

```
https://mcp.aetherapulse.io/mcp
```

## Einrichtung in claude.ai

1. claude.ai → Anpassungen → Konnektoren → „Konnektor hinzufügen“ → „Benutzerdefinierten Konnektor hinzufügen“.
2. Name `Multica`, MCP-Server-URL wie oben, dann „Weiter“. Die Vorgaben „Jetzt anmelden“ und „Automatisch registrieren“ bleiben stehen, dann „Hinzufügen“.
3. „Verbinden“ öffnet die Login-Seite des Connectors. Dort muss als Ziel `claude.ai` stehen. „Login-Code an i***@model2star.com senden“ antippen, den sechsstelligen Code aus der Multica-Mail eingeben und „Anmelden und verbinden“ antippen.
4. Unter Tool-Berechtigungen dürfen die fünf Lese-Werkzeuge immer laufen. Die sieben schreibenden Werkzeuge fragen nach einer Genehmigung.

Die Android-App übernimmt den Connector automatisch aus dem Konto.

## Werkzeuge

| Werkzeug | Zweck |
| --- | --- |
| `list_issues` | Issues filtern nach Projekt, Status, Zuständigem, Oberkarte (`parent`), Zeitraum (`days`) oder Suchbegriff (`query`). Ohne Status kommen die offenen, unter einer Oberkarte alle. Bis 100 je Seite, weiter mit `page`. Die Zahl ist die Gesamtzahl aus Multica. Wo eine Seitengrenze greift (Zeitraum über 100 Treffer, Suche 50), heißt es „mindestens“. |
| `get_issue` | Ein Issue mit Beschreibung, Oberkarte, Unterkarten und den letzten drei Kommentaren |
| `create_issue` | Issue anlegen (Projekt, Titel, Beschreibung, Zuständiger, Status, Priorität), dazu Oberkarte (`parent`, `stage`), Abhängigkeiten (`blocked_by`, `blocks`) und vorhandene Labels. Standard ist `backlog`. |
| `update_issue` | Status und/oder Zuständigen ändern. `niemand` entfernt den Zuständigen. |
| `bulk_update_issues` | Status und/oder Zuständigen für bis zu 50 Kennungen oder für alle offenen Unterkarten einer Oberkarte setzen |
| `archive_issue` | Versehentliche Karte abbrechen, auf Wunsch als Duplikat einer anderen. Gelöscht wird nichts. |
| `add_comment` | Kommentar als fl0w |
| `create_project` | Neues Projekt mit Name, Beschreibung und Status (Standard aktiv) |
| `update_project` | Projekt umbenennen, Beschreibung ersetzen, Status ändern oder archivieren (Status `cancelled`, Karten bleiben) |
| `get_project` | Projekt mit Beschreibung, Karten je Status und letzter Änderung |
| `system_status` | Daemon und Laufzeiten, arbeitende Agenten, Issues in Arbeit |
| `list_projects` | Projektnamen, aktive zuerst |

Multica hat kein eigenes Feld für Abhängigkeiten. `blocked_by` und `blocks` tragen deshalb in die wartende Karte die Zeile „Wartet auf: MS-…“ ein und legen, wenn ein Agent zuständig ist, einen Wecker an, der ihn startet, sobald die Vorgängerkarte erledigt ist. Ohne Agenten bleibt es bei der Zeile. Eine wartende Karte mit Agent wird nicht auf `todo` angelegt, sonst liefe der Agent sofort los.

Alle Antworten sind kurze deutsche Sätze ohne IDs und ohne Markdown, damit sie sich gut vorlesen lassen. Projekte und Zuständige werden über ihren Namen gefunden, Issues über ihre Kennung (auch „ms 2400“). Ein `todo` mit einem Agenten als Zuständigem startet sofort einen Lauf, die Antwort sagt das dazu.

## Beispielsätze

- „Was ist im Projekt CRM gerade offen?“
- „Welche Issues hat der Builder in den letzten drei Tagen bearbeitet?“
- „Such mir das Issue zum Promo-Postfach.“
- „Lies mir MS-2400 vor.“
- „Leg im Projekt Multica ein Issue an: Daemon-Log aufräumen, für den Builder, Status Backlog.“
- „Setz MS-2401 auf erledigt und schreib dazu: geprüft.“
- „Läuft der Daemon? Wer arbeitet gerade?“
- „Leg ein Projekt Website-Relaunch an und darin eine Karte Konzept mit den Unterkarten Texte und Design. Design wartet auf Texte.“
- „Setz alle offenen Unterkarten von MS-2700 auf abgebrochen.“
- „Wie steht das Projekt CRM?“

## Anmeldung und Sicherheit

- Ohne Token antwortet `/mcp` mit `401` und `WWW-Authenticate: Bearer resource_metadata=…`. Daran erkennt claude.ai, dass OAuth nötig ist.
- Der Login läuft über den Mail-Code von Multica. Die Seite schickt den Code nur an die fest eingestellte Adresse und nimmt keine andere an, kann also keine Multica-Konten anlegen. Nach dem Code muss die Multica-User-ID die von fl0w sein (`CONNECTOR_ALLOWED_USER_ID`).
- Die Multica-Sitzung aus diesem Login (30 Tage gültig) ist die Berechtigung, mit der die Werkzeuge arbeiten. Kommentare und Änderungen erscheinen deshalb in Multica als fl0w. Lehnt Multica die Sitzung ab, widerruft der Connector die Anmeldung, und Claude verlangt einen neuen Login.
- Eigene Tokens sind zufällig erzeugt und werden nur als SHA-256-Hash gespeichert: Access-Token 1 Stunde, Refresh-Token 30 Tage und rotierend, Code 10 Minuten und einmalig. „Trennen“ in claude.ai widerruft den Refresh-Token und damit sofort die ganze Anmeldung.
- Jede schreibende Aktion, jeder Login-Versuch und jeder Fehler landet in der Tabelle `audit` in `~/.local/state/multica-claude-connector/connector.db`.

## Erreichbarkeit

claude.ai ruft Connectoren aus dem Internet auf. Ein Cloud-Server kommt nicht in Frage, deshalb läuft ein Cloudflare-Tunnel (`multica-connector`, Zone `aetherapulse.io`) auf dem MacBook. Er leitet nur `https://mcp.aetherapulse.io` auf `127.0.0.1:8791` und verrät keine anderen Dienste des Macs. In claude.ai lautet die Connector-Adresse `https://mcp.aetherapulse.io/mcp`.

Bis 24.10.2026 lief der Connector über Tailscale Funnel. Am 22.10.2026 abends hat Tailscale den öffentlichen DNS-Eintrag von `macbook-air-von-fl0w.taildc41c0.ts.net` entfernt, obwohl die Konsole Funnel weiter als aktiv zeigte. Neu anmelden, Funnel umschalten und `tailscale funnel reset` mit Wiederherstellung holten ihn nicht zurück, und claude.ai meldete „Multica konnte nicht erreicht werden“.

Ein Wächter (`com.fl0w.multica-claude-connector-watchdog`, alle 5 Minuten) ruft `/mcp` über die öffentliche Adresse auf und meldet jeden Wechsel zwischen erreichbar und nicht erreichbar per Telegram an fl0w (Secret `multiversemedia-alert-telegram`).

## Betrieb

```bash
bash tools/claude-connector/launchd/install.sh   # installieren oder aktualisieren, idempotent
```

Das Skript kopiert den Code nach `~/.local/share/multica-claude-connector/app` (unabhängig vom Branch, der in `~/multica` ausgecheckt ist), schreibt den LaunchAgent `com.fl0w.multica-claude-connector` mit `KeepAlive`, startet ihn neu, legt den Tunnel samt DNS-Eintrag an (`com.cloudflared.multica-connector`), installiert den Wächter, entfernt die alten Funnel-Pfade und prüft lokal `/healthz` und öffentlich `401` auf `/mcp`.

- Log: `~/.local/state/multica-claude-connector/connector.log`, eine Zeile je Anfrage mit JSON-RPC-Methode, ohne Query-Strings.
- Neustart: `launchctl kickstart -k gui/$UID/com.fl0w.multica-claude-connector`
- Tunnel-Log: `~/.local/state/multica-claude-connector/tunnel.log`, Wächter-Log: `watchdog.log` daneben.
- Abschalten: `launchctl bootout` für `com.fl0w.multica-claude-connector`, `com.cloudflared.multica-connector` und `com.fl0w.multica-claude-connector-watchdog`.

claude.ai fragt zuerst `server/discover` mit einer neueren Protokollversion im Header `mcp-protocol-version` ab. SDK 1.32.1 (die neueste Version am 19.10.2026) kennt diese Version nicht und antwortet `400 Unsupported protocol version`. Danach verhandelt claude.ai über `initialize` eine unterstützte Version. Diese 400er im Log sind deshalb erwartet.

## Entwicklung

```bash
cd tools/claude-connector
npm ci
npm test          # 67 Tests: OAuth Ende zu Ende, alle Werkzeuge und Seitengrenzen gegen eine nachgebaute Multica-API
npm run typecheck
```

Node 24 oder neuer führt die `.ts`-Dateien direkt aus, ohne Build-Schritt. Gespeichert wird mit dem eingebauten `node:sqlite`.
