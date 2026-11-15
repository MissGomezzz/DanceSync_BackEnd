# Etapa 1: compilar TypeScript
FROM node:22-slim AS build
WORKDIR /app
RUN npm install -g pnpm@10.11.0
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: no dependency lifecycle script runs while the image is built.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# Etapa 2: solo lo necesario para ejecutar
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
# 3000: API and Socket.IO. 9464: Prometheus /metrics (METRICS_PORT), internal only.
EXPOSE 3000 9464
CMD ["node", "dist/server.js"]