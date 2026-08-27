#!/usr/bin/env bash
# Run a node command against the project without installing node on the host.
#   scripts/node.sh npm install
#   scripts/node.sh npm test
set -euo pipefail
exec docker run --rm --network host \
  -v "$PWD":/app -w /app \
  -e DATABASE_URL="${DATABASE_URL:-postgres://sr:sr@127.0.0.1:55433/service_records}" \
  node:22-alpine "$@"
