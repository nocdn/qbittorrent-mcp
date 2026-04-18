import type { LogLevel } from "./logger.ts";

export type Env = {
  QBITTORRENT_URL?: string;
  QBITTORRENT_USERNAME?: string;
  QBITTORRENT_PASSWORD?: string;
  QBITTORRENT_REQUEST_TIMEOUT_MS?: string;
  LOG_LEVEL?: string;
  LOG_FORMAT?: string;
  LOG_ACCESS_LOG_PROBES?: string;
  PORT?: string;
  RATE_LIMIT_WINDOW_MS?: string;
  RATE_LIMIT_MAX?: string;
  HEALTH_RATE_LIMIT_WINDOW_MS?: string;
  HEALTH_RATE_LIMIT_MAX?: string;
};

export type QBittorrentConfig = {
  url: string;
  username: string;
  password: string;
  requestTimeoutMs: number;
};

export type RuntimeConfig = {
  port: number;
  requestTimeoutMs: number;
  logLevel: LogLevel;
  mainRateLimit: {
    windowMs: number;
    limit: number;
  };
  healthRateLimit: {
    windowMs: number;
    limit: number;
  };
};

const DEFAULT_PORT = 7100;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LOG_LEVEL: LogLevel = "info";
const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX = 100;
const DEFAULT_HEALTH_RATE_LIMIT_WINDOW_MS = 500;
const DEFAULT_HEALTH_RATE_LIMIT_MAX = 1;

function readEnvString(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseIntegerEnv(name: string, value: string | undefined, fallback: number, minimum = 1): number {
  const trimmed = readEnvString(value);
  if (!trimmed) {
    return fallback;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isNaN(parsed) || parsed < minimum) {
    throw new Error(`Invalid environment variable ${name}: expected an integer >= ${minimum}`);
  }

  return parsed;
}

function parseLogLevelEnv(value: string | undefined): LogLevel {
  const trimmed = readEnvString(value);
  if (!trimmed) {
    return DEFAULT_LOG_LEVEL;
  }

  if (trimmed === "debug" || trimmed === "info" || trimmed === "warn" || trimmed === "error") {
    return trimmed;
  }

  throw new Error("Invalid environment variable LOG_LEVEL: expected one of debug, info, warn, error");
}

export function getRuntimeConfig(source: Partial<Env>): RuntimeConfig {
  return {
    port: parseIntegerEnv("PORT", source.PORT, DEFAULT_PORT),
    requestTimeoutMs: parseIntegerEnv("QBITTORRENT_REQUEST_TIMEOUT_MS", source.QBITTORRENT_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    logLevel: parseLogLevelEnv(source.LOG_LEVEL),
    mainRateLimit: {
      windowMs: parseIntegerEnv("RATE_LIMIT_WINDOW_MS", source.RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS),
      limit: parseIntegerEnv("RATE_LIMIT_MAX", source.RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX),
    },
    healthRateLimit: {
      windowMs: parseIntegerEnv("HEALTH_RATE_LIMIT_WINDOW_MS", source.HEALTH_RATE_LIMIT_WINDOW_MS, DEFAULT_HEALTH_RATE_LIMIT_WINDOW_MS),
      limit: parseIntegerEnv("HEALTH_RATE_LIMIT_MAX", source.HEALTH_RATE_LIMIT_MAX, DEFAULT_HEALTH_RATE_LIMIT_MAX),
    },
  };
}

export function getQBittorrentConfig(source: Partial<Env>): QBittorrentConfig {
  const url = readEnvString(source.QBITTORRENT_URL);
  const username = readEnvString(source.QBITTORRENT_USERNAME);
  const password = readEnvString(source.QBITTORRENT_PASSWORD);

  const missing = [
    !url ? "QBITTORRENT_URL" : null,
    !username ? "QBITTORRENT_USERNAME" : null,
    !password ? "QBITTORRENT_PASSWORD" : null,
  ].filter((value): value is string => value !== null);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variable${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  }

  const { requestTimeoutMs } = getRuntimeConfig(source);

  return {
    url: url!,
    username: username!,
    password: password!,
    requestTimeoutMs,
  };
}
