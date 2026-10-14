#!/usr/bin/env bash
# Local Postgres for development and integration tests.
# No node or postgres on the host is required; everything runs in Docker.
set -euo pipefail

NAME=sr-pg
# 55433, not 55432: docker-compose.yml publishes the application database on
# 55432. Sharing the port means whichever starts second silently fails to bind,
# and the test suite then connects to the compose database with the wrong
# credentials — every test "fails" for a reason that has nothing to do with the
# code. Keep the two apart.
PORT=${PORT:-55433}

case "${1:-up}" in
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" \
      -e POSTGRES_USER=sr -e POSTGRES_PASSWORD=sr -e POSTGRES_DB=service_records \
      -p "$PORT":5432 postgres:18-alpine >/dev/null
    printf 'waiting for postgres'
    for _ in $(seq 1 60); do
      if docker exec "$NAME" pg_isready -U sr -d service_records >/dev/null 2>&1; then
        echo " ready on localhost:$PORT"; exit 0
      fi
      printf '.'; sleep 1
    done
    echo " timed out"; exit 1
    ;;
  down) docker rm -f "$NAME" >/dev/null 2>&1 || true; echo "stopped" ;;
  psql) docker exec -it "$NAME" psql -U sr -d service_records ;;
  *) echo "usage: $0 {up|down|psql}"; exit 1 ;;
esac
