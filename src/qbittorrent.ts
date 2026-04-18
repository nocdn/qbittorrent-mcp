import type { Logger } from "./logger.ts";

export class QBittorrentClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private requestTimeoutMs: number;
  private logger: Logger;
  private sid: string | null = null;

  constructor(baseUrl: string, username: string, password: string, requestTimeoutMs = 30_000, logger?: Logger) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.username = username;
    this.password = password;
    this.requestTimeoutMs = requestTimeoutMs;
    this.logger = logger ?? {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => this.logger,
    };
  }

  async login(): Promise<void> {
    this.logger.debug("qBittorrent login started", {
      baseUrl: this.baseUrl,
      requestTimeoutMs: this.requestTimeoutMs,
    });

    const body = new URLSearchParams({ username: this.username, password: this.password });
    const res = await this.fetchWithTimeout("/api/v2/auth/login", {
      method: "POST",
      headers: { Referer: this.baseUrl },
      body,
    });

    if (!res.ok) {
      throw await this.createRequestError("POST", "/api/v2/auth/login", res);
    }

    const setCookie = res.headers.get("set-cookie");
    const match = setCookie?.match(/SID=([^;]+)/);
    if (!match) {
      const details = (await res.text()).trim();
      throw new Error(`Login failed: no SID cookie received${details ? ` (${details})` : ""}`);
    }
    this.sid = match[1];

    this.logger.debug("qBittorrent login succeeded", {
      baseUrl: this.baseUrl,
    });
  }

  async logout(): Promise<void> {
    await this.post("/api/v2/auth/logout");
    this.sid = null;
    this.logger.debug("qBittorrent session cleared");
  }

  async getVersion(): Promise<string> {
    const res = await this.get("/api/v2/app/version");
    return res.text();
  }

  async getApiVersion(): Promise<string> {
    const res = await this.get("/api/v2/app/webapiVersion");
    return res.text();
  }

  async validateConnection(): Promise<{ version: string; apiVersion: string }> {
    const version = await this.getVersion();
    const apiVersion = await this.getApiVersion();
    return { version, apiVersion };
  }

  async getPreferences(): Promise<Record<string, unknown>> {
    const res = await this.get("/api/v2/app/preferences");
    return res.json();
  }

  async getDefaultSavePath(): Promise<string> {
    const res = await this.get("/api/v2/app/defaultSavePath");
    return res.text();
  }

  async getTransferInfo(): Promise<Record<string, unknown>> {
    const res = await this.get("/api/v2/transfer/info");
    return res.json();
  }

  async getSpeedLimitsMode(): Promise<number> {
    const res = await this.get("/api/v2/transfer/speedLimitsMode");
    return Number(await res.text());
  }

  async setDownloadLimit(limit: number): Promise<void> {
    await this.post("/api/v2/transfer/setDownloadLimit", new URLSearchParams({ limit: String(limit) }));
  }

  async setUploadLimit(limit: number): Promise<void> {
    await this.post("/api/v2/transfer/setUploadLimit", new URLSearchParams({ limit: String(limit) }));
  }

  async getTorrents(
    filter?: string,
    category?: string,
    tag?: string,
    sort?: string,
    reverse?: boolean,
    limit?: number,
    offset?: number,
    hashes?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const params: Record<string, string> = {};
    if (filter !== undefined) params.filter = filter;
    if (category !== undefined) params.category = category;
    if (tag !== undefined) params.tag = tag;
    if (sort !== undefined) params.sort = sort;
    if (reverse !== undefined) params.reverse = String(reverse);
    if (limit !== undefined) params.limit = String(limit);
    if (offset !== undefined) params.offset = String(offset);
    if (hashes !== undefined) params.hashes = hashes;
    const res = await this.get("/api/v2/torrents/info", params);
    return res.json();
  }

  async getTorrent(hash: string): Promise<Record<string, unknown> | null> {
    const torrents = await this.getTorrents(undefined, undefined, undefined, undefined, undefined, undefined, undefined, hash);
    return torrents[0] ?? null;
  }

  async getTorrentProperties(hash: string): Promise<Record<string, unknown>> {
    const res = await this.get("/api/v2/torrents/properties", { hash });
    return res.json();
  }

  async getTorrentTrackers(hash: string): Promise<Array<Record<string, unknown>>> {
    const res = await this.get("/api/v2/torrents/trackers", { hash });
    return res.json();
  }

  async getTorrentFiles(hash: string): Promise<Array<Record<string, unknown>>> {
    const res = await this.get("/api/v2/torrents/files", { hash });
    return res.json();
  }

  async addTorrent(options: {
    urls?: string;
    savepath?: string;
    category?: string;
    tags?: string;
    skipChecking?: boolean;
    paused?: boolean;
    rootFolder?: boolean;
    rename?: string;
    upLimit?: number;
    dlLimit?: number;
    ratioLimit?: number;
    seedingTimeLimit?: number;
    autoTMM?: boolean;
    sequentialDownload?: boolean;
    firstLastPiecePrio?: boolean;
  }): Promise<string> {
    const body = new URLSearchParams();
    if (options.urls !== undefined) body.set("urls", options.urls);
    if (options.savepath !== undefined) body.set("savepath", options.savepath);
    if (options.category !== undefined) body.set("category", options.category);
    if (options.tags !== undefined) body.set("tags", options.tags);
    if (options.skipChecking !== undefined) body.set("skip_checking", String(options.skipChecking));
    if (options.paused !== undefined) body.set("paused", String(options.paused));
    if (options.rootFolder !== undefined) body.set("root_folder", String(options.rootFolder));
    if (options.rename !== undefined) body.set("rename", options.rename);
    if (options.upLimit !== undefined) body.set("upLimit", String(options.upLimit));
    if (options.dlLimit !== undefined) body.set("dlLimit", String(options.dlLimit));
    if (options.ratioLimit !== undefined) body.set("ratioLimit", String(options.ratioLimit));
    if (options.seedingTimeLimit !== undefined) body.set("seedingTimeLimit", String(options.seedingTimeLimit));
    if (options.autoTMM !== undefined) body.set("autoTMM", String(options.autoTMM));
    if (options.sequentialDownload !== undefined) body.set("sequentialDownload", String(options.sequentialDownload));
    if (options.firstLastPiecePrio !== undefined) body.set("firstLastPiecePrio", String(options.firstLastPiecePrio));
    const res = await this.post("/api/v2/torrents/add", body);
    return res.text();
  }

  async pauseTorrents(hashes: string): Promise<void> {
    await this.post("/api/v2/torrents/pause", new URLSearchParams({ hashes }));
  }

  async resumeTorrents(hashes: string): Promise<void> {
    await this.post("/api/v2/torrents/resume", new URLSearchParams({ hashes }));
  }

  async deleteTorrents(hashes: string, deleteFiles: boolean): Promise<void> {
    await this.post("/api/v2/torrents/delete", new URLSearchParams({ hashes, deleteFiles: String(deleteFiles) }));
  }

  async recheckTorrents(hashes: string): Promise<void> {
    await this.post("/api/v2/torrents/recheck", new URLSearchParams({ hashes }));
  }

  async reannounceTorrents(hashes: string): Promise<void> {
    await this.post("/api/v2/torrents/reannounce", new URLSearchParams({ hashes }));
  }

  async setTorrentCategory(hashes: string, category: string): Promise<void> {
    await this.post("/api/v2/torrents/setCategory", new URLSearchParams({ hashes, category }));
  }

  async addTorrentTags(hashes: string, tags: string): Promise<void> {
    await this.post("/api/v2/torrents/addTags", new URLSearchParams({ hashes, tags }));
  }

  async removeTorrentTags(hashes: string, tags: string): Promise<void> {
    await this.post("/api/v2/torrents/removeTags", new URLSearchParams({ hashes, tags }));
  }

  async setTorrentDownloadLimit(hashes: string, limit: number): Promise<void> {
    await this.post("/api/v2/torrents/setDownloadLimit", new URLSearchParams({ hashes, limit: String(limit) }));
  }

  async setTorrentUploadLimit(hashes: string, limit: number): Promise<void> {
    await this.post("/api/v2/torrents/setUploadLimit", new URLSearchParams({ hashes, limit: String(limit) }));
  }

  async setTorrentLocation(hashes: string, location: string): Promise<void> {
    await this.post("/api/v2/torrents/setLocation", new URLSearchParams({ hashes, location }));
  }

  async getCategories(): Promise<Record<string, unknown>> {
    const res = await this.get("/api/v2/torrents/categories");
    return res.json();
  }

  async getTags(): Promise<string[]> {
    const res = await this.get("/api/v2/torrents/tags");
    return res.json();
  }

  private async request(method: string, path: string, body?: URLSearchParams): Promise<Response> {
    const startedAt = Date.now();

    if (!this.sid) {
      await this.login();
    }

    const headers: Record<string, string> = { Cookie: `SID=${this.sid}` };
    let res = await this.fetchWithTimeout(path, { method, headers, body });

    if (res.status === 403) {
      this.logger.warn("qBittorrent request returned 403, retrying after re-authentication", {
        method,
        path,
      });
      await this.login();
      headers.Cookie = `SID=${this.sid}`;
      res = await this.fetchWithTimeout(path, { method, headers, body });
    }

    if (!res.ok) {
      throw await this.createRequestError(method, path, res);
    }

    this.logger.debug("qBittorrent request succeeded", {
      method,
      path,
      status: res.status,
      durationMs: Date.now() - startedAt,
    });

    return res;
  }

  private async get(path: string, params?: Record<string, string>): Promise<Response> {
    const url = params ? `${path}?${new URLSearchParams(params).toString()}` : path;
    return this.request("GET", url);
  }

  private async post(path: string, body?: URLSearchParams): Promise<Response> {
    return this.request("POST", path, body);
  }

  private async fetchWithTimeout(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(`Timed out after ${this.requestTimeoutMs}ms`);
    }, this.requestTimeoutMs);
    const timer = timeout as ReturnType<typeof setTimeout> & { unref?: () => void };
    timer.unref?.();

    try {
      return await fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        this.logger.warn("qBittorrent request timed out", {
          method: init.method ?? "GET",
          path,
          requestTimeoutMs: this.requestTimeoutMs,
        });
        throw new Error(`qBittorrent request timed out after ${this.requestTimeoutMs}ms: ${init.method ?? "GET"} ${path}`);
      }

      this.logger.warn("qBittorrent request failed before receiving a response", {
        method: init.method ?? "GET",
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async createRequestError(method: string, path: string, res: Response): Promise<Error> {
    const rawDetails = (await res.text()).trim();
    const details = rawDetails ? ` - ${rawDetails.slice(0, 200)}` : "";
    return new Error(`qBittorrent request failed: ${method} ${path} returned ${res.status} ${res.statusText}${details}`);
  }
}
