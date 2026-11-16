FROM oven/bun:1.4.4-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

USER bun
EXPOSE 3000

# APP_ROLE escolhe o papel da instância: api, worker ou all
CMD ["bun", "run", "src/main.ts"]
