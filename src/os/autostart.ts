import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "../config/loader.js";
import { log } from "../util/logger.js";

const execFileAsync = promisify(execFile);

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "ClaudeRichPresence";

/** Ruta a dist/main.js (cuando corre compilado) o al .ts (en dev). */
function entryPoint(): string {
  // este módulo vive en dist/os/autostart.js → entry en dist/main.js
  const here = fileURLToPath(import.meta.url);
  const distMain = join(here, "..", "..", "main.js");
  return distMain;
}

function vbsPath(): string {
  return join(configDir(), "start-hidden.vbs");
}

/** Crea el lanzador VBS que arranca el demonio sin ventana de consola. */
function writeLauncher(): string {
  const node = process.execPath; // ruta a node.exe
  const main = entryPoint();
  const vbs = `Set sh = CreateObject("WScript.Shell")
sh.Run """${node}"" ""${main}""", 0, False
`;
  const p = vbsPath();
  writeFileSync(p, vbs, "utf8");
  return p;
}

export async function enableAutostart(): Promise<void> {
  const vbs = writeLauncher();
  const cmd = `wscript.exe "${vbs}"`;
  await execFileAsync(
    "reg",
    ["add", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ", "/d", cmd, "/f"],
    { windowsHide: true },
  );
  log.info("Autoarranque activado.");
}

export async function disableAutostart(): Promise<void> {
  try {
    await execFileAsync("reg", ["delete", RUN_KEY, "/v", VALUE_NAME, "/f"], {
      windowsHide: true,
    });
    log.info("Autoarranque desactivado.");
  } catch {
    /* no existía */
  }
}

export async function isAutostartEnabled(): Promise<boolean> {
  try {
    await execFileAsync("reg", ["query", RUN_KEY, "/v", VALUE_NAME], {
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}
