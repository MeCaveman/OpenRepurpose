# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY integrations ./integrations
COPY tsconfig.base.json tsconfig.json .prettierignore prettier.config.js ./

RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm build \
  && pnpm deploy --filter @openrepurpose/server --prod /opt/openrepurpose/server

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    APP_CONFIG_DIR=/etc/openrepurpose \
    APP_DATA_DIR=/var/lib/openrepurpose/data \
    APP_TEMP_DIR=/var/lib/openrepurpose/tmp \
    WHISPER_MODEL_DIR=/var/lib/openrepurpose/models \
    BIND_HOST=0.0.0.0 \
    PORT=3000

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /etc/openrepurpose /var/lib/openrepurpose/data /var/lib/openrepurpose/models /var/lib/openrepurpose/tmp /media \
  && chown -R node:node /etc/openrepurpose /var/lib/openrepurpose /media

WORKDIR /opt/openrepurpose
COPY --from=build --chown=node:node /opt/openrepurpose/server ./apps/server
COPY --from=build --chown=node:node /workspace/apps/web/dist ./apps/web/dist

USER node
EXPOSE 3000
VOLUME ["/etc/openrepurpose", "/var/lib/openrepurpose/data", "/var/lib/openrepurpose/models", "/var/lib/openrepurpose/tmp"]

ENTRYPOINT ["node", "apps/server/dist/index.js"]
