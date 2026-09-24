# Container image for the network-served Coolify MCP server (issue #22).
#
# Runs `vbcdx-coolify serve` — MCP over Streamable HTTP, the Coolify API token
# supplied per request in the Authorization header. No credential is baked into
# the image, ENV or any layer; service settings arrive from the environment and
# the token arrives per request. Mirrors VBCDX/forgejo-plugin's Dockerfile.

FROM node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

WORKDIR /app

# Production dependencies only (the pinned @modelcontextprotocol/sdk); lockfiles
# first so this layer caches independently of source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY bin ./bin
COPY src ./src

# Network defaults. The Coolify URL and the token are runtime concerns.
ENV VBCDX_COOLIFY_HTTP_PORT=8080 \
    VBCDX_COOLIFY_HTTP_HOST=0.0.0.0 \
    VBCDX_COOLIFY_WRITES=off \
    NODE_ENV=production
EXPOSE 8080

USER node

# Probes 127.0.0.1 (not localhost: the listener is IPv4 and localhost may resolve to ::1).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "bin/vbcdx-coolify.js", "healthcheck"]

ENTRYPOINT ["node", "bin/vbcdx-coolify.js"]
CMD ["serve"]
