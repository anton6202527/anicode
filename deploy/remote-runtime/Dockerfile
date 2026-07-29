# Build with a reviewed, digest-pinned BASE_IMAGE in CI.
ARG BASE_IMAGE=node:24-bookworm-slim
FROM ${BASE_IMAGE}
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
ENV NODE_ENV=production
USER node
CMD ["npm", "run", "remote", "--workspace", "@anicode/core"]
