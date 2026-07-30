# Build with a reviewed, digest-pinned BASE_IMAGE in CI.
ARG BASE_IMAGE=node:24-bookworm-slim
FROM ${BASE_IMAGE} AS node-runtime
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
ENV NODE_ENV=production
LABEL org.opencontainers.image.source="https://github.com/anton6202527/anicode"

FROM node-runtime AS control-plane
USER node
CMD ["npm", "run", "remote", "--workspace", "@anicode/core"]

FROM node-runtime AS runner
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential cargo ca-certificates git golang-go openjdk-17-jdk-headless python3 python3-venv ripgrep \
    && rm -rf /var/lib/apt/lists/*
USER node
CMD ["node", "--version"]
