# syntax=docker/dockerfile:1
# Build stage: compile the TypeScript renderer and install production deps.
FROM node:22-alpine AS build
WORKDIR /build
RUN corepack enable
COPY app/package.json app/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY app/ ./
RUN pnpm build && pnpm prune --prod

# Runtime stage: Home Assistant base image (Alpine 3.22, s6-overlay, bashio).
FROM ghcr.io/home-assistant/base:3.22

# Chromium + fonts for headless rendering, Node 22 runtime.
RUN apk add --no-cache \
    nodejs \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    font-dejavu \
    font-liberation \
    font-noto-emoji \
    && rm -rf /var/cache/apk/*

ENV CHROMIUM_PATH=/usr/bin/chromium-browser \
    NODE_ENV=production

WORKDIR /app
COPY --from=build /build/package.json /app/package.json
COPY --from=build /build/node_modules /app/node_modules
COPY --from=build /build/dist /app/dist
COPY rootfs /

LABEL \
    io.hass.version="0.2.1" \
    io.hass.type="app" \
    io.hass.arch="aarch64|amd64" \
    org.opencontainers.image.title="Home Assistant App: Kindle Dashboard Renderer" \
    org.opencontainers.image.description="Renders a Lovelace dashboard into an e-ink friendly PNG for a jailbroken Kindle." \
    org.opencontainers.image.source="https://github.com/LANcaster83/kindle-ha-dashboard" \
    org.opencontainers.image.licenses="MIT"
