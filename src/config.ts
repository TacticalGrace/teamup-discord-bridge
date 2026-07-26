import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import 'dotenv/config';
import { IANAZone } from 'luxon';

const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

type Weekday = (typeof WEEKDAYS)[number];

export interface Config {
  teamup: {
    calendarKey: string;
    apiKey: string | null;
    icsUrl: string | null;
    publicUrl: string;
    subcalendarIds: number[];
  };
  discord: {
    webhookUrl: string;
    mentionRoleId: string | null;
    username: string | null;
    avatarUrl: string | null;
  };
  /** Organization name shown in post footers and the iCalendar PRODID. */
  orgName: string;
  timezone: string;
  reminderOffsetsMinutes: number[];
  changeAlertsEnabled: boolean;
  digest: {
    enabled: boolean;
    /** Luxon weekday number, 1 = Monday. */
    weekday: number;
    hour: number;
    minute: number;
    /** Admin-written greeting that opens the digest post. */
    intro: string;
  };
  /** Absolute URL this service is reachable at, for serving .ics downloads. */
  publicBaseUrl: string | null;
  addToCalendarEnabled: boolean;
  digestLayout: DigestLayout;
  linkSecret: string;
  pollIntervalMinutes: number;
  horizonDays: number;
  stateFile: string;
  dryRun: boolean;
  port: number;
  adminToken: string | null;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

function str(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const HINTS: Record<string, string> = {
  DISCORD_WEBHOOK_URL:
    'In Discord: pick a channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL.',
  TEAMUP_CALENDAR_KEY:
    'It is the last path segment of the public Teamup link: https://teamup.com/ksabc123 → ksabc123',
};

function required(name: string): string {
  const value = str(name);
  if (value === null) {
    throw new ConfigError(`${name} is not set.`, HINTS[name]);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const value = str(name);
  if (value === null) return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new ConfigError(`${name} must be a boolean-ish value, got "${value}"`);
}

function int(name: string, fallback: number, min: number, max: number): number {
  const value = str(name);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}, got "${value}"`);
  }
  return parsed;
}

function intList(name: string, fallback: number[]): number[] {
  const value = str(name);
  if (value === null) return fallback;
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const parsed = parts.map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ConfigError(`${name} entries must be positive integers, got "${p}"`);
    }
    return n;
  });
  // Descending: the farthest-out reminder fires first, which is also the order
  // the reminder job wants when several offsets come due in the same tick.
  return [...new Set(parsed)].sort((a, b) => b - a);
}

/** Render hands us RENDER_EXTERNAL_URL; strip any trailing slash. */
function normalizeBaseUrl(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(trimmed)) {
    throw new ConfigError(`PUBLIC_BASE_URL must start with http:// or https://, got "${value}"`);
  }
  return trimmed;
}

function weekday(name: string, fallback: Weekday): number {
  const value = (str(name) ?? fallback).toLowerCase();
  const index = WEEKDAYS.indexOf(value as Weekday);
  if (index === -1) {
    throw new ConfigError(`${name} must be one of ${WEEKDAYS.join(', ')}, got "${value}"`);
  }
  return index + 1; // Luxon: 1 = Monday
}

/** Prints a config failure as guidance rather than a stack trace. */
export function reportConfigError(error: ConfigError): void {
  const lines = ['', `Configuration problem: ${error.message}`];
  if (error.hint) lines.push('', `  ${error.hint}`);

  lines.push('', existsSync('.env')
    ? '  Add it to teamup-discord/.env, then run the command again.'
    : '  There is no .env file yet. Create one and add it:\n\n      cp .env.example .env');
  lines.push('');
  console.error(lines.join('\n'));
}

const DIGEST_LAYOUTS = ['flat', 'grouped', 'compact', 'cards'] as const;
export type DigestLayout = (typeof DIGEST_LAYOUTS)[number];

function digestLayout(name: string, fallback: DigestLayout): DigestLayout {
  const value = (str(name) ?? fallback).toLowerCase();
  if (!(DIGEST_LAYOUTS as readonly string[]).includes(value)) {
    throw new ConfigError(`${name} must be one of ${DIGEST_LAYOUTS.join(', ')}, got "${value}"`);
  }
  return value as DigestLayout;
}

export interface LoadOptions {
  /** The demo runs off scripted events, so it needs no Teamup credentials. */
  requireCalendarSource?: boolean;
}

export function loadConfig(options: LoadOptions = {}): Config {
  const needsCalendar = options.requireCalendarSource !== false;

  const calendarKey = needsCalendar
    ? required('TEAMUP_CALENDAR_KEY')
    : (str('TEAMUP_CALENDAR_KEY') ?? 'demo-calendar');
  const apiKey = str('TEAMUP_API_KEY');
  const icsUrl = str('TEAMUP_ICS_URL');

  const webhookUrl = required('DISCORD_WEBHOOK_URL');
  if (!/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//.test(webhookUrl)) {
    throw new ConfigError('DISCORD_WEBHOOK_URL does not look like a Discord webhook URL.');
  }

  const timezone = str('TIMEZONE') ?? 'America/Chicago';
  if (!IANAZone.isValidZone(timezone)) {
    throw new ConfigError(`TIMEZONE "${timezone}" is not a valid IANA time zone.`);
  }

  const subcalendarIds = intList('TEAMUP_SUBCALENDAR_IDS', []);

  return {
    teamup: {
      calendarKey,
      apiKey,
      icsUrl,
      publicUrl: str('TEAMUP_PUBLIC_URL') ?? `https://teamup.com/${calendarKey}`,
      subcalendarIds,
    },
    discord: {
      webhookUrl,
      mentionRoleId: str('DISCORD_MENTION_ROLE_ID'),
      username: str('DISCORD_USERNAME'),
      avatarUrl: str('DISCORD_AVATAR_URL'),
    },
    orgName: str('ORG_NAME') ?? 'Community Calendar',
    timezone,
    reminderOffsetsMinutes: intList('REMINDER_OFFSETS_MINUTES', [1440, 120]),
    changeAlertsEnabled: bool('CHANGE_ALERTS_ENABLED', true),
    digest: {
      enabled: bool('DIGEST_ENABLED', true),
      weekday: weekday('DIGEST_DAY', 'friday'),
      hour: int('DIGEST_HOUR', 9, 0, 23),
      minute: int('DIGEST_MINUTE', 0, 0, 59),
      intro:
        str('DIGEST_INTRO') ??
        "Hey y'all! Here's what we have going on this week. Hope you can make it!",
    },
    publicBaseUrl: normalizeBaseUrl(str('PUBLIC_BASE_URL') ?? str('RENDER_EXTERNAL_URL')),
    addToCalendarEnabled: bool('ADD_TO_CALENDAR_ENABLED', true),
    digestLayout: digestLayout('DIGEST_LAYOUT', 'grouped'),
    // Signs .ics links so the endpoint can't be used to serve arbitrary
    // calendar files. Derived from the webhook when unset, which keeps old
    // links working across redeploys without another secret to manage.
    linkSecret:
      str('LINK_SECRET') ?? createHash('sha256').update(webhookUrl).digest('hex').slice(0, 32),
    pollIntervalMinutes: int('POLL_INTERVAL_MINUTES', 10, 1, 720),
    horizonDays: int('HORIZON_DAYS', 60, 1, 365),
    stateFile: str('STATE_FILE') ?? './data/state.json',
    dryRun: bool('DRY_RUN', false),
    port: int('PORT', 10000, 1, 65535),
    adminToken: str('ADMIN_TOKEN'),
  };
}
