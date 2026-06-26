/**
 * Coalescing de actualizaciones: como mucho 1 cada `minIntervalMs`.
 * Si llega una actualización dentro de la ventana, se guarda la última y se
 * envía cuando expira (trailing edge). La primera tras una pausa va inmediata.
 */
export class Throttler<T> {
  private lastSentAt = 0;
  private pending: T | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly minIntervalMs: number,
    private readonly flush: (value: T) => void,
  ) {}

  submit(value: T): void {
    const now = Date.now();
    const elapsed = now - this.lastSentAt;

    if (elapsed >= this.minIntervalMs) {
      this.send(value);
      return;
    }

    // Dentro de la ventana: guardamos y programamos el trailing flush.
    this.pending = value;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.pending !== null) {
          const v = this.pending;
          this.pending = null;
          this.send(v);
        }
      }, this.minIntervalMs - elapsed);
    }
  }

  private send(value: T): void {
    this.lastSentAt = Date.now();
    this.flush(value);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}
