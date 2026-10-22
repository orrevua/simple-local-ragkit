# ragkit HTTP API in a container. Mount a folder holding ragkit.config.ts and
# your documents at /data; the collection DB is written there too.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /data
ENV NODE_ENV=production PORT=8787
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY --from=build /app/package.json /app/package.json
EXPOSE 8787
# Incremental ingest on every start (unchanged files are skipped by content
# hash), then serve.
CMD ["sh", "-c", "node /app/dist/cli/index.js ingest && exec node /app/dist/cli/index.js serve --host 0.0.0.0 --port ${PORT}"]
