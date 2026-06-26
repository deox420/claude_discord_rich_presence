/**
 * Modelo de datos canónico, independiente de la fuente.
 * Todos los providers emiten `Observation`s; el Aggregator las fusiona en
 * un único `PresenceState`.
 */

export type SourceTag = "process" | "window" | "log" | "cdp";

export type Activity =
  | "idle" // app abierta, sin generar
  | "thinking" // generando / streaming
  | "waiting" // esperando input del usuario
  | "away" // app sin foco durante un rato
  | "offline"; // app cerrada

export interface ModelInfo {
  /** id crudo, ej. "claude-opus-4-8" */
  id: string;
  /** etiqueta amigable, ej. "Opus 4.8" */
  label: string;
}

export interface ProjectInfo {
  /** título del chat o nombre del proyecto */
  title?: string;
  /** solo el nombre de la carpeta de trabajo (sesiones de código/agente) */
  directory?: string;
  kind?: "chat" | "project" | "code" | "cloud" | "design" | "cowork";
}

export interface PresenceState {
  app: {
    running: boolean;
    focused: boolean;
    visible: boolean;
  };
  model?: ModelInfo;
  project?: ProjectInfo;
  activity: Activity;
  session: {
    /** epoch ms — base del timer "transcurrido" */
    startedAt?: number;
  };
  /** de qué providers proviene el estado actual (debug) */
  sources: SourceTag[];
  updatedAt: number;
}

/** Observación parcial emitida por un provider. */
export interface Observation {
  partial: DeepPartial<PresenceState>;
  source: SourceTag;
  /** 0..1 — confianza de la fuente para resolver conflictos */
  confidence: number;
  at: number;
}

export interface ProviderHealth {
  ok: boolean;
  lastEmit: number | null;
  detail?: string;
}

export interface Provider {
  readonly tag: SourceTag;
  start(emit: (obs: Observation) => void): Promise<void>;
  stop(): Promise<void>;
  healthcheck(): ProviderHealth;
}

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export function emptyState(): PresenceState {
  return {
    app: { running: false, focused: false, visible: false },
    activity: "offline",
    session: {},
    sources: [],
    updatedAt: 0,
  };
}
