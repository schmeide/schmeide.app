# check=skip=InvalidDefaultArgInFrom
# The platform server (server/) for the cluster: `make image` builds it, cd-image.yml pushes it from main.
# The site is not in here; GitHub Pages serves it.
# Run:     node src/main.ts     (CMD)
# Migrate: node src/migrate.ts  (from server/, the same image)
# No default: `make image` passes the version in .nvmrc.
ARG NODE_VERSION
FROM node:${NODE_VERSION}-trixie-slim

# GNU make 4 and git: the server refuses to start without make, and builds call git. openssh-client:
# build pods (SCHMEIDE_RUNNER=kubernetes) reach Forgejo with a deploy key.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git make openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
# The agent SDK installs the claude CLI it was built for, pinned by the lockfile, as a per-platform
# optional dependency. npm cannot tell glibc from musl here, so drop the musl copy. --omit=dev still
# installs better-auth's optional peers (vitest, drizzle-kit, ...): npm marks them devOptional.
RUN npm ci --omit=dev -w server \
    && npm cache clean --force \
    && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl \
    && ln -s /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude /usr/local/bin/claude \
    && claude --version
COPY server server

RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production \
    SCHMEIDE_HOST=0.0.0.0 \
    PORT=3100 \
    SCHMEIDE_DATA_DIR=/data
VOLUME /data
EXPOSE 3100
WORKDIR /app/server
CMD ["node", "src/main.ts"]
