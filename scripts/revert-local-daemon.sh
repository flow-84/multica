#!/usr/bin/env bash
# Dreht den Binary-Swap aus swap-local-daemon.sh zurueck: Symlink wieder auf das
# offizielle Homebrew-Binary (0.4.18), Daemon-Neustart. Grund: der lokale Build
# war 420 Commits hinter Upstream und inkompatibel mit einer anderen Komponente
# (execenv-Helper) -> alle neuen Agent-Runs schlugen fehl.
set -euo pipefail
LINK=/opt/homebrew/bin/multica
ORIGINAL=$(cat /Users/fl0w/multica/scripts/.daemon-swap-original-target)

cd /opt/homebrew/bin
ln -sf "$ORIGINAL" multica

multica --profile desktop-localhost-8080 daemon restart
multica --profile desktop-localhost-8080 daemon status
