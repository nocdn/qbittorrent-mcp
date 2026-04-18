import app from "./app.ts";
import { getQBittorrentConfig, getRuntimeConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { QBittorrentClient } from "./qbittorrent.ts";

async function validateQBittorrentConnection(): Promise<void> {
  const runtimeConfig = getRuntimeConfig(process.env as Partial<Record<string, string | undefined>>);
  const logger = createLogger("qbittorrent-mcp.startup", runtimeConfig.logLevel);
  const qbittorrent = getQBittorrentConfig(process.env as Partial<Record<string, string | undefined>>);
  const client = new QBittorrentClient(
    qbittorrent.url,
    qbittorrent.username,
    qbittorrent.password,
    qbittorrent.requestTimeoutMs,
    logger.child("qbittorrent"),
  );

  const { version, apiVersion } = await client.validateConnection();
  logger.info("Connected to qBittorrent", {
    version,
    apiVersion,
    requestTimeoutMs: qbittorrent.requestTimeoutMs,
  });
}

async function main(): Promise<void> {
  const config = getRuntimeConfig(process.env as Partial<Record<string, string | undefined>>);
  const logger = createLogger("qbittorrent-mcp.startup", config.logLevel);

  logger.info("Starting server", {
    port: config.port,
    logLevel: config.logLevel,
    requestTimeoutMs: config.requestTimeoutMs,
    statefulMcpSessions: true,
  });

  await validateQBittorrentConnection();

  const server = Bun.serve({
    fetch: app.fetch,
    port: config.port,
  });

  logger.info("Server is listening", {
    url: `http://localhost:${server.port}`,
  });
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const fallbackLogger = createLogger("qbittorrent-mcp.startup", "error");
  fallbackLogger.error("Startup check failed", { error: message });
  process.exit(1);
}
