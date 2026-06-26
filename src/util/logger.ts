/**
 * Logger mínimo con niveles y redacción de datos sensibles.
 * Evita dependencias externas; suficiente para un demonio pequeño.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const envLevel = (process.env.CRP_LOG_LEVEL as Level) || "info";
let threshold = LEVELS[envLevel] ?? LEVELS.info;

export function setLevel(level: Level): void {
  threshold = LEVELS[level] ?? threshold;
}

/** Redacta cadenas que parezcan tokens/jwt/cookies. */
function redact(s: string): string {
  return s
    .replace(/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, "[jwt]")
    .replace(/(sk-ant-[A-Za-z0-9_\-]{6})[A-Za-z0-9_\-]+/g, "$1…[redacted]")
    .replace(/(token|cookie|authorization)[=:]\s*\S+/gi, "$1=[redacted]");
}

function emit(level: Level, msg: string): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] ${redact(msg)}`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (m: string) => emit("debug", m),
  info: (m: string) => emit("info", m),
  warn: (m: string) => emit("warn", m),
  error: (m: string) => emit("error", m),
};
