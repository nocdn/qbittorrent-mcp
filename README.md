# qbittorrent-mcp

A [Hono](https://hono.dev) API running on [Bun](https://bun.sh).

## Setup

```sh
bun install
cp .env.example .env
```

## Development

```sh
bun run dev
```

Open http://localhost:7100

## Routes

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/api` | App info |
| `GET` | `/api/health` | Health check |

## Environment variables

All variables are optional. Defaults are used when not set.

| Variable | Description | Default |
| -------- | ----------- | ------- |
| `PORT` | Port the API listens on | `7100` |
| `RATE_LIMIT_WINDOW_MS` | Main rate limit window (ms) | `900000` (15 min) |
| `RATE_LIMIT_MAX` | Max requests per main window | `100` |
| `HEALTH_RATE_LIMIT_WINDOW_MS` | Health endpoint rate limit window (ms) | `500` |
| `HEALTH_RATE_LIMIT_MAX` | Max requests per health window | `1` |

## Rate limiting

Rate limiting is handled by [hono-rate-limiter](https://github.com/rhinobase/hono-rate-limiter). Limits are global - they apply to all clients as a single shared bucket, not per-IP.

Two separate limiters are configured:

- **Main** - covers all routes except `/api/health`. Defaults to 100 requests per 15 minutes.
- **Health** - covers `/api/health` only. Defaults to 1 request per 500ms.

## Docker

Commit `bun.lock` for reproducible container builds. If it is missing, the Docker image will still install dependencies, but without `--frozen-lockfile`.

```sh
docker compose up --build
```
