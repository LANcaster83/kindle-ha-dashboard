import { readFileSync, existsSync } from "node:fs";

export type Rotation = 0 | 90 | 180 | 270;

export interface Config {
  /** Home Assistant base URL. Empty = resolve at startup (Supervisor, then probe), see haurl.ts. */
  haUrl: string;
  accessToken: string;
  dashboardPath: string;
  urlQuery: string;
  width: number;
  height: number;
  rotation: Rotation;
  zoom: number;
  intervalSeconds: number;
  renderDelayMs: number;
  colorScheme: "light" | "dark";
  theme: string;
  language: string;
  hideHeader: boolean;
  grayLevels: number;
  dither: boolean;
  contrast: number;
  serverToken: string;
  port: number;
  chromiumPath: string;
  renderTimeoutMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  /** Where the screenshot of a failed render is written. Empty disables it. */
  errorScreenshotPath: string;
  /** How haUrl was determined: "option", "supervisor", "probe", "default"; "unresolved" before startup. */
  haUrlSource: string;
}

type RawOptions = Record<string, unknown>;

export const OPTIONS_FILE = "/data/options.json";

/** Maps option names (as in config.yaml / options.json) to KD_* env vars. */
const ENV_MAP: Record<string, string> = {
  ha_url: "KD_HA_URL",
  access_token: "KD_ACCESS_TOKEN",
  dashboard_path: "KD_DASHBOARD_PATH",
  url_query: "KD_URL_QUERY",
  width: "KD_WIDTH",
  height: "KD_HEIGHT",
  rotation: "KD_ROTATION",
  zoom: "KD_ZOOM",
  interval: "KD_INTERVAL",
  render_delay_ms: "KD_RENDER_DELAY_MS",
  color_scheme: "KD_COLOR_SCHEME",
  theme: "KD_THEME",
  language: "KD_LANGUAGE",
  hide_header: "KD_HIDE_HEADER",
  gray_levels: "KD_GRAY_LEVELS",
  dither: "KD_DITHER",
  contrast: "KD_CONTRAST",
  server_token: "KD_SERVER_TOKEN",
  port: "KD_PORT",
  chromium_path: "CHROMIUM_PATH",
  render_timeout_ms: "KD_RENDER_TIMEOUT_MS",
  log_level: "KD_LOG_LEVEL",
  error_screenshot: "KD_ERROR_SCREENSHOT",
};

/** Kindle Oasis (2017/2019) panel: 1264x1680 portrait, 300 ppi. Defaults render a landscape dashboard. */
export const OASIS_LONG_EDGE = 1680;
export const OASIS_SHORT_EDGE = 1264;

export class ConfigError extends Error {}

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v) ?? "";
}

function str(raw: RawOptions, key: string, def: string): string {
  const v = raw[key];
  if (v === undefined || v === null) return def;
  return asText(v).trim();
}

function num(raw: RawOptions, key: string, def: number, min: number, max: number): number {
  const v = raw[key];
  if (v === undefined || v === null || v === "") return def;
  const n = typeof v === "number" ? v : Number(asText(v).trim());
  if (!Number.isFinite(n)) throw new ConfigError(`Option ${key} must be a number, got ${asText(v)}`);
  if (n < min || n > max) throw new ConfigError(`Option ${key} must be between ${min} and ${max}, got ${n}`);
  return n;
}

function bool(raw: RawOptions, key: string, def: boolean): boolean {
  const v = raw[key];
  if (v === undefined || v === null || v === "") return def;
  if (typeof v === "boolean") return v;
  const s = asText(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  throw new ConfigError(`Option ${key} must be a boolean, got ${asText(v)}`);
}

function oneOf<T extends string>(raw: RawOptions, key: string, def: T, allowed: readonly T[]): T {
  const v = str(raw, key, def);
  if (!(allowed as readonly string[]).includes(v)) {
    throw new ConfigError(`Option ${key} must be one of ${allowed.join(", ")}, got ${v}`);
  }
  return v as T;
}

/** Normalises a dashboard path so it always starts with a single slash. */
export function normalisePath(p: string): string {
  const trimmed = p.trim();
  if (trimmed === "") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Builds a Config from raw options (options.json shape) and env overrides. */
export function buildConfig(fileOptions: RawOptions, env: NodeJS.ProcessEnv = process.env): Config {
  const raw: RawOptions = { ...fileOptions };
  for (const [key, envName] of Object.entries(ENV_MAP)) {
    const v = env[envName];
    if (v !== undefined && v !== "") raw[key] = v;
  }

  const haUrl = str(raw, "ha_url", "").replace(/\/+$/, "");
  if (haUrl !== "" && !/^https?:\/\//.test(haUrl)) {
    throw new ConfigError(`Option ha_url must start with http:// or https://, got ${haUrl}`);
  }
  const accessToken = str(raw, "access_token", "");

  const rotationStr = oneOf(raw, "rotation", "90", ["0", "90", "180", "270"] as const);

  return {
    haUrl,
    accessToken,
    dashboardPath: normalisePath(str(raw, "dashboard_path", "/dashboard-test-2")),
    urlQuery: str(raw, "url_query", ""),
    width: Math.round(num(raw, "width", OASIS_LONG_EDGE, 100, 4096)),
    height: Math.round(num(raw, "height", OASIS_SHORT_EDGE, 100, 4096)),
    rotation: Number(rotationStr) as Rotation,
    zoom: num(raw, "zoom", 1.0, 0.25, 4.0),
    intervalSeconds: Math.round(num(raw, "interval", 60, 10, 86400)),
    renderDelayMs: Math.round(num(raw, "render_delay_ms", 1500, 0, 60000)),
    colorScheme: oneOf(raw, "color_scheme", "light", ["light", "dark"] as const),
    theme: str(raw, "theme", ""),
    language: str(raw, "language", ""),
    hideHeader: bool(raw, "hide_header", true),
    grayLevels: Math.round(num(raw, "gray_levels", 16, 2, 256)),
    dither: bool(raw, "dither", true),
    contrast: num(raw, "contrast", 1.15, 0.5, 3.0),
    serverToken: str(raw, "server_token", ""),
    port: Math.round(num(raw, "port", 8080, 1, 65535)),
    chromiumPath: str(raw, "chromium_path", "/usr/bin/chromium-browser"),
    renderTimeoutMs: Math.round(num(raw, "render_timeout_ms", 45000, 1000, 600000)),
    logLevel: oneOf(raw, "log_level", "info", ["debug", "info", "warn", "error"] as const),
    errorScreenshotPath: str(raw, "error_screenshot", "/data/last-error.png"),
    haUrlSource: haUrl ? "option" : "unresolved",
  };
}

export function loadConfig(optionsFile: string = OPTIONS_FILE, env: NodeJS.ProcessEnv = process.env): Config {
  let fileOptions: RawOptions = {};
  if (existsSync(optionsFile)) {
    const parsed: unknown = JSON.parse(readFileSync(optionsFile, "utf8"));
    if (parsed && typeof parsed === "object") fileOptions = parsed as RawOptions;
  }
  return buildConfig(fileOptions, env);
}

/** Config with secrets masked, for logging and /status. */
export function redactConfig(cfg: Config): Record<string, unknown> {
  return {
    ...cfg,
    accessToken: cfg.accessToken ? "***" : "",
    serverToken: cfg.serverToken ? "***" : "",
  };
}
