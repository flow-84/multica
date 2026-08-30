#!/usr/bin/env bash
# Tauscht nur den Symlink /opt/homebrew/bin/multica auf den lokal gebauten Stand
# (inkl. MS-121-Fix) um, statt die read-only Homebrew-Cellar-Datei zu überschreiben.
set -euo pipefail
LINK=/opt/homebrew/bin/multica
BUILT=/Users/fl0w/multica/server/bin/multica

[ -x "$BUILT" ] || { echo "fehlt: $BUILT (erst 'go build -o bin/multica ./cmd/multica' im server/-Verzeichnis)"; exit 1; }

ORIGINAL_TARGET=$(readlink "$LINK")
echo "$ORIGINAL_TARGET" > /Users/fl0w/multica/scripts/.daemon-swap-original-target
ln -sf "$BUILT" "$LINK"

multica --profile desktop-localhost-8080 daemon restart
echo
echo "Symlink zeigt jetzt auf den lokalen Build. Original war: $ORIGINAL_TARGET"
echo "Rueckweg: ln -sf \"$ORIGINAL_TARGET\" $LINK   (Pfad ist relativ zu /opt/homebrew/bin, cd dorthin vorher)"
