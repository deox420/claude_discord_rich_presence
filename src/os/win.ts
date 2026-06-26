import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../util/logger.js";

const execFileAsync = promisify(execFile);

export interface ClaudeProcessInfo {
  running: boolean;
  focused: boolean;
  title: string;
}

/**
 * Script PowerShell que devuelve JSON con el estado de la app de escritorio
 * (distinguiéndola del CLI de Claude Code por la ruta WindowsApps).
 */
const PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@ | Out-Null
$fg = [Fg]::GetForegroundWindow()
$fgpid = 0
[void][Fg]::GetWindowThreadProcessId($fg, [ref]$fgpid)
$procs = Get-Process -Name claude -ErrorAction SilentlyContinue
$desktop = @($procs | Where-Object { $_.Path -like '*WindowsApps*' -or ($_.Path -like '*\\AnthropicClaude\\*') })
$running = $desktop.Count -gt 0
$mainWin = $desktop | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
$title = if ($mainWin) { $mainWin.MainWindowTitle } else { '' }
$focused = $false
foreach ($p in $desktop) { if ($p.Id -eq $fgpid) { $focused = $true } }
[pscustomobject]@{ running=$running; focused=$focused; title=$title } | ConvertTo-Json -Compress
`;

function encode(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Consulta el estado de la app de escritorio de Claude.
 * Devuelve `null` si el sondeo FALLA (no se pudo determinar) — para no
 * confundir un fallo transitorio de PowerShell con "Claude cerrado".
 */
export async function pollClaude(): Promise<ClaudeProcessInfo | null> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encode(PS_SCRIPT)],
      { windowsHide: true, timeout: 8000 },
    );
    const json = JSON.parse(stdout.trim());
    return {
      running: Boolean(json.running),
      focused: Boolean(json.focused),
      title: typeof json.title === "string" ? json.title : "",
    };
  } catch (err) {
    log.debug(`pollClaude falló: ${(err as Error).message}`);
    return null; // desconocido: no tocar el estado actual
  }
}

/**
 * Abre la app de escritorio de Claude vía AUMID (Store/MSIX).
 * Nota: las apps MSIX no aceptan de forma fiable argumentos como
 * --remote-debugging-port al lanzarse así; por eso el directorio/proyecto se
 * obtiene de los logs (Nivel 1) y no se depende del relanzado con flag.
 */
export async function launchClaude(): Promise<void> {
  try {
    await execFileAsync(
      "explorer.exe",
      ["shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude"],
      { windowsHide: true, timeout: 8000 },
    );
  } catch (err) {
    log.warn(`No se pudo lanzar Claude: ${(err as Error).message}`);
  }
}
