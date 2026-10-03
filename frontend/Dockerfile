# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: produce the static SPA.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

# A static SPA has no server to read runtime configuration from, so the API's public origin is baked
# into the bundle at build time. Pass it per environment:
#   docker build --build-arg NUXT_PUBLIC_API_BASE_URL=https://api.dev.example.com .
ARG NUXT_PUBLIC_API_BASE_URL
ENV NUXT_PUBLIC_API_BASE_URL=${NUXT_PUBLIC_API_BASE_URL}

# Dependencies first, so the (slow) install layer is only repeated when they change.
COPY package.json package-lock.json ./
RUN npm ci

# Then the sources, which change far more often.
COPY . .
RUN npm run generate

# The app shell contains three inline scripts (Nuxt's import map, the colour-mode bootstrap and the
# runtime config). A strict `script-src 'self'` blocks all three, so the build hashes each of them
# and nginx allows exactly those - no 'unsafe-inline', and no nonce that would need the response to
# be uncached. Two of the scripts change on every build, which is why this cannot be a constant.
RUN node scripts/csp-hashes.mjs .output/public > /csp-script-hashes.conf && cat /csp-script-hashes.conf

# ---------------------------------------------------------------------------
# Runtime stage: nginx serving the files, as an unprivileged user.
#
# `nginx-unprivileged` listens on 8080 and runs as the `nginx` user rather than root, so a
# compromise of the process is not root inside the container. Its entrypoint renders the config
# template below with `envsubst`, which is how API_ORIGIN reaches the Content-Security-Policy
# without rebuilding the image for a different domain.
# ---------------------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:alpine

COPY --chown=nginx:nginx nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build --chown=nginx:nginx /app/.output/public /usr/share/nginx/html

# The build-time `script-src` hashes, included by the config template.
COPY --from=build --chown=nginx:nginx /csp-script-hashes.conf /etc/nginx/script-hashes.conf

EXPOSE 8080
