import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import type { Config } from '../src/config.js';
import type { DiscordMessage, Notifier } from '../src/discord.js';
import type { CalendarEvent, CalendarSource } from '../src/teamup/types.js';

export const TZ = 'America/Chicago';

/** Parses a fixture timestamp in the calendar's zone. */
export function at(iso: string): Date {
  const dt = DateTime.fromISO(iso, { zone: TZ });
  if (!dt.isValid) throw new Error(`Invalid fixture date: ${iso}`);
  return dt.toJSDate();
}

export function makeEvent(
  overrides: Partial<CalendarEvent> & { id: string; start: Date },
): CalendarEvent {
  return {
    title: 'General Meeting',
    end: new Date(overrides.start.getTime() + 90 * 60_000),
    allDay: false,
    location: 'Central Library',
    description: null,
    url: 'https://teamup.com/kstest/events/1',
    subcalendarIds: [],
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    teamup: {
      calendarKey: 'kstest',
      apiKey: 'fake',
      icsUrl: null,
      publicUrl: 'https://teamup.com/kstest',
      subcalendarIds: [],
    },
    discord: {
      webhookUrl: 'https://discord.com/api/webhooks/1/abc',
      mentionRoleId: null,
      username: 'Calendar',
      avatarUrl: null,
    },
    orgName: 'Test Org',
    timezone: TZ,
    reminderOffsetsMinutes: [1440, 120],
    changeAlertsEnabled: true,
    digest: {
      enabled: true,
      weekday: 1,
      hour: 9,
      minute: 0,
      intro: "Here's what we have going on this week.",
    },
    publicBaseUrl: 'https://calendar.example.org',
    addToCalendarEnabled: true,
    digestLayout: 'flat',
    linkSecret: 'test-link-secret',
    pollIntervalMinutes: 10,
    horizonDays: 60,
    stateFile: '/tmp/unused-state.json',
    dryRun: false,
    port: 10000,
    adminToken: null,
    ...overrides,
  };
}

export class FakeSource implements CalendarSource {
  readonly name = 'fake';
  events: CalendarEvent[] = [];

  async fetchEvents(): Promise<CalendarEvent[]> {
    return this.events.map((event) => ({ ...event }));
  }
}

export class Recorder implements Notifier {
  readonly mention = null;
  messages: DiscordMessage[] = [];

  async post(message: DiscordMessage): Promise<string[]> {
    this.messages.push(message);
    return [`message-${this.messages.length}`];
  }

  drain(): DiscordMessage[] {
    const out = this.messages;
    this.messages = [];
    return out;
  }

  contents(): string[] {
    return this.messages.map((m) => m.content ?? '');
  }
}

/** Runs a body with a temporary directory, removing it afterwards. */
export async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'teamup-discord-bridge-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Flattens an embed to searchable text. */
export function embedText(embed: {
  title?: string;
  description?: string;
  fields?: Array<{ name: string; value: string }>;
}): string {
  return [
    embed.title ?? '',
    embed.description ?? '',
    ...(embed.fields ?? []).flatMap((f) => [f.name, f.value]),
  ].join('\n');
}
