#!/usr/bin/env bash
# Installs or updates the connector on this MacBook: copies the code to a
# stable location (independent of which branch ~/multica has checked out),
# writes the LaunchAgent, restarts it, publishes it through a Cloudflare
# tunnel, installs the reachability watchdog and checks health. Idempotent;
# rerun after every change.
set -euo pipefail

LABEL=com.fl0w.multica-claude-connector
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/.local/share/multica-claude-connector/app"
STATE="$HOME/.local/state/multica-claude-connector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"
PORT=8791
# Public through a Cloudflare tunnel, not Tailscale Funnel: on 22.10.2026
# Tailscale silently dropped the public DNS record of the Funnel host while the
# admin console still showed Funnel as active, and claude.ai lost the connector.
PUBLIC_HOST="${CONNECTOR_PUBLIC_HOST:-mcp.aetherapulse.io}"
PUBLIC_URL="https://$PUBLIC_HOST"
TUNNEL=multica-connector
CF_DIR="$HOME/.cloudflared"
# Origin cert of the Cloudflare zone aetherapulse.io (account fl0w).
export TUNNEL_ORIGIN_CERT="$CF_DIR/cert-aetherapulse.pem"
CF_CONFIG="$CF_DIR/config-$TUNNEL.yml"
CF_LABEL="com.cloudflared.$TUNNEL"
CF_PLIST="$HOME/Library/LaunchAgents/$CF_LABEL.plist"
WD_LABEL="$LABEL-watchdog"
WD_PLIST="$HOME/Library/LaunchAgents/$WD_LABEL.plist"

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
load() {
  launchctl bootout "gui/$UID/$1" 2>/dev/null || true
  for _ in $(seq 1 20); do
    launchctl print "gui/$UID/$1" >/dev/null 2>&1 || break
    sleep 0.5
  done
  launchctl bootstrap "gui/$UID" "$2"
}
load "$LABEL" "$PLIST"

# Old Tailscale Funnel mounts; the Multica web app on 443 stays untouched.
for p in /mcp /mcp-oauth /.well-known/oauth-protected-resource /.well-known/oauth-authorization-server; do
  tailscale funnel --https=443 --set-path="$p" off >/dev/null 2>&1 || true
done

tunnel_id() {
  cloudflared tunnel list --output json 2>/dev/null | /usr/bin/python3 -I -c \
    'import json,sys; print(next((t["id"] for t in (json.load(sys.stdin) or []) if t["name"]==sys.argv[1]), ""))' "$TUNNEL"
}
id="$(tunnel_id)"
if [ -z "$id" ]; then
  cloudflared tunnel create "$TUNNEL" >/dev/null
  id="$(tunnel_id)"
fi
cloudflared tunnel route dns --overwrite-dns "$id" "$PUBLIC_HOST"
cat >"$CF_CONFIG" <<YML
# Written by multica/tools/claude-connector/launchd/install.sh, do not edit.
tunnel: $id
credentials-file: $CF_DIR/$id.json
ingress:
  - hostname: $PUBLIC_HOST
    service: http://127.0.0.1:$PORT
  - service: http_status:404
YML
cat >"$CF_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$CF_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(command -v cloudflared)</string>
		<string>tunnel</string>
		<string>--config</string>
		<string>$CF_CONFIG</string>
		<string>run</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>30</integer>
	<key>StandardOutPath</key>
	<string>$STATE/tunnel.log</string>
	<key>StandardErrorPath</key>
	<string>$STATE/tunnel.log</string>
</dict>
</plist>
PLIST
load "$CF_LABEL" "$CF_PLIST"

install -m 755 "$SRC/launchd/watchdog.sh" "$STATE/watchdog.sh"
cat >"$WD_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$WD_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$STATE/watchdog.sh</string>
		<string>$PUBLIC_URL</string>
	</array>
	<key>StartInterval</key>
	<integer>300</integer>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$STATE/watchdog.log</string>
	<key>StandardErrorPath</key>
	<string>$STATE/watchdog.log</string>
</dict>
</plist>
PLIST
load "$WD_LABEL" "$WD_PLIST"

for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null
echo "lokal ok: http://127.0.0.1:$PORT"
for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$PUBLIC_URL/mcp")" = 401 ] && break
  sleep 2
done
status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$PUBLIC_URL/mcp")"
[ "$status" = 401 ] || { echo "öffentlich: erwartet 401, bekam $status" >&2; exit 1; }
echo "öffentlich ok: $PUBLIC_URL/mcp"
