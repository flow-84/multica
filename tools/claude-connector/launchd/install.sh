#!/usr/bin/env bash
# Installs or updates the connector on this MacBook: copies the code to a
# stable location (independent of which branch ~/multica has checked out),
# writes the LaunchAgent, restarts it, mounts the public paths on Tailscale
# Funnel and checks health. Idempotent; rerun after every change.
set -euo pipefail

LABEL=com.fl0w.multica-claude-connector
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/.local/share/multica-claude-connector/app"
STATE="$HOME/.local/state/multica-claude-connector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"
PORT=8791
# Funnel only allows 443, 8443 and 10000, all taken. claude.ai only reaches
# connectors on 443, which serves the Multica web app (127.0.0.1:3000); the
# connector paths are mounted beside it (the web app uses none of them).
FUNNEL_PORT=443
PUBLIC_HOST="$(tailscale status --json | /usr/bin/python3 -I -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
PUBLIC_URL="https://$PUBLIC_HOST"

mkdir -p "$APP" "$STATE"
rsync -a --delete "$SRC/src" "$SRC/package.json" "$SRC/package-lock.json" "$APP/"
(cd "$APP" && npm ci --omit=dev --silent)

cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$NODE</string>
		<string>$APP/src/main.ts</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>CONNECTOR_PORT</key>
		<string>$PORT</string>
		<key>CONNECTOR_PUBLIC_URL</key>
		<string>$PUBLIC_URL</string>
		<key>MULTICA_API_URL</key>
		<string>http://localhost:8080</string>
		<key>MULTICA_WORKSPACE_ID</key>
		<string>50b08bfb-a5fe-426f-b012-5da67a25d153</string>
		<key>CONNECTOR_ALLOWED_EMAIL</key>
		<string>info@model2star.com</string>
		<key>CONNECTOR_ALLOWED_USER_ID</key>
		<string>46ece536-d531-4ef9-a493-be97b0118e06</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>WorkingDirectory</key>
	<string>$APP</string>
	<key>StandardOutPath</key>
	<string>$STATE/connector.log</string>
	<key>StandardErrorPath</key>
	<string>$STATE/connector.log</string>
</dict>
</plist>
PLIST

# bootout returns before the job is gone; bootstrap fails with EIO until then.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
for _ in $(seq 1 20); do
  launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl bootstrap "gui/$UID" "$PLIST"

# Tailscale strips the mount point before proxying, so each target repeats it.
# `tailscale funnel`, not `serve`: `serve` on a funneled port turns the public
# Funnel off for the whole port, the Multica web app included.
for p in /mcp /mcp-oauth /.well-known/oauth-protected-resource /.well-known/oauth-authorization-server; do
  tailscale funnel --bg --https=$FUNNEL_PORT --set-path="$p" "http://127.0.0.1:$PORT$p" >/dev/null
done
tailscale serve status --json | /usr/bin/python3 -I -c "import json,sys; sys.exit(0 if json.load(sys.stdin)['AllowFunnel'].get('$PUBLIC_HOST:$FUNNEL_PORT') else 1)" \
  || { echo "Funnel auf $FUNNEL_PORT ist aus" >&2; exit 1; }

for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null
echo "lokal ok: http://127.0.0.1:$PORT"
status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$PUBLIC_URL/mcp")"
[ "$status" = 401 ] || { echo "öffentlich: erwartet 401, bekam $status" >&2; exit 1; }
echo "öffentlich ok: $PUBLIC_URL/mcp"
