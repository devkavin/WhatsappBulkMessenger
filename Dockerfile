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
EXPOSE 3100
CMD ["node", "dist/server.js"]
