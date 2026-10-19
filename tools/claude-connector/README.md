# Multica-Connector für Claude

Mit diesem Connector steuert fl0w den Multica-Workspace `m2s` aus claude.ai im Browser und aus der Claude-App auf Android, auch im Sprachmodus. Es ist ein Remote-MCP-Server (Streamable HTTP, zustandslos) mit OAuth 2.1, PKCE und Dynamic Client Registration. Er läuft als LaunchAgent auf dem MacBook und ist über Tailscale Funnel erreichbar. (MS-2400)

## Connector-URL

```
https://macbook-air-von-fl0w.taildc41c0.ts.net/mcp
```

## Einrichtung in claude.ai

1. claude.ai → Anpassungen → Konnektoren → „Konnektor hinzufügen“ → „Benutzerdefinierten Konnektor hinzufügen“.
2. Name `Multica`, MCP-Server-URL wie oben, dann „Weiter“. Die Vorgaben „Jetzt anmelden“ und „Automatisch registrieren“ bleiben stehen, dann „Hinzufügen“.
3. „Verbinden“ öffnet die Login-Seite des Connectors. Dort muss als Ziel `claude.ai` stehen. „Login-Code an i***@model2star.com senden“ antippen, den sechsstelligen Code aus der Multica-Mail eingeben und „Anmelden und verbinden“ antippen.
4. Unter Tool-Berechtigungen dürfen die vier Lese-Werkzeuge immer laufen. Die drei schreibenden Werkzeuge fragen nach einer Genehmigung.

Die Android-App übernimmt den Connector automatisch aus dem Konto.

## Werkzeuge

| Werkzeug | Zweck |
| --- | --- |
| `list_issues` | Issues filtern nach Projekt, Status, Zuständigem, Zeitraum (`days`) oder Suchbegriff (`query`). Ohne Status kommen die offenen. |
| `get_issue` | Ein Issue mit Beschreibung und den letzten drei Kommentaren |
| `create_issue` | Issue anlegen (Projekt, Titel, Beschreibung, Zuständiger, Status, Priorität). Standard ist `backlog`. |
| `update_issue` | Status und/oder Zuständigen ändern. `niemand` entfernt den Zuständigen. |
| `add_comment` | Kommentar als fl0w |
| `system_status` | Daemon und Laufzeiten, arbeitende Agenten, Issues in Arbeit |
| `list_projects` | Projektnamen, aktive zuerst |

Alle Antworten sind kurze deutsche Sätze ohne IDs und ohne Markdown, damit sie sich gut vorlesen lassen. Projekte und Zuständige werden über ihren Namen gefunden, Issues über ihre Kennung (auch „ms 2400“). Ein `todo` mit einem Agenten als Zuständigem startet sofort einen Lauf, die Antwort sagt das dazu.

## Beispielsätze

- „Was ist im Projekt CRM gerade offen?“
- „Welche Issues hat der Builder in den letzten drei Tagen bearbeitet?“
- „Such mir das Issue zum Promo-Postfach.“
- „Lies mir MS-2400 vor.“
- „Leg im Projekt Multica ein Issue an: Daemon-Log aufräumen, für den Builder, Status Backlog.“
- „Setz MS-2401 auf erledigt und schreib dazu: geprüft.“
- „Läuft der Daemon? Wer arbeitet gerade?“

## Anmeldung und Sicherheit

- Ohne Token antwortet `/mcp` mit `401` und `WWW-Authenticate: Bearer resource_metadata=…`. Daran erkennt claude.ai, dass OAuth nötig ist.
- Der Login läuft über den Mail-Code von Multica. Die Seite schickt den Code nur an die fest eingestellte Adresse und nimmt keine andere an, kann also keine Multica-Konten anlegen. Nach dem Code muss die Multica-User-ID die von fl0w sein (`CONNECTOR_ALLOWED_USER_ID`).
- Die Multica-Sitzung aus diesem Login (30 Tage gültig) ist die Berechtigung, mit der die Werkzeuge arbeiten. Kommentare und Änderungen erscheinen deshalb in Multica als fl0w. Lehnt Multica die Sitzung ab, widerruft der Connector die Anmeldung, und Claude verlangt einen neuen Login.
- Eigene Tokens sind zufällig erzeugt und werden nur als SHA-256-Hash gespeichert: Access-Token 1 Stunde, Refresh-Token 30 Tage und rotierend, Code 10 Minuten und einmalig. „Trennen“ in claude.ai widerruft den Refresh-Token und damit sofort die ganze Anmeldung.
- Jede schreibende Aktion, jeder Login-Versuch und jeder Fehler landet in der Tabelle `audit` in `~/.local/state/multica-claude-connector/connector.db`.

## Erreichbarkeit

claude.ai ruft Connectoren aus dem Internet auf. Ein Cloud-Server kommt nicht in Frage, deshalb läuft Tailscale Funnel auf dem MacBook. Funnel erlaubt nur die Ports 443, 8443 und 10000, und alle drei sind belegt. Auf Port 8443 kommt claude.ai nicht an: Beim Hinzufügen meldete es „Diese Adresse konnte nicht erreicht werden“, und am Server kam keine Anfrage an. Die Connector-Pfade hängen deshalb auf Port 443 neben dem Multica-Web (`127.0.0.1:3000`), das keinen davon benutzt:

| Pfad | Ziel |
| --- | --- |
| `/mcp` | `127.0.0.1:8791/mcp` |
| `/mcp-oauth` | `127.0.0.1:8791/mcp-oauth` |
| `/.well-known/oauth-protected-resource` | `127.0.0.1:8791/.well-known/oauth-protected-resource` |
| `/.well-known/oauth-authorization-server` | `127.0.0.1:8791/.well-known/oauth-authorization-server` |

Tailscale schneidet den Mount-Pfad vor dem Weiterleiten ab, deshalb wiederholt jedes Ziel ihn. Die Pfade setzt `tailscale funnel --set-path`, nicht `tailscale serve`: `serve` auf einem Funnel-Port schaltet den öffentlichen Funnel für den ganzen Port ab.

## Betrieb

```bash
bash tools/claude-connector/launchd/install.sh   # installieren oder aktualisieren, idempotent
```

Das Skript kopiert den Code nach `~/.local/share/multica-claude-connector/app` (unabhängig vom Branch, der in `~/multica` ausgecheckt ist), schreibt den LaunchAgent `com.fl0w.multica-claude-connector` mit `KeepAlive`, startet ihn neu, setzt die Funnel-Pfade und prüft lokal `/healthz` und öffentlich `401` auf `/mcp`.

- Log: `~/.local/state/multica-claude-connector/connector.log`, eine Zeile je Anfrage mit JSON-RPC-Methode, ohne Query-Strings.
- Neustart: `launchctl kickstart -k gui/$UID/com.fl0w.multica-claude-connector`
- Abschalten: `launchctl bootout gui/$UID/com.fl0w.multica-claude-connector`, danach je Pfad `tailscale funnel --https=443 --set-path=<pfad> off`

claude.ai fragt zuerst `server/discover` mit einer neueren Protokollversion im Header `mcp-protocol-version` ab. SDK 1.32.1 (die neueste Version am 19.10.2026) kennt diese Version nicht und antwortet `400 Unsupported protocol version`. Danach verhandelt claude.ai über `initialize` eine unterstützte Version. Diese 400er im Log sind deshalb erwartet.

## Entwicklung

```bash
cd tools/claude-connector
npm ci
npm test          # 36 Tests: OAuth Ende zu Ende und alle Werkzeuge gegen eine nachgebaute Multica-API
npm run typecheck
```

Node 24 oder neuer führt die `.ts`-Dateien direkt aus, ohne Build-Schritt. Gespeichert wird mit dem eingebauten `node:sqlite`.
