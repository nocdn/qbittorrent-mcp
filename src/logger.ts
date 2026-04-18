import { getLogFormat } from "./log-format.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  child: (scope: string) => Logger;
};

const logLevelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) {
    return undefined;
  }

  const entries = Object.entries(meta).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function useAnsiColors(): boolean {
  if (process.env.NO_COLOR && process.env.NO_COLOR !== "0") {
    return false;
  }
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") {
    return true;
  }
  return Boolean(process.stdout?.isTTY);
}

function ansi(level: LogLevel): { time: string; level: string; scope: string; reset: string } {
  if (!useAnsiColors()) {
    return { time: "", level: "", scope: "", reset: "" };
  }
  const reset = "\x1b[0m";
  const dim = "\x1b[2m";
  const bold = "\x1b[1m";
  const cyan = "\x1b[36m";
  const yellow = "\x1b[33m";
  const red = "\x1b[31m";
  const magenta = "\x1b[35m";
  const levelStyle =
    level === "error" ? red : level === "warn" ? yellow : level === "debug" ? magenta : bold;
  return {
    time: dim,
    level: levelStyle,
    scope: cyan,
    reset,
  };
}

function formatPrettyLine(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>): string {
  const iso = new Date().toISOString();
  const { time, level: lvlStyle, scope: scopeStyle, reset } = ansi(level);
  const levelTag = level.toUpperCase().padEnd(5);
  let line = `${time}${iso}${reset} ${lvlStyle}${levelTag}${reset} ${scopeStyle}[${scope}]${reset} ${message}`;
  const normalized = normalizeMeta(meta);
  if (normalized && Object.keys(normalized).length > 0) {
    const body = JSON.stringify(normalized, null, 2);
    line += `\n${body.split("\n").map((l) => `  ${l}`).join("\n")}`;
  }
  return line;
}

function emit(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>) {
  const format = getLogFormat();

  if (format === "pretty") {
    const line = formatPrettyLine(level, scope, message, meta);
    switch (level) {
      case "debug":
      case "info":
        console.log(line);
        break;
      case "warn":
        console.warn(line);
        break;
      case "error":
        console.error(line);
        break;
    }
    return;
  }

  const payload = {
    time: new Date().toISOString(),
    level,
    scope,
    message,
    ...(meta ? { meta } : {}),
  };

  const serialized = JSON.stringify(payload);

  switch (level) {
    case "debug":
    case "info":
      console.log(serialized);
      break;
    case "warn":
      console.warn(serialized);
      break;
    case "error":
      console.error(serialized);
      break;
  }
}

export function createLogger(scope: string, minimumLevel: LogLevel): Logger {
  const minimumPriority = logLevelPriority[minimumLevel];

  const log = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
    if (logLevelPriority[level] < minimumPriority) {
      return;
    }

    emit(level, scope, message, normalizeMeta(meta));
  };

  return {
    debug: (message, meta) => log("debug", message, meta),
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta),
    child: (childScope) => createLogger(`${scope}.${childScope}`, minimumLevel),
  };
}
