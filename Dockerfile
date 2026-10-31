# ── Base image ────────────────────────────────────────────────────────────────
# Pinned to a specific patch (not :latest, not a floating major) so every rebuild
# is reproducible and you know exactly what's running in production. To go further,
# pin by immutable digest — replace the tag with:
#     node:20.18.1-alpine3.20@sha256:<digest>
# and/or build/pull with DOCKER_CONTENT_TRUST=1 so only signed images are accepted.
FROM node:20.18.1-alpine3.20

# su-exec (tiny, ~20KB) lets the entrypoint fix data-volume ownership as root and
# then drop to an unprivileged user before exec'ing node. Pin its version too.
RUN apk add --no-cache 'su-exec=0.2-r3' || apk add --no-cache su-exec

ENV NODE_ENV=production \
    PORT=8099 \
    DATA_DIR=/app/data \
    PUID=1000 \
    PGID=1000

WORKDIR /app

# Dependencies on their own cached layer. --omit=dev drops devDependencies;
# cleaning the cache keeps the final image lean.
#
# `npm ci` installs the EXACT tree recorded in package-lock.json and fails if the
# lockfile and package.json disagree. `npm install` would instead re-resolve the
# "^" ranges at build time, so two builds of the same commit could ship different
# dependency code — the gap a supply-chain attack walks through. Falls back to
# `npm install` if the lockfile hasn't been committed yet.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; \
    else npm install --omit=dev --no-audit --no-fund; fi && npm cache clean --force

# Application source (node_modules / data / .env excluded via .dockerignore).
COPY . .

RUN mkdir -p /app/data && chmod +x /app/entrypoint.sh

EXPOSE 8099

# Liveness probe against the unauthenticated /healthz route. busybox wget ships
# with alpine, so no extra package is needed.
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 || exit 1

# entrypoint fixes volume perms (as root) then drops to PUID:PGID and runs CMD.
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "server.js"]
