export type LogFormat = "json" | "pretty";

/** How application and HTTP access logs are serialized. Default is pretty for local and Docker log tailing; set LOG_FORMAT=json for log aggregators. */
export function getLogFormat(): LogFormat {
  const raw = process.env.LOG_FORMAT?.trim().toLowerCase();
  if (!raw || raw === "pretty" || raw === "human") {
    return "pretty";
  }
  if (raw === "json") {
    return "json";
  }
  throw new Error("Invalid environment variable LOG_FORMAT: expected json, pretty, or human (or omit for pretty)");
}
