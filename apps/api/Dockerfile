FROM node:22.14.0-bookworm-slim AS deps
WORKDIR /app/api

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global npm@10.9.2 \
    && npm config set fetch-retries 5 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000

COPY apps/api/package.json apps/api/package-lock.json ./

RUN npm ci --include=dev --no-audit --no-fund --foreground-scripts

FROM deps AS build

COPY apps/api/prisma ./prisma
COPY apps/api/tsconfig.json ./
COPY apps/api/src ./src

RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22.14.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/api

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r app \
    && useradd -r -g app app

COPY --from=build /app/api/package.json /app/api/package-lock.json ./
COPY --from=build /app/api/node_modules ./node_modules
COPY --from=build /app/api/dist ./dist
COPY --from=build /app/api/prisma ./prisma
COPY apps/web /app/web

USER app
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/server.js"]
