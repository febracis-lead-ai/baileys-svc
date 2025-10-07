FROM oven/bun:latest AS deps
WORKDIR /app

COPY package.json ./
RUN bun install --production

FROM oven/bun:latest AS runner
WORKDIR /app

USER bun

COPY --from=deps /app/node_modules /app/node_modules

COPY src ./src
COPY config.js webhook.js index.js jid.js manager.js routes.js socket-factory.js ./

ENV NODE_ENV=production
EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS http://localhost:3002/healthz || exit 1

VOLUME ["/app/auth"]

CMD ["bun", "src/index.js"]
