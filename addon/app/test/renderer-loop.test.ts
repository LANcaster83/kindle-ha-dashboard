import { describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { PNG } from "pngjs";
import { buildConfig, type Config } from "../src/config.js";
import { createRenderer, isProtocolTimeout, RenderError, withDeadline } from "../src/renderer.js";

/** What the loaded page does when the renderer calls `page.evaluate` (the probe), in call order. */
type EvaluateStep = "ok" | "hang" | "protocol-timeout" | "context-destroyed";

interface FakeOptions {
  evaluate?: EvaluateStep[];
  /** page.close() never resolves (Target.closeTarget hangs). */
  hangClose?: boolean;
  /** page.screenshot() never resolves. */
  hangScreenshot?: boolean;
}

interface FakeBrowser {
  browser: Browser;
  calls: string[];
  closed: boolean;
  killed: boolean;
  pages: number;
}

const never = (): Promise<never> => new Promise(() => undefined);

function pngOf(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(200);
  return PNG.sync.write(png);
}

const PROTOCOL_TIMEOUT_MSG =
  "Runtime.evaluate timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed.";

function fakeBrowser(opts: FakeOptions = {}): FakeBrowser {
  const steps = [...(opts.evaluate ?? ["ok"])];
  const fake: FakeBrowser = { browser: null as unknown as Browser, calls: [], closed: false, killed: false, pages: 0 };
  let connected = true;
  let disconnected: (() => void) | null = null;

  const newPage = (): Page => {
    fake.pages += 1;
    let closed = false;
    const page = {
      setDefaultTimeout: () => undefined,
      emulateMediaFeatures: () => Promise.resolve(),
      setViewport: () => Promise.resolve(),
      evaluateOnNewDocument: () => {
        fake.calls.push("seed");
        return Promise.resolve();
      },
      goto: () => {
        fake.calls.push("goto");
        return Promise.resolve({ status: () => 200 });
      },
      evaluate: async (script: string) => {
        if (script.includes("const style")) return true; // HIDE_HEADER_SCRIPT
        fake.calls.push("evaluate");
        const step = steps.length > 1 ? steps.shift() : steps[0];
        if (step === "hang") return never();
        if (step === "protocol-timeout") throw new Error(PROTOCOL_TIMEOUT_MSG);
        if (step === "context-destroyed") throw new Error("Execution context was destroyed, most likely because of a navigation.");
        return { url: "http://ha.test/dashboard", hasAuthorize: false, hasHomeAssistant: true, title: "Home Assistant" };
      },
      waitForFunction: () => Promise.resolve({ jsonValue: () => Promise.resolve("ready") }),
      addStyleTag: () => Promise.resolve(),
      screenshot: async () => {
        fake.calls.push("screenshot");
        if (opts.hangScreenshot) return never();
        return pngOf(4, 2);
      },
      isClosed: () => closed,
      close: async () => {
        fake.calls.push("page.close");
        if (opts.hangClose) return never();
        closed = true;
      },
    };
    return page as unknown as Page;
  };

  const browser = {
    get connected() {
      return connected;
    },
    on: (event: string, handler: () => void) => {
      if (event === "disconnected") disconnected = handler;
    },
    newPage: () => Promise.resolve(newPage()),
    close: () => {
      fake.calls.push("browser.close");
      fake.closed = true;
      connected = false;
      disconnected?.();
      return Promise.resolve();
    },
    process: () => ({
      pid: 424242,
      exitCode: null,
      kill: () => {
        fake.killed = true;
        return true;
      },
    }),
  };
  fake.browser = browser as unknown as Browser;
  return fake;
}

function config(renderTimeoutMs: number): Config {
  return {
    ...buildConfig({ ha_url: "http://ha.test", access_token: "tok", render_delay_ms: 0, rotation: "0" }, {}),
    width: 4,
    height: 2,
    renderTimeoutMs,
    errorScreenshotPath: "",
  };
}

/** A renderer whose Chromium is a fake; `launched` lists every browser it started. */
function renderer(cfg: Config, browsers: FakeOptions[]) {
  const launched: FakeBrowser[] = [];
  const queue = [...browsers];
  const r = createRenderer(cfg, {
    closeTimeoutMs: 200,
    launch: () => {
      const b = fakeBrowser(queue.shift() ?? {});
      launched.push(b);
      return Promise.resolve(b.browser);
    },
  });
  return { r, launched };
}

describe("createRenderer", () => {
  it("renders a page through a fresh tab, seeding the token before navigation", async () => {
    const { r, launched } = renderer(config(2000), [{}]);
    const res = await r.render();
    expect(res.width).toBe(4);
    expect(res.height).toBe(2);
    expect(launched).toHaveLength(1);
    expect(launched[0]?.calls).toEqual(["seed", "goto", "evaluate", "screenshot", "page.close"]);
    expect(launched[0]?.closed).toBe(false);
    // The second render reuses Chromium but opens a new tab.
    await r.render();
    expect(launched).toHaveLength(1);
    expect(launched[0]?.pages).toBe(2);
  });

  it("bounds a render whose page never answers the probe, then replaces Chromium", async () => {
    const { r, launched } = renderer(config(300), [{ evaluate: ["hang"] }, {}]);
    const started = Date.now();
    const err = await r.render().catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(err).toBeInstanceOf(RenderError);
    expect((err as RenderError).kind).toBe("timeout");
    expect((err as RenderError).phase).toBe("probe");
    expect((err as RenderError).message).toMatch(/timed out after 300 ms during probe/);
    // One evaluate, no retries, no screenshot of the hung page; Chromium is dropped.
    expect(launched[0]?.calls).toEqual(["seed", "goto", "evaluate", "browser.close"]);
    expect(launched[0]?.closed).toBe(true);

    const res = await r.render();
    expect(res.width).toBe(4);
    expect(launched).toHaveLength(2);
  });

  it("treats puppeteer's protocolTimeout error as a timeout and does not retry the probe", async () => {
    const { r, launched } = renderer(config(5000), [{ evaluate: ["protocol-timeout"] }]);
    const err = (await r.render().catch((e: unknown) => e)) as RenderError;
    expect(err.kind).toBe("timeout");
    expect(err.phase).toBe("probe");
    expect(err.message).toContain("Runtime.evaluate timed out");
    expect(launched[0]?.calls.filter((c) => c === "evaluate")).toHaveLength(1);
    expect(launched[0]?.closed).toBe(true);
  });

  it("retries the probe when the frontend destroyed the execution context", async () => {
    const { r, launched } = renderer(config(5000), [{ evaluate: ["context-destroyed", "ok"] }]);
    await r.render();
    expect(launched[0]?.calls.filter((c) => c === "evaluate")).toHaveLength(2);
    expect(launched[0]?.closed).toBe(false);
  });

  it("gives up the probe retries before the deadline", async () => {
    const { r } = renderer(config(1200), [{ evaluate: ["context-destroyed"] }]);
    const started = Date.now();
    const err = (await r.render().catch((e: unknown) => e)) as RenderError;
    expect(Date.now() - started).toBeLessThan(1500);
    expect(err.kind).toBe("navigation");
    expect(err.message).toContain("Could not inspect the loaded page");
  });

  it("names the phase when the screenshot hangs", async () => {
    const { r, launched } = renderer(config(300), [{ hangScreenshot: true }]);
    const err = (await r.render().catch((e: unknown) => e)) as RenderError;
    expect(err.kind).toBe("timeout");
    expect(err.phase).toBe("screenshot");
    expect(launched[0]?.closed).toBe(true);
  });

  it("kills Chromium when the tab refuses to close after a successful render", async () => {
    const { r, launched } = renderer(config(2000), [{ hangClose: true }, {}]);
    const res = await r.render();
    expect(res.width).toBe(4);
    // page.close hung (bounded): the browser is discarded so the next render starts a new one.
    expect(launched[0]?.calls.slice(-2)).toEqual(["page.close", "browser.close"]);
    await r.render();
    expect(launched).toHaveLength(2);
  });
});

describe("withDeadline", () => {
  it("rejects with the given error after the deadline and lets the work settle quietly later", async () => {
    let reject: (e: Error) => void = () => undefined;
    const work = new Promise<never>((_, r) => (reject = r));
    await expect(withDeadline(work, 20, () => new Error("late"))).rejects.toThrow("late");
    reject(new Error("abandoned")); // must not surface as an unhandled rejection
  });
  it("passes a value through", async () => {
    await expect(withDeadline(Promise.resolve(7), 1000, () => new Error("late"))).resolves.toBe(7);
  });
});

describe("isProtocolTimeout", () => {
  it("recognises puppeteer's timeouts", () => {
    expect(isProtocolTimeout(new Error(PROTOCOL_TIMEOUT_MSG))).toBe(true);
    const navigation = new Error("Navigation timeout of 45000 ms exceeded");
    navigation.name = "TimeoutError";
    expect(isProtocolTimeout(navigation)).toBe(true);
    expect(isProtocolTimeout(new Error("Execution context was destroyed"))).toBe(false);
    expect(isProtocolTimeout("timed out")).toBe(false);
  });
});
