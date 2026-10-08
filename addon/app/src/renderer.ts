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

async function launchBrowser(cfg: Config): Promise<Browser> {
  log.info(`Launching Chromium at ${cfg.chromiumPath}`);
  return puppeteer.launch({
    executablePath: cfg.chromiumPath,
    headless: true,
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

function dashboardUrl(cfg: Config): string {
  return `${cfg.haUrl}${cfg.dashboardPath}${cfg.urlQuery}`;
}

/** Stores the long-lived token the way the HA frontend expects it, then returns. */
async function injectAuth(page: Page, cfg: Config): Promise<void> {
  const origin = new URL(cfg.haUrl).origin;
  const tokens = JSON.stringify({
    hassUrl: cfg.haUrl,
    clientId: null,
    access_token: cfg.accessToken,
    token_type: "Bearer",
    expires: 9_999_999_999_999,
    expires_in: 1_800,
  });
  await page.goto(`${cfg.haUrl}/`, { waitUntil: "domcontentloaded", timeout: cfg.renderTimeoutMs });
  await page.evaluate(
    (tokensJson: string, expectedOrigin: string, language: string, theme: string) => {
      if (window.location.origin !== expectedOrigin) {
        throw new Error(`Refusing to store token on origin ${window.location.origin}`);
      }
      localStorage.setItem("hassTokens", tokensJson);
      localStorage.setItem("dockedSidebar", JSON.stringify("always_hidden"));
      if (language) localStorage.setItem("selectedLanguage", JSON.stringify(language));
      if (theme) localStorage.setItem("selectedTheme", JSON.stringify({ theme }));
    },
    tokens,
    origin,
    cfg.language,
    cfg.theme,
  );
}

export function createRenderer(cfg: Config): Renderer {
  let browser: Browser | null = null;
  let authenticated = false;

  async function getBrowser(): Promise<Browser> {
    if (browser && browser.connected) return browser;
    authenticated = false;
    browser = await launchBrowser(cfg);
    browser.on("disconnected", () => {
      log.warn("Chromium disconnected; it will be relaunched on the next render");
      browser = null;
      authenticated = false;
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
      const landscape = cfg.rotation === 90 || cfg.rotation === 270;
      const viewport = landscape
        ? { width: cfg.height, height: cfg.width }
        : { width: cfg.width, height: cfg.height };
      await page.setViewport({ ...viewport, deviceScaleFactor: 1 });

      if (!authenticated) {
        await injectAuth(page, cfg);
        authenticated = true;
      }

      const url = dashboardUrl(cfg);
      log.debug(`Navigating to ${url}`);
      await page.goto(url, { waitUntil: ["load", "networkidle2"], timeout: cfg.renderTimeoutMs });
      await page.waitForSelector("home-assistant", { timeout: cfg.renderTimeoutMs });

      // Detect the login page: the frontend swaps the root element when unauthenticated.
      const onLogin = await page.$("ha-authorize");
      if (onLogin) {
        authenticated = false;
        throw new Error("Home Assistant showed the login page: the access token is missing, invalid or revoked");
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
