import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.js';

const WEBHOOK = 'https://discord.com/api/webhooks/123/abc';

/** Variables this suite manipulates; cleared between cases. */
const MANAGED = [
  'TEAMUP_CALENDAR_KEY',
  'TEAMUP_API_KEY',
  'TEAMUP_ICS_URL',
  'TEAMUP_PUBLIC_URL',
  'TEAMUP_SUBCALENDAR_IDS',
  'DISCORD_WEBHOOK_URL',
  'DISCORD_MENTION_ROLE_ID',
  'TIMEZONE',
  'REMINDER_OFFSETS_MINUTES',
  'DIGEST_ENABLED',
  'DIGEST_DAY',
  'DIGEST_HOUR',
  'DIGEST_MINUTE',
  'DIGEST_INTRO',
  'DIGEST_LAYOUT',
  'CHANGE_ALERTS_ENABLED',
  'ADD_TO_CALENDAR_ENABLED',
  'PUBLIC_BASE_URL',
  'RENDER_EXTERNAL_URL',
  'LINK_SECRET',
  'POLL_INTERVAL_MINUTES',
  'HORIZON_DAYS',
  'STATE_FILE',
  'DRY_RUN',
  'PORT',
  'ADMIN_TOKEN',
];

function withEnv(values: Record<string, string>): void {
  for (const key of MANAGED) delete process.env[key];
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const key of MANAGED) delete process.env[key];
});

const MINIMAL = { TEAMUP_CALENDAR_KEY: 'kstest', DISCORD_WEBHOOK_URL: WEBHOOK };

describe('loadConfig', () => {
  it('accepts a calendar key and webhook alone', () => {
    withEnv(MINIMAL);
    const config = loadConfig();
    assert.equal(config.teamup.calendarKey, 'kstest');
    assert.equal(config.teamup.apiKey, null);
    assert.equal(config.teamup.icsUrl, null);
  });

  it('derives the public calendar URL from the key', () => {
    withEnv(MINIMAL);
    assert.equal(loadConfig().teamup.publicUrl, 'https://teamup.com/kstest');
  });

  it('prefers an explicit public URL', () => {
    withEnv({ ...MINIMAL, TEAMUP_PUBLIC_URL: 'https://example.org/cal' });
    assert.equal(loadConfig().teamup.publicUrl, 'https://example.org/cal');
  });

  it('requires a calendar key', () => {
    withEnv({ DISCORD_WEBHOOK_URL: WEBHOOK });
    assert.throws(() => loadConfig(), ConfigError);
  });

  it('requires a webhook', () => {
    withEnv({ TEAMUP_CALENDAR_KEY: 'kstest' });
    assert.throws(() => loadConfig(), ConfigError);
  });

  it('rejects a webhook that is not a Discord URL', () => {
    withEnv({ ...MINIMAL, DISCORD_WEBHOOK_URL: 'https://example.org/hook' });
    assert.throws(() => loadConfig(), ConfigError);
  });

  it('skips the calendar requirement when the caller opts out', () => {
    withEnv({ DISCORD_WEBHOOK_URL: WEBHOOK });
    assert.doesNotThrow(() => loadConfig({ requireCalendarSource: false }));
  });

  it('rejects an unknown time zone', () => {
    withEnv({ ...MINIMAL, TIMEZONE: 'Mars/Olympus' });
    assert.throws(() => loadConfig(), ConfigError);
  });

  it('sorts reminder offsets descending and drops duplicates', () => {
    withEnv({ ...MINIMAL, REMINDER_OFFSETS_MINUTES: '120, 1440, 120 ,60' });
    assert.deepEqual(loadConfig().reminderOffsetsMinutes, [1440, 120, 60]);
  });

  it('rejects non-positive reminder offsets', () => {
    withEnv({ ...MINIMAL, REMINDER_OFFSETS_MINUTES: '60,-5' });
    assert.throws(() => loadConfig(), ConfigError);
  });

  it('parses boolean-ish values in either direction', () => {
    withEnv({ ...MINIMAL, CHANGE_ALERTS_ENABLED: 'no', DIGEST_ENABLED: 'YES' });
    const config = loadConfig();
    assert.equal(config.changeAlertsEnabled, false);
    assert.equal(config.digest.enabled, true);
  });

  it('rejects a value that is not boolean-ish', () => {
    withEnv({ ...MINIMAL, DRY_RUN: 'maybe' });
    assert.throws(() => loadConfig(), ConfigError);
  });

  it('maps weekday names to Luxon numbers', () => {
    withEnv({ ...MINIMAL, DIGEST_DAY: 'friday' });
    assert.equal(loadConfig().digest.weekday, 5);
  });

  it('rejects an unknown weekday', () => {
    withEnv({ ...MINIMAL, DIGEST_DAY: 'caturday' });
    assert.throws(() => loadConfig(), ConfigError);
  });

  it('rejects an hour outside the day', () => {
    withEnv({ ...MINIMAL, DIGEST_HOUR: '24' });
    assert.throws(() => loadConfig(), ConfigError);
  });

  it('rejects an unknown digest layout', () => {
    withEnv({ ...MINIMAL, DIGEST_LAYOUT: 'sideways' });
    assert.throws(() => loadConfig(), ConfigError);
  });

  it('falls back to the host-provided external URL', () => {
    withEnv({ ...MINIMAL, RENDER_EXTERNAL_URL: 'https://svc.onrender.com/' });
    assert.equal(loadConfig().publicBaseUrl, 'https://svc.onrender.com');
  });

  it('prefers an explicit public base URL and strips trailing slashes', () => {
    withEnv({
      ...MINIMAL,
      RENDER_EXTERNAL_URL: 'https://svc.onrender.com',
      PUBLIC_BASE_URL: 'https://calendar.example.org//',
    });
    assert.equal(loadConfig().publicBaseUrl, 'https://calendar.example.org');
  });

  it('rejects a base URL with no scheme', () => {
    withEnv({ ...MINIMAL, PUBLIC_BASE_URL: 'calendar.example.org' });
    assert.throws(() => loadConfig(), ConfigError);
  });

  it('derives a link secret from the webhook when unset', () => {
    withEnv(MINIMAL);
    const first = loadConfig().linkSecret;
    withEnv(MINIMAL);
    assert.equal(loadConfig().linkSecret, first, 'expected the derivation to be stable');
    assert.ok(first.length >= 32);
  });

  it('treats blank values as unset', () => {
    withEnv({ ...MINIMAL, DISCORD_MENTION_ROLE_ID: '   ' });
    assert.equal(loadConfig().discord.mentionRoleId, null);
  });

  it('parses sub-calendar id lists', () => {
    withEnv({ ...MINIMAL, TEAMUP_SUBCALENDAR_IDS: '15670552, 12732576' });
    assert.deepEqual(loadConfig().teamup.subcalendarIds, [15670552, 12732576]);
  });

  it('names the offending variable in the error', () => {
    withEnv({ ...MINIMAL, HORIZON_DAYS: '9999' });
    assert.throws(() => loadConfig(), /HORIZON_DAYS/);
  });
});
