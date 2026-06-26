import { loadConfig } from "./config/loader.js";
import { Aggregator } from "./core/aggregator.js";
import { mapToActivity, shouldClear } from "./core/activity-mapper.js";
import { DiscordRpcClient } from "./discord/rpc-client.js";
import { Throttler } from "./discord/throttler.js";
import { ProcessWindowProvider } from "./providers/process-window.js";
import { LogTailProvider } from "./providers/log-tail.js";
import type { DiscordActivity } from "./core/activity-mapper.js";
import type { Provider, PresenceState } from "./core/types.js";
import { Tray } from "./tray/index.js";
import {
  enableAutostart,
  disableAutostart,
} from "./os/autostart.js";
import { log } from "./util/logger.js";
import { sleep } from "./util/backoff.js";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const ONCE = args.has("--once");
const NO_TRAY = args.has("--no-tray");
const INSTALL = args.has("--install");
const UNINSTALL = args.has("--uninstall");

function describe(state: PresenceState, activity: DiscordActivity | null): string {
  const parts = [
    `app=${state.app.running ? "on" : "off"}${state.app.focused ? "/focus" : ""}`,
    `activity=${state.activity}`,
    `model=${state.model?.label ?? "-"}`,
    `dir=${state.project?.directory ?? "-"}`,
    `title=${state.project?.title ?? "-"}`,
    `sources=[${state.sources.join(",")}]`,
  ];
  let s = parts.join("  ");
  if (activity) {
    s += `\n   → Discord: "${activity.details ?? ""}" | "${activity.state ?? ""}"`;
  }
  return s;
}

async function main(): Promise<void> {
  if (INSTALL) {
    await enableAutostart();
    log.info("Autoarranque instalado. Saliendo.");
    process.exit(0);
  }
  if (UNINSTALL) {
    await disableAutostart();
    log.info("Autoarranque desinstalado. Saliendo.");
    process.exit(0);
  }

  const cfg = loadConfig();

  const aggregator = new Aggregator({
    activityHysteresisMs: 1500,
    idleTimeoutMs: cfg.privacy.idleTimeoutMin * 60_000,
    offlineGraceMs: cfg.privacy.offlineGraceSec * 1000,
  });

  const providers: Provider[] = [
    new ProcessWindowProvider(4000),
    new LogTailProvider(cfg),
  ];

  let discord: DiscordRpcClient | null = null;
  let throttler: Throttler<DiscordActivity> | null = null;

  if (!DRY_RUN && !ONCE) {
    discord = new DiscordRpcClient(cfg.discord.clientId);
    throttler = new Throttler<DiscordActivity>(cfg.behavior.throttleMs, (a) => {
      void discord!.setActivity(a);
    });
  }

  let paused = false;
  let tray: Tray | null = null;

  const statusFor = (state: PresenceState): string => {
    if (!state.app.running) return "Claude cerrado";
    const dir = state.project?.directory ?? state.project?.title ?? "—";
    return `${state.model?.label ?? "Claude"} · ${dir}`;
  };

  const publishState = (state: PresenceState): void => {
    if (paused) return;
    if (shouldClear(state, cfg)) {
      log.info(describe(state, null));
      void discord?.clearActivity();
      tray?.setStatus(statusFor(state));
      return;
    }
    const activity = mapToActivity(state, cfg);
    log.info(describe(state, activity));
    throttler?.submit(activity);
    tray?.setStatus(statusFor(state));
  };

  aggregator.onChange(publishState);

  for (const p of providers) {
    try {
      await p.start((obs) => aggregator.ingest(obs));
    } catch (err) {
      log.error(`Provider ${p.tag} no arrancó: ${(err as Error).message}`);
    }
  }

  if (discord) await discord.start();

  const tick = setInterval(() => aggregator.tick(Date.now()), 1000);

  // Bandeja del sistema (no en --once/--dry-run/--no-tray)
  const shutdownRef = { fn: async () => {} };
  if (!ONCE && !NO_TRAY) {
    tray = new Tray({
      onTogglePause: (p) => {
        paused = p;
        if (p) void discord?.clearActivity();
        else publishState(aggregator.getState()); // re-publica al reanudar
      },
      onQuit: () => void shutdownRef.fn(),
    });
    try {
      await tray.start();
    } catch (err) {
      log.warn(`No se pudo iniciar la bandeja: ${(err as Error).message}`);
      tray = null;
    }
  }

  if (ONCE) {
    log.info("Modo --once: recolectando 6s…");
    await sleep(6000);
    aggregator.tick(Date.now());
    const state = aggregator.getState();
    const activity = shouldClear(state, cfg) ? null : mapToActivity(state, cfg);
    log.info("Estado final:\n" + describe(state, activity));
    clearInterval(tick);
    for (const p of providers) await p.stop();
    process.exit(0);
  }

  const shutdown = async () => {
    log.info("Cerrando…");
    clearInterval(tick);
    throttler?.dispose();
    for (const p of providers) await p.stop();
    await discord?.stop();
    await tray?.stop();
    process.exit(0);
  };
  shutdownRef.fn = shutdown;
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  log.info(
    `claude-rich-presence en marcha${DRY_RUN ? " (DRY RUN, sin Discord)" : ""}.`,
  );
}

main().catch((err) => {
  log.error(`Fallo fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
