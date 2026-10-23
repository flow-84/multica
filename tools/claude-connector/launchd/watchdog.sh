#!/usr/bin/env bash
# Checks every few minutes (LaunchAgent, see install.sh) that the connector is
# reachable from the internet the way claude.ai reaches it, and tells fl0w on
# Telegram when that changes, so an outage shows up before it is needed.
set -uo pipefail

URL="${1:?public base url}"
STATE="$HOME/.local/state/multica-claude-connector"
LAST="$STATE/watchdog.status"
SECRETS="$HOME/.secrets/multiversemedia-alert-telegram"

probe() { curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST "$URL/mcp"; }

code="$(probe)"
# One retry, so a single dropped request is not an alarm.
[ "$code" = 401 ] || { sleep 20; code="$(probe)"; }
[ "$code" = 401 ] && now=ok || now=down
before="$(cat "$LAST" 2>/dev/null || echo ok)"
echo "$(date -u +%FT%TZ) $now $code"
[ "$now" = "$before" ] && exit 0

if [ "$now" = down ]; then
  text="Multica-Connector für Claude ist von außen nicht erreichbar ($URL/mcp antwortet $code). Prüfen: launchctl list | grep -E 'multica-claude-connector|cloudflared.multica-connector'"
else
  text="Multica-Connector für Claude ist wieder erreichbar ($URL/mcp)."
fi
set -a
# shellcheck disable=SC1090
. "$SECRETS"
set +a
curl -s -m 15 -o /dev/null -w 'telegram %{http_code}\n' \
  "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
  --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" --data-urlencode "text=$text" \
  && echo "$now" >"$LAST"
