import type { Config } from "../config/schema.js";
import type { PresenceState } from "./types.js";

/** Payload que entendemos para Discord RPC (subset). */
export interface DiscordActivity {
  details?: string;
  state?: string;
  startTimestamp?: number;
  largeImageKey?: string;
  largeImageText?: string;
  smallImageKey?: string;
  smallImageText?: string;
  buttons?: Array<{ label: string; url: string }>;
}

/** true si no hay nada que mostrar (hay que limpiar la presencia). */
export function shouldClear(state: PresenceState, cfg: Config): boolean {
  if (!state.app.running || state.activity === "offline") return true;
  if (state.activity === "away" && !cfg.privacy.showWhenAway) return true;
  return false;
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "").trim();
}

export function mapToActivity(
  state: PresenceState,
  cfg: Config,
): DiscordActivity {
  const modelLabel = state.model?.label ?? "Claude";
  const activityLabel =
    cfg.templates.activityLabels[state.activity] ?? state.activity;

  // Emoji y genérico según el PRODUCTO de Claude.
  // "cloud" (Code en la nube) y "project" se tratan como Claude Code.
  const kind = state.project?.kind ?? "chat";
  const emojiMap = cfg.templates.kindEmoji;
  const product: "code" | "cowork" | "design" | "chat" =
    kind === "cowork"
      ? "cowork"
      : kind === "design"
        ? "design"
        : kind === "chat"
          ? "chat"
          : "code"; // code, cloud, project
  const emoji = emojiMap[product];
  const genericLabel: Record<typeof product, string> = {
    code: "Claude Code",
    cowork: "Cowork",
    design: "Claude Design",
    chat: cfg.privacy.fallbackProjectTitle,
  };

  // Texto de proyecto/directorio respetando privacidad.
  let label = "";
  if (state.project?.directory && cfg.privacy.showDirectory) {
    label = state.project.directory;
  } else if (state.project?.title && cfg.privacy.showProjectTitle) {
    label = state.project.title;
  } else if (product === "chat" || cfg.privacy.showProjectTitle) {
    label = genericLabel[product];
  }
  const project = label ? `${emoji} ${label}`.trim() : "";

  const vars: Record<string, string> = {
    model: modelLabel,
    activity: activityLabel,
    project,
    directory: project,
  };

  const details = fill(cfg.templates.details, vars) || undefined;
  const stateLine = fill(cfg.templates.state, vars) || undefined;

  const activity: DiscordActivity = {
    details,
    state: stateLine,
    largeImageKey: cfg.discord.assets.largeImage,
    largeImageText: cfg.discord.assets.largeText,
  };

  const smallKey = cfg.discord.assets.smallImageByActivity[state.activity];
  if (smallKey) {
    activity.smallImageKey = smallKey;
    activity.smallImageText = activityLabel;
  }

  if (state.session.startedAt) {
    activity.startTimestamp = state.session.startedAt;
  }

  if (cfg.discord.buttons.length > 0) {
    activity.buttons = cfg.discord.buttons;
  }

  return activity;
}
