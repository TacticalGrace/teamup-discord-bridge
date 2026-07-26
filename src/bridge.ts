import { DateTime } from 'luxon';
import type { Config } from './config.js';
import type { Notifier } from './discord.js';
import { addedEmbed, cancelledEmbed, changedEmbed, digestEmbed, reminderEmbed } from './embeds.js';
import { humanizeRemaining } from './format.js';
import { log } from './logger.js';
import type { Store, TrackedEvent } from './state.js';
import { fingerprint, type CalendarEvent, type CalendarSource } from './teamup/types.js';

/** How long after a digest's scheduled time we'll still post it. */
const DIGEST_CATCHUP_HOURS = 6;

export interface Deps {
  config: Config;
  source: CalendarSource;
  discord: Notifier;
  store: Store;
}

export interface RunResult {
  fetched: number;
  primed: boolean;
  added: number;
  changed: number;
  cancelled: number;
  reminders: number;
  digest: boolean;
}

export async function runCheck(deps: Deps, now: Date = new Date()): Promise<RunResult> {
  const { config, source, store } = deps;

  const from = new Date(now.getTime() - 86_400_000);
  const to = new Date(now.getTime() + config.horizonDays * 86_400_000);
  const events = await source.fetchEvents(from, to);
  log.info(`Fetched ${events.length} event(s) from ${source.name}`);

  const isPrimingRun = !store.isPrimed;
  const result: RunResult = {
    fetched: events.length,
    primed: isPrimingRun,
    added: 0,
    changed: 0,
    cancelled: 0,
    reminders: 0,
    digest: false,
  };

  if (isPrimingRun) {
    log.info('First run with no saved state: recording the calendar without announcing it.');
  }

  const changes = detectChanges(deps, events, now, isPrimingRun);
  result.added = changes.added.length;
  result.changed = changes.changed.length;
  result.cancelled = changes.cancelled.length;

  // Recorded before posting so a crash mid-post cannot replay these alerts.
  for (const event of events) store.putEvent(event.id, toTracked(event, now));
  for (const id of changes.cancelledIds) store.deleteEvent(id);
  if (isPrimingRun) store.markPrimed();
  await store.save();

  if (!isPrimingRun) {
    await postChanges(deps, changes);
  }

  result.reminders = await handleReminders(deps, events, now, isPrimingRun);
  result.digest = await handleDigest(deps, events, now, isPrimingRun);

  await store.save();
  return result;
}

// --- change detection ------------------------------------------------------

interface Changes {
  added: CalendarEvent[];
  changed: Array<{ event: CalendarEvent; previous: TrackedEvent }>;
  cancelled: TrackedEvent[];
  cancelledIds: string[];
}

function detectChanges(
  deps: Deps,
  events: CalendarEvent[],
  now: Date,
  isPrimingRun: boolean,
): Changes {
  const { config, store } = deps;
  const changes: Changes = { added: [], changed: [], cancelled: [], cancelledIds: [] };

  if (isPrimingRun || !config.changeAlertsEnabled) return changes;

  for (const event of events) {
    // Past events are recorded but not announced.
    if (event.start.getTime() <= now.getTime()) continue;

    const previous = store.getEvent(event.id);
    if (previous === undefined) {
      changes.added.push(event);
    } else if (previous.fingerprint !== fingerprint(event)) {
      changes.changed.push({ event, previous });
    }
  }

  // An empty or partial fetch must not be read as a mass cancellation.
  if (events.length === 0) return changes;

  const seen = new Set(events.map((event) => event.id));
  const horizonEnd = now.getTime() + config.horizonDays * 86_400_000;

  for (const [id, tracked] of Object.entries(store.trackedEvents)) {
    if (seen.has(id)) continue;
    const start = Date.parse(tracked.start);
    if (Number.isNaN(start) || start <= now.getTime() || start > horizonEnd) continue;
    changes.cancelled.push(tracked);
    changes.cancelledIds.push(id);
  }

  return changes;
}

async function postChanges(deps: Deps, changes: Changes): Promise<void> {
  const { config, discord } = deps;

  if (changes.added.length > 0) {
    const plural = changes.added.length === 1 ? 'event' : 'events';
    await discord.post({
      content: `**New on the chapter calendar** (${changes.added.length} ${plural})`,
      embeds: changes.added.map((event) => addedEmbed(event, config)),
    });
  }

  if (changes.changed.length > 0) {
    const plural = changes.changed.length === 1 ? 'event' : 'events';
    await discord.post({
      content: `**Updated on the chapter calendar** (${changes.changed.length} ${plural})`,
      embeds: changes.changed.map(({ event, previous }) => changedEmbed(event, previous, config)),
    });
  }

  if (changes.cancelled.length > 0) {
    const plural = changes.cancelled.length === 1 ? 'event' : 'events';
    await discord.post({
      content: `**Removed from the chapter calendar** (${changes.cancelled.length} ${plural})`,
      embeds: changes.cancelled.map((tracked) => cancelledEmbed(tracked, config)),
    });
  }
}

// --- reminders -------------------------------------------------------------

async function handleReminders(
  deps: Deps,
  events: CalendarEvent[],
  now: Date,
  isPrimingRun: boolean,
): Promise<number> {
  const { config, discord, store } = deps;
  if (config.reminderOffsetsMinutes.length === 0) return 0;

  let posted = 0;

  for (const event of events) {
    if (event.start.getTime() <= now.getTime()) continue;

    const minutesOut = (event.start.getTime() - now.getTime()) / 60_000;
    // Offsets whose window has opened, nearest first. Taking the smallest
    // prevents a long outage from replaying every earlier reminder.
    const due = config.reminderOffsetsMinutes
      .filter((offset) => minutesOut <= offset)
      .sort((a, b) => a - b);

    const offset = due[0];
    if (offset === undefined) continue;

    const key = `reminder:${event.id}:${offset}`;
    if (store.hasPosted(key)) continue;

    if (isPrimingRun) {
      // Already due before startup; record it so it never fires late.
      store.markPosted(key, now);
      continue;
    }

    const mention = discord.mention;
    await discord.post({
      content: `${mention ? `${mention} ` : ''}**${event.title}** — ${humanizeRemaining(now, event.start)}`,
      embeds: [reminderEmbed(event, config)],
      allowMention: true,
    });
    store.markPosted(key, now);
    posted += 1;
  }

  if (posted > 0) log.info(`Posted ${posted} reminder(s)`);
  return posted;
}

// --- weekly digest ---------------------------------------------------------

async function handleDigest(
  deps: Deps,
  events: CalendarEvent[],
  now: Date,
  isPrimingRun: boolean,
): Promise<boolean> {
  const { config, discord, store } = deps;
  if (!config.digest.enabled) return false;

  const zoned = DateTime.fromJSDate(now, { zone: config.timezone });
  const scheduled = zoned.set({
    weekday: config.digest.weekday as 1 | 2 | 3 | 4 | 5 | 6 | 7,
    hour: config.digest.hour,
    minute: config.digest.minute,
    second: 0,
    millisecond: 0,
  });

  if (zoned < scheduled) return false;
  if (zoned > scheduled.plus({ hours: DIGEST_CATCHUP_HOURS })) return false;

  const key = `digest:${scheduled.weekYear}-W${String(scheduled.weekNumber).padStart(2, '0')}`;
  if (store.hasPosted(key)) return false;

  if (isPrimingRun) {
    store.markPosted(key, now);
    return false;
  }

  const windowEnd = zoned.plus({ days: 7 });
  const upcoming = events
    .filter((event) => {
      const start = DateTime.fromJSDate(event.start, { zone: config.timezone });
      return start >= zoned && start < windowEnd;
    })
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const rangeLabel = `${zoned.toFormat('LLLL d')} – ${windowEnd.minus({ days: 1 }).toFormat('LLLL d')}`;
  const mention = discord.mention;

  await discord.post({
    content: `${mention ? `${mention} ` : ''}${config.digest.intro}`,
    embeds: [digestEmbed(upcoming, config, rangeLabel)],
    allowMention: true,
  });

  store.markPosted(key, now);
  log.info(`Posted weekly digest ${key} with ${upcoming.length} event(s)`);
  return true;
}

// --- helpers ---------------------------------------------------------------

function toTracked(event: CalendarEvent, now: Date): TrackedEvent {
  return {
    fingerprint: fingerprint(event),
    title: event.title,
    start: event.start.toISOString(),
    end: event.end.toISOString(),
    allDay: event.allDay,
    location: event.location,
    url: event.url,
    lastSeen: now.toISOString(),
  };
}
