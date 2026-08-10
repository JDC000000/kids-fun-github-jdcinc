# KIDS FUN ingestion worker — Node LTS + headless Chromium (TSD §3A.1, §5).
# Long-running/containerised runtime (Fly.io / Railway-class or satellite process).
# NOT Vercel serverless. Exposes /healthz; headless-render capable.
#
# ── BUILD CONTEXT IS THE REPO ROOT, NOT worker/ ──────────────────────────────
#   docker build -f worker/Dockerfile -t kids-fun-worker .     # run from the repo root
#   fly deploy --config worker/fly.toml                        # likewise (see fly.toml)
#
# It used to be worker/. It had to change: worker/core/corrections-retention.ts imports
# lib/corrections/retention.ts so the `corrections_retention` job and the Vercel route share
# ONE purge implementation and ONE retention window (a compliance claim — see that file),
# and a Docker COPY cannot reach outside its context. Duplicating those modules into worker/
# would have kept the old context at the price of two definitions that can drift apart, so
# the context moved instead. .dockerignore (repo root) keeps the context small.
#
# The image layout mirrors the repo (/app/worker/**, /app/lib/**) because the emitted
# CommonJS uses relative requires — worker/dist/worker/core/corrections-retention.js does
# `require("../../lib/corrections/retention")`, which only resolves if the two trees keep
# their relative positions. That is also why the entrypoint is dist/worker/src/index.js and
# not dist/src/index.js (worker/tsconfig.json now compiles with rootDir "..").

# ── builder: compile TypeScript → dist ───────────────────────────────────────
FROM node:20-bookworm-slim AS builder
#
# node_modules is installed at /app, NOT at /app/worker, and that placement is REQUIRED.
# Node and tsc resolve a bare specifier by walking UP from the importing file, so
# /app/lib/db/client.ts (which imports `pg`) searches /app/lib/db, /app/lib, /app, / — it
# never looks inside /app/worker. Installing under /app/worker builds fine on a developer
# box only because the repo root has its own node_modules to fall back on; in the container
# there is no such fallback and the compile dies with TS2307 on `pg`. /app is the nearest
# common ancestor of both trees, and it is also where the runtime stage puts node_modules,
# so build-time and run-time resolution agree.
WORKDIR /app
COPY worker/package.json worker/package-lock.json* ./
RUN npm install --no-audit --no-fund
# package.json is copied into worker/ as well so `npm run build` runs there (same file; the
# copy at /app is what anchors node_modules).
COPY worker/package.json worker/tsconfig.json ./worker/
COPY worker/src ./worker/src
COPY worker/core ./worker/core
COPY worker/adapters ./worker/adapters
COPY worker/scheduler ./worker/scheduler
COPY worker/health ./worker/health
# The ONLY app code the worker shares. Kept to whole directories rather than individual
# files so a refactor inside them cannot silently drop a file the image needs; kept to
# these TWO directories so the shared surface stays visible and reviewable.
# tests/scheduler/worker-image-closure.test.ts fails if the worker's module closure ever
# reaches outside the paths copied here.
COPY lib/corrections ./lib/corrections
COPY lib/db ./lib/db
WORKDIR /app/worker
RUN npm run build

# ── runtime: Chromium + prod deps + compiled dist ────────────────────────────
FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    WORKER_HEALTHZ_PORT=8080

# System Chromium + rendering libs + fonts (puppeteer-core uses the system binary).
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      curl \
      fonts-liberation \
      fonts-noto-color-emoji \
      libnss3 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdrm2 \
      libgbm1 \
      libgtk-3-0 \
      libpangocairo-1.0-0 \
      libx11-xcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY worker/package.json worker/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=builder /app/worker/dist ./dist

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://localhost:${WORKER_HEALTHZ_PORT}/healthz" || exit 1

CMD ["node", "dist/worker/src/index.js"]
