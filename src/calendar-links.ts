import { createHmac, timingSafeEqual } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Config } from './config.js';
import type { CalendarEvent } from './teamup/types.js';

/**
 * Add-to-calendar links.
 *
 * Google Calendar and Outlook Web accept prefilled-event URLs. Apple Calendar,
 * Outlook desktop, and Thunderbird have no URL scheme and require an .ics file,
 * which this service serves at /event.ics.
 *
 * The event is encoded into the .ics link rather than looked up from state, so
 * links stay valid after a redeploy clears the state file. Links are signed to
 * prevent the endpoint serving arbitrary calendar content.
 */

/** Field names are short because this is encoded into a URL. */
export interface LinkEvent {
  /** title */ t: string;
  /** start, unix seconds */ s: number;
  /** end, unix seconds */ e: number;
  /** all-day */ a: 0 | 1;
  /** location */ l?: string;
  /** source url */ u?: string;
}

const MAX_TITLE = 120;
const MAX_LOCATION = 150;

export function toLinkEvent(event: CalendarEvent): LinkEvent {
  const payload: LinkEvent = {
    t: event.title.slice(0, MAX_TITLE),
    s: Math.floor(event.start.getTime() / 1000),
    e: Math.floor(event.end.getTime() / 1000),
    a: event.allDay ? 1 : 0,
  };
  if (event.location) payload.l = event.location.slice(0, MAX_LOCATION);
  if (event.url) payload.u = event.url;
  return payload;
}

// --- signing ---------------------------------------------------------------

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(data: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(data).digest()).slice(0, 22);
}

function encodeLinkEvent(payload: LinkEvent, secret: string): { d: string; s: string } {
  const d = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return { d, s: sign(d, secret) };
}

export function decodeLinkEvent(d: string, signature: string, secret: string): LinkEvent | null {
  const expected = sign(d, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(fromBase64url(d).toString('utf8')) as Partial<LinkEvent>;
    if (
      typeof parsed.t !== 'string' ||
      typeof parsed.s !== 'number' ||
      typeof parsed.e !== 'number' ||
      !Number.isFinite(parsed.s) ||
      !Number.isFinite(parsed.e)
    ) {
      return null;
    }
    return {
      t: parsed.t.slice(0, MAX_TITLE),
      s: parsed.s,
      e: parsed.e,
      a: parsed.a === 1 ? 1 : 0,
      ...(typeof parsed.l === 'string' ? { l: parsed.l.slice(0, MAX_LOCATION) } : {}),
      ...(typeof parsed.u === 'string' ? { u: parsed.u.slice(0, 500) } : {}),
    };
  } catch {
    return null;
  }
}

// --- iCalendar -------------------------------------------------------------

/** RFC 5545 text escaping: backslash, semicolon, comma, and newlines. */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545 lines wrap at 75 octets, continued with a leading space. */
function foldIcsLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const parts: string[] = [];
  let offset = 0;
  let limit = 75;
  while (offset < bytes.length) {
    let end = Math.min(offset + limit, bytes.length);
    // Never split a multi-byte character across a fold.
    while (end > offset && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    parts.push(bytes.subarray(offset, end).toString('utf8'));
    offset = end;
    limit = 74; // continuation lines lose one octet to the leading space
  }
  return parts.join('\r\n ');
}

function utcStamp(seconds: number): string {
  return `${DateTime.fromSeconds(seconds, { zone: 'utc' }).toFormat("yyyyLLdd'T'HHmmss")}Z`;
}

function dateStamp(seconds: number, timezone: string): string {
  return DateTime.fromSeconds(seconds, { zone: timezone }).toFormat('yyyyLLdd');
}

/**
 * Single-event VCALENDAR. Uses UTC timestamps rather than VTIMEZONE blocks,
 * which have inconsistent client support.
 */
export function buildIcsDocument(
  payload: LinkEvent,
  options: { timezone: string; uid: string; orgName: string; now?: Date },
): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${escapeIcsText(options.orgName)}//teamup-discord-bridge//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(options.uid)}`,
    `DTSTAMP:${utcStamp(Math.floor((options.now ?? new Date()).getTime() / 1000))}`,
  ];

  if (payload.a === 1) {
    lines.push(`DTSTART;VALUE=DATE:${dateStamp(payload.s, options.timezone)}`);
    lines.push(`DTEND;VALUE=DATE:${dateStamp(payload.e, options.timezone)}`);
  } else {
    lines.push(`DTSTART:${utcStamp(payload.s)}`);
    lines.push(`DTEND:${utcStamp(payload.e)}`);
  }

  lines.push(`SUMMARY:${escapeIcsText(payload.t)}`);
  if (payload.l) lines.push(`LOCATION:${escapeIcsText(payload.l)}`);
  if (payload.u) {
    lines.push(`URL:${escapeIcsText(payload.u)}`);
    lines.push(`DESCRIPTION:${escapeIcsText(`Event details: ${payload.u}`)}`);
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');

  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

/** Slugified filename for the Content-Disposition header. */
export function icsFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug.length > 0 ? slug : 'event'}.ics`;
}

// --- provider URLs ---------------------------------------------------------

export function icsDownloadUrl(payload: LinkEvent, config: Config): string | null {
  if (config.publicBaseUrl === null) return null;
  const { d, s } = encodeLinkEvent(payload, config.linkSecret);
  return `${config.publicBaseUrl}/event.ics?d=${d}&s=${s}`;
}

export function googleCalendarUrl(payload: LinkEvent, timezone: string): string {
  const dates =
    payload.a === 1
      ? `${dateStamp(payload.s, timezone)}/${dateStamp(payload.e, timezone)}`
      : `${utcStamp(payload.s)}/${utcStamp(payload.e)}`;

  const params = new URLSearchParams({ action: 'TEMPLATE', text: payload.t, dates });
  if (payload.l) params.set('location', payload.l);
  if (payload.u) params.set('details', `Event details: ${payload.u}`);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function outlookWebUrl(payload: LinkEvent, timezone: string): string {
  const iso = (seconds: number): string =>
    payload.a === 1
      ? dateStamp(seconds, timezone)
      : (DateTime.fromSeconds(seconds, { zone: 'utc' }).toISO({ suppressMilliseconds: true }) ?? '');

  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: payload.t,
    startdt: iso(payload.s),
    enddt: iso(payload.e),
  });
  if (payload.a === 1) params.set('allday', 'true');
  if (payload.l) params.set('location', payload.l);
  if (payload.u) params.set('body', `Event details: ${payload.u}`);
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

/** Single link for constrained space. Prefers the .ics download. */
export function compactAddToCalendarLink(event: CalendarEvent, config: Config): string | null {
  if (!config.addToCalendarEnabled) return null;
  const payload = toLinkEvent(event);
  const ics = icsDownloadUrl(payload, config);
  return ics !== null
    ? `[Add to calendar](${ics})`
    : `[Add to Google Calendar](${googleCalendarUrl(payload, config.timezone)})`;
}

/**
 * Markdown row for an embed description. Not a field: three URLs can exceed the
 * 1024 character field limit.
 */
export function addToCalendarLine(event: CalendarEvent, config: Config): string | null {
  if (!config.addToCalendarEnabled) return null;

  const payload = toLinkEvent(event);
  const parts: string[] = [];

  const ics = icsDownloadUrl(payload, config);
  if (ics !== null) parts.push(`[Apple / Outlook / Thunderbird](${ics})`);
  parts.push(`[Google](${googleCalendarUrl(payload, config.timezone)})`);
  parts.push(`[Outlook Web](${outlookWebUrl(payload, config.timezone)})`);

  return `**Add to your calendar:** ${parts.join(' · ')}`;
}
