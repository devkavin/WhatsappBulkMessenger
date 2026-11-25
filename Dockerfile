FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
ENV UPLOAD_DIR=/app/data/uploads
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /app/data && chown node:node /app/data
COPY --from=build /app/dist ./dist
COPY views ./views
COPY public ./public
USER node
ENV PORT=3100
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health', { signal: AbortSignal.timeout(4000) }).then(response => { if (!response.ok) throw new Error('Health endpoint returned HTTP ' + response.status); }).catch(error => { console.error(error.cause ?? error); process.exitCode = 1; })"]
CMD ["node", "dist/server.js"]
