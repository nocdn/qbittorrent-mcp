# syntax=docker/dockerfile:1

FROM oven/bun:1-alpine AS deps
WORKDIR /usr/src/app

COPY . ./
RUN if [ -f bun.lock ]; then bun install --frozen-lockfile --production; else bun install --production; fi

FROM oven/bun:1-alpine AS release
WORKDIR /usr/src/app

ENV NODE_ENV=production

COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . ./

USER bun
EXPOSE 7100

CMD ["bun", "run", "src/index.ts"]
