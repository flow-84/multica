#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

make_app() {
  mkdir -p "$1/Contents"
  printf '%s\n' "$2" >"$1/Contents/version"
}

home="$tmp_dir/home"
state_dir="$home/.local/state/multica-desktop"
app_dest="$tmp_dir/Applications/Multica.app"
mkdir -p "$home" "$tmp_dir/Applications"
make_app "$app_dest" v0
make_app "$tmp_dir/build1/Multica.app" v1
make_app "$tmp_dir/build2/Multica.app" v2
make_app "$state_dir/Multica.app.bak-202610090632" legacy

run() {
  HOME="$home" MULTICA_APP_DEST="$app_dest" MULTICA_DESKTOP_STATE_DIR="$state_dir" \
    MULTICA_BUILT_APP="$1" bash "$root_dir/scripts/rebuild-desktop-local.sh"
}

backup_count() {
  find "$state_dir" -maxdepth 1 -name 'Multica.app.previous*' | wc -l | tr -d ' '
}

run "$tmp_dir/build1/Multica.app" >"$tmp_dir/out1"
run "$tmp_dir/build2/Multica.app" >"$tmp_dir/out2"

[ "$(cat "$app_dest/Contents/version")" = v2 ] || fail "installed app is not the second build"
[ "$(backup_count)" = 1 ] || fail "want exactly one backup after two rebuilds, got $(backup_count)"
[ "$(cat "$state_dir/Multica.app.previous/Contents/version")" = v1 ] || fail "backup is not the previous build"
[ -d "$state_dir/Multica.app.bak-202610090632" ] || fail "legacy copy was removed"
grep -Fq "Multica.app.bak-202610090632" "$tmp_dir/out2" || fail "legacy copy not reported"

# A missing build leaves both the installed app and the backup untouched.
status=0
run "$tmp_dir/missing/Multica.app" >/dev/null 2>&1 || status=$?
[ "$status" -ne 0 ] || fail "missing build should fail"
[ "$(cat "$app_dest/Contents/version")" = v2 ] || fail "failed run changed the installed app"
[ "$(cat "$state_dir/Multica.app.previous/Contents/version")" = v1 ] || fail "failed run changed the backup"

# First install without an existing app creates no backup.
rm -rf "$app_dest" "$state_dir/Multica.app.previous"
run "$tmp_dir/build1/Multica.app" >/dev/null
[ "$(backup_count)" = 0 ] || fail "fresh install should not create a backup"

echo "rebuild-desktop-local tests passed"
