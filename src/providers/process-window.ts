import type {
  Observation,
  Provider,
  ProviderHealth,
  SourceTag,
} from "../core/types.js";
import { pollClaude } from "../os/win.js";

/**
 * Nivel 1 — detecta si la app de escritorio está corriendo / enfocada.
 * Hace polling ligero (intervalo configurable).
 */
export class ProcessWindowProvider implements Provider {
  readonly tag: SourceTag = "process";
  private timer: NodeJS.Timeout | null = null;
  private lastEmit: number | null = null;
  private lastOk = true;

  constructor(private readonly intervalMs = 4000) {}

  async start(emit: (obs: Observation) => void): Promise<void> {
    const run = async () => {
      try {
        const info = await pollClaude();
        if (info === null) {
          // Sondeo no concluyente: no emitimos nada (mantenemos el estado).
          this.lastOk = false;
          return;
        }
        this.lastOk = true;
        const obs: Observation = {
          source: this.tag,
          confidence: 0.9,
          at: Date.now(),
          partial: {
            app: {
              running: info.running,
              focused: info.focused,
              visible: info.running,
            },
          },
        };
        // El título de ventana es un fallback parcial (suele ser solo "Claude").
        if (info.title && info.title !== "Claude") {
          obs.partial.project = { title: info.title, kind: "chat" };
        }
        this.lastEmit = obs.at;
        emit(obs);
      } catch {
        this.lastOk = false;
      }
    };
    await run();
    this.timer = setInterval(run, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  healthcheck(): ProviderHealth {
    return { ok: this.lastOk, lastEmit: this.lastEmit };
  }
}
