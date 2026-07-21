FROM node:22-bookworm-slim AS deps
WORKDIR /app/api
COPY apps/api/package*.json ./
RUN npm ci

FROM deps AS build
COPY apps/api/prisma ./prisma
RUN npx prisma generate
COPY apps/api/tsconfig.json ./
COPY apps/api/src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/api
RUN groupadd -r app && useradd -r -g app app
COPY --from=build /app/api/package*.json ./
COPY --from=build /app/api/node_modules ./node_modules
COPY --from=build /app/api/dist ./dist
COPY --from=build /app/api/prisma ./prisma
COPY apps/web /app/web
USER app
EXPOSE 8787
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
