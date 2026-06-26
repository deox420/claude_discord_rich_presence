import { basename } from "node:path";
import type {
  Observation,
  Provider,
  ProviderHealth,
  SourceTag,
  Activity,
  ProjectInfo,
} from "../core/types.js";
import type { Config } from "../config/schema.js";
import { resolveLogPath } from "../config/loader.js";
import { Tailer } from "../util/tail.js";
import { log } from "../util/logger.js";

/**
 * Nivel 1 — extrae de los logs de Claude:
 *  - modelo (web log)
 *  - directorio/proyecto de trabajo (main.log, líneas `cwd=...`)
 *  - actividad (heurística por eventos de generación)
 */
export class LogTailProvider implements Provider {
  readonly tag: SourceTag = "log";
  private tailers: Tailer[] = [];
  private lastEmit: number | null = null;

  private modelRe: RegExp;
  private thinkingRe: RegExp;
  // Directorio local de Windows: cwd=C:\Users\...\proyecto
  private cwdRe = /cwd["']?\s*[:=]\s*["']?([A-Za-z]:\\[^"',}\r\n]+)/i;
  // Sesión en la nube/cowork: Cwd=/sessions/<sesion>/mnt/<carpeta>
  private cloudCwdRe = /Cwd=\/sessions\/[^/]+\/mnt\/([^/\s"',}]+)/i;
  // Working dir de la VM cloud: vmCwd=/sessions/<sesion>/mnt/<carpeta>
  private vmCwdRe = /vmCwd=\/sessions\/[^/]+\/mnt\/([^/\s"',}]+)/i;
  // Repo de GitHub en sesiones cloud: repo=owner/name
  private repoRe = /\brepo=([\w.-]+)\/([\w.-]+)/i;
  // Sesión enfocada en la UI: null = chat (sin proyecto); id = sesión de código
  private focusRe = /setFocusedSession:\s*sessionId=(\S+)/i;
  // Ruta activa de la UI (delata el PRODUCTO): topFrameUrl: 'https://claude.ai/<ruta>'
  private topUrlRe = /topFrameUrl:\s*'https:\/\/claude\.ai\/([^'\s]+)/i;
  /** Producto actual (último evento manda, sin ventanas de tiempo). */
  private product: "code" | "cowork" | "design" | "chat" | undefined = undefined;
  /** Nombre del archivo de Claude Design (de la ruta). */
  private designTitle = "";
  // Mapa autoritativo sesión -> carpeta: addFolderToSession: sessionId=X, path=Y
  private addFolderRe = /addFolderToSession:\s*sessionId=(\S+?),\s*path=(.+?)\s*$/i;

  /** Sesión actualmente enfocada (null = chat). undefined = aún desconocido. */
  private focusedSession: string | null | undefined = undefined;
  /** Mapa sesión -> proyecto/carpeta (atribuido mientras esa sesión está enfocada). */
  private sessionDir = new Map<string, ProjectInfo>();

  private lastThinkingAt = 0;
  private activityTimer: NodeJS.Timeout | null = null;
  private currentActivity: Activity = "idle";
  /** Falso durante el arranque para no reaccionar a eventos del histórico. */
  private activityEnabled = false;

  constructor(
    private readonly cfg: Config,
    private emit?: (obs: Observation) => void,
  ) {
    this.modelRe = new RegExp(cfg.patterns.model, "i");
    this.thinkingRe = new RegExp(cfg.patterns.thinkingEvents, "i");
  }

  async start(emit: (obs: Observation) => void): Promise<void> {
    this.emit = emit;

    const webLog = resolveLogPath(this.cfg, "web");
    const mainLog = resolveLogPath(this.cfg, "main");
    log.info(`LogTail: web=${webLog}`);
    log.info(`LogTail: main=${mainLog}`);

    // Al arrancar se procesa el histórico reciente para reflejar el estado
    // actual sin esperar a líneas nuevas. El id de modelo se registra de forma
    // esporádica, así que el web log se barre casi entero; el main.log (grande)
    // se acota a los últimos MB, suficiente para el `cwd` reciente.
    const SEED_WEB = 8 * 1024 * 1024;
    const SEED_MAIN = 1 * 1024 * 1024;
    this.tailers.push(
      new Tailer(webLog, (line) => this.onWebLine(line), 1200, SEED_WEB),
      new Tailer(mainLog, (line) => this.onMainLine(line), 1200, SEED_MAIN),
    );
    for (const t of this.tailers) t.start();

    // Tras procesar el histórico (seed), habilita la detección de actividad
    // en tiempo real para no reaccionar a eventos antiguos.
    setTimeout(() => {
      this.activityEnabled = true;
    }, 3000);

    // Reloj de actividad: pasa a idle si no hay eventos de generación.
    this.activityTimer = setInterval(() => this.checkIdle(), 2000);
  }

  private onWebLine(line: string): void {
    // El modelo del web log suele estar desfasado; la actividad sí sirve.
    if (this.thinkingRe.test(line)) {
      this.markThinking();
    }
  }

  private detectModel(line: string): void {
    const m = this.modelRe.exec(line);
    if (m) {
      const id = (m[1] ?? m[0]).toLowerCase();
      const label = this.cfg.modelLabels[id] ?? this.prettify(id);
      this.publish({ model: { id, label } });
    }
  }

  private onMainLine(line: string): void {
    if (this.thinkingRe.test(line)) this.markThinking();
    this.detectModel(line); // main.log es la fuente fiable del modelo activo

    // Ruta activa de la UI → producto de Claude (último evento manda).
    const u = this.topUrlRe.exec(line);
    if (u && u[1]) {
      const route = this.classifyRoute(u[1]);
      if (route) {
        this.product = route.product;
        if (route.product === "design" && route.title) {
          this.designTitle = route.title;
        }
        this.emitProject();
      }
      return;
    }

    // Foco de sesión.
    const f = this.focusRe.exec(line);
    if (f && f[1]) {
      if (f[1] === "null") {
        // La app emite `null` constantemente entre focos reales (blur), incluso
        // durante minutos mientras trabajas en una sesión. Es RUIDO: se ignora.
        // Solo sirve de arranque cuando aún no sabemos nada.
        if (this.product === undefined) {
          this.product = "chat";
          this.emitProject();
        }
        return;
      }
      this.focusedSession = f[1];
      this.product = "code"; // entrar en una sesión de código es definitivo
      this.emitProject();
      return;
    }

    // Cada fuente de directorio se ATRIBUYE a la sesión enfocada del tipo
    // correcto, para no contaminar entre sesiones (local vs nube).
    const isLocal = (s: typeof this.focusedSession) =>
      typeof s === "string" && s.startsWith("local_");
    const isCloud = (s: typeof this.focusedSession) =>
      typeof s === "string" && s.startsWith("session_");

    // addFolderToSession: liga explícitamente una sesión LOCAL con su carpeta.
    const af = this.addFolderRe.exec(line);
    if (af && af[1] && af[2]) {
      const sid = af[1];
      const p = af[2].replace(/\\+/g, "\\").trim();
      if (p !== "(picker)" && this.isUserDir(p)) {
        this.sessionDir.set(sid, { directory: basename(p), kind: "code" });
        if (this.focusedSession === sid) this.emitProject();
      }
      return;
    }

    // Directorio local de Windows → solo si la sesión enfocada es LOCAL.
    const c = this.cwdRe.exec(line);
    if (c && c[1] && isLocal(this.focusedSession)) {
      const raw = c[1].replace(/\\+/g, "\\").trim();
      if (this.isUserDir(raw)) {
        this.sessionDir.set(this.focusedSession as string, {
          directory: basename(raw),
          kind: "code",
        });
        this.emitProject();
      }
      return;
    }

    // Repo de GitHub → solo si la sesión enfocada es de NUBE.
    const r = this.repoRe.exec(line);
    if (r && r[2] && isCloud(this.focusedSession)) {
      this.sessionDir.set(this.focusedSession as string, {
        title: `${r[1]}/${r[2]}`,
        directory: r[2],
        kind: "cloud",
      });
      this.emitProject();
      return;
    }

    // Carpeta de trabajo del sandbox cloud (Cwd=/sessions/.../mnt/X o vmCwd).
    const cc = this.cloudCwdRe.exec(line) ?? this.vmCwdRe.exec(line);
    if (cc && cc[1] && isCloud(this.focusedSession)) {
      const dir = cc[1];
      if (dir.toLowerCase() !== "void") {
        this.sessionDir.set(this.focusedSession as string, {
          directory: dir,
          kind: "cloud",
        });
        this.emitProject();
      }
    }
  }

  /** Clasifica una ruta de claude.ai en un producto. null = ignorar. */
  private classifyRoute(
    path: string,
  ): { product: "design" | "cowork" | "code" | "chat"; title?: string } | null {
    const p = path.toLowerCase();
    if (p.startsWith("design/p/")) {
      // El nombre del archivo va en ?file=... (lo extrae el llamador si quiere)
      const m = /file=([^'&]+)/i.exec(path);
      let title: string | undefined;
      if (m && m[1]) {
        try {
          title = decodeURIComponent(m[1].replace(/\+/g, " "))
            .replace(/\.dc\.html$|\.html$/i, "")
            .trim();
        } catch {
          title = m[1].replace(/\+/g, " ");
        }
      }
      return { product: "design", title };
    }
    if (p.startsWith("cowork/")) return { product: "cowork" };
    if (p.startsWith("local_sessions/") || p.startsWith("code/"))
      return { product: "code" };
    if (p.startsWith("chat/") || p === "new" || p.startsWith("new?"))
      return { product: "chat" };
    return null; // /task, /customize, /epitaxy, etc. → no cambian el producto
  }

  /** Publica el proyecto según el producto actual (último evento manda). */
  private emitProject(): void {
    switch (this.product) {
      case "design":
        this.publish({ project: { title: this.designTitle, kind: "design" } });
        return;
      case "cowork":
        this.publish({ project: { kind: "cowork" } });
        return;
      case "code": {
        const proj =
          typeof this.focusedSession === "string"
            ? this.sessionDir.get(this.focusedSession)
            : undefined;
        this.publish({ project: proj ?? { kind: "code" } });
        return;
      }
      case "chat":
        this.publish({ project: { kind: "chat" } });
        return;
      default:
        return; // aún desconocido: no publica
    }
  }

  /** Excluye rutas internas de Claude y el home pelado. */
  private isUserDir(p: string): boolean {
    const low = p.toLowerCase();
    if (low.includes("\\appdata\\")) return false;
    if (/^[a-z]:\\users\\[^\\]+\\?$/i.test(p)) return false; // home raíz
    return true;
  }

  private prettify(id: string): string {
    // claude-opus-4-8 -> "Opus 4.8"
    const mm = /claude-([a-z]+)-(\d+)-(\d+)/i.exec(id);
    if (mm) {
      const name = mm[1]![0]!.toUpperCase() + mm[1]!.slice(1);
      return `${name} ${mm[2]}.${mm[3]}`;
    }
    return id;
  }

  private markThinking(): void {
    if (!this.activityEnabled) return;
    this.lastThinkingAt = Date.now();
    if (this.currentActivity !== "thinking") {
      this.currentActivity = "thinking";
      this.publish({ activity: "thinking" });
    }
  }

  private checkIdle(): void {
    if (
      this.currentActivity === "thinking" &&
      Date.now() - this.lastThinkingAt > this.cfg.patterns.idleAfterMs
    ) {
      this.currentActivity = "idle";
      this.publish({ activity: "idle" });
    }
  }

  private publish(partial: Observation["partial"]): void {
    if (!this.emit) return;
    const obs: Observation = {
      source: this.tag,
      confidence: 0.7,
      at: Date.now(),
      partial,
    };
    this.lastEmit = obs.at;
    this.emit(obs);
  }

  async stop(): Promise<void> {
    for (const t of this.tailers) t.stop();
    this.tailers = [];
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.activityTimer = null;
  }

  healthcheck(): ProviderHealth {
    return { ok: true, lastEmit: this.lastEmit };
  }
}
