import { Context, Hono } from "hono";
import { logger } from "hono/logger";
import { env } from "hono/adapter";
import { rateLimiter } from "hono-rate-limiter";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { MemoryEventStore, StreamableHTTPTransport } from "@hono/mcp";
import { Env, getQBittorrentConfig, getRuntimeConfig } from "./config.ts";
import { createLogger, type LogLevel, type Logger } from "./logger.ts";
import { QBittorrentClient } from "./qbittorrent.ts";
import { registerTools } from "./tools.ts";
import { getLogFormat } from "./log-format.ts";

const app = new Hono<{ Bindings: Env }>();
const limiterCache = new Map<string, ReturnType<typeof rateLimiter>>();
const mcpTransports = new Map<string, StreamableHTTPTransport>();
const supportsStatefulMcpSessions = typeof Bun !== "undefined";
function accessLogProbesEnabled(): boolean {
  const raw = process.env.LOG_ACCESS_LOG_PROBES?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Hono access lines look like "<-- GET /api/ready" or "--> GET /api/ready 200 193ms". */
function isHealthOrReadyAccessLine(line: string): boolean {
  const match = line.match(/^(?:<--|-->|xxx)\s+\S+\s+(\S+)/);
  if (!match) {
    return false;
  }
  try {
    const pathname = new URL(match[1], "http://localhost").pathname;
    return pathname === "/api/health" || pathname === "/api/ready";
  } catch {
    return false;
  }
}

const mcpServerInstructions = [
  "Use tools/list to discover the available qBittorrent tools and their input schemas.",
  "Use get_torrent_status for a compact one-shot status lookup for a single torrent.",
  "Use wait_for_torrent when you need bounded polling until a torrent exists, completes, seeds, pauses, or disappears.",
  "Torrent hashes may be passed as lowercase or uppercase hex info hashes; mutation tools also accept hash arrays.",
  "Mutation tools return structured JSON with status, action, and the hashes or settings that were applied.",
  "add_torrent accepts arrays or newline-separated URL strings and supports common qBittorrent add options like category, tags, savepath, paused, limits, autoTMM, sequentialDownload, and firstLastPiecePrio.",
  "When a tool call fails, the response uses isError=true and JSON text with status=error, a human-readable message, recoveryHints, and optional qbittorrent details (HTTP status, path, response snippet) so you can fix credentials, URL, or connectivity.",
].join(" ");

function printAccessLogLine(line: string) {
  if (!accessLogProbesEnabled() && isHealthOrReadyAccessLine(line)) {
    return;
  }

  if (getLogFormat() !== "pretty") {
    console.log(line);
    return;
  }

  const ts = new Date().toISOString();
  let rest = line;
  let arrow = "·";
  if (rest.startsWith("<-- ")) {
    arrow = "→";
    rest = rest.slice(4);
  } else if (rest.startsWith("--> ")) {
    arrow = "←";
    rest = rest.slice(4);
  } else if (rest.startsWith("xxx ")) {
    arrow = "!";
    rest = rest.slice(4);
  }
  const noColor = process.env.NO_COLOR && process.env.NO_COLOR !== "0";
  const dim = noColor ? "" : "\x1b[2m";
  const reset = dim ? "\x1b[0m" : "";
  const tty = Boolean(process.stdout?.isTTY);
  const prefix = tty && dim ? `${dim}${ts}${reset} ${arrow} ` : `${ts} ${arrow} `;
  console.log(`${prefix}${rest}`);
}

app.use(logger(printAccessLogLine));

function getCachedLimiter(scope: string, windowMs: number, limit: number) {
  const key = `${scope}:${windowMs}:${limit}`;
  const existing = limiterCache.get(key);
  if (existing) {
    return existing;
  }

  const limiter = rateLimiter({
    windowMs,
    limit,
    keyGenerator: () => `${scope}:global`,
  });
  limiterCache.set(key, limiter);
  return limiter;
}

function createAppLogger(logLevel: LogLevel): Logger {
  return createLogger("qbittorrent-mcp", logLevel);
}

function createQBittorrentClient(e: Partial<Env>, logger: Logger) {
  const qbittorrent = getQBittorrentConfig(e);
  return new QBittorrentClient(
    qbittorrent.url,
    qbittorrent.username,
    qbittorrent.password,
    qbittorrent.requestTimeoutMs,
    logger.child("qbittorrent"),
  );
}

function createMcpServer(client: QBittorrentClient, logger: Logger) {
  const mcp = new McpServer(
    { name: "qbittorrent-mcp", version: "1.0.0" },
    { instructions: mcpServerInstructions },
  );
  registerTools(mcp, client, logger.child("mcp.tool"));
  return mcp;
}

function createSessionTransport(logger: Logger) {
  const eventStore = new MemoryEventStore();
  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    eventStore,
    onsessioninitialized: (sessionId) => {
      mcpTransports.set(sessionId, transport);
      logger.info("MCP session initialized", {
        sessionId,
        activeSessions: mcpTransports.size,
      });
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      mcpTransports.delete(transport.sessionId);
      logger.info("MCP session closed", {
        sessionId: transport.sessionId,
        activeSessions: mcpTransports.size,
      });
    }
  };

  return transport;
}

async function getParsedBody(c: Context): Promise<unknown> {
  if (c.req.method !== "POST") {
    return undefined;
  }

  try {
    return await c.req.raw.clone().json();
  } catch {
    return undefined;
  }
}

function jsonRpcError(message: string, status: number, code = -32000, data?: Record<string, unknown>) {
  return Response.json({
    jsonrpc: "2.0",
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
    id: null,
  }, { status });
}

app.use("*", async (c, next) => {
  if (c.req.path === "/api/health") {
    return next();
  }

  const config = getRuntimeConfig(env(c) as Env);
  return (getCachedLimiter("main", config.mainRateLimit.windowMs, config.mainRateLimit.limit) as any)(c, next);
});

app.get("/api/health", async (c, next) => {
  const config = getRuntimeConfig(env(c) as Env);
  return (getCachedLimiter("health", config.healthRateLimit.windowMs, config.healthRateLimit.limit) as any)(c, next);
}, (c) => {
  return c.json({ status: "ok" });
});

app.get("/api/ready", async (c) => {
  const runtimeConfig = getRuntimeConfig(env(c) as Env);
  const logger = createAppLogger(runtimeConfig.logLevel).child("ready");

  try {
    const client = createQBittorrentClient(env(c) as Env, logger);
    const { version, apiVersion } = await client.validateConnection();

    logger.debug("Readiness check succeeded", { version, apiVersion });

    return c.json({
      status: "ready",
      qbittorrent: {
        status: "connected",
        version,
        apiVersion,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Readiness check failed", { error: message });
    return c.json({
      status: "not_ready",
      error: message,
    }, 503);
  }
});

app.get("/api", (c) => {
  return c.json({
    name: "qbittorrent-mcp",
    status: "ok",
  });
});

app.all("/api/mcp", async (c) => {
  const runtimeConfig = getRuntimeConfig(env(c) as Env);
  const logger = createAppLogger(runtimeConfig.logLevel).child("mcp");

  try {
    const client = createQBittorrentClient(env(c) as Env, logger);
    const parsedBody = await getParsedBody(c);
    const sessionId = c.req.header("mcp-session-id");

    if (supportsStatefulMcpSessions && sessionId) {
      const transport = mcpTransports.get(sessionId);
      if (!transport) {
        logger.warn("Received MCP request for missing session", { sessionId });
        return jsonRpcError(
          "MCP session not found or expired. The server may have restarted, the session may have timed out, " +
            "or the client did not send the Mcp-Session-Id header from the initialize response. " +
            "Perform a new initialize handshake to /api/mcp and include that session id on every subsequent request.",
          404,
          -32001,
          {
            sessionId,
            recoveryHints: [
              "Re-run the MCP initialize flow and persist the returned Mcp-Session-Id (or equivalent) for the Streamable HTTP session.",
              "If you deploy with replicas, ensure the same instance handles all requests for a session (sticky sessions or a single replica).",
            ],
          },
        );
      }

      logger.debug("Reusing MCP session transport", { sessionId });
      return transport.handleRequest(c, parsedBody);
    }

    if (supportsStatefulMcpSessions && c.req.method === "POST" && parsedBody !== undefined && isInitializeRequest(parsedBody)) {
      logger.info("Creating stateful MCP session transport");
      const transport = createSessionTransport(logger);
      const mcp = createMcpServer(client, logger);
      await mcp.connect(transport);
      return transport.handleRequest(c, parsedBody);
    }

    if (supportsStatefulMcpSessions && c.req.method !== "POST") {
      logger.warn("Rejected stateful MCP request without a valid session", {
        method: c.req.method,
      });
      return jsonRpcError(
        "Bad Request: Streamable HTTP requires an MCP session id for non-POST requests. " +
          "Send Mcp-Session-Id from the initialize response, or use POST with the session id for this transport.",
        400,
        -32602,
        {
          recoveryHints: [
            "After initialize, include the Mcp-Session-Id header on GET and POST requests to /api/mcp.",
            "If testing with curl, follow the Streamable HTTP session flow from the MCP specification.",
          ],
        },
      );
    }

    // Stateless mode keeps manual curl testing ergonomic and is safe for Workers,
    // where in-memory session affinity across requests is not guaranteed.
    logger.debug("Using stateless MCP transport", {
      runtime: supportsStatefulMcpSessions ? "bun-fallback" : "workerd",
      method: c.req.method,
    });
    const transport = new StreamableHTTPTransport();
    const mcp = createMcpServer(client, logger);
    await mcp.connect(transport);
    return transport.handleRequest(c, parsedBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("MCP request handling failed", {
      error: message,
      method: c.req.method,
      path: c.req.path,
    });
    return jsonRpcError(message, 500, -32603, {
      recoveryHints: [
        "If the message mentions qBittorrent, verify QBITTORRENT_URL, QBITTORRENT_USERNAME, and QBITTORRENT_PASSWORD.",
        "If the process just started, check startup logs: the server may exit on failed qBittorrent validation before accepting MCP traffic.",
      ],
    });
  }
});

export default app;
