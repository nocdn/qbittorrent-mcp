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

function emit(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>) {
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
