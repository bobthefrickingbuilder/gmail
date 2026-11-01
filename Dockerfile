# Email Assistant — single container: backend API + worker + built web app (PWA).
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w web && npm run build -w backend && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8787 DATABASE_URL=sqlite:/data/assistant.sqlite RELEASES_DIR=/data/releases
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/config ./config
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "backend/dist/index.js"]
