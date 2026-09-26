#!/bin/sh
# Entry point for the hosted AI gateway container.
# Railway mounts volumes owned by root; fix ownership, then drop privileges.
set -eu

DB_PATH="${AI_GATEWAY_DB_PATH:-/data/ai-gateway.sqlite}"
DB_DIR="$(dirname "$DB_PATH")"
NODE_ARGS="--disable-warning=ExperimentalWarning /app/dist/server.mjs"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DB_DIR"
  if [ "$DB_DIR" != "/" ]; then
    chown -R node:node "$DB_DIR"
  fi
  # shellcheck disable=SC2086
  exec setpriv --reuid=node --regid=node --init-groups node $NODE_ARGS
fi

# shellcheck disable=SC2086
exec node $NODE_ARGS
