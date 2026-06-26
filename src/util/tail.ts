import { existsSync, statSync, createReadStream } from "node:fs";
import { log } from "./logger.js";

/**
 * Sigue un fichero de log leyendo solo lo que se va añadiendo.
 * Maneja rotación/truncado (si el tamaño baja, reabre desde 0).
 * Usa polling de tamaño: simple y robusto en Windows.
 */
export class Tailer {
  private offset = 0;
  private timer: NodeJS.Timeout | null = null;
  private reading = false;
  private buffer = "";

  constructor(
    private readonly path: string,
    private readonly onLine: (line: string) => void,
    private readonly pollMs = 1200,
    /** Bytes finales a procesar al arrancar (para reflejar el estado actual). */
    private readonly seedBytes = 0,
  ) {}

  start(): void {
    if (existsSync(this.path)) {
      try {
        const size = statSync(this.path).size;
        this.offset = Math.max(0, size - this.seedBytes);
      } catch {
        this.offset = 0;
      }
    }
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  private async poll(): Promise<void> {
    if (this.reading) return;
    if (!existsSync(this.path)) return;
    this.reading = true;
    try {
      const size = statSync(this.path).size;
      if (size < this.offset) {
        // truncado / rotado
        this.offset = 0;
        this.buffer = "";
      }
      if (size === this.offset) return;

      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(this.path, {
          start: this.offset,
          end: size - 1,
          encoding: "utf8",
        });
        stream.on("data", (chunk) => {
          this.buffer += chunk;
          let idx: number;
          while ((idx = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, idx).replace(/\r$/, "");
            this.buffer = this.buffer.slice(idx + 1);
            if (line) this.onLine(line);
          }
        });
        stream.on("end", () => {
          this.offset = size;
          resolve();
        });
        stream.on("error", reject);
      });
    } catch (err) {
      log.debug(`Tailer(${this.path}): ${(err as Error).message}`);
    } finally {
      this.reading = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
