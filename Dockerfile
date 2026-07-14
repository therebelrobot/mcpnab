# syntax=docker/dockerfile:1

# ---- build stage ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY examples ./examples
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ----
FROM node:22-bookworm-slim AS runtime

# uv/uvx for Python MCP servers (`uvx <pkg>`); npx ships with the node image.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# Persist everything under /app/data (mount one volume): config, sqlite db, and
# the npm/uv caches so npx/uvx don't re-download MCP servers on cold restart.
ENV NODE_ENV=production \
    HOME=/home/node \
    MCPNAB_CONFIG=/app/data/config.json \
    NPM_CONFIG_CACHE=/app/data/npm \
    UV_CACHE_DIR=/app/data/uv

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY examples ./examples
COPY package.json default-config.json entrypoint.sh ./

# Owned by node so a *named* volume at /app/data inherits node ownership on init;
# the entrypoint also chowns for *bind* mounts before dropping privileges.
RUN mkdir -p /app/data /downloads && chown -R node:node /app/data /downloads

EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
