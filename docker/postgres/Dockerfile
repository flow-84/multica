# pgvector/pgvector:pg17 with gosu replaced by setpriv. Upstream ships gosu 1.19 built with
# Go 1.24.6, which carries the critical stdlib finding CVE-2025-68121; gosu 1.20 uses the same
# Go release, so a newer gosu does not help (MS-3619). setpriv comes from util-linux, a C
# program already in the base image.
# Refresh the base: docker compose -f docker-compose.selfhost.yml build --pull postgres
# Drop this file and go back to the upstream image once it ships a gosu built with a fixed Go.
FROM pgvector/pgvector:pg17
# Debian point fixes land before the next upstream build (apt, libsasl2, tzdata on 2026-11-11).
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /usr/local/bin/gosu
# A separate layer on purpose: Trivy drops a file from a lower layer only for a whiteout; a file
# merely overwritten in the same layer keeps being reported (measured MS-3179).
# The wrapper keeps the gosu command line used by docker-entrypoint.sh ("gosu postgres <cmd>")
# and, like gosu, sets HOME to the target user's home while keeping the rest of the environment.
RUN printf '%s\n' \
      '#!/bin/sh' \
      'set -e' \
      'u="$1"; shift' \
      'HOME="$(getent passwd "$u" | cut -d: -f6)"' \
      'export HOME' \
      'exec setpriv --reuid="$u" --regid="$u" --init-groups "$@"' \
      > /usr/local/bin/gosu \
 && chmod 0755 /usr/local/bin/gosu \
 && gosu postgres sh -c '[ "$(id -u)" = 999 ] && [ "$HOME" = /var/lib/postgresql ]'
