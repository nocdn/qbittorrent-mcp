import { Context, Hono } from "hono";
import { logger } from "hono/logger";
import { env } from "hono/adapter";
import { rateLimiter } from "hono-rate-limiter";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { MemoryEventStore, StreamableHTTPTransport } from "@hono/mcp";
import { Env, getQBittorrentConfig, getRuntimeConfig } from "./config.ts";
import { QBittorrentClient } from "./qbittorrent.ts";
import { registerTools } from "./tools.ts";

const app = new Hono<{ Bindings: Env }>();
const limiterCache = new Map<string, ReturnType<typeof rateLimiter>>();
const mcpTransports = new Map<string, StreamableHTTPTransport>();
const supportsStatefulMcpSessions = typeof Bun !== "undefined";
const mcpServerInstructions = [
  "Use tools/list to discover the available qBittorrent tools and their input schemas.",
  "Use get_torrent_status for a compact one-shot status lookup for a single torrent.",
  "Use wait_for_torrent when you need bounded polling until a torrent exists, completes, seeds, pauses, or disappears.",
  "Torrent hashes may be passed as lowercase or uppercase hex info hashes; mutation tools also accept hash arrays.",
  "Mutation tools return structured JSON with status, action, and the hashes or settings that were applied.",
  "add_torrent accepts arrays or newline-separated URL strings and supports common qBittorrent add options like category, tags, savepath, paused, limits, autoTMM, sequentialDownload, and firstLastPiecePrio.",
].join(" ");

app.use(logger());

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

function createQBittorrentClient(e: Partial<Env>) {
  const qbittorrent = getQBittorrentConfig(e);
  return new QBittorrentClient(
    qbittorrent.url,
    qbittorrent.username,
    qbittorrent.password,
    qbittorrent.requestTimeoutMs,
  );
}

function createMcpServer(client: QBittorrentClient) {
  const mcp = new McpServer(
    { name: "qbittorrent-mcp", version: "1.0.0" },
    { instructions: mcpServerInstructions },
  );
  registerTools(mcp, client);
  return mcp;
}

function createSessionTransport() {
  const eventStore = new MemoryEventStore();
  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    eventStore,
    onsessioninitialized: (sessionId) => {
      mcpTransports.set(sessionId, transport);
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      mcpTransports.delete(transport.sessionId);
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

function jsonRpcError(message: string, status: number, code = -32000) {
  return Response.json({
    jsonrpc: "2.0",
    error: {
      code,
      message,
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
  try {
    const client = createQBittorrentClient(env(c) as Env);
    const { version, apiVersion } = await client.validateConnection();

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
  try {
    const client = createQBittorrentClient(env(c) as Env);
    const parsedBody = await getParsedBody(c);
    const sessionId = c.req.header("mcp-session-id");

    if (supportsStatefulMcpSessions && sessionId) {
      const transport = mcpTransports.get(sessionId);
      if (!transport) {
        return jsonRpcError("Session not found", 404, -32001);
      }

      return transport.handleRequest(c, parsedBody);
    }

    if (supportsStatefulMcpSessions && c.req.method === "POST" && parsedBody !== undefined && isInitializeRequest(parsedBody)) {
      const transport = createSessionTransport();
      const mcp = createMcpServer(client);
      await mcp.connect(transport);
      return transport.handleRequest(c, parsedBody);
    }

    if (supportsStatefulMcpSessions && c.req.method !== "POST") {
      return jsonRpcError("Bad Request: No valid session ID provided", 400);
    }

    // Stateless mode keeps manual curl testing ergonomic and is safe for Workers,
    // where in-memory session affinity across requests is not guaranteed.
    const transport = new StreamableHTTPTransport();
    const mcp = createMcpServer(client);
    await mcp.connect(transport);
    return transport.handleRequest(c, parsedBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonRpcError(message, 500, -32603);
  }
});

export default app;
