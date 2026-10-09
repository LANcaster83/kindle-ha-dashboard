import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { loadConfig, redactConfig, type Config } from "./config.js";
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
  image_width: number | null;
  image_height: number | null;
  image_bytes: number | null;
  interval_seconds: number;
  next_render: string | null;
  uptime_seconds: number;
  version: string;
}

export const VERSION = "0.1.0";

/** Mutable state shared between the scheduler and the HTTP handlers. */
export class RenderState {
  last: RenderResult | null = null;
  etag: string | null = null;
  lastError: string | null = null;
  lastErrorAt: Date | null = null;
  renderCount = 0;
  errorCount = 0;
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
        this.etag = `"${createHash("sha1").update(res.png).digest("hex")}"`;
        this.renderCount += 1;
        this.lastError = null;
        log.info(`Rendered ${res.width}x${res.height} (${res.png.length} bytes) in ${res.durationMs} ms`);
        return res;
      })
      .catch((err: unknown) => {
        this.errorCount += 1;
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
      image_width: this.last?.width ?? null,
      image_height: this.last?.height ?? null,
      image_bytes: this.last?.png.length ?? null,
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

function indexHtml(status: Status): string {
  const ts = status.last_render ?? "never";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Kindle Dashboard Renderer</title>
<style>body{font-family:sans-serif;margin:1rem;background:#eee}img{max-width:100%;border:1px solid #999;background:#fff}pre{background:#fff;padding:.5rem}</style></head>
<body><h1>Kindle Dashboard Renderer</h1>
<p>Last render: ${ts}. <a href="/kindle.png">kindle.png</a> · <a href="/status">status</a> · <form style="display:inline" method="post" action="/render"><button>Render now</button></form></p>
<p><img src="/kindle.png?ts=${Date.now()}" alt="dashboard"></p>
<pre>${JSON.stringify(status, null, 2)}</pre></body></html>`;
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
      res.end(indexHtml(state.status()));
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
      const img = state.last;
      if (!img || !state.etag) {
        sendJson(res, 503, { error: "no image rendered yet" });
        return;
      }
      if (req.headers["if-none-match"] === state.etag) {
        res.writeHead(304, { ETag: state.etag });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": img.png.length,
        "Cache-Control": "no-cache",
        ETag: state.etag,
        "Last-Modified": img.renderedAt.toUTCString(),
        "X-Render-Time": img.renderedAt.toISOString(),
        "X-Image-Size": `${img.width}x${img.height}`,
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
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  log.info(`kindledash renderer ${VERSION} starting`, redactConfig(cfg));
  if (!cfg.accessToken) {
    log.error("No access_token configured. Create a long-lived access token in Home Assistant and set it in the app options.");
  }

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
