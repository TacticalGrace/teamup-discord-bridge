import { ConfigError, loadConfig, reportConfigError } from './config.js';
import { DiscordWebhook } from './discord.js';
import { log } from './logger.js';
import { runCheck, type Deps } from './bridge.js';
import { startServer, type ServerStatus } from './server.js';
import { Store } from './state.js';
import { createCalendarSource } from './teamup/index.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const store = new Store(config.stateFile);
  await store.load();

  const deps: Deps = {
    config,
    source: createCalendarSource(config),
    discord: new DiscordWebhook(config),
    store,
  };

  const status: ServerStatus = { lastRunAt: null, lastRunOk: null, lastError: null, runs: 0 };
  let running = false;

  async function tick(): Promise<void> {
    if (running) {
      log.warn('Previous check still running; skipping this tick.');
      return;
    }
    running = true;
    try {
      const result = await runCheck(deps);
      status.lastRunOk = true;
      status.lastError = null;
      log.info(
        `Check complete: ${result.fetched} event(s), +${result.added} new, ~${result.changed} changed, -${result.cancelled} removed, ${result.reminders} reminder(s)${result.digest ? ', digest posted' : ''}${result.primed ? ' (priming run)' : ''}`,
      );
    } catch (error) {
      status.lastRunOk = false;
      status.lastError = error instanceof Error ? error.message : String(error);
      log.error('Check failed', error);
    } finally {
      status.lastRunAt = new Date().toISOString();
      status.runs += 1;
      running = false;
    }
  }

  const server = startServer(config, { status: () => ({ ...status }), triggerRun: tick });

  if (config.dryRun) log.warn('DRY_RUN is on — nothing will actually be posted to Discord.');

  await tick();
  const timer = setInterval(() => void tick(), config.pollIntervalMinutes * 60_000);

  const shutdown = (signal: string): void => {
    log.info(`${signal} received, shutting down.`);
    clearInterval(timer);
    server.close(() => process.exit(0));
    // Render sends SIGTERM and waits ~30s; don't hang on a lingering socket.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    reportConfigError(error);
    process.exit(1);
  }
  log.error('Fatal startup error', error);
  process.exit(1);
});
