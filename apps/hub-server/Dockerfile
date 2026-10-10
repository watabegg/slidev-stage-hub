# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/hub-server/Dockerfile .
ARG NODE_IMAGE=node:24.15.0-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /workspace
RUN npm install --global pnpm@12.3.4
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:server \
    && pnpm build:server-runtime \
    && pnpm --filter @slidev-stage-hub/server-app deploy --prod /out

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    HUB_STATIC_DIR=/app/static
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /workspace/apps/hub-worker/artifacts/site ./static
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "dist/start.js"]
