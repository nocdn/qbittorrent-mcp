# qbittorrent-mcp

An MCP (Model Context Protocol) server for [qBittorrent](https://www.qbittorrent.org/) built with [Hono](https://hono.dev). Lets AI agents manage torrents on your seedbox or local qBittorrent instance via the [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) transport.

Runs on **[Bun](https://bun.sh)** (Docker / bare metal) or **[Cloudflare Workers](https://workers.cloudflare.com)** from the same codebase.

## Setup

```sh
bun install
cp .env.example .env
```

Edit `.env` with your qBittorrent WebUI credentials:

```env
QBITTORRENT_URL=https://seedbox.example.com:8080
QBITTORRENT_USERNAME=admin
QBITTORRENT_PASSWORD=your_password
```

## Development

### Bun (Docker / local)

```sh
bun run dev
```

Open http://localhost:7100

On startup, the Bun server performs a qBittorrent connection check using the configured URL and credentials. If the check fails, the process exits before it starts listening for requests.

Structured JSON logs are emitted for startup, MCP session flow, readiness checks, tool execution, and qBittorrent request retries or timeouts. Adjust verbosity with `LOG_LEVEL`.

### Cloudflare Workers

Create a `.dev.vars` file with the same qBittorrent variables, then:

```sh
bun run dev:worker
```

## Deployment

### Docker

Commit `bun.lock` for reproducible container builds. If it is missing, the Docker image will still install dependencies, but without `--frozen-lockfile`.

```sh
docker compose up --build
```

The container validates the qBittorrent connection during startup. Invalid connection details cause the process to exit with a startup error instead of serving the MCP endpoint with a broken backend connection.

`compose.yaml` also defines a Docker healthcheck against `/api/ready` (every **10 minutes** by default), so the container health reflects whether the MCP service can still authenticate to qBittorrent without polling the Web API every minute.

### Cloudflare Workers

Set secrets via wrangler:

```sh
bunx wrangler secret put QBITTORRENT_URL
bunx wrangler secret put QBITTORRENT_USERNAME
bunx wrangler secret put QBITTORRENT_PASSWORD
```

Then deploy:

```sh
bun run deploy
```

## MCP endpoint

The MCP server is available at:

```
POST http://localhost:7100/api/mcp
```

The server supports the standard MCP initialization flow, including session-based Streamable HTTP requests for `initialize`, `notifications/initialized`, `tools/list`, and subsequent tool calls. It also publishes server-level MCP instructions so compliant clients can give agents built-in usage guidance automatically.

On Bun/Docker, the server uses stateful MCP sessions with `Mcp-Session-Id`. On Cloudflare Workers, it falls back to stateless MCP handling because Workers do not guarantee that in-memory session state survives or routes consistently across requests. Both modes support tool discovery and tool calls for compliant MCP clients.

### Connecting from an MCP client

Add to your MCP client config (e.g. Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "qbittorrent": {
      "url": "http://localhost:7100/api/mcp"
    }
  }
}
```

For Workers, replace the URL with your `*.workers.dev` or custom domain.

For quick manual testing, one-off stateless `curl` calls to `tools/call` are still supported even without running the full MCP initialize flow.

### Errors and agent-facing detail

Per the [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), tool execution failures are returned as a normal tool result with **`isError: true`** so the model can read the payload and recover (as opposed to only a transport-level failure).

For this server:

- **Tool calls** (`tools/call`): failures return JSON text with `status: "error"`, a **`message`**, **`recoveryHints`** (concrete next steps), and optional **`qbittorrent`** fields (`httpStatus`, `path`, `responseBodySnippet`, etc.) when the failure came from the Web API.
- **Protocol / transport JSON-RPC errors** (e.g. unknown session, bad request): responses use the JSON-RPC **`error`** object; when applicable, **`error.data`** includes `recoveryHints` and identifiers such as `sessionId`.

Server `instructions` (MCP initialize) also mention that tool errors include structured detail for agents.

### MCP discovery with `curl`

On Bun/Docker, a compliant MCP client would typically:

1. Send `initialize`
2. Read the `mcp-session-id` response header
3. Send `notifications/initialized`
4. Send `tools/list`

Initialize:

```sh
curl -i -N http://localhost:7100/api/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc": "2.0",
    "id": "init-1",
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {
        "name": "curl",
        "version": "1.0.0"
      }
    }
  }'
```

Then send `notifications/initialized` and `tools/list` with the returned `mcp-session-id` header:

```sh
SESSION_ID="paste-the-mcp-session-id-here"

curl -N http://localhost:7100/api/mcp \
  -H "Mcp-Session-Id: ${SESSION_ID}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc": "2.0",
    "method": "notifications/initialized"
  }'

curl -N http://localhost:7100/api/mcp \
  -H "Mcp-Session-Id: ${SESSION_ID}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc": "2.0",
    "id": "tools-1",
    "method": "tools/list"
  }'
```

On Cloudflare Workers, the server runs in stateless MCP mode, so the same sequence works without an `Mcp-Session-Id` header:

```sh
curl -N https://your-worker.example.com/api/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc": "2.0",
    "id": "tools-1",
    "method": "tools/list"
  }'
```

When `add_torrent` is called with magnet links, the response includes extracted info hashes so clients can poll torrent status immediately without re-parsing the magnet URI.

For ergonomics, `add_torrent` accepts arrays or newline-separated strings for `urls`, and the hash/tag mutation tools accept arrays as well as the original pipe-separated or comma-separated string formats.

Example result:

```json
{
  "status": "done",
  "action": "add_torrent",
  "hash": "8bfa244903ca33a668d878d9c9c92d9b2208676f",
  "hashes": [
    "8bfa244903ca33a668d878d9c9c92d9b2208676f"
  ],
  "urls": [
    "magnet:?xt=urn:btih:8BFA244903CA33A668D878D9C9C92D9B2208676F..."
  ],
  "tags": [],
  "qbittorrentResponse": "Ok."
}
```

## Project structure

```
src/
├── app.ts          # Shared Hono app (routes, MCP tools, rate limiting)
├── config.ts       # Shared environment parsing and runtime configuration
├── index.ts        # Bun entry point (Bun.serve)
├── worker.ts       # Cloudflare Workers entry point (export default app)
├── qbittorrent.ts  # qBittorrent Web API client
└── tools.ts        # MCP tool definitions (28 tools)
```

## Available MCP tools

### Application

| Tool | Description |
| ---- | ----------- |
| `get_version` | Get qBittorrent application version |
| `get_api_version` | Get qBittorrent Web API version |
| `get_preferences` | Get qBittorrent application preferences |
| `get_default_save_path` | Get default save path for torrents |

### Transfer

| Tool | Description |
| ---- | ----------- |
| `get_transfer_info` | Get global transfer info (speeds, connection status) |
| `get_speed_limits_mode` | Get current speed limits mode (0=normal, 1=alternative) |
| `set_global_download_limit` | Set global download speed limit in bytes/second |
| `set_global_upload_limit` | Set global upload speed limit in bytes/second |

### Torrent management

| Tool | Description |
| ---- | ----------- |
| `list_torrents` | List torrents with optional filters (status, category, tag) |
| `get_torrent_status` | Get a compact status snapshot for a specific torrent |
| `wait_for_torrent` | Wait for a torrent to reach a target state with bounded polling |
| `get_torrent_properties` | Get properties for a specific torrent |
| `get_torrent_trackers` | Get trackers for a specific torrent |
| `get_torrent_files` | Get files for a specific torrent |
| `add_torrent` | Add torrents by URL or magnet link with optional placement and per-torrent settings, and return extracted magnet info hashes when available |
| `pause_torrents` | Pause one or more torrents |
| `resume_torrents` | Resume one or more torrents |
| `delete_torrents` | Delete one or more torrents; downloaded files are deleted by default unless `deleteFiles=false` |
| `recheck_torrents` | Recheck one or more torrents |
| `reannounce_torrents` | Reannounce one or more torrents to trackers |
| `set_torrent_category` | Set category for torrents |
| `add_torrent_tags` | Add tags to torrents |
| `remove_torrent_tags` | Remove tags from torrents |
| `set_torrent_download_limit` | Set per-torrent download speed limit |
| `set_torrent_upload_limit` | Set per-torrent upload speed limit |
| `set_torrent_location` | Move torrents to a different disk location |
| `get_categories` | Get all torrent categories |
| `get_tags` | Get all torrent tags |

`delete_torrents` defaults `deleteFiles` to `true`. Agents must explicitly pass `deleteFiles=false` if they want to remove the torrent from qBittorrent but keep the downloaded files on disk.

## Routes

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/api` | App info |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/ready` | Readiness check with live qBittorrent validation |
| `ALL` | `/api/mcp` | MCP Streamable HTTP endpoint |

## Environment variables

All variables are optional except the qBittorrent connection settings.

| Variable | Description | Default |
| -------- | ----------- | ------- |
| `QBITTORRENT_URL` | Full URL to qBittorrent WebUI | *(required)* |
| `QBITTORRENT_USERNAME` | qBittorrent WebUI username | *(required)* |
| `QBITTORRENT_PASSWORD` | qBittorrent WebUI password | *(required)* |
| `QBITTORRENT_REQUEST_TIMEOUT_MS` | Timeout for each qBittorrent Web API request | `30000` |
| `LOG_LEVEL` | Application log level (`debug`, `info`, `warn`, `error`) | `info` |
| `LOG_FORMAT` | Log layout: `pretty` / `human` (default; readable lines, indented meta, nicer HTTP access lines) or `json` (one JSON object per line for aggregators) | `pretty` (when unset) |
| `LOG_ACCESS_LOG_PROBES` | When `true` / `1` / `yes`, include `/api/health` and `/api/ready` in HTTP access logs; default hides them to reduce probe noise | *(omit; probes hidden)* |
| `PORT` | Port the API listens on (Bun only) | `7100` |
| `RATE_LIMIT_WINDOW_MS` | Main rate limit window (ms) | `900000` (15 min) |
| `RATE_LIMIT_MAX` | Max requests per main window | `100` |
| `HEALTH_RATE_LIMIT_WINDOW_MS` | Health endpoint rate limit window (ms) | `500` |
| `HEALTH_RATE_LIMIT_MAX` | Max requests per health window | `1` |

## Rate limiting

Rate limiting is handled by [hono-rate-limiter](https://github.com/rhinobase/hono-rate-limiter). Limits are global - they apply to all clients as a single shared bucket, not per-IP.

Two separate limiters are configured:

- **Main** - covers all routes except `/api/health`. Defaults to 100 requests per 15 minutes.
- **Health** - covers `/api/health` only. Defaults to 1 request per 500ms.

## Health endpoints

- `GET /api/health` is a liveness check for the MCP process itself.
- `GET /api/ready` is a readiness check that logs into qBittorrent and verifies the Web API version endpoint is reachable.
- Docker Compose runs a **`healthcheck`** against `/api/ready` every **10 minutes** (see `compose.yaml`); adjust `interval` there if you want a different cadence.

## Logging

- Request logging uses Hono's built-in logger middleware.
- Additional structured JSON logs cover startup, MCP transport/session behavior, readiness checks, tool calls, and qBittorrent retries/timeouts.
- `LOG_LEVEL=debug` is useful when diagnosing agent behavior or upstream qBittorrent connectivity issues.
- **`LOG_FORMAT`** defaults to **pretty** (omit the variable or set `pretty` / `human`). Use **`LOG_FORMAT=json`** when shipping logs to aggregators that expect one JSON object per line. Pretty mode uses an ISO prefix and `→` / `←` on HTTP lines instead of `<--` / `-->`. In Docker without a TTY, colors are usually off; set `FORCE_COLOR=1` if you want ANSI colors in captured logs.
- **`/api/health`** and **`/api/ready`** are omitted from the HTTP access log by default so Docker or orchestrator probes do not interleave with MCP traffic. Successful readiness is logged at **`debug`** only (`LOG_LEVEL=debug` to see it); failures stay at **`warn`**. Set **`LOG_ACCESS_LOG_PROBES=true`** to print probe requests in the access log again.
