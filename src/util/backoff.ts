/** Backoff exponencial con tope, para reconexiones. */
export class Backoff {
  private attempt = 0;
  constructor(
    private readonly baseMs = 1000,
    private readonly maxMs = 60000,
  ) {}

  next(): number {
    const delay = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    this.attempt++;
    return delay;
  }

  reset(): void {
    this.attempt = 0;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
