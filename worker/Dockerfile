# KIDS FUN ingestion worker — Node LTS + headless Chromium (TSD §3A.1, §5).
# Long-running/containerised runtime (Fly.io / Railway-class or satellite process).
# NOT Vercel serverless. Exposes /healthz; headless-render capable.

# ── builder: compile TypeScript → dist ───────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY core ./core
COPY adapters ./adapters
COPY scheduler ./scheduler
COPY health ./health
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
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=builder /app/dist ./dist

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://localhost:${WORKER_HEALTHZ_PORT}/healthz" || exit 1

CMD ["node", "dist/src/index.js"]
