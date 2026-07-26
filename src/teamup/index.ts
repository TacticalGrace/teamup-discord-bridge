import type { Config } from '../config.js';
import { log } from '../logger.js';
import { TeamupApiSource } from './api.js';
import { TeamupIcsSource } from './ics.js';
import type { CalendarSource } from './types.js';

export function createCalendarSource(config: Config): CalendarSource {
  if (config.teamup.apiKey !== null) {
    log.info('Reading Teamup through the REST API');
    return new TeamupApiSource({
      calendarKey: config.teamup.calendarKey,
      apiKey: config.teamup.apiKey,
      timezone: config.timezone,
      subcalendarIds: config.teamup.subcalendarIds,
    });
  }

  if (config.teamup.icsUrl !== null) {
    log.info('Reading Teamup through the iCal feed');
    return new TeamupIcsSource({ icsUrl: config.teamup.icsUrl });
  }

  // No credentials at all: a public calendar key is enough.
  log.info('Reading Teamup through the public calendar endpoint (no API key)');
  return new TeamupApiSource({
    calendarKey: config.teamup.calendarKey,
    apiKey: null,
    timezone: config.timezone,
    subcalendarIds: config.teamup.subcalendarIds,
  });
}

export * from './types.js';
