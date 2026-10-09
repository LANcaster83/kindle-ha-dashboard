type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = LEVELS.info;

export function setLogLevel(level: Level): void {
  threshold = LEVELS[level];
}

function emit(level: Level, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}`;
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  if (extra instanceof Error) {
    out.write(`${line}: ${extra.message}\n`);
    if (extra.stack && LEVELS.debug >= threshold) out.write(`${extra.stack}\n`);
  } else if (extra !== undefined) {
    out.write(`${line} ${JSON.stringify(extra)}\n`);
  } else {
    out.write(`${line}\n`);
  }
}

export const log = {
  debug: (msg: string, extra?: unknown): void => emit("debug", msg, extra),
  info: (msg: string, extra?: unknown): void => emit("info", msg, extra),
  warn: (msg: string, extra?: unknown): void => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown): void => emit("error", msg, extra),
};
