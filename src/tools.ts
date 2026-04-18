import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { QBittorrentClient } from "./qbittorrent.ts";

const hashInputSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const tagsInputSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const urlsInputSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const waitUntilSchema = z.enum(["exists", "complete", "seeding", "paused", "missing"]);

type HashInput = z.infer<typeof hashInputSchema>;
type TagsInput = z.infer<typeof tagsInputSchema>;
type UrlsInput = z.infer<typeof urlsInputSchema>;
type WaitUntil = z.infer<typeof waitUntilSchema>;

type CompactTorrentStatus = {
  found: boolean;
  hash: string;
  name?: string;
  state?: string;
  progress?: number;
  eta?: number;
  dlspeed?: number;
  upspeed?: number;
  completed?: boolean;
};

function ok(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

function done(action: string, details: Record<string, unknown> = {}) {
  return ok({
    status: "done",
    action,
    ...details,
  });
}

function fail(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

function normalizeInfoHash(value: string): string | null {
  const trimmed = value.trim();

  if (/^[a-fA-F0-9]{40}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  if (!/^[A-Z2-7]{32}$/i.test(trimmed)) {
    return null;
  }

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let buffer = 0;
  let bufferedBits = 0;
  let hex = "";

  for (const char of trimmed.toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value === -1) {
      return null;
    }

    buffer = (buffer << 5) | value;
    bufferedBits += 5;

    while (bufferedBits >= 4) {
      bufferedBits -= 4;
      hex += ((buffer >> bufferedBits) & 0x0f).toString(16);
    }
  }

  return hex.length === 40 ? hex : null;
}

function normalizeHash(value: string): string {
  return normalizeInfoHash(value) ?? value.trim();
}

function splitInput(value: string | string[], separator: RegExp): string[] {
  const parts = Array.isArray(value) ? value : [value];
  return parts.flatMap((part) => part.split(separator)).map((part) => part.trim()).filter(Boolean);
}

function normalizeUrls(urls: UrlsInput): string[] {
  return splitInput(urls, /\r?\n/);
}

function normalizeTags(tags: TagsInput): string[] {
  return [...new Set(splitInput(tags, /,/))];
}

function normalizeHashesInput(hashes: HashInput): { parameter: string; hashes: string[]; all: boolean } {
  const values = [...new Set(splitInput(hashes, /\|/).map((value) => normalizeHash(value)))];

  if (values.includes("all")) {
    if (values.length !== 1) {
      throw new Error("The value 'all' cannot be combined with specific hashes");
    }

    return {
      parameter: "all",
      hashes: [],
      all: true,
    };
  }

  return {
    parameter: values.join("|"),
    hashes: values,
    all: false,
  };
}

function toHashScopeResult(input: { hashes: string[]; all: boolean }) {
  return {
    hashes: input.hashes,
    all: input.all,
  };
}

function extractInfoHashes(urls: string): string[] {
  const hashes = new Set<string>();

  for (const entry of urls.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    if (!entry.toLowerCase().startsWith("magnet:?")) {
      continue;
    }

    const query = entry.slice("magnet:?".length);
    const xtValues = new URLSearchParams(query).getAll("xt");

    for (const xt of xtValues) {
      const match = xt.match(/^urn:btih:(.+)$/i);
      if (!match) {
        continue;
      }

      const hash = normalizeInfoHash(match[1]);
      if (hash) {
        hashes.add(hash);
      }
    }
  }

  return [...hashes];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function toCompactTorrentStatus(hash: string, torrent: Record<string, unknown> | null): CompactTorrentStatus {
  const normalizedHash = normalizeHash(hash);

  if (!torrent) {
    return {
      found: false,
      hash: normalizedHash,
    };
  }

  const torrentHash = asString(torrent.hash);
  const progress = asNumber(torrent.progress);

  return {
    found: true,
    hash: torrentHash ? normalizeHash(torrentHash) : normalizedHash,
    name: asString(torrent.name),
    state: asString(torrent.state),
    progress,
    eta: asNumber(torrent.eta),
    dlspeed: asNumber(torrent.dlspeed),
    upspeed: asNumber(torrent.upspeed),
    completed: progress !== undefined ? progress >= 1 : undefined,
  };
}

async function getCompactTorrentStatus(client: QBittorrentClient, hash: string): Promise<CompactTorrentStatus> {
  const normalizedHash = normalizeHash(hash);
  const torrent = await client.getTorrent(normalizedHash);
  return toCompactTorrentStatus(normalizedHash, torrent);
}

function matchesWaitCondition(status: CompactTorrentStatus, until: WaitUntil): boolean {
  if (until === "missing") {
    return !status.found;
  }

  if (!status.found) {
    return false;
  }

  const state = status.state?.toLowerCase() ?? "";
  const progress = status.progress ?? 0;

  switch (until) {
    case "exists":
      return true;
    case "complete":
      return progress >= 1;
    case "seeding":
      return progress >= 1 && (state.includes("upload") || state.includes("seed") || state.includes("up"));
    case "paused":
      return state.startsWith("paused");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForTorrent(
  client: QBittorrentClient,
  hash: string,
  until: WaitUntil,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<{ elapsedMs: number; torrent: CompactTorrentStatus }> {
  const normalizedHash = normalizeHash(hash);
  const startedAt = Date.now();
  let lastStatus = await getCompactTorrentStatus(client, normalizedHash);

  if (matchesWaitCondition(lastStatus, until)) {
    return {
      elapsedMs: Date.now() - startedAt,
      torrent: lastStatus,
    };
  }

  while (Date.now() - startedAt < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    await sleep(Math.min(pollIntervalMs, remainingMs));

    lastStatus = await getCompactTorrentStatus(client, normalizedHash);
    if (matchesWaitCondition(lastStatus, until)) {
      return {
        elapsedMs: Date.now() - startedAt,
        torrent: lastStatus,
      };
    }
  }

  throw new Error(
    `Timed out waiting for torrent ${normalizedHash} to reach '${until}' after ${timeoutMs}ms. Last observed status: ${JSON.stringify(lastStatus)}`,
  );
}

export function registerTools(mcp: McpServer, client: QBittorrentClient): void {
  mcp.tool("get_version", "Get qBittorrent application version", async () => {
    try { return ok(await client.getVersion()); } catch (e) { return fail(e); }
  });

  mcp.tool("get_api_version", "Get qBittorrent Web API version", async () => {
    try { return ok(await client.getApiVersion()); } catch (e) { return fail(e); }
  });

  mcp.tool("get_preferences", "Get qBittorrent application preferences", async () => {
    try { return ok(await client.getPreferences()); } catch (e) { return fail(e); }
  });

  mcp.tool("get_default_save_path", "Get default save path for torrents", async () => {
    try { return ok(await client.getDefaultSavePath()); } catch (e) { return fail(e); }
  });

  mcp.tool("get_transfer_info", "Get global transfer info (speeds, connection status)", async () => {
    try { return ok(await client.getTransferInfo()); } catch (e) { return fail(e); }
  });

  mcp.tool("get_speed_limits_mode", "Get current speed limits mode (0=normal, 1=alternative)", async () => {
    try { return ok(await client.getSpeedLimitsMode()); } catch (e) { return fail(e); }
  });

  mcp.tool("set_global_download_limit", "Set global download speed limit in bytes/second (0 to disable)", { limit: z.number() }, async (args) => {
    try {
      await client.setDownloadLimit(args.limit);
      return done("set_global_download_limit", { limit: args.limit });
    } catch (e) {
      return fail(e);
    }
  });

  mcp.tool("set_global_upload_limit", "Set global upload speed limit in bytes/second (0 to disable)", { limit: z.number() }, async (args) => {
    try {
      await client.setUploadLimit(args.limit);
      return done("set_global_upload_limit", { limit: args.limit });
    } catch (e) {
      return fail(e);
    }
  });

  mcp.tool("list_torrents", "List torrents with optional filters", {
    filter: z.enum(["all", "downloading", "seeding", "completed", "paused", "active", "inactive", "resumed", "stalled", "stalled_uploading", "stalled_downloading", "errored"]).optional(),
    category: z.string().optional(),
    tag: z.string().optional(),
    sort: z.string().optional(),
    reverse: z.boolean().optional(),
    limit: z.number().optional(),
    offset: z.number().optional(),
  }, async (args) => {
    try { return ok(await client.getTorrents(args.filter, args.category, args.tag, args.sort, args.reverse, args.limit, args.offset)); } catch (e) { return fail(e); }
  });

  mcp.tool("get_torrent_status", "Get a compact status snapshot for a specific torrent", {
    hash: z.string(),
  }, async (args) => {
    try {
      return ok(await getCompactTorrentStatus(client, args.hash));
    } catch (e) {
      return fail(e);
    }
  });

  mcp.tool("wait_for_torrent", "Wait for a torrent to reach a target state", {
    hash: z.string(),
    until: waitUntilSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
    pollIntervalMs: z.number().int().positive().optional(),
  }, async (args) => {
    try {
      const until = args.until ?? "complete";
      const timeoutMs = args.timeoutMs ?? 5 * 60 * 1000;
      const pollIntervalMs = Math.min(args.pollIntervalMs ?? 2_000, timeoutMs);
      const result = await waitForTorrent(client, args.hash, until, timeoutMs, pollIntervalMs);

      return done("wait_for_torrent", {
        until,
        elapsedMs: result.elapsedMs,
        torrent: result.torrent,
      });
    } catch (e) {
      return fail(e);
    }
  });

  mcp.tool("get_torrent_properties", "Get properties for a specific torrent", { hash: z.string() }, async (args) => {
    try { return ok(await client.getTorrentProperties(normalizeHash(args.hash))); } catch (e) { return fail(e); }
  });

  mcp.tool("get_torrent_trackers", "Get trackers for a specific torrent", { hash: z.string() }, async (args) => {
    try { return ok(await client.getTorrentTrackers(normalizeHash(args.hash))); } catch (e) { return fail(e); }
  });

  mcp.tool("get_torrent_files", "Get files for a specific torrent", { hash: z.string() }, async (args) => {
    try { return ok(await client.getTorrentFiles(normalizeHash(args.hash))); } catch (e) { return fail(e); }
  });

  mcp.tool("add_torrent", "Add torrents by URL or magnet link", {
    urls: urlsInputSchema.describe("Magnet links or torrent URLs as an array or newline-separated string"),
    savepath: z.string().optional(),
    category: z.string().optional(),
    tags: tagsInputSchema.optional().describe("Tags as an array or comma-separated string"),
    skipChecking: z.boolean().optional(),
    paused: z.boolean().optional(),
    rootFolder: z.boolean().optional(),
    rename: z.string().optional(),
    upLimit: z.number().optional(),
    dlLimit: z.number().optional(),
    ratioLimit: z.number().optional(),
    seedingTimeLimit: z.number().int().optional(),
    autoTMM: z.boolean().optional(),
    sequentialDownload: z.boolean().optional(),
    firstLastPiecePrio: z.boolean().optional(),
  }, async (args) => {
    try {
      const normalizedUrls = normalizeUrls(args.urls);
      const normalizedTags = args.tags !== undefined ? normalizeTags(args.tags) : undefined;
      const response = await client.addTorrent({
        ...args,
        urls: normalizedUrls.join("\n"),
        tags: normalizedTags?.join(","),
      });
      const hashes = extractInfoHashes(normalizedUrls.join("\n"));

      return done("add_torrent", {
        hash: hashes.length === 1 ? hashes[0] : null,
        hashes,
        urls: normalizedUrls,
        tags: normalizedTags ?? [],
        qbittorrentResponse: response,
      });
    } catch (e) {
      return fail(e);
    }
  });

  mcp.tool("pause_torrents", "Pause one or more torrents", {
    hashes: hashInputSchema.describe("Hashes as an array, a pipe-separated string, or 'all'"),
  }, async (args) => {
    try {
      const normalized = normalizeHashesInput(args.hashes);
      await client.pauseTorrents(normalized.parameter);
      return done("pause_torrents", toHashScopeResult(normalized));
    } catch (e) {
      return fail(e);
    }
  });

  mcp.tool("resume_torrents", "Resume one or more torrents", {
    hashes: hashInputSchema.describe("Hashes as an array, a pipe-separated string, or 'all'"),
  }, async (args) => {
    try {
      const normalized = normalizeHashesInput(args.hashes);
      await client.resumeTorrents(normalized.parameter);
      return done("resume_torrents", toHashScopeResult(normalized));
    } catch (e) {
      return fail(e);
    }
  });

  mcp.tool("delete_torrents", "Delete one or more torrents", {
    hashes: hashInputSchema.describe("Hashes as an array, a pipe-separated string, or 'all'"),
    deleteFiles: z.boolean().describe("Also delete downloaded files"),
  }, async (args) => {
    try {
      const normalized = normalizeHashesInput(args.hashes);
      await client.deleteTorrents(normalized.parameter, args.deleteFiles);
      return done("delete_torrents", {
        ...toHashScopeResult(normalized),
        deleteFiles: args.deleteFiles,
      });
    } catch (e) {
      return fail(e);
    }
  });

  mcp.tool("recheck_torrents", "Recheck one or more torrents", {
    hashes: hashInputSchema.describe("Hashes as an array, a pipe-separated string, or 'all'"),
  }, async (args) => {
    try {
      const normalized = normalizeHashesInput(args.hashes);
      await client.recheckTorrents(normalized.parameter);
      return done("recheck_torrents", toHashScopeResult(normalized));
    } catch (e) {
      return fail(e);
    }
  });

  mcp.tool("reannounce_torrents", "Reannounce one or more torrents to trackers", {
    hashes: hashInputSchema.describe("Hashes as an array, a pipe-separated string, or 'all'"),
  }, async (args) => {
    try {
      const normalized = normalizeHashesInput(args.hashes);
      await client.reannounceTorrents(normalized.parameter);
      return done("reannounce_torrents", toHashScopeResult(normalized));
    } catch (e) {
      return fail(e);
    }
  });

  mcp.tool("set_torrent_category", "Set category for one or more torrents", {
    hashes: hashInputSchema,
    category: z.string(),
  }, async (args) => {
    try {
      const normalized = normalizeHashesInput(args.hashes);
      await client.setTorrentCategory(normalized.parameter, args.category);
      return done("set_torrent_category", {
        ...toHashScopeResult(normalized),
        category: args.category,
      });
    } catch (e) {
      return fail(e);
    }
  });

  mcp.tool("add_torrent_tags", "Add tags to one or more torrents", {
    hashes: hashInputSchema,
    tags: tagsInputSchema.describe("Tags as an array or comma-separated string"),
  }, async (args) => {
    try {
      const normalizedHashes = normalizeHashesInput(args.hashes);
      const normalizedTags = normalizeTags(args.tags);
      await client.addTorrentTags(normalizedHashes.parameter, normalizedTags.join(","));
      return done("add_torrent_tags", {
        ...toHashScopeResult(normalizedHashes),
        tags: normalizedTags,
      });
    } catch (e) {
      return fail(e);
    }
  });

  mcp.tool("remove_torrent_tags", "Remove tags from one or more torrents", {
    hashes: hashInputSchema,
    tags: tagsInputSchema.describe("Tags as an array or comma-separated string"),
  }, async (args) => {
    try {
      const normalizedHashes = normalizeHashesInput(args.hashes);
      const normalizedTags = normalizeTags(args.tags);
      await client.removeTorrentTags(normalizedHashes.parameter, normalizedTags.join(","));
      return done("remove_torrent_tags", {
        ...toHashScopeResult(normalizedHashes),
        tags: normalizedTags,
      });
    } catch (e) {
      return fail(e);
    }
  });

  mcp.tool("set_torrent_download_limit", "Set download speed limit for specific torrents (bytes/second, 0 to disable)", {
    hashes: hashInputSchema,
    limit: z.number(),
  }, async (args) => {
    try {
      const normalized = normalizeHashesInput(args.hashes);
      await client.setTorrentDownloadLimit(normalized.parameter, args.limit);
      return done("set_torrent_download_limit", {
        ...toHashScopeResult(normalized),
        limit: args.limit,
      });
    } catch (e) {
      return fail(e);
    }
  });

  mcp.tool("set_torrent_upload_limit", "Set upload speed limit for specific torrents (bytes/second, 0 to disable)", {
    hashes: hashInputSchema,
    limit: z.number(),
  }, async (args) => {
    try {
      const normalized = normalizeHashesInput(args.hashes);
      await client.setTorrentUploadLimit(normalized.parameter, args.limit);
      return done("set_torrent_upload_limit", {
        ...toHashScopeResult(normalized),
        limit: args.limit,
      });
    } catch (e) {
      return fail(e);
    }
  });

  mcp.tool("set_torrent_location", "Move torrents to a different location on disk", {
    hashes: hashInputSchema,
    location: z.string(),
  }, async (args) => {
    try {
      const normalized = normalizeHashesInput(args.hashes);
      await client.setTorrentLocation(normalized.parameter, args.location);
      return done("set_torrent_location", {
        ...toHashScopeResult(normalized),
        location: args.location,
      });
    } catch (e) {
      return fail(e);
    }
  });

  mcp.tool("get_categories", "Get all torrent categories", async () => {
    try { return ok(await client.getCategories()); } catch (e) { return fail(e); }
  });

  mcp.tool("get_tags", "Get all torrent tags", async () => {
    try { return ok(await client.getTags()); } catch (e) { return fail(e); }
  });
}
