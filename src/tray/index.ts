import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import SysTrayImport from "systray2";

// systray2 es CommonJS (exports.default = class). En ESM nativo el import por
// defecto devuelve el objeto del módulo, así que hay que coger `.default` en
// runtime. Tipamos el constructor a mano.
type SysTrayCtor = {
  new (conf: unknown): {
    onClick(cb: (action: { seq_id: number }) => void): Promise<unknown>;
    sendAction(action: unknown): Promise<unknown>;
    kill(exitNode?: boolean): Promise<void>;
  };
  separator: unknown;
};
const SysTray: SysTrayCtor =
  ((SysTrayImport as { default?: SysTrayCtor }).default ??
    SysTrayImport) as SysTrayCtor;
type SysTrayInstance = InstanceType<typeof SysTray>;
import { configDir, defaultConfigPath } from "../config/loader.js";
import {
  enableAutostart,
  disableAutostart,
  isAutostartEnabled,
} from "../os/autostart.js";
import { log } from "../util/logger.js";

export interface TrayHandlers {
  onTogglePause: (paused: boolean) => void;
  onQuit: () => void;
}

// Orden de los items del menú (seq_id = índice).
const IDX_STATUS = 0;
const IDX_SEP1 = 1;
const IDX_PAUSE = 2;
const IDX_AUTOSTART = 3;
const IDX_OPEN_CONFIG = 4;
const IDX_OPEN_FOLDER = 5;
const IDX_SEP2 = 6;
const IDX_QUIT = 7;

function iconBase64(): string {
  const here = fileURLToPath(import.meta.url);
  // dist/tray/index.js | src/tray/index.ts → ../../assets/tray-icon.ico
  const icoPath = join(here, "..", "..", "..", "assets", "tray-icon.ico");
  return readFileSync(icoPath).toString("base64");
}

export class Tray {
  private systray: SysTrayInstance | null = null;
  private paused = false;
  private autostart = false;
  private statusText = "Iniciando…";

  constructor(private readonly handlers: TrayHandlers) {}

  async start(): Promise<void> {
    this.autostart = await isAutostartEnabled();

    const menu = {
      icon: iconBase64(),
      isTemplateIcon: false,
      title: "",
      tooltip: "Claude Rich Presence",
      items: [
        { title: this.statusText, tooltip: "Estado actual", enabled: false },
        SysTray.separator,
        { title: "Pausar", tooltip: "Pausar la presencia", enabled: true },
        {
          title: "Iniciar con Windows",
          tooltip: "Arrancar automáticamente",
          checked: this.autostart,
          enabled: true,
        },
        {
          title: "Abrir configuración",
          tooltip: "Editar config.yaml",
          enabled: true,
        },
        {
          title: "Abrir carpeta",
          tooltip: "Abrir carpeta de configuración",
          enabled: true,
        },
        SysTray.separator,
        { title: "Salir", tooltip: "Cerrar Claude Rich Presence", enabled: true },
      ],
    };

    this.systray = new SysTray({ menu, debug: false, copyDir: true });

    await this.systray.onClick((action) => this.onClick(action.seq_id));
    log.info("Bandeja del sistema iniciada.");
  }

  private onClick(seq: number): void {
    switch (seq) {
      case IDX_PAUSE:
        this.togglePause();
        break;
      case IDX_AUTOSTART:
        void this.toggleAutostart();
        break;
      case IDX_OPEN_CONFIG:
        // Notepad abre el .yaml con seguridad (sin depender de asociaciones).
        execFile("notepad.exe", [defaultConfigPath()], { windowsHide: true }, () => {});
        break;
      case IDX_OPEN_FOLDER:
        this.openFolder(configDir());
        break;
      case IDX_QUIT:
        this.handlers.onQuit();
        break;
      default:
        break;
    }
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.handlers.onTogglePause(this.paused);
    void this.updateItem(IDX_PAUSE, {
      title: this.paused ? "Reanudar" : "Pausar",
      tooltip: this.paused ? "Reanudar la presencia" : "Pausar la presencia",
      enabled: true,
    });
    if (this.paused) this.setStatus("⏸ En pausa");
  }

  private async toggleAutostart(): Promise<void> {
    this.autostart = !this.autostart;
    try {
      if (this.autostart) await enableAutostart();
      else await disableAutostart();
    } catch (err) {
      log.warn(`Autoarranque: ${(err as Error).message}`);
      this.autostart = !this.autostart; // revertir
    }
    void this.updateItem(IDX_AUTOSTART, {
      title: "Iniciar con Windows",
      tooltip: "Arrancar automáticamente",
      checked: this.autostart,
      enabled: true,
    });
  }

  /** Actualiza la línea de estado del menú. */
  setStatus(text: string): void {
    if (this.paused && !text.startsWith("⏸")) return;
    this.statusText = text;
    void this.updateItem(IDX_STATUS, {
      title: text,
      tooltip: "Estado actual",
      enabled: false,
    });
  }

  private async updateItem(
    seq_id: number,
    item: { title: string; tooltip: string; enabled?: boolean; checked?: boolean },
  ): Promise<void> {
    if (!this.systray) return;
    try {
      await this.systray.sendAction({ type: "update-item", item, seq_id });
    } catch {
      /* noop */
    }
  }

  private openFolder(p: string): void {
    // `explorer.exe <carpeta>` devuelve código 1 aunque abra bien; usamos
    // `start` vía cmd, que es fiable para carpetas y no deja ventana.
    execFile("cmd", ["/c", "start", "", p], { windowsHide: true }, () => {});
  }

  async stop(): Promise<void> {
    try {
      await this.systray?.kill(false);
    } catch {
      /* noop */
    }
    this.systray = null;
  }
}
