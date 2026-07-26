import { DateTime } from 'luxon';
import { fetchWithRetry } from '../http.js';
import { log } from '../logger.js';
import { dedupeIds, htmlToText, type CalendarEvent, type CalendarSource } from './types.js';

/** Documented API. Requires an API key in a Teamup-Token header. */
const API_ROOT = 'https://api.teamup.com';

/**
 * The endpoint the Teamup web application uses. Returns the same JSON as the
 * documented API for a public calendar, without credentials and with
 * server-side recurrence expansion. Undocumented and subject to change.
 */
const PUBLIC_ROOT = 'https://teamup.com';

interface TeamupApiEvent {
  id?: string | number;
  title?: string;
  start_dt?: string;
  end_dt?: string;
  all_day?: boolean;
  location?: string | null;
  notes?: string | null;
  who?: string | null;
  subcalendar_id?: number;
  subcalendar_ids?: number[];
  delete_dt?: string | null;
}

interface TeamupApiResponse {
  events?: TeamupApiEvent[];
}

export interface TeamupApiOptions {
  calendarKey: string;
  /** Null selects the keyless public endpoint. */
  apiKey: string | null;
  timezone: string;
  subcalendarIds: number[];
}

export class TeamupApiSource implements CalendarSource {
  readonly name: string;

  constructor(private readonly options: TeamupApiOptions) {
    this.name = options.apiKey === null ? 'teamup-public' : 'teamup-api';
  }

  async fetchEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const zone = this.options.timezone;
    const params = new URLSearchParams({
      startDate: DateTime.fromJSDate(from, { zone }).toISODate() ?? '',
      endDate: DateTime.fromJSDate(to, { zone }).toISODate() ?? '',
      tz: zone,
    });
    for (const id of this.options.subcalendarIds) {
      params.append('subcalendarId[]', String(id));
    }

    const root = this.options.apiKey === null ? PUBLIC_ROOT : API_ROOT;
    const url = `${root}/${encodeURIComponent(this.options.calendarKey)}/events?${params.toString()}`;

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.options.apiKey !== null) headers['Teamup-Token'] = this.options.apiKey;

    const response = await fetchWithRetry(url, { headers });

    const payload = (await response.json()) as TeamupApiResponse;
    const raw = payload.events ?? [];
    log.debug(`Teamup API returned ${raw.length} raw event(s)`);

    const events: CalendarEvent[] = [];
    for (const item of raw) {
      const event = this.normalize(item);
      if (event !== null) events.push(event);
    }
    return dedupeIds(events);
  }

  private normalize(item: TeamupApiEvent): CalendarEvent | null {
    if (item.delete_dt) return null;

    const id = item.id === undefined ? null : String(item.id);
    if (id === null || item.start_dt === undefined) {
      log.warn('Skipping Teamup event with no id or start time', item);
      return null;
    }

    const start = DateTime.fromISO(item.start_dt, { setZone: true });
    if (!start.isValid) {
      log.warn(`Skipping Teamup event ${id} with unparseable start "${item.start_dt}"`);
      return null;
    }

    const parsedEnd = item.end_dt ? DateTime.fromISO(item.end_dt, { setZone: true }) : null;
    const end = parsedEnd?.isValid
      ? parsedEnd
      : start.plus({ hours: item.all_day === true ? 24 : 1 });

    const subcalendarIds =
      item.subcalendar_ids ?? (item.subcalendar_id === undefined ? [] : [item.subcalendar_id]);

    const description = [htmlToText(item.notes), item.who?.trim() || null]
      .filter((part): part is string => part !== null && part.length > 0)
      .join('\n\n');

    return {
      id,
      title: item.title?.trim() || 'Untitled event',
      start: start.toJSDate(),
      end: end.toJSDate(),
      allDay: item.all_day === true,
      location: item.location?.trim() || null,
      description: description.length > 0 ? description : null,
      url: `https://teamup.com/${this.options.calendarKey}/events/${encodeURIComponent(id)}`,
      subcalendarIds,
    };
  }
}
