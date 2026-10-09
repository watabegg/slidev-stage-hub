FROM node:24.15.0-bookworm
RUN npm install --global pnpm@12.3.4
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/stage/package.json ./apps/stage/package.json
COPY packages/hub/package.json ./packages/hub/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/slidev-adapter/package.json ./packages/slidev-adapter/package.json
COPY packages/stage-tools/package.json ./packages/stage-tools/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/hub/bundle-sharing/experiments/workers/package.json ./packages/hub/bundle-sharing/experiments/workers/package.json
COPY examples/slidev52/package.json ./examples/slidev52/package.json
RUN pnpm install --frozen-lockfile
RUN pnpm exec playwright install --with-deps chromium
COPY . .
CMD ["pnpm", "verify:portable"]
