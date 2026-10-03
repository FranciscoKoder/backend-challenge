# Bun executa TypeScript direto: não há etapa de build.
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 3000
# SIGTERM chega direto ao processo Bun (exec form): o consumidor SQS drena antes de sair.
CMD ["bun", "run", "src/main.ts"]
