# syntax=docker/dockerfile:1

FROM oven/bun:1-alpine AS build
WORKDIR /usr/src/app

COPY . ./
RUN if [ -f bun.lock ]; then bun install --frozen-lockfile; else bun install; fi
RUN bun build --compile --minify src/index.ts --outfile qbittorrent-mcp

FROM alpine:3 AS release

RUN apk add --no-cache libstdc++ libgcc \
 && addgroup -S app && adduser -S app -G app

COPY --from=build /usr/src/app/qbittorrent-mcp /usr/local/bin/qbittorrent-mcp

USER app
EXPOSE 7100

CMD ["qbittorrent-mcp"]
