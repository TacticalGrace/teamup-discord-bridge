import ical from 'node-ical';
import { log } from '../logger.js';
import { dedupeIds, htmlToText, type CalendarEvent, type CalendarSource } from './types.js';

/** Minimal local declaration of the node-ical result shape. */
interface IcsEvent {
  type?: string;
  uid?: string;
  summary?: string;
  location?: string;
  description?: string;
  url?: string;
  start?: Date & { dateOnly?: boolean };
  end?: Date & { dateOnly?: boolean };
  datetype?: string;
  status?: string;
  rrule?: { between(after: Date, before: Date, inclusive?: boolean): Date[] };
  exdate?: Record<string, Date>;
  recurrences?: Record<string, IcsEvent>;
}

export interface TeamupIcsOptions {
  icsUrl: string;
}

/**
 * iCal feed source. Recurrence expansion is performed locally and is
 * approximate; the REST or public endpoint sources are preferred.
 */
export class TeamupIcsSource implements CalendarSource {
  readonly name = 'teamup-ics';

  constructor(private readonly options: TeamupIcsOptions) {}

  async fetchEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const parsed = (await ical.async.fromURL(this.options.icsUrl)) as Record<string, IcsEvent>;
    const events: CalendarEvent[] = [];

    for (const entry of Object.values(parsed)) {
      if (entry.type !== 'VEVENT') continue;
      if (typeof entry.status === 'string' && entry.status.toUpperCase() === 'CANCELLED') continue;
      if (!(entry.start instanceof Date)) continue;

      if (entry.rrule) {
        events.push(...this.expandRecurring(entry, from, to));
      } else if (entry.start >= from && entry.start <= to) {
        events.push(this.toEvent(entry, entry.start, this.endOf(entry, entry.start)));
      }
    }

    log.debug(`ICS feed produced ${events.length} event(s) in window`);
    return dedupeIds(events);
  }

  private expandRecurring(entry: IcsEvent, from: Date, to: Date): CalendarEvent[] {
    const seriesStart = entry.start as Date;
    const durationMs = this.endOf(entry, seriesStart).getTime() - seriesStart.getTime();
    const out: CalendarEvent[] = [];

    let occurrences: Date[] = [];
    try {
      occurrences = entry.rrule?.between(from, to, true) ?? [];
    } catch (error) {
      log.warn(`Could not expand recurrence for "${entry.summary ?? entry.uid}"`, error);
      return out;
    }

    for (const rawOccurrence of occurrences) {
      // rrule expands in UTC. Shift when an occurrence falls on the opposite
      // side of a DST boundary from the series start to preserve local time.
      const offsetDeltaMinutes =
        seriesStart.getTimezoneOffset() - rawOccurrence.getTimezoneOffset();
      const start = new Date(rawOccurrence.getTime() + offsetDeltaMinutes * 60_000);
      const key = isoDate(start);

      if (entry.exdate?.[key]) continue;

      const override = entry.recurrences?.[key];
      if (override) {
        const overrideStart = override.start instanceof Date ? override.start : start;
        out.push(this.toEvent(override, overrideStart, this.endOf(override, overrideStart), entry.uid));
        continue;
      }

      out.push(this.toEvent(entry, start, new Date(start.getTime() + durationMs)));
    }

    return out;
  }

  private endOf(entry: IcsEvent, start: Date): Date {
    if (entry.end instanceof Date && entry.end.getTime() > start.getTime()) return entry.end;
    const isAllDay = entry.start?.dateOnly === true || entry.datetype === 'date';
    return new Date(start.getTime() + (isAllDay ? 24 : 1) * 3_600_000);
  }

  private toEvent(entry: IcsEvent, start: Date, end: Date, uidOverride?: string): CalendarEvent {
    const uid = uidOverride ?? entry.uid ?? `${entry.summary ?? 'event'}`;
    return {
      id: `${uid}-${start.toISOString()}`,
      title: entry.summary?.trim() || 'Untitled event',
      start,
      end,
      allDay: entry.start?.dateOnly === true || entry.datetype === 'date',
      location: entry.location?.trim() || null,
      description: htmlToText(entry.description ?? null),
      url: entry.url?.trim() || null,
      subcalendarIds: [],
    };
  }
}

function isoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
