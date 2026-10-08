import { describe, expect, it } from "vitest";
import { buildConfig, ConfigError, normalisePath, redactConfig } from "../src/config.js";

describe("buildConfig", () => {
  it("applies defaults", () => {
    const cfg = buildConfig({}, {});
    expect(cfg.haUrl).toBe("http://homeassistant:8123");
    expect(cfg.width).toBe(1264);
    expect(cfg.height).toBe(1680);
    expect(cfg.rotation).toBe(0);
    expect(cfg.intervalSeconds).toBe(60);
    expect(cfg.grayLevels).toBe(16);
    expect(cfg.dither).toBe(true);
  });
  it("reads options.json values and lets env override them", () => {
    const cfg = buildConfig(
      { ha_url: "http://10.0.0.1:8123/", rotation: "90", interval: 120, hide_header: false },
      { KD_INTERVAL: "30", KD_DITHER: "false", KD_ACCESS_TOKEN: "abc" },
    );
    expect(cfg.haUrl).toBe("http://10.0.0.1:8123");
    expect(cfg.rotation).toBe(90);
    expect(cfg.intervalSeconds).toBe(30);
    expect(cfg.hideHeader).toBe(false);
    expect(cfg.dither).toBe(false);
    expect(cfg.accessToken).toBe("abc");
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
