import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DateTime } from 'luxon';
import { runCheck, type Deps } from './bridge.js';
import type { Config, DigestLayout } from './config.js';
import { DiscordWebhook, type DiscordMessage, type Notifier } from './discord.js';
import { digestEmbed } from './embeds.js';
import { sleep } from './http.js';
import { log } from './logger.js';
import { Store } from './state.js';
import type { CalendarEvent, CalendarSource } from './teamup/types.js';

/**
 * Scripted walkthrough that posts one of each message type. Requires a webhook
 * but no Teamup credentials. Events are anchored to the current clock so
 * reminder timing and relative timestamps exercise the production code paths.
 */

/** Where the IDs of demo posts are kept so `demo:clean` can undo a run. */
function messageLogPath(config: Config): string {
  return resolve(`${config.stateFile}.demo-messages.json`);
}

/** Wraps the real webhook and remembers every message ID it creates. */
class RecordingWebhook implements Notifier {
  readonly ids: string[] = [];

  constructor(private readonly inner: DiscordWebhook) {}

  get mention(): string | null {
    return this.inner.mention;
  }

  async post(message: DiscordMessage): Promise<string[]> {
    const ids = await this.inner.post(message);
    this.ids.push(...ids);
    return ids;
  }
}

async function readMessageLog(config: Config): Promise<string[]> {
  try {
    const raw = await readFile(messageLogPath(config), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Records CLI-posted messages so `demo:clean` can take them back down. */
export async function appendMessageLog(config: Config, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await writeMessageLog(config, [...(await readMessageLog(config)), ...ids]);
}

async function writeMessageLog(config: Config, ids: string[]): Promise<void> {
  const path = messageLogPath(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(ids, null, 2), 'utf8');
}

/**
 * Deletes messages recorded in the message log. Webhooks may delete their own
 * messages, so no bot or additional permissions are required. Limited to
 * messages this tool posted and logged.
 */
export async function cleanDemo(config: Config): Promise<{ deleted: number; missing: number }> {
  const ids = await readMessageLog(config);
  if (ids.length === 0) {
    log.info('No logged demo messages to delete.');
    return { deleted: 0, missing: 0 };
  }

  const discord = new DiscordWebhook(config);
  let deleted = 0;
  let missing = 0;
  const remaining: string[] = [];

  for (const id of ids) {
    try {
      const gone = await discord.deleteMessage(id);
      if (gone) deleted += 1;
      else missing += 1;
    } catch (error) {
      log.error(`Could not delete message ${id}; leaving it in the log`, error);
      remaining.push(id);
    }
    await sleep(300);
  }

  if (remaining.length > 0) await writeMessageLog(config, remaining);
  else await rm(messageLogPath(config), { force: true });

  log.info(`Deleted ${deleted} demo message(s); ${missing} were already gone.`);
  return { deleted, missing };
}

class ScriptedSource implements CalendarSource {
  readonly name = 'demo';
  events: CalendarEvent[] = [];
  async fetchEvents(): Promise<CalendarEvent[]> {
    return this.events.map((event) => ({ ...event }));
  }
}

interface Seed {
  id: string;
  title: string;
  inMinutes: number;
  durationMinutes: number;
  location: string;
  description?: string;
}

const SEEDS: Seed[] = [
  {
    id: 'demo-electoral',
    title: 'Electoral Committee',
    inMinutes: 75,
    durationMinutes: 60,
    location: 'Online — Zoom',
    description: 'Endorsement process for the fall municipal races. Agenda in the shared drive.',
  },
  {
    id: 'demo-general',
    title: 'General Membership Meeting',
    inMinutes: 20 * 60,
    durationMinutes: 90,
    location: 'Central Library, Meeting Room B',
    description: 'Monthly chapter meeting. New members welcome — come early to get oriented.',
  },
  {
    id: 'demo-canvass',
    title: 'Canvass Launch: Ward 3',
    inMinutes: 3 * 24 * 60,
    durationMinutes: 180,
    location: 'Meet at the Riverside Park pavilion',
    description: 'Doors, clipboards, and snacks provided. No experience needed.',
  },
  {
    id: 'demo-gnd',
    title: 'Growth & Development Committee',
    inMinutes: 5 * 24 * 60,
    durationMinutes: 60,
    location: 'Online — Zoom',
    description: 'Onboarding pipeline and the new-member call rotation.',
  },
  {
    id: 'demo-reading',
    title: 'Reading Group: Abolish Rent',
    inMinutes: 6 * 24 * 60,
    durationMinutes: 90,
    location: 'The Old Mill, Studio 214',
  },
];

function buildEvent(seed: Seed, now: Date, publicUrl: string): CalendarEvent {
  const start = new Date(now.getTime() + seed.inMinutes * 60_000);
  return {
    id: seed.id,
    title: seed.title,
    start,
    end: new Date(start.getTime() + seed.durationMinutes * 60_000),
    allDay: false,
    location: seed.location,
    description: seed.description ?? null,
    url: `${publicUrl}/events/${seed.id}`,
    subcalendarIds: [],
  };
}

/**
 * Posts only the weekly digest, using the scripted events. Appends to the
 * message log so `demo:clean` removes it.
 */
export async function postDigestPreview(
  config: Config,
  layouts: DigestLayout[] = [config.digestLayout],
): Promise<void> {
  const now = new Date();
  const events = SEEDS.map((seed) => buildEvent(seed, now, config.teamup.publicUrl)).sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );

  const zoned = DateTime.fromJSDate(now, { zone: config.timezone });
  const rangeLabel = `${zoned.toFormat('LLLL d')} – ${zoned.plus({ days: 6 }).toFormat('LLLL d')}`;

  const discord = new DiscordWebhook(config);
  const mention = discord.mention;
  const posted: string[] = [];
  const comparing = layouts.length > 1;

  for (const layout of layouts) {
    // Label each variant when several are posted for comparison.
    const heading = comparing ? `\u2015\u2015\u2015  **${layout.toUpperCase()}**  \u2015\u2015\u2015\n` : '';
    const ids = await discord.post({
      content: `${heading}${mention ? `${mention} ` : ''}${config.digest.intro}`,
      embeds: [digestEmbed(events, config, rangeLabel, layout)],
      allowMention: !comparing,
    });
    posted.push(...ids);
    if (comparing) await sleep(1_200);
  }

  await writeMessageLog(config, [...(await readMessageLog(config)), ...posted]);
  log.info(
    `Posted ${layouts.length} digest(s) [${layouts.join(', ')}] covering ${rangeLabel} with ${events.length} event(s).`,
  );
  if (config.publicBaseUrl === null) {
    log.warn(
      'PUBLIC_BASE_URL is unset, so "Add to calendar" falls back to Google links only. ' +
        'On Render the .ics link fills itself in.',
    );
  }
}

export async function runDemo(config: Config, pauseMs = 2_500): Promise<void> {
  const now = new Date();
  const source = new ScriptedSource();
  const discord = new RecordingWebhook(new DiscordWebhook(config));

  // Separate state file so a demo cannot disturb a deployment's record.
  const store = new Store(`${config.stateFile}.demo`);
  await store.load();

  const deps: Deps = { config, source, discord, store };

  log.info('Step 0/5 — priming against an empty calendar (posts nothing)');
  await runCheck(deps, now);

  log.info('Step 1/5 — five events appear on Teamup');
  source.events = SEEDS.map((seed) => buildEvent(seed, now, config.teamup.publicUrl));
  // Produces the new-event post and both reminders, since two seeds fall
  // inside the configured reminder windows.
  await runCheck(deps, now);
  await sleep(pauseMs);

  log.info('Step 2/5 — the G&D meeting is moved an hour later and off Zoom');
  const gnd = source.events.find((event) => event.id === 'demo-gnd');
  if (gnd) {
    gnd.start = new Date(gnd.start.getTime() + 60 * 60_000);
    gnd.end = new Date(gnd.end.getTime() + 60 * 60_000);
    gnd.location = 'Union Hall';
  }
  await runCheck(deps, now);
  await sleep(pauseMs);

  log.info('Step 3/5 — the canvass is called off');
  source.events = source.events.filter((event) => event.id !== 'demo-canvass');
  await runCheck(deps, now);
  await sleep(pauseMs);

  log.info('Step 4/5 — the weekly digest goes out');
  const zoned = DateTime.fromJSDate(now, { zone: config.timezone }).minus({ minutes: 1 });
  const digestConfig: Config = {
    ...config,
    digest: {
      ...config.digest,
      enabled: true,
      weekday: zoned.weekday,
      hour: zoned.hour,
      minute: zoned.minute,
    },
  };
  await runCheck({ ...deps, config: digestConfig }, now);
  await sleep(pauseMs);

  log.info('Step 5/5 — a quiet tick, to show it stays silent when nothing changed');
  const quiet = await runCheck(deps, now);
  log.info(
    `Quiet tick posted nothing: +${quiet.added} new, ~${quiet.changed} changed, ${quiet.reminders} reminder(s)`,
  );

  await writeMessageLog(config, discord.ids);
  log.info(
    `Demo complete — ${discord.ids.length} message(s) posted. Undo them with: npm run demo:clean`,
  );
}
