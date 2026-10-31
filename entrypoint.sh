#!/bin/sh
set -e

# BookSeerr runs as a NON-root user. But the bind-mounted ./data on the host is
# often root-owned, which would stop the app writing db.json (and silently break
# persistence). So: while we're still root, make sure the data dir exists and is
# owned by the runtime user, THEN drop privileges and run the app. This keeps your
# data writable no matter who owns the host directory.

DATA_DIR="${DATA_DIR:-/app/data}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

mkdir -p "$DATA_DIR"
# Cheap no-op on restarts when ownership already matches.
chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  exec su-exec "$PUID:$PGID" "$@"
else
  # Already unprivileged (e.g. compose `user:` set) — just run.
  exec "$@"
fi
