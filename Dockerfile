# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /build
COPY package*.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    BROWSER_DATA_DIR=/data/browser

WORKDIR /app

# Copy production deps and install (includes playwright)
COPY package*.json ./
RUN npm ci --omit=dev

# Install Chromium using the exact playwright version from package.json
RUN npx playwright install --with-deps chromium

# Copy compiled output
COPY --from=builder /build/dist ./dist

# Persistent browser data directory
RUN mkdir -p /data/browser

# Non-root user for security
RUN useradd -r -u 1001 -g root appuser && \
    chown -R appuser:root /data /app /ms-playwright
USER appuser

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 10000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
