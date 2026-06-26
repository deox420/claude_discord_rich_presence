import { z } from "zod";

/** Esquema de configuración validado en runtime. */
export const ConfigSchema = z.object({
  discord: z.object({
    clientId: z.string().min(10, "Falta el Application ID de Discord"),
    appName: z.string().default("Claude"),
    assets: z
      .object({
        largeImage: z.string().default("claude_icon"),
        largeText: z.string().default("Claude"),
        smallImageByActivity: z
          .record(z.string())
          .default({ thinking: "spinner", idle: "idle_dot" }),
      })
      .default({}),
    buttons: z
      .array(z.object({ label: z.string(), url: z.string().url() }))
      .max(2)
      .default([]),
  }),

  sources: z
    .object({
      level1: z.object({ enabled: z.boolean().default(true) }).default({}),
      cdp: z
        .object({
          enabled: z.boolean().default(true),
          port: z.number().int().positive().default(9222),
          /** Relanzar Claude con el flag de depuración si está abierto sin él. */
          autoRelaunch: z.boolean().default(true),
        })
        .default({}),
    })
    .default({}),

  paths: z
    .object({
      /** Permite "%APPDATA%\\Claude"; se expande al cargar. */
      claudeDataDir: z.string().default("%APPDATA%\\Claude"),
      webLog: z.string().default("logs/claude.ai-web.log"),
      mainLog: z.string().default("logs/main.log"),
      /** Ruta a claude.exe; si vacía, se autodetecta. */
      claudeExe: z.string().default(""),
    })
    .default({}),

  patterns: z
    .object({
      // Exige el prefijo `model:` (singular) para coger el modelo ACTIVO y no
      // la línea de "N models: ..." (lista de disponibles). Captura en grupo 1.
      model: z
        .string()
        .default("\\bmodel:\\s*'?(claude-(?:opus|sonnet|haiku)-\\d+-\\d+(?:-\\d+)?)"),
      thinkingEvents: z
        .string()
        .default("(stream_start|/v1/.*messages|completion)"),
      idleAfterMs: z.number().int().positive().default(8000),
    })
    .default({}),

  /** Normalización id -> etiqueta. */
  modelLabels: z
    .record(z.string())
    .default({
      "claude-opus-4-8": "Opus 4.8",
      "claude-sonnet-4-6": "Sonnet 4.6",
      "claude-haiku-4-5": "Haiku 4.5",
    }),

  templates: z
    .object({
      details: z.string().default("{project}"),
      state: z.string().default("{model} · {activity}"),
      directoryFormat: z.string().default("📁 {directory}"),
      /** Emoji por tipo de contexto, antepuesto al texto del proyecto. */
      kindEmoji: z
        .object({
          code: z.string().default("💻"), // Claude Code (local / nube / ssh)
          cowork: z.string().default("👥"), // Claude Cowork
          design: z.string().default("🎨"), // Claude Design
          chat: z.string().default("💬"), // Claude Chat
        })
        .default({}),
      activityLabels: z
        .record(z.string())
        .default({
          thinking: "Generando…",
          idle: "Pensando",
          waiting: "Escribiendo prompt",
          away: "Ausente",
        }),
    })
    .default({}),

  privacy: z
    .object({
      showProjectTitle: z.boolean().default(true),
      fallbackProjectTitle: z.string().default("En una conversación"),
      fallbackCloudTitle: z.string().default("En la nube"),
      showDirectory: z.boolean().default(true),
      showWhenAway: z.boolean().default(true),
      idleTimeoutMin: z.number().positive().default(10),
      offlineGraceSec: z.number().positive().default(30),
    })
    .default({}),

  behavior: z
    .object({
      autostart: z.boolean().default(true),
      startMinimizedToTray: z.boolean().default(true),
      /** ms entre updates mínimos a Discord (límite real ~15s). */
      throttleMs: z.number().int().positive().default(15000),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
