import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { processScreenshot } from "./image.js";

export interface RenderResult {
  png: Buffer;
  width: number;
  height: number;
  renderedAt: Date;
  durationMs: number;
}

export interface Renderer {
  render(): Promise<RenderResult>;
  close(): Promise<void>;
}

export type RenderErrorKind = "login" | "not-frontend" | "navigation" | "timeout" | "browser";

/** Steps of one render attempt, in order; named in timeout errors so the log says where time went. */
export type RenderPhase =
  | "launch"
  | "new-page"
  | "setup"
  | "navigate"
  | "probe"
  | "wait-dashboard"
  | "prepare"
  | "settle"
  | "screenshot"
  | "process";

/** A render failure with a classified cause, so callers and tests can tell them apart. */
export class RenderError extends Error {
  constructor(
    message: string,
    readonly kind: RenderErrorKind,
    readonly httpStatus: number | null = null,
    readonly phase: RenderPhase | null = null,
  ) {
    super(message);
    this.name = "RenderError";
  }
}

/** Puppeteer's own timeouts: a CDP call past `protocolTimeout` or a navigation/wait past its timeout. */
export function isProtocolTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "TimeoutError" || /timed out|timeout of \d+ ?ms exceeded/i.test(err.message);
}

/**
 * Rejects with `onTimeout()` when `work` has not settled within `ms`. The abandoned promise is
 * still allowed to settle later (e.g. once Chromium is killed) without an unhandled rejection.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  work.catch(() => undefined);
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/** What we learn about the document after navigation; input to classifyPage(). */
export interface PageProbe {
  /** URL the browser ended up on (after redirects). */
  url: string;
  /** HTTP status of the main document, null when the browser gave us none. */
  status: number | null;
  hasAuthorize: boolean;
  hasHomeAssistant: boolean;
  title: string;
}

/**
 * Decides whether the loaded page is a usable Home Assistant dashboard.
 * Checked in order: login page, then "not the frontend at all". Returns null when fine.
 */
export function classifyPage(probe: PageProbe, requestedUrl: string): RenderError | null {
  const status = probe.status === null ? "no HTTP status" : `HTTP ${probe.status}`;
  if (probe.hasAuthorize) {
    return new RenderError(
      `Home Assistant at ${new URL(probe.url).origin} showed the login page: the access token is missing, invalid or revoked. ` +
        "Create a new long-lived access token and update access_token.",
      "login",
      probe.status,
    );
  }
  if (!probe.hasHomeAssistant || (probe.status !== null && probe.status >= 400)) {
    const title = probe.title ? `, title "${probe.title}"` : "";
    return new RenderError(
      `The page at ${requestedUrl} is not the Home Assistant frontend (${status}${title}). ` +
        "ha_url must be the URL Home Assistant actually listens on, e.g. http://homeassistant:8123 or http://10.3.0.104, " +
        "and dashboard_path an existing dashboard.",
      "not-frontend",
      probe.status,
    );
  }
  return null;
}

/** Runs in the page before any frontend script: looks at the root elements of the document. */
const PROBE_SCRIPT = `
(() => ({
  url: window.location.href,
  hasAuthorize: !!document.querySelector("ha-authorize"),
  hasHomeAssistant: !!document.querySelector("home-assistant"),
  title: document.title || "",
}))()
`;

/**
 * Walks the frontend's shadow DOM. Returns "ready" once the Lovelace view (hui-root) exists,
 * "login" when the frontend swapped to the login page meanwhile, otherwise null (keep waiting).
 */
const DASHBOARD_STATE = `
(() => {
  if (document.querySelector("ha-authorize") || location.pathname.startsWith("/auth/")) return "login";
  const walk = (root, path) => {
    let el = root;
    for (const sel of path) {
      if (!el) return null;
      const sr = el.shadowRoot;
      el = (sr ?? el).querySelector(sel);
    }
    return el;
  };
  return walk(document, ["home-assistant", "home-assistant-main", "ha-panel-lovelace", "hui-root"]) ? "ready" : null;
})()
`;

/** Script run inside the HA frontend to hide the Lovelace header. Best effort: swallows errors. */
const HIDE_HEADER_SCRIPT = `
(() => {
  const style = document.createElement("style");
  style.textContent = "html, body { overflow: hidden !important; }";
  document.head.appendChild(style);
  const walk = (root, path) => {
    let el = root;
    for (const sel of path) {
      if (!el) return null;
      const sr = el.shadowRoot;
      el = (sr ?? el).querySelector(sel);
    }
    return el;
  };
  const huiRoot = walk(document, ["home-assistant", "home-assistant-main", "ha-panel-lovelace", "hui-root"]);
  if (huiRoot && huiRoot.shadowRoot) {
    const header = huiRoot.shadowRoot.querySelector(".header");
    if (header) header.style.display = "none";
    huiRoot.style.setProperty("--header-height", "0px");
    const view = huiRoot.shadowRoot.querySelector("#view");
    if (view) { view.style.paddingTop = "0px"; view.style.minHeight = "100vh"; }
  }
  return !!huiRoot;
})()
`;

/** Upper bound for waiting until hui-root shows up; non-Lovelace panels never produce it. */
const DASHBOARD_WAIT_MS = 20_000;
const ERROR_SCREENSHOT_TIMEOUT_MS = 10_000;
/** A page or browser that does not close within this is treated as hung and Chromium is killed. */
const CLOSE_TIMEOUT_MS = 5_000;
/** How long a probe retry waits after "Execution context was destroyed". */
const PROBE_RETRY_DELAY_MS = 500;

async function launchBrowser(cfg: Config): Promise<Browser> {
  log.info(`Launching Chromium at ${cfg.chromiumPath}`);
  return puppeteer.launch({
    executablePath: cfg.chromiumPath,
    headless: true,
    // Every CDP call (Runtime.evaluate, Page.captureScreenshot, Target.closeTarget, ...) fails after this
    // instead of puppeteer's default 180 s; a hung page then costs at most one render_timeout_ms.
    protocolTimeout: cfg.renderTimeoutMs,
    // Self-signed certificates on https://homeassistant are common; the token is scoped to that origin anyway.
    acceptInsecureCerts: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--no-first-run",
      "--disable-extensions",
      "--hide-scrollbars",
      "--font-render-hinting=none",
      "--force-device-scale-factor=1",
    ],
  });
}

export function dashboardUrl(cfg: Config): string {
  return `${cfg.haUrl}${cfg.dashboardPath}${cfg.urlQuery}`;
}

/**
 * Seeds the long-lived token (and UI preferences) into localStorage *before* any frontend
 * script runs, on every document the page loads. Evaluating after navigation raced with the
 * frontend's own redirects ("Execution context was destroyed").
 */
async function seedAuth(page: Page, cfg: Config): Promise<void> {
  const origin = new URL(cfg.haUrl).origin;
  const tokens = JSON.stringify({
    hassUrl: cfg.haUrl,
    clientId: null,
    access_token: cfg.accessToken,
    token_type: "Bearer",
    expires: 9_999_999_999_999,
    expires_in: 1_800,
  });
  await page.evaluateOnNewDocument(
    (tokensJson: string, expectedOrigin: string, language: string, theme: string) => {
      // Never hand the token to a different origin (misconfigured ha_url, redirect to a proxy, ...).
      if (window.location.origin !== expectedOrigin) return;
      try {
        localStorage.setItem("hassTokens", tokensJson);
        localStorage.setItem("dockedSidebar", JSON.stringify("always_hidden"));
        if (language) localStorage.setItem("selectedLanguage", JSON.stringify(language));
        if (theme) localStorage.setItem("selectedTheme", JSON.stringify({ theme }));
      } catch {
        // localStorage unavailable (e.g. an error page served with restrictive headers): the frontend will redirect to login.
      }
    },
    tokens,
    origin,
    cfg.language,
    cfg.theme,
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Inspects the current document. The frontend may still be redirecting (e.g. to the login page)
 * right after `load`, which destroys the execution context; retry until `deadline` instead of
 * failing. A protocol timeout is not retried: the page is hung and every retry would cost another
 * protocolTimeout (0.2.0 spent 4 x 180 s here, which is where the 16-minute stalls came from).
 */
async function probePage(page: Page, status: number | null, deadline: number): Promise<PageProbe> {
  for (let attempt = 1; ; attempt++) {
    try {
      const probe = (await page.evaluate(PROBE_SCRIPT)) as Omit<PageProbe, "status">;
      return { ...probe, status };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isProtocolTimeout(err)) {
        throw new RenderError(`The loaded page did not answer Runtime.evaluate: ${msg}`, "timeout", status, "probe");
      }
      if (Date.now() + PROBE_RETRY_DELAY_MS >= deadline || attempt >= 4) {
        throw new RenderError(`Could not inspect the loaded page: ${msg}`, "navigation", status, "probe");
      }
      log.debug(`Page inspection failed (attempt ${attempt}), retrying`, err);
      await sleep(PROBE_RETRY_DELAY_MS);
    }
  }
}

/** Wraps anything thrown inside a render attempt into a RenderError that names the phase. */
function toRenderError(err: unknown, phase: RenderPhase): RenderError {
  if (err instanceof RenderError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (isProtocolTimeout(err)) return new RenderError(`Chromium did not answer during ${phase}: ${msg}`, "timeout", null, phase);
  return new RenderError(`Render failed during ${phase}: ${msg}`, "browser", null, phase);
}

/** Kills the Chromium process (and its process group, as puppeteer spawns it detached). */
function killBrowserProcess(b: Browser): void {
  const proc = b.process();
  if (!proc || proc.pid === undefined || proc.exitCode !== null) return;
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    // not a group leader (or already gone): fall through to the plain kill
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // already exited
  }
}

async function saveErrorScreenshot(page: Page, cfg: Config): Promise<void> {
  if (!cfg.errorScreenshotPath || page.isClosed()) return;
  try {
    mkdirSync(dirname(cfg.errorScreenshotPath), { recursive: true });
    await Promise.race([
      page.screenshot({ type: "png", path: cfg.errorScreenshotPath, captureBeyondViewport: false }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("screenshot timed out")), ERROR_SCREENSHOT_TIMEOUT_MS)),
    ]);
    log.info(`Screenshot of the failed render saved to ${cfg.errorScreenshotPath} (also served at /last-error.png)`);
  } catch (err) {
    log.debug("Could not save the error screenshot", err);
  }
}

export interface RendererDeps {
  /** Starts Chromium; replaced by a fake in tests. */
  launch?: (cfg: Config) => Promise<Browser>;
  /** Bound for page.close()/browser.close() before Chromium is killed; shortened in tests. */
  closeTimeoutMs?: number;
}

export function createRenderer(cfg: Config, deps: RendererDeps = {}): Renderer {
  const launch = deps.launch ?? launchBrowser;
  const closeTimeoutMs = deps.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
  let browser: Browser | null = null;

  async function getBrowser(): Promise<Browser> {
    if (browser && browser.connected) return browser;
    const b = await launch(cfg);
    b.on("disconnected", () => {
      // Only forget it if it is still the current one; a replacement may already be running.
      if (browser === b) {
        log.warn("Chromium disconnected; it will be relaunched on the next render");
        browser = null;
      }
    });
    browser = b;
    return b;
  }

  /** Drops the current Chromium: graceful close bounded by closeTimeoutMs, then SIGKILL. */
  async function discardBrowser(reason: string): Promise<void> {
    const b = browser;
    browser = null;
    if (!b) return;
    log.warn(`Discarding Chromium (${reason}); it will be relaunched on the next render`);
    try {
      await withDeadline(b.close(), closeTimeoutMs, () => new Error("Browser.close timed out"));
    } catch (err) {
      log.warn("Chromium did not close in time, killing it", err);
      killBrowserProcess(b);
    }
  }

  /** Closes a page; a page that does not close in time means Chromium is stuck, so it is discarded. */
  async function closePage(page: Page): Promise<void> {
    if (page.isClosed()) return;
    try {
      await withDeadline(page.close(), closeTimeoutMs, () => new Error("Target.closeTarget timed out"));
    } catch (err) {
      await discardBrowser(`page did not close: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function renderOnce(): Promise<RenderResult> {
    const started = Date.now();
    const deadline = started + cfg.renderTimeoutMs;
    let phase: RenderPhase = "launch";
    let page: Page | null = null;

    const attempt = async (): Promise<RenderResult> => {
      const b = await getBrowser();
      phase = "new-page";
      const p = await b.newPage();
      page = p;
      phase = "setup";
      p.setDefaultTimeout(cfg.renderTimeoutMs);
      await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: cfg.colorScheme }]);
      // width x height is the dashboard viewport; `rotation` only turns the finished PNG.
      const viewport = { width: cfg.width, height: cfg.height };
      await p.setViewport({ ...viewport, deviceScaleFactor: 1 });
      await seedAuth(p, cfg);

      phase = "navigate";
      const url = dashboardUrl(cfg);
      log.debug(`Navigating to ${url}`);
      // "load" only: HA keeps a websocket open, so network-idle heuristics time out on healthy pages.
      const response = await p.goto(url, { waitUntil: "load", timeout: cfg.renderTimeoutMs }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        throw new RenderError(`Could not load ${url}: ${msg}`, "navigation", null, "navigate");
      });
      const status = response ? response.status() : null;

      phase = "probe";
      const problem = classifyPage(await probePage(p, status, deadline), url);
      if (problem) throw problem;

      phase = "wait-dashboard";
      // Never spend the whole remaining budget here: a non-Lovelace page must still get its screenshot.
      const waitMs = Math.max(0, Math.min(DASHBOARD_WAIT_MS, (deadline - Date.now()) / 2));
      const state = await p
        .waitForFunction(DASHBOARD_STATE, { timeout: waitMs, polling: 250 })
        .then((handle) => handle.jsonValue())
        .catch(() => null);
      if (state !== "ready") {
        // Either not a Lovelace dashboard, or the frontend rejected the token meanwhile and went to the login page.
        phase = "probe";
        const late = classifyPage(await probePage(p, null, deadline), url);
        if (late) throw late;
        log.debug("hui-root did not appear in time; not a Lovelace dashboard? Rendering anyway");
      }

      phase = "prepare";
      if (cfg.zoom !== 1) {
        await p.addStyleTag({ content: `body { zoom: ${cfg.zoom * 100}%; }` });
      }
      if (cfg.hideHeader) {
        try {
          const found = await p.evaluate(HIDE_HEADER_SCRIPT);
          if (!found) log.debug("hui-root not found; header not hidden (not a Lovelace dashboard?)");
        } catch (err) {
          if (isProtocolTimeout(err)) throw err;
          log.warn("Hiding header failed", err);
        }
      }

      phase = "settle";
      if (cfg.renderDelayMs > 0) await sleep(cfg.renderDelayMs);

      phase = "screenshot";
      const shot = await p.screenshot({
        type: "png",
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, ...viewport },
      });

      phase = "process";
      const processed = processScreenshot(Buffer.from(shot), {
        rotation: cfg.rotation,
        contrast: cfg.contrast,
        grayLevels: cfg.grayLevels,
        dither: cfg.dither,
      });
      return {
        png: processed.png,
        width: processed.width,
        height: processed.height,
        renderedAt: new Date(),
        durationMs: Date.now() - started,
      };
    };

    let result: RenderResult;
    try {
      // Hard bound for the whole attempt: no single step (or retry loop) may exceed render_timeout_ms.
      result = await withDeadline(
        attempt(),
        cfg.renderTimeoutMs,
        () => new RenderError(`Render timed out after ${cfg.renderTimeoutMs} ms during ${phase}`, "timeout", null, phase),
      );
    } catch (err) {
      const failure = toRenderError(err, phase);
      if (failure.kind === "timeout") {
        // The page (or Chromium) is not answering: a screenshot or a graceful close would only hang too.
        await discardBrowser(`render timed out during ${failure.phase ?? phase}`);
      } else {
        if (page) await saveErrorScreenshot(page, cfg);
        if (page) await closePage(page);
        else if (browser && !browser.connected) browser = null;
      }
      throw failure;
    }
    if (page) await closePage(page);
    return result;
  }

  return {
    render: renderOnce,
    async close() {
      if (browser) {
        const b = browser;
        browser = null;
        await b.close().catch(() => undefined);
      }
    },
  };
}
