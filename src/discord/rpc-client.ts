import { Client } from "@xhayper/discord-rpc";
import type { DiscordActivity } from "../core/activity-mapper.js";
import { Backoff, sleep } from "../util/backoff.js";
import { log } from "../util/logger.js";

/**
 * Envuelve el cliente de Discord RPC: conexión, reconexión con backoff y
 * set/clear de la activity. Reenvía la última activity al reconectar.
 */
export class DiscordRpcClient {
  private client: Client | null = null;
  private ready = false;
  private lastActivity: DiscordActivity | null = null;
  private shouldRun = false;
  private backoff = new Backoff(1000, 60000);

  constructor(private readonly clientId: string) {}

  async start(): Promise<void> {
    this.shouldRun = true;
    void this.connectLoop();
  }

  private async connectLoop(): Promise<void> {
    while (this.shouldRun) {
      try {
        await this.connectOnce();
        // connectOnce resuelve al desconectarse; reintentamos.
      } catch (err) {
        log.warn(`Discord RPC: conexión fallida (${(err as Error).message})`);
      }
      if (!this.shouldRun) break;
      const delay = this.backoff.next();
      log.debug(`Discord RPC: reintentando en ${delay}ms`);
      await sleep(delay);
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const client = new Client({ clientId: this.clientId });
      this.client = client;

      client.on("ready", () => {
        this.ready = true;
        this.backoff.reset();
        log.info("Discord RPC: conectado y listo.");
        if (this.lastActivity) void this.push(this.lastActivity);
      });

      client.on("disconnected", () => {
        this.ready = false;
        log.warn("Discord RPC: desconectado.");
        resolve(); // sale del connectOnce para reintentar
      });

      client.login().catch((err) => {
        this.ready = false;
        reject(err);
      });
    });
  }

  /** Actualiza la presencia (guardando la última para reenviar al reconectar). */
  async setActivity(activity: DiscordActivity): Promise<void> {
    this.lastActivity = activity;
    if (!this.ready || !this.client?.user) return;
    await this.push(activity);
  }

  private async push(activity: DiscordActivity): Promise<void> {
    try {
      await this.client!.user!.setActivity(activity);
      log.debug(
        `Presence: ${activity.details ?? ""} | ${activity.state ?? ""}`,
      );
    } catch (err) {
      log.warn(`Discord RPC: setActivity falló (${(err as Error).message})`);
    }
  }

  async clearActivity(): Promise<void> {
    this.lastActivity = null;
    if (!this.ready || !this.client?.user) return;
    try {
      await this.client.user.clearActivity();
      log.debug("Presence limpiada.");
    } catch (err) {
      log.warn(`Discord RPC: clearActivity falló (${(err as Error).message})`);
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  async stop(): Promise<void> {
    this.shouldRun = false;
    try {
      await this.clearActivity();
      await this.client?.destroy();
    } catch {
      /* noop */
    }
    this.client = null;
    this.ready = false;
  }
}
