import app from "./app.ts";
import { getQBittorrentConfig, getRuntimeConfig } from "./config.ts";
import { QBittorrentClient } from "./qbittorrent.ts";

async function validateQBittorrentConnection(): Promise<void> {
  const qbittorrent = getQBittorrentConfig(process.env as Partial<Record<string, string | undefined>>);
  const client = new QBittorrentClient(
    qbittorrent.url,
    qbittorrent.username,
    qbittorrent.password,
    qbittorrent.requestTimeoutMs,
  );

  const { version, apiVersion } = await client.validateConnection();
  console.log(`Connected to qBittorrent ${version} (Web API ${apiVersion})`);
}

async function main(): Promise<void> {
  const config = getRuntimeConfig(process.env as Partial<Record<string, string | undefined>>);
  await validateQBittorrentConnection();

  const server = Bun.serve({
    fetch: app.fetch,
    port: config.port,
  });

  console.log(`Listening on http://localhost:${server.port}`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Startup check failed: ${message}`);
  process.exit(1);
}
