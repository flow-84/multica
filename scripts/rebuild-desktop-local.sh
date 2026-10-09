#!/usr/bin/env bash
# Build the desktop app from the current checkout and install it over the
# local /Applications/Multica.app, keeping exactly one backup of the previous
# app in a fixed place. Every local rebuild goes through this script so old
# app copies never pile up (~730 MB each).
#
# Overrides (used by the test):
#   MULTICA_APP_DEST           install target (default /Applications/Multica.app)
#   MULTICA_DESKTOP_STATE_DIR  backup + log dir (default ~/.local/state/multica-desktop)
#   MULTICA_BUILT_APP          skip the build and install this .app instead
#
# The script does not quit the running app: the agent daemon lives inside it.
# Restart Multica afterwards to run the new build.
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_dest="${MULTICA_APP_DEST:-/Applications/Multica.app}"
state_dir="${MULTICA_DESKTOP_STATE_DIR:-$HOME/.local/state/multica-desktop}"
backup="$state_dir/Multica.app.previous"
log="$state_dir/build.log"

mkdir -p "$state_dir"

if [ -n "${MULTICA_BUILT_APP:-}" ]; then
  built_app="$MULTICA_BUILT_APP"
else
  built_app="$root_dir/apps/desktop/dist/mac-arm64/Multica.app"
  echo "Building desktop app (log: $log)"
  if ! (cd "$root_dir/apps/desktop" &&
    CSC_IDENTITY_AUTO_DISCOVERY=false pnpm package -- --mac --arm64 --dir) >"$log" 2>&1; then
    echo "Build failed, nothing installed. See $log" >&2
    exit 1
  fi
fi

if [ ! -d "$built_app/Contents" ]; then
  echo "Built app not found: $built_app" >&2
  exit 1
fi

# Drop the old backup first: the disk is the tight resource here.
rm -rf "$backup"
if [ -d "$app_dest" ]; then
  mv "$app_dest" "$backup"
fi

if ! ditto "$built_app" "$app_dest"; then
  echo "Install failed, restoring previous app" >&2
  rm -rf "$app_dest"
  if [ -d "$backup" ]; then
    mv "$backup" "$app_dest"
  fi
  exit 1
fi

echo "Installed $app_dest (previous app: $backup)"

legacy=()
while IFS= read -r path; do
  legacy+=("$path")
done < <(find "$state_dir" "$HOME/.multica/app-backup" -maxdepth 1 -name '*.app*' \
  ! -path "$backup" ! -path "$state_dir" 2>/dev/null | sort)
if [ "${#legacy[@]}" -gt 0 ]; then
  echo "Other app copies not managed by this script (not removed):"
  du -sh "${legacy[@]}" 2>/dev/null | sed 's/^/  /'
fi

echo "Restart Multica to run the new build."
