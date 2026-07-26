import { DateTime } from 'luxon';
import { ConfigError, loadConfig, reportConfigError, type DigestLayout } from './config.js';
import { DiscordWebhook } from './discord.js';
import { log } from './logger.js';
import { runCheck, type Deps } from './bridge.js';
import { Store } from './state.js';
import { createCalendarSource } from './teamup/index.js';
import { formatWhen } from './format.js';
import { cleanDemo, postDigestPreview, runDemo } from './demo.js';
import { postLiveDigest, postLiveReminder } from './manual.js';

/**
 * Local helpers:
 *   npm run once        -- one full check, then exit
 *   npm run preview     -- just print what Teamup returns; posts nothing
 *   npm run demo        -- scripted walkthrough; clears the previous run first
 *   npm run demo:clean  -- delete everything the last demo posted
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'run-once';

  if (command === 'demo') {
    // Only a webhook is needed; the calendar is scripted.
    const demoConfig = loadConfig({ requireCalendarSource: false });
    // Re-running the demo replaces the last one rather than stacking on it.
    await cleanDemo(demoConfig);
    await runDemo(demoConfig);
    return;
  }

  if (command === 'demo-digest') {
    const rest = process.argv.slice(3);
    const layouts = rest.includes('all')
      ? (['grouped', 'compact', 'cards', 'flat'] as DigestLayout[])
      : (rest.filter((a) => !a.startsWith('-')) as DigestLayout[]);
    const cfg = loadConfig({ requireCalendarSource: false });
    await postDigestPreview(cfg, layouts.length > 0 ? layouts : [cfg.digestLayout]);
    return;
  }

  if (command === 'demo-clean') {
    await cleanDemo(loadConfig({ requireCalendarSource: false }));
    return;
  }

  const config = loadConfig();

  if (command === 'digest') {
    const days = Number(process.argv[3] ?? 7);
    await postLiveDigest(config, Number.isInteger(days) && days > 0 ? days : 7);
    return;
  }

  if (command === 'reminder') {
    const count = Number(process.argv[3] ?? 1);
    await postLiveReminder(config, Number.isInteger(count) && count > 0 ? count : 1);
    return;
  }

  if (command === 'preview') {
    const source = createCalendarSource(config);
    const now = new Date();
    const events = await source.fetchEvents(
      now,
      new Date(now.getTime() + config.horizonDays * 86_400_000),
    );
    events.sort((a, b) => a.start.getTime() - b.start.getTime());

    console.log(`\n${events.length} event(s) on ${config.teamup.publicUrl}\n`);
    for (const event of events) {
      const line = [
        DateTime.fromJSDate(event.start, { zone: config.timezone }).toFormat('yyyy-LL-dd HH:mm'),
        event.title,
      ].join('  ');
      console.log(line);
      console.log(`    ${formatWhen(event, config.timezone)}`);
      if (event.location) console.log(`    at ${event.location}`);
    }
    console.log();
    return;
  }

  if (command !== 'run-once') {
    console.error(
      `Unknown command "${command}". Use "run-once", "digest", "reminder", "preview", "demo", "demo-digest", or "demo-clean".`,
    );
    process.exit(2);
  }

  const store = new Store(config.stateFile);
  await store.load();

  const deps: Deps = {
    config,
    source: createCalendarSource(config),
    discord: new DiscordWebhook(config),
    store,
  };

  const result = await runCheck(deps);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    reportConfigError(error);
    process.exit(1);
  }
  log.error('Command failed', error);
  process.exit(1);
});
