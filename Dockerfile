FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY apps/server/package.json apps/server/package.json
RUN npm ci
COPY . .
ENV VITE_DEMO_MODE=false
ENV VITE_BASE=/
RUN npm run build -w @passageworks/web

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY apps/server/package.json apps/server/package.json
RUN npm ci --omit=dev
COPY apps/server apps/server
COPY packages packages
COPY fixtures fixtures
COPY --from=web /app/apps/web/dist apps/web/dist
ENV WEB_DIST=/app/apps/web/dist
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "apps/server/src/index.ts"]
