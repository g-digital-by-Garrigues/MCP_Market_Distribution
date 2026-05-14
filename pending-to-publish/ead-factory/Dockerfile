# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ─── Production stage ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

# Refresh the Alpine package index and upgrade ALL OS packages to the latest
# available version. Without this, the cached node:22-alpine layer pulls in
# whatever packages were current at image-build time on the upstream side,
# which Docker Scout flags as "Fixable critical or high vulnerabilities
# found" once new CVEs are disclosed and patched. --no-cache keeps the
# index out of the layer (smaller image, no stale state).
RUN apk update && apk upgrade --no-cache

ENV NODE_ENV=production
ENV TRANSPORT=http
ENV HTTP_PORT=3000

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Non-root user for security
RUN addgroup -S mcp && adduser -S mcp -G mcp
USER mcp

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/server.js"]
