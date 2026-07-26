import { DateTime } from 'luxon';
import type { CalendarEvent } from './teamup/types.js';

/** Discord renders these in each reader's local time zone. */
export function discordTimestamp(date: Date, style: 'F' | 'f' | 'D' | 't' | 'R'): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

/** "Thursday, August 6 · 6:30–8:00 PM CDT" */
export function formatWhen(event: CalendarEvent, timezone: string): string {
  const start = DateTime.fromJSDate(event.start, { zone: timezone });
  const end = DateTime.fromJSDate(event.end, { zone: timezone });

  if (event.allDay) {
    const lastDay = end.minus({ milliseconds: 1 });
    const spansDays = lastDay.hasSame(start, 'day') === false;
    return spansDays
      ? `${start.toFormat('cccc, LLLL d')} – ${lastDay.toFormat('cccc, LLLL d')} (all day)`
      : `${start.toFormat('cccc, LLLL d')} (all day)`;
  }

  const day = start.toFormat('cccc, LLLL d');
  if (!end.isValid || end <= start) return `${day} · ${start.toFormat('h:mm a ZZZZ')}`;

  return end.hasSame(start, 'day')
    ? `${day} · ${start.toFormat('h:mm a')}–${end.toFormat('h:mm a ZZZZ')}`
    : `${day} ${start.toFormat('h:mm a')} – ${end.toFormat('cccc, LLLL d h:mm a ZZZZ')}`;
}

/**
 * Reminder headline based on time remaining rather than the configured offset,
 * so an event added shortly before it starts is described accurately.
 */
export function humanizeRemaining(from: Date, until: Date): string {
  const minutes = Math.round((until.getTime() - from.getTime()) / 60_000);
  if (minutes <= 1) return 'starting now';
  if (minutes < 60) return `in ${plural(minutes, 'minute')}`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in about ${plural(hours, 'hour')}`;

  const days = Math.round(minutes / 1440);
  if (days < 14) return `in ${plural(days, 'day')}`;
  return `in about ${plural(Math.round(days / 7), 'week')}`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function ordinal(day: number): string {
  // 11th, 12th and 13th are exceptions to the 1st/2nd/3rd pattern.
  const suffix =
    day % 100 >= 11 && day % 100 <= 13
      ? 'th'
      : day % 10 === 1
        ? 'st'
        : day % 10 === 2
          ? 'nd'
          : day % 10 === 3
            ? 'rd'
            : 'th';
  return `${day}${suffix}`;
}

/** Day heading without a time, e.g. "Friday, the 31st". */
export function formatDayHeading(date: Date, timezone: string): string {
  const day = DateTime.fromJSDate(date, { zone: timezone });
  return `${day.toFormat('cccc')}, the ${ordinal(day.day)}`;
}

/** Abbreviated day, e.g. "Fri 31". */
export function formatShortDay(date: Date, timezone: string): string {
  const day = DateTime.fromJSDate(date, { zone: timezone });
  return `${day.toFormat('ccc')} ${ordinal(day.day)}`;
}

/** "6:30 PM", "7 PM", or "all day". */
export function formatTimeOnly(event: CalendarEvent, timezone: string): string {
  if (event.allDay) return 'all day';
  const start = DateTime.fromJSDate(event.start, { zone: timezone });
  return start.minute === 0 ? start.toFormat('h a') : start.toFormat('h:mm a');
}

/** Day and time lead-in, e.g. "Friday, the 31st, 6:30 PM". */
export function formatDigestWhen(event: CalendarEvent, timezone: string): string {
  const start = DateTime.fromJSDate(event.start, { zone: timezone });
  const day = `${start.toFormat('cccc')}, the ${ordinal(start.day)}`;
  if (event.allDay) return `${day} (all day)`;
  const time = start.minute === 0 ? start.toFormat('h a') : start.toFormat('h:mm a');
  return `${day}, ${time}`;
}

/** Collapses multi-line notes onto a single line. */
export function oneLine(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** Discord embed field values cap at 1024; descriptions at 4096. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
