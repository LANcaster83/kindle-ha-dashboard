import { log } from "./log.js";

export type HaUrlSource = "option" | "supervisor" | "probe" | "default";

export interface HaUrlResolution {
  url: string;
  source: HaUrlSource;
  detail: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Hostname of the Home Assistant Core container on the Supervisor network. */
export const HA_HOST = "homeassistant";
export const SUPERVISOR_CORE_INFO = "http://supervisor/core/info";
export const DEFAULT_HA_URL = `http://${HA_HOST}:8123`;
/** Tried in order when the Supervisor cannot tell us the port. */
export const PROBE_URLS: readonly string[] = [DEFAULT_HA_URL, `http://${HA_HOST}`];

const PROBE_TIMEOUT_MS = 4000;

function withTimeout(fetchFn: FetchLike, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetchFn(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

/** Asks the Supervisor which port (and scheme) Core listens on. Returns null when unavailable. */
export async function haUrlFromSupervisor(token: string, fetchFn: FetchLike = fetch): Promise<string | null> {
  try {
    const res = await withTimeout(fetchFn, SUPERVISOR_CORE_INFO, { headers: { Authorization: `Bearer ${token}` } }, PROBE_TIMEOUT_MS);
    if (!res.ok) {
      log.warn(`Supervisor /core/info answered HTTP ${res.status}; is hassio_api enabled for this app?`);
      return null;
    }
    const body = (await res.json()) as { data?: { port?: unknown; ssl?: unknown } };
    const port = body.data?.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
      log.warn("Supervisor /core/info did not contain a valid port", body.data);
      return null;
    }
    const scheme = body.data?.ssl === true ? "https" : "http";
    const defaultPort = scheme === "https" ? 443 : 80;
    return port === defaultPort ? `${scheme}://${HA_HOST}` : `${scheme}://${HA_HOST}:${port}`;
  } catch (err) {
    log.warn("Supervisor /core/info not reachable", err);
    return null;
  }
}

/**
 * True when `base` looks like a Home Assistant instance: `/api/` answers 401 (no auth) or 200.
 * Anything else, including connection errors, is treated as "not HA".
 */
export async function looksLikeHomeAssistant(base: string, fetchFn: FetchLike = fetch): Promise<boolean> {
  try {
    const res = await withTimeout(fetchFn, `${base}/api/`, { redirect: "manual" }, PROBE_TIMEOUT_MS);
    return res.status === 401 || res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Decides which URL the renderer should open.
 * 1. An explicit `ha_url` option always wins.
 * 2. On HAOS (SUPERVISOR_TOKEN present) ask the Supervisor for Core's port.
 * 3. Otherwise probe `homeassistant` on 8123, then 80.
 * 4. Fall back to http://homeassistant:8123 with a warning.
 */
export async function resolveHaUrl(
  configured: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: FetchLike = fetch,
): Promise<HaUrlResolution> {
  if (configured) {
    return { url: configured, source: "option", detail: "ha_url option" };
  }
  const token = env.SUPERVISOR_TOKEN;
  if (token) {
    const url = await haUrlFromSupervisor(token, fetchFn);
    if (url) return { url, source: "supervisor", detail: "port reported by the Supervisor (/core/info)" };
  }
  for (const candidate of PROBE_URLS) {
    if (await looksLikeHomeAssistant(candidate, fetchFn)) {
      return { url: candidate, source: "probe", detail: `${candidate}/api/ answered like Home Assistant` };
    }
  }
  return {
    url: DEFAULT_HA_URL,
    source: "default",
    detail: "nothing answered; set ha_url to the URL Home Assistant actually listens on",
  };
}
