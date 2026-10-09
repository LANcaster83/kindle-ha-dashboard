import { describe, expect, it } from "vitest";
import { DEFAULT_HA_URL, haUrlFromSupervisor, looksLikeHomeAssistant, resolveHaUrl, type FetchLike } from "../src/haurl.js";

type Route = { status: number; body?: unknown } | "down";

/** Minimal fetch stub keyed by URL; unknown URLs behave like a refused connection. */
function fakeFetch(routes: Record<string, Route>): FetchLike & { calls: string[] } {
  const fn = ((url: string): Promise<Response> => {
    fn.calls.push(url);
    const route = routes[url];
    if (!route || route === "down") return Promise.reject(new TypeError("fetch failed: ECONNREFUSED"));
    return Promise.resolve(new Response(route.body === undefined ? "" : JSON.stringify(route.body), { status: route.status }));
  }) as FetchLike & { calls: string[] };
  fn.calls = [];
  return fn;
}

const coreInfo = (port: number, ssl = false): Route => ({ status: 200, body: { result: "ok", data: { port, ssl } } });

describe("haUrlFromSupervisor", () => {
  it("builds the URL from the Supervisor's port and scheme", async () => {
    expect(await haUrlFromSupervisor("t", fakeFetch({ "http://supervisor/core/info": coreInfo(8123) }))).toBe(
      "http://homeassistant:8123",
    );
    expect(await haUrlFromSupervisor("t", fakeFetch({ "http://supervisor/core/info": coreInfo(80) }))).toBe("http://homeassistant");
    expect(await haUrlFromSupervisor("t", fakeFetch({ "http://supervisor/core/info": coreInfo(8123, true) }))).toBe(
      "https://homeassistant:8123",
    );
  });
  it("sends the token as a bearer header", async () => {
    let auth: string | null = null;
    const fetchFn: FetchLike = (_url, init) => {
      auth = new Headers(init?.headers).get("authorization");
      return Promise.resolve(new Response(JSON.stringify({ data: { port: 80, ssl: false } }), { status: 200 }));
    };
    await haUrlFromSupervisor("secret", fetchFn);
    expect(auth).toBe("Bearer secret");
  });
  it("returns null on HTTP errors, bad payloads and connection failures", async () => {
    expect(await haUrlFromSupervisor("t", fakeFetch({ "http://supervisor/core/info": { status: 403, body: {} } }))).toBeNull();
    expect(await haUrlFromSupervisor("t", fakeFetch({ "http://supervisor/core/info": { status: 200, body: { data: {} } } }))).toBeNull();
    expect(await haUrlFromSupervisor("t", fakeFetch({}))).toBeNull();
  });
});

describe("looksLikeHomeAssistant", () => {
  it("accepts 401 and 200 from /api/, rejects anything else", async () => {
    expect(await looksLikeHomeAssistant("http://x", fakeFetch({ "http://x/api/": { status: 401 } }))).toBe(true);
    expect(await looksLikeHomeAssistant("http://x", fakeFetch({ "http://x/api/": { status: 200 } }))).toBe(true);
    expect(await looksLikeHomeAssistant("http://x", fakeFetch({ "http://x/api/": { status: 404 } }))).toBe(false);
    expect(await looksLikeHomeAssistant("http://x", fakeFetch({}))).toBe(false);
  });
});

describe("resolveHaUrl", () => {
  it("uses the configured option without touching the network", async () => {
    const fetchFn = fakeFetch({});
    const r = await resolveHaUrl("http://10.3.0.104", { SUPERVISOR_TOKEN: "t" }, fetchFn);
    expect(r).toMatchObject({ url: "http://10.3.0.104", source: "option" });
    expect(fetchFn.calls).toEqual([]);
  });
  it("asks the Supervisor on HAOS", async () => {
    const fetchFn = fakeFetch({ "http://supervisor/core/info": coreInfo(80) });
    const r = await resolveHaUrl("", { SUPERVISOR_TOKEN: "t" }, fetchFn);
    expect(r).toMatchObject({ url: "http://homeassistant", source: "supervisor" });
  });
  it("falls back to probing 8123 then 80 when the Supervisor does not answer", async () => {
    const on80 = fakeFetch({ "http://homeassistant/api/": { status: 401 } });
    expect(await resolveHaUrl("", { SUPERVISOR_TOKEN: "t" }, on80)).toMatchObject({ url: "http://homeassistant", source: "probe" });
    expect(on80.calls).toEqual(["http://supervisor/core/info", "http://homeassistant:8123/api/", "http://homeassistant/api/"]);

    const on8123 = fakeFetch({ "http://homeassistant:8123/api/": { status: 401 } });
    expect(await resolveHaUrl("", {}, on8123)).toMatchObject({ url: "http://homeassistant:8123", source: "probe" });
    expect(on8123.calls).toEqual(["http://homeassistant:8123/api/"]);
  });
  it("defaults to homeassistant:8123 when nothing answers", async () => {
    const r = await resolveHaUrl("", {}, fakeFetch({}));
    expect(r).toMatchObject({ url: DEFAULT_HA_URL, source: "default" });
  });
});
