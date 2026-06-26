import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, type Config } from "./schema.js";
import { log } from "../util/logger.js";

/** Directorio de configuración del usuario: %APPDATA%\claude-rich-presence */
export function configDir(): string {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "claude-rich-presence");
}

export function defaultConfigPath(): string {
  return join(configDir(), "config.yaml");
}

/** Expande variables de entorno tipo %APPDATA% en una ruta. */
export function expandEnv(p: string): string {
  return p.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
}

/** Resuelve la ruta del directorio de datos de Claude. */
export function resolveClaudeDataDir(cfg: Config): string {
  return expandEnv(cfg.paths.claudeDataDir);
}

/** Ruta absoluta a un log de Claude. */
export function resolveLogPath(cfg: Config, which: "web" | "main"): string {
  const base = resolveClaudeDataDir(cfg);
  const rel = which === "web" ? cfg.paths.webLog : cfg.paths.mainLog;
  return isAbsolute(rel) ? rel : join(base, rel);
}

/**
 * Carga y valida la configuración. Si el fichero no existe, usa valores por
 * defecto (requiere que `discord.clientId` venga por env CRP_DISCORD_CLIENT_ID).
 */
export function loadConfig(path = defaultConfigPath()): Config {
  let raw: unknown = {};

  if (existsSync(path)) {
    try {
      raw = parseYaml(readFileSync(path, "utf8")) ?? {};
    } catch (err) {
      log.error(`No se pudo parsear ${path}: ${(err as Error).message}`);
      throw err;
    }
  } else {
    log.warn(`No existe ${path}; usando valores por defecto.`);
  }

  // Permite override del clientId por variable de entorno (cómodo en dev).
  const envClientId = process.env.CRP_DISCORD_CLIENT_ID;
  if (envClientId) {
    raw = {
      ...(raw as object),
      discord: { ...((raw as any).discord ?? {}), clientId: envClientId },
    };
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    log.error("Configuración inválida:");
    for (const issue of parsed.error.issues) {
      log.error(`  · ${issue.path.join(".") || "(raíz)"}: ${issue.message}`);
    }
    throw new Error("Config inválida");
  }

  return parsed.data;
}
