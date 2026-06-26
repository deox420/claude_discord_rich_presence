import {
  type Observation,
  type PresenceState,
  type Activity,
  type SourceTag,
  emptyState,
} from "./types.js";

/** Prioridad por campo: qué fuente gana cuando varias aportan el mismo dato. */
const FIELD_PRIORITY: Record<string, SourceTag[]> = {
  model: ["cdp", "log"],
  project: ["cdp", "log", "window"],
  activity: ["cdp", "log"],
  app: ["process", "window", "cdp"],
};

interface FieldEntry<T> {
  value: T;
  source: SourceTag;
  at: number;
}

/** TTL por campo (ms): una observación vieja deja de contar. */
const TTL_MS = 30_000;

export interface AggregatorOptions {
  /** ms de estabilidad antes de cambiar `activity` (anti-parpadeo). */
  activityHysteresisMs?: number;
  /** ms tras detectar app cerrada antes de marcar offline. */
  offlineGraceMs?: number;
  /** ms sin foco para pasar a `away`. */
  idleTimeoutMs?: number;
}

export class Aggregator {
  private state: PresenceState = emptyState();
  private fields = new Map<string, FieldEntry<unknown>>();
  private listeners: Array<(s: PresenceState) => void> = [];

  // Histéresis de actividad
  private pendingActivity: Activity | null = null;
  private pendingSince = 0;

  private lastFocusedAt = 0;
  private lastRunningAt = 0;

  constructor(private readonly opts: AggregatorOptions = {}) {}

  onChange(fn: (s: PresenceState) => void): void {
    this.listeners.push(fn);
  }

  getState(): PresenceState {
    return this.state;
  }

  /** Punto de entrada: una observación de cualquier provider. */
  ingest(obs: Observation): void {
    const { partial, source, at } = obs;

    if (partial.app) this.setField("app", partial.app, source, at);
    if (partial.model) this.setField("model", partial.model, source, at);
    if (partial.project) this.setField("project", partial.project, source, at);
    if (partial.activity)
      this.setField("activity", partial.activity, source, at);

    this.recompute(at);
  }

  /** Llamar periódicamente (p. ej. cada 1s) para timers/transiciones. */
  tick(now: number): void {
    this.recompute(now);
  }

  private setField(
    key: string,
    value: unknown,
    source: SourceTag,
    at: number,
  ): void {
    const prio = FIELD_PRIORITY[key] ?? [];
    const current = this.fields.get(key);
    if (current && Date.now() - current.at < TTL_MS) {
      const newRank = prio.indexOf(source);
      const oldRank = prio.indexOf(current.source);
      // Menor índice = mayor prioridad. Si la nueva fuente es peor y la vieja
      // sigue fresca, ignoramos salvo que sea la misma fuente (actualización).
      if (
        newRank !== -1 &&
        oldRank !== -1 &&
        newRank > oldRank &&
        source !== current.source
      ) {
        return;
      }
    }
    this.fields.set(key, { value, source, at });
  }

  private getField<T>(key: string): FieldEntry<T> | undefined {
    const e = this.fields.get(key);
    if (!e) return undefined;
    // Campos "pegajosos" (modelo, proyecto): no caducan — el modelo y el
    // directorio se loguean de forma esporádica, así que el último valor
    // conocido sigue siendo válido hasta que llega otro o se cierra Claude.
    const sticky = key === "model" || key === "project";
    if (!sticky && Date.now() - e.at > TTL_MS) return undefined;
    return e as FieldEntry<T>;
  }

  private recompute(now: number): void {
    const prev = this.state;
    const next = emptyState();
    next.updatedAt = now;

    const sources = new Set<SourceTag>();

    const appEntry = this.getField<PresenceState["app"]>("app");
    if (appEntry) {
      next.app = { ...appEntry.value };
      sources.add(appEntry.source);
    }

    // Margen de gracia: tras ver "running" no declaramos "cerrado" hasta que
    // pasen `offlineGraceMs` sin verlo, para absorber blips del sondeo.
    const grace = this.opts.offlineGraceMs ?? 30_000;
    if (next.app.running) this.lastRunningAt = now;
    else if (this.lastRunningAt > 0 && now - this.lastRunningAt <= grace) {
      next.app.running = true; // sigue "vivo" durante la gracia
    }

    // Si Claude está cerrado (pasada la gracia), olvida el contexto pegajoso.
    if (!next.app.running) {
      this.fields.delete("model");
      this.fields.delete("project");
      this.fields.delete("activity");
    }

    const modelEntry = this.getField<PresenceState["model"]>("model");
    if (modelEntry && next.app.running) {
      next.model = modelEntry.value;
      sources.add(modelEntry.source);
    }

    const projectEntry = this.getField<PresenceState["project"]>("project");
    if (projectEntry && next.app.running) {
      next.project = projectEntry.value;
      sources.add(projectEntry.source);
    }

    // Actividad base
    let activity: Activity = "offline";
    if (next.app.running) {
      const actEntry = this.getField<Activity>("activity");
      activity = actEntry?.value ?? "idle";
      if (actEntry) sources.add(actEntry.source);
    }

    // away por falta de foco
    if (next.app.focused) this.lastFocusedAt = now;
    const idleTimeout = this.opts.idleTimeoutMs ?? 10 * 60_000;
    if (
      next.app.running &&
      !next.app.focused &&
      activity !== "thinking" &&
      this.lastFocusedAt > 0 &&
      now - this.lastFocusedAt > idleTimeout
    ) {
      activity = "away";
    }

    next.activity = this.applyHysteresis(activity, now);

    // Sesión: arranca al pasar a un estado activo; se borra al quedar offline.
    if (next.activity === "offline") {
      next.session = {};
    } else {
      next.session = {
        startedAt: prev.session.startedAt ?? now,
      };
    }

    next.sources = [...sources];
    this.state = next;

    if (this.significantChange(prev, next)) {
      for (const fn of this.listeners) fn(next);
    }
  }

  private applyHysteresis(target: Activity, now: number): Activity {
    const current = this.state.activity;
    const hyst = this.opts.activityHysteresisMs ?? 1500;
    // offline e idle->thinking se aplican rápido; transiciones a idle esperan.
    if (target === current) {
      this.pendingActivity = null;
      return current;
    }
    // Transiciones inmediatas: apagar, empezar a generar, o "encender" la app
    // (de offline a cualquier estado activo) no deben esperar a la histéresis.
    if (target === "offline" || target === "thinking" || current === "offline") {
      this.pendingActivity = null;
      return target;
    }
    if (this.pendingActivity !== target) {
      this.pendingActivity = target;
      this.pendingSince = now;
      return current;
    }
    if (now - this.pendingSince >= hyst) {
      this.pendingActivity = null;
      return target;
    }
    return current;
  }

  private significantChange(a: PresenceState, b: PresenceState): boolean {
    return (
      a.activity !== b.activity ||
      a.model?.label !== b.model?.label ||
      a.project?.title !== b.project?.title ||
      a.project?.directory !== b.project?.directory ||
      a.app.running !== b.app.running ||
      a.session.startedAt !== b.session.startedAt
    );
  }
}
