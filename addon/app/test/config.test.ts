import { describe, expect, it } from "vitest";
import { buildConfig, ConfigError, normalisePath, redactConfig } from "../src/config.js";

describe("buildConfig", () => {
  it("applies landscape Oasis defaults and leaves ha_url to be resolved", () => {
    const cfg = buildConfig({}, {});
    expect(cfg.haUrl).toBe("");
    expect(cfg.haUrlSource).toBe("unresolved");
    expect(cfg.width).toBe(1680);
    expect(cfg.height).toBe(1264);
    expect(cfg.rotation).toBe(90);
    expect(cfg.intervalSeconds).toBe(60);
    expect(cfg.grayLevels).toBe(16);
    expect(cfg.dither).toBe(true);
    expect(cfg.errorScreenshotPath).toBe("/data/last-error.png");
  });
  it("reads options.json values and lets env override them", () => {
    const cfg = buildConfig(
      { ha_url: "http://10.0.0.1:8123/", rotation: "0", interval: 120, hide_header: false },
      { KD_INTERVAL: "30", KD_DITHER: "false", KD_ACCESS_TOKEN: "abc", KD_ERROR_SCREENSHOT: "" },
    );
    expect(cfg.haUrl).toBe("http://10.0.0.1:8123");
    expect(cfg.haUrlSource).toBe("option");
    expect(cfg.rotation).toBe(0);
    expect(cfg.intervalSeconds).toBe(30);
    expect(cfg.hideHeader).toBe(false);
    expect(cfg.dither).toBe(false);
    expect(cfg.accessToken).toBe("abc");
    // An empty env value does not override; the default stays.
    expect(cfg.errorScreenshotPath).toBe("/data/last-error.png");
  });
  it("accepts a port-less ha_url (Home Assistant on port 80)", () => {
    expect(buildConfig({ ha_url: "http://10.3.0.104" }, {}).haUrl).toBe("http://10.3.0.104");
  });
  it("treats an empty or blank ha_url like a missing one (auto-detection)", () => {
    // The HA configuration UI sends "" for a cleared field; the schema is str? so it reaches us.
    for (const value of ["", "   ", null, undefined]) {
      const cfg = buildConfig({ ha_url: value }, {});
      expect(cfg.haUrl).toBe("");
      expect(cfg.haUrlSource).toBe("unresolved");
    }
    expect(buildConfig({ ha_url: "http://x" }, { KD_HA_URL: "" }).haUrl).toBe("http://x");
  });
  it("validates ranges and enums", () => {
    expect(() => buildConfig({ interval: 1 }, {})).toThrow(ConfigError);
    expect(() => buildConfig({ rotation: "45" }, {})).toThrow(ConfigError);
    expect(() => buildConfig({ ha_url: "homeassistant:8123" }, {})).toThrow(ConfigError);
    expect(() => buildConfig({ dither: "maybe" }, {})).toThrow(ConfigError);
  });
  it("normalises dashboard paths", () => {
    expect(normalisePath("dashboard-test-2")).toBe("/dashboard-test-2");
    expect(normalisePath(" /lovelace/0 ")).toBe("/lovelace/0");
    expect(normalisePath("")).toBe("/");
  });
  it("redacts secrets", () => {
    const cfg = buildConfig({ access_token: "secret", server_token: "s2" }, {});
    const red = redactConfig(cfg);
    expect(red.accessToken).toBe("***");
    expect(red.serverToken).toBe("***");
  });
});
