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

export type RenderErrorKind = "login" | "not-frontend" | "navigation";

/** A render failure with a classified cause, so callers and tests can tell them apart. */
export class RenderError extends Error {
  constructor(
    message: string,
    readonly kind: RenderErrorKind,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "RenderError";
  }
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

async function launchBrowser(cfg: Config): Promise<Browser> {
  log.info(`Launching Chromium at ${cfg.chromiumPath}`);
  return puppeteer.launch({
    executablePath: cfg.chromiumPath,
    headless: true,
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
 * right after `load`, which destroys the execution context; retry a few times instead of failing.
 */
async function probePage(page: Page, status: number | null): Promise<PageProbe> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const probe = (await page.evaluate(PROBE_SCRIPT)) as Omit<PageProbe, "status">;
      return { ...probe, status };
    } catch (err) {
      lastErr = err;
      await sleep(500);
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new RenderError(`Could not inspect the loaded page: ${msg}`, "navigation", status);
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

export function createRenderer(cfg: Config): Renderer {
  let browser: Browser | null = null;

  async function getBrowser(): Promise<Browser> {
    if (browser && browser.connected) return browser;
    browser = await launchBrowser(cfg);
    browser.on("disconnected", () => {
      log.warn("Chromium disconnected; it will be relaunched on the next render");
      browser = null;
    });
    return browser;
  }

  async function renderOnce(): Promise<RenderResult> {
    const started = Date.now();
    const b = await getBrowser();
    const page = await b.newPage();
    try {
      page.setDefaultTimeout(cfg.renderTimeoutMs);
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: cfg.colorScheme }]);
      // width x height is the dashboard viewport; `rotation` only turns the finished PNG.
      const viewport = { width: cfg.width, height: cfg.height };
      await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
      await seedAuth(page, cfg);

      const url = dashboardUrl(cfg);
      log.debug(`Navigating to ${url}`);
      // "load" only: HA keeps a websocket open, so network-idle heuristics time out on healthy pages.
      const response = await page.goto(url, { waitUntil: "load", timeout: cfg.renderTimeoutMs }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        throw new RenderError(`Could not load ${url}: ${msg}`, "navigation");
      });
      const status = response ? response.status() : null;
      const problem = classifyPage(await probePage(page, status), url);
      if (problem) throw problem;

      const state = await page
        .waitForFunction(DASHBOARD_STATE, { timeout: Math.min(DASHBOARD_WAIT_MS, cfg.renderTimeoutMs), polling: 250 })
        .then((handle) => handle.jsonValue())
        .catch(() => null);
      if (state !== "ready") {
        // Either not a Lovelace dashboard, or the frontend rejected the token meanwhile and went to the login page.
        const late = classifyPage(await probePage(page, null), url);
        if (late) throw late;
        log.debug("hui-root did not appear in time; not a Lovelace dashboard? Rendering anyway");
      }

      if (cfg.zoom !== 1) {
        await page.addStyleTag({ content: `body { zoom: ${cfg.zoom * 100}%; }` });
      }
      if (cfg.hideHeader) {
        try {
          const found = await page.evaluate(HIDE_HEADER_SCRIPT);
          if (!found) log.debug("hui-root not found; header not hidden (not a Lovelace dashboard?)");
        } catch (err) {
          log.warn("Hiding header failed", err);
        }
      }
      if (cfg.renderDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, cfg.renderDelayMs));
      }

      const shot = await page.screenshot({
        type: "png",
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, ...viewport },
      });
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
    } catch (err) {
      await saveErrorScreenshot(page, cfg);
      throw err;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  return {
    async render() {
      try {
        return await renderOnce();
      } catch (err) {
        // A crashed or hung browser is the most common failure: drop it so the retry relaunches.
        if (browser && !browser.connected) browser = null;
        throw err;
      }
    },
    async close() {
      if (browser) {
        const b = browser;
        browser = null;
        await b.close().catch(() => undefined);
      }
    },
  };
}
