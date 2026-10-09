import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config.js";
import { classifyPage, dashboardUrl, RenderError, type PageProbe } from "../src/renderer.js";

const REQUESTED = "http://10.3.0.104/dashboard-test-2";

function probe(overrides: Partial<PageProbe> = {}): PageProbe {
  return {
    url: REQUESTED,
    status: 200,
    hasAuthorize: false,
    hasHomeAssistant: true,
    title: "Home Assistant",
    ...overrides,
  };
}

describe("classifyPage", () => {
  it("accepts a loaded frontend", () => {
    expect(classifyPage(probe(), REQUESTED)).toBeNull();
    // A second probe after the dashboard wait carries no status.
    expect(classifyPage(probe({ status: null }), REQUESTED)).toBeNull();
  });

  it("reports the login page as a rejected token, even when the frontend element is missing", () => {
    const err = classifyPage(
      probe({ url: "http://10.3.0.104/auth/authorize?response_type=code", hasAuthorize: true, hasHomeAssistant: false }),
      REQUESTED,
    );
    expect(err).toBeInstanceOf(RenderError);
    expect(err?.kind).toBe("login");
    expect(err?.message).toContain("login page");
    expect(err?.message).toContain("http://10.3.0.104");
    expect(err?.message).toContain("access token");
  });

  it("reports a non-frontend page with the HTTP status (mistyped URL, HA 404)", () => {
    const err = classifyPage(
      probe({ url: "http://10.3.0.104/8123", status: 404, hasHomeAssistant: false, title: "404: Not Found" }),
      "http://10.3.0.104/8123",
    );
    expect(err?.kind).toBe("not-frontend");
    expect(err?.httpStatus).toBe(404);
    expect(err?.message).toContain("http://10.3.0.104/8123");
    expect(err?.message).toContain("HTTP 404");
    expect(err?.message).toContain("404: Not Found");
    expect(err?.message).toContain("ha_url");
  });

  it("treats a 2xx page without <home-assistant> as not the frontend (reverse proxy, other app)", () => {
    const err = classifyPage(probe({ hasHomeAssistant: false, title: "Welcome to nginx!" }), REQUESTED);
    expect(err?.kind).toBe("not-frontend");
    expect(err?.message).toContain("HTTP 200");
    expect(err?.message).toContain("nginx");
  });

  it("treats an error status as a failure even if the element is present", () => {
    const err = classifyPage(probe({ status: 502 }), REQUESTED);
    expect(err?.kind).toBe("not-frontend");
    expect(err?.message).toContain("HTTP 502");
  });

  it("copes with a missing status", () => {
    const err = classifyPage(probe({ status: null, hasHomeAssistant: false, title: "" }), REQUESTED);
    expect(err?.message).toContain("no HTTP status");
    expect(err?.message).not.toContain("title");
  });
});

describe("dashboardUrl", () => {
  it("joins ha_url, path and query", () => {
    const cfg = buildConfig({ ha_url: "http://10.3.0.104/", dashboard_path: "dashboard-test-2", url_query: "?kiosk" }, {});
    expect(dashboardUrl(cfg)).toBe("http://10.3.0.104/dashboard-test-2?kiosk");
  });
});
