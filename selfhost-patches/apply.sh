#!/bin/bash
# Applies every selfhost-patches/*.sql to the live self-hosted Multica database. Called by
# ~/.multica/update-selfhost.sh after each backend update; safe to run any time (patches are
# idempotent). A patch with a tests/<name>.test.sql is first loaded together with its test in one
# rolled-back transaction and only applied when the test passes.
# Exit code 1 when any patch failed; prints one line per patch.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PSQL=(docker exec -i -e PGOPTIONS='-c client_min_messages=warning'
  "${MULTICA_PG_CONTAINER:-multica-postgres-1}" psql -U multica -d multica -v ON_ERROR_STOP=1 -q)

rc=0
for patch in "$DIR"/*.sql; do
  name="$(basename "$patch" .sql)"
  test="$DIR/tests/$name.test.sql"
  if [ -f "$test" ] && ! { echo 'BEGIN;'; cat "$patch" "$test"; echo 'ROLLBACK;'; } | "${PSQL[@]}"; then
    echo "$name: TEST FEHLGESCHLAGEN, nicht angewendet"
    rc=1
    continue
  fi
  if "${PSQL[@]}" <"$patch"; then
    echo "$name: angewendet"
  else
    echo "$name: FEHLGESCHLAGEN"
    rc=1
  fi
done
exit $rc
