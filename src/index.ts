import { Hono } from "hono";
import { logger } from "hono/logger";
import { rateLimiter } from "hono-rate-limiter";

const defaultPort = Number.parseInt("7100", 10);
const configuredPort = Number.parseInt(process.env.PORT ?? "", 10);
const port = Number.isNaN(configuredPort) ? defaultPort : configuredPort;

const mainWindowMs = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "", 10) || 15 * 60 * 1000;
const mainLimit = Number.parseInt(process.env.RATE_LIMIT_MAX ?? "", 10) || 100;
const healthWindowMs = Number.parseInt(process.env.HEALTH_RATE_LIMIT_WINDOW_MS ?? "", 10) || 500;
const healthLimit = Number.parseInt(process.env.HEALTH_RATE_LIMIT_MAX ?? "", 10) || 1;

const app = new Hono();

app.use(logger());

const mainLimiter = rateLimiter({
  windowMs: mainWindowMs,
  limit: mainLimit,
  keyGenerator: () => "global",
});

const healthLimiter = rateLimiter({
  windowMs: healthWindowMs,
  limit: healthLimit,
  keyGenerator: () => "global",
});

app.use("*", async (c, next) => {
  if (c.req.path === "/api/health") {
    return next();
  }
  return mainLimiter(c, next);
});

app.get("/api/health", healthLimiter, (c) => {
  return c.json({ status: "ok" });
});

app.get("/api", (c) => {
  return c.json({
    name: "qbittorrent-mcp",
    status: "ok",
    port,
  });
});

const server = Bun.serve({
  fetch: app.fetch,
  port,
});

console.log(`Listening on http://localhost:${server.port}`);
