import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadConfig, redactConfig, type Config, type Rotation } from "./config.js";
import { resolveHaUrl } from "./haurl.js";
import { effectiveRotation, encodeGrayPng, parseFbRotate, rotate, type FbRotate } from "./image.js";
import { log, setLogLevel } from "./log.js";
import { createRenderer, type Renderer, type RenderResult } from "./renderer.js";

export interface Status {
  ok: boolean;
  rendering: boolean;
  last_render: string | null;
  last_duration_ms: number | null;
  last_error: string | null;
  last_error_at: string | null;
  render_count: number;
  error_count: number;
  /** Failures since the last successful render; 0 while renders succeed. */
  consecutive_errors: number;
  image_width: number | null;
  image_height: number | null;
  image_bytes: number | null;
  /** The configured base rotation; `/kindle.png?fb_rotate=` serves other rotations of the same frame. */
  rotation: Rotation;
  interval_seconds: number;
  next_render: string | null;
  uptime_seconds: number;
  version: string;
}

export const VERSION = "0.2.2";

/** One encoding of the latest frame at a given rotation. */
export interface ImageVariant {
  png: Buffer;
  width: number;
  height: number;
  rotation: Rotation;
  etag: string;
}

function etagOf(png: Buffer): string {
  return `"${createHash("sha1").update(png).digest("hex")}"`;
}

/** Mutable state shared between the scheduler and the HTTP handlers. */
export class RenderState {
  last: RenderResult | null = null;
  etag: string | null = null;
  /** Encodings of `last` at rotations other than the configured one, derived on demand. */
  private variants = new Map<Rotation, ImageVariant>();
  lastError: string | null = null;
  lastErrorAt: Date | null = null;
  renderCount = 0;
  errorCount = 0;
  consecutiveErrors = 0;
  rendering: Promise<RenderResult> | null = null;
  nextRenderAt: Date | null = null;
  private readonly startedAt = Date.now();

  constructor(
    private readonly renderer: Renderer,
    private readonly cfg: Config,
  ) {}

  /** Renders now, coalescing concurrent requests into one browser session. */
  render(): Promise<RenderResult> {
    if (this.rendering) return this.rendering;
    this.rendering = this.renderer
      .render()
      .then((res) => {
        this.last = res;
        this.etag = etagOf(res.png);
        this.variants.clear();
        this.renderCount += 1;
        this.consecutiveErrors = 0;
        this.lastError = null;
        log.info(`Rendered ${res.width}x${res.height} (${res.png.length} bytes) in ${res.durationMs} ms`);
        return res;
      })
      .catch((err: unknown) => {
        this.errorCount += 1;
        this.consecutiveErrors += 1;
        this.lastError = err instanceof Error ? err.message : String(err);
        this.lastErrorAt = new Date();
        log.error("Render failed", err);
        throw err;
      })
      .finally(() => {
        this.rendering = null;
      });
    return this.rendering;
  }

  /**
   * The latest frame rotated so that it shows upright on a framebuffer the kernel displays rotated by
   * `fbRotate` (what the Kindle reports as `currentRota`). The configured rotation is served as rendered;
   * other rotations are encoded once per render and cached until the next one.
   */
  variant(fbRotate: FbRotate): ImageVariant | null {
    const last = this.last;
    if (!last || !this.etag) return null;
    const rotation = effectiveRotation(this.cfg.rotation, fbRotate);
    if (rotation === this.cfg.rotation) {
      return { png: last.png, width: last.width, height: last.height, rotation, etag: this.etag };
    }
    let variant = this.variants.get(rotation);
    if (!variant) {
      const img = rotate(last.image, rotation);
      const png = encodeGrayPng(img);
      variant = { png, width: img.width, height: img.height, rotation, etag: etagOf(png) };
      this.variants.set(rotation, variant);
      log.info(`Encoded the frame at rotation ${rotation} (fb_rotate=${fbRotate}, base ${this.cfg.rotation}): ${img.width}x${img.height}`);
    }
    return variant;
  }

  status(): Status {
    return {
      ok: this.last !== null && this.lastError === null,
      rendering: this.rendering !== null,
      last_render: this.last?.renderedAt.toISOString() ?? null,
      last_duration_ms: this.last?.durationMs ?? null,
      last_error: this.lastError,
      last_error_at: this.lastErrorAt?.toISOString() ?? null,
      render_count: this.renderCount,
      error_count: this.errorCount,
      consecutive_errors: this.consecutiveErrors,
      image_width: this.last?.width ?? null,
      image_height: this.last?.height ?? null,
      image_bytes: this.last?.png.length ?? null,
      rotation: this.cfg.rotation,
      interval_seconds: this.cfg.intervalSeconds,
      next_render: this.nextRenderAt?.toISOString() ?? null,
      uptime_seconds: Math.round((Date.now() - this.startedAt) / 1000),
      version: VERSION,
    };
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Checks ?token=, X-Kindle-Token and Authorization: Bearer against the configured server token. */
export function isAuthorised(req: IncomingMessage, url: URL, serverToken: string): boolean {
  if (!serverToken) return true;
  const candidates: string[] = [];
  const q = url.searchParams.get("token");
  if (q) candidates.push(q);
  const h = req.headers["x-kindle-token"];
  if (typeof h === "string") candidates.push(h);
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) candidates.push(auth.slice(7).trim());
  return candidates.some((c) => constantTimeEquals(c, serverToken));
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(payload);
}

function indexHtml(status: Status, cfg: Config): string {
  const ts = status.last_render ?? "never";
  const orientation =
    cfg.rotation === 0
      ? `Dashboard viewport ${cfg.width}x${cfg.height}, served as is.`
      : `Dashboard viewport ${cfg.width}x${cfg.height}, served rotated by ${cfg.rotation}° for the Kindle framebuffer.`;
  const errorNote = status.last_error
    ? `<p><b>Last error:</b> ${escapeHtml(status.last_error)} · <a href="/last-error.png">last-error.png</a></p>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Kindle Dashboard Renderer</title>
<style>body{font-family:sans-serif;margin:1rem;background:#eee}img{max-width:100%;max-height:90vh;border:1px solid #999;background:#fff}pre{background:#fff;padding:.5rem}</style></head>
<body><h1>Kindle Dashboard Renderer</h1>
<p>Last render: ${ts}. <a href="/kindle.png">kindle.png</a> · <a href="/status">status</a> · <a href="/config">config</a> · <form style="display:inline" method="post" action="/render"><button>Render now</button></form></p>
<p>${orientation} Home Assistant: ${escapeHtml(cfg.haUrl)} (${escapeHtml(cfg.haUrlSource)}).</p>
${errorNote}
<p><img src="/kindle.png?ts=${Date.now()}" alt="dashboard"></p>
<pre>${JSON.stringify(status, null, 2)}</pre></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function createApp(state: RenderState, cfg: Config) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const path = url.pathname;

    if (path === "/health") {
      sendJson(res, 200, { ok: true, version: VERSION });
      return;
    }

    if (!isAuthorised(req, url, cfg.serverToken)) {
      sendJson(res, 401, { error: "unauthorised" });
      return;
    }

    if (path === "/" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(indexHtml(state.status(), cfg));
      return;
    }

    if (path === "/last-error.png" && method === "GET") {
      try {
        const png = cfg.errorScreenshotPath ? await readFile(cfg.errorScreenshotPath) : null;
        if (!png) throw new Error("disabled");
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "no-store" });
        res.end(png);
      } catch {
        sendJson(res, 404, { error: "no failed render has been captured yet" });
      }
      return;
    }

    if (path === "/status" && method === "GET") {
      sendJson(res, 200, state.status());
      return;
    }

    if (path === "/config" && method === "GET") {
      sendJson(res, 200, redactConfig(cfg));
      return;
    }

    if (path === "/render" && (method === "POST" || method === "GET")) {
      try {
        await state.render();
        sendJson(res, 200, state.status());
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err), ...state.status() });
      }
      return;
    }

    if (path === "/kindle.png" && (method === "GET" || method === "HEAD")) {
      const fbRotate = parseFbRotate(url.searchParams.get("fb_rotate"));
      if (fbRotate === undefined) {
        sendJson(res, 400, { error: "fb_rotate must be 0, 1, 2 or 3 (the framebuffer rotation, fbink's currentRota)" });
        return;
      }
      const fresh = url.searchParams.get("render") === "1";
      if (fresh || !state.last) {
        try {
          await state.render();
        } catch (err) {
          if (!state.last) {
            sendJson(res, 503, { error: err instanceof Error ? err.message : String(err) });
            return;
          }
          // Serve the stale image but flag the failure.
          res.setHeader("X-Render-Error", "1");
        }
      }
      const img = state.variant(fbRotate ?? 0);
      const renderedAt = state.last?.renderedAt;
      if (!img || !renderedAt) {
        sendJson(res, 503, { error: "no image rendered yet" });
        return;
      }
      if (req.headers["if-none-match"] === img.etag) {
        res.writeHead(304, { ETag: img.etag });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": img.png.length,
        "Cache-Control": "no-cache",
        ETag: img.etag,
        "Last-Modified": renderedAt.toUTCString(),
        "X-Render-Time": renderedAt.toISOString(),
        "X-Image-Size": `${img.width}x${img.height}`,
        "X-Image-Rotation": String(img.rotation),
      });
      res.end(method === "HEAD" ? undefined : img.png);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  };
}

/** Periodic render loop; waits `interval` after each render finishes (success or failure). */
export function startScheduler(state: RenderState, intervalSeconds: number): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await state.render();
    } catch {
      // already logged
    }
    if (stopped) return;
    const delayMs = intervalSeconds * 1000;
    state.nextRenderAt = new Date(Date.now() + delayMs);
    timer = setTimeout(() => void tick(), delayMs);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function main(): Promise<void> {
  const loaded = loadConfig();
  setLogLevel(loaded.logLevel);
  log.info(`kindledash renderer ${VERSION} starting`, redactConfig(loaded));
  if (!loaded.accessToken) {
    log.error("No access_token configured. Create a long-lived access token in Home Assistant and set it in the app options.");
  }

  const resolved = await resolveHaUrl(loaded.haUrl, process.env);
  const cfg: Config = { ...loaded, haUrl: resolved.url, haUrlSource: resolved.source };
  const line = `Home Assistant URL: ${cfg.haUrl} (${resolved.detail})`;
  if (resolved.source === "default") log.warn(line);
  else log.info(line);

  const renderer = createRenderer(cfg);
  const state = new RenderState(renderer, cfg);
  const app = createApp(state, cfg);
  const server = createServer((req, res) => {
    app(req, res).catch((err: unknown) => {
      log.error("Unhandled request error", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
  });
  await new Promise<void>((resolve) => server.listen(cfg.port, "0.0.0.0", resolve));
  log.info(`HTTP server listening on :${cfg.port}`);
  const stopScheduler = startScheduler(state, cfg.intervalSeconds);

  const shutdown = (signal: string): void => {
    log.info(`Received ${signal}, shutting down`);
    stopScheduler();
    server.close();
    renderer
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) {
  main().catch((err: unknown) => {
    log.error("Fatal", err);
    process.exit(1);
  });
}
