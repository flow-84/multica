# Official Multica web image without the package managers Node ships with (npm, npx, corepack,
# yarn) and with current Alpine packages. The image only runs `node apps/web/server.js`; the
# bundled npm alone carried 10 high and 12 medium findings (brace-expansion, ip-address, pacote,
# picomatch, sigstore, ...), Alpine zlib one more (MS-3002).
# Refresh the base: docker compose -f docker-compose.selfhost.yml build --pull frontend
# (make selfhost and ~/.multica/update-selfhost.sh do this after pulling the backend).
ARG BASE_IMAGE=ghcr.io/multica-ai/multica-web:latest
FROM ${BASE_IMAGE}
USER root
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && ! command -v npm
USER nextjs
