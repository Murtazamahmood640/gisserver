# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install ALL deps (including dev) for the build step
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source
COPY . .

# Type-check (fails the build if types are wrong)
RUN npx tsc --noEmit

# ─── Stage 2: Production image ───────────────────────────────────────────────
FROM node:20-alpine AS runner

# Security: run as non-root user
RUN addgroup -S gis && adduser -S -G gis gis

WORKDIR /app

# Copy only production dependencies manifest, then install prod-only deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy all source files (tsx executes TypeScript directly; no compile step needed
# in the runtime stage, keeping the image small while avoiding a separate dist/).
# Entry point: backend/server.ts compiled at runtime by tsx.
COPY --from=builder /app .

# Drop to non-root
RUN chown -R gis:gis /app
USER gis

EXPOSE 3000

# Health check: hit the /api/health endpoint every 30 s
# Fail after 3 consecutive failures; allow 10 s start-up grace.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

# tsx is a production dependency (see package.json) so it is available after
# "npm ci --omit=dev". The server is run directly from TypeScript source
# without a separate compile step, keeping the image lean.
CMD ["node_modules/.bin/tsx", "server.ts"]
