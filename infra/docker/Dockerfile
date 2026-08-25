FROM node:24.17.0-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS build

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json .npmrc ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/contracts/package.json packages/contracts/package.json

RUN npm ci

COPY config/tsconfig.base.json config/tsconfig.base.json
COPY apps apps
COPY packages packages
COPY plugins/yaaps/skills/yaaps plugins/yaaps/skills/yaaps
COPY plugins/yaaps/installers plugins/yaaps/installers
COPY plugins/yaaps/distribution/build-skill-distribution.mjs plugins/yaaps/distribution/build-skill-distribution.mjs

RUN npm run build && npm prune --omit=dev

FROM node:24.17.0-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS runtime

ENV NODE_ENV=production \
    YAAPS_DASHBOARD_DIR=/app/apps/dashboard/dist \
    YAAPS_DATA_DIR=/data \
    YAAPS_HOST=0.0.0.0 \
    YAAPS_PORT=3000 \
    YAAPS_SKILL_DISTRIBUTION_DIR=/app/apps/server/dist/skill-distribution

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/dashboard/dist ./apps/dashboard/dist
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json

RUN mkdir /data && chown node:node /data

USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(response => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
