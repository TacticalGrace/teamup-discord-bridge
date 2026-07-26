import { DateTime } from 'luxon';
import {
  addToCalendarLine,
  compactAddToCalendarLink,
  googleCalendarUrl,
  icsDownloadUrl,
  toLinkEvent,
} from './calendar-links.js';
import type { Config, DigestLayout } from './config.js';
import { COLORS, type DiscordEmbed, type DiscordEmbedField } from './discord.js';
import {
  discordTimestamp,
  formatDayHeading,
  formatDigestWhen,
  formatShortDay,
  formatTimeOnly,
  formatWhen,
  oneLine,
  truncate,
} from './format.js';
import type { TrackedEvent } from './state.js';
import type { CalendarEvent } from './teamup/types.js';

function eventEmbed(
  event: CalendarEvent,
  config: Config,
  color: number,
  extraFields: DiscordEmbedField[] = [],
): DiscordEmbed {
  const fields: DiscordEmbedField[] = [
    {
      name: 'When',
      value: truncate(
        `${formatWhen(event, config.timezone)}\n${discordTimestamp(event.start, 'R')}`,
        1024,
      ),
      inline: false,
    },
  ];

  if (event.location) {
    fields.push({ name: 'Where', value: truncate(event.location, 1024), inline: false });
  }

  fields.push(...extraFields);

  const description = [
    event.description ? truncate(event.description, 700) : null,
    addToCalendarLine(event, config),
    `[Full chapter calendar](${config.teamup.publicUrl})`,
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n');

  const embed: DiscordEmbed = {
    title: truncate(event.title, 256),
    description: truncate(description, 4096),
    color,
    fields,
    footer: { text: config.orgName },
  };
  if (event.url) embed.url = event.url;
  return embed;
}

export function reminderEmbed(event: CalendarEvent, config: Config): DiscordEmbed {
  return eventEmbed(event, config, COLORS.reminder);
}

export function addedEmbed(event: CalendarEvent, config: Config): DiscordEmbed {
  return eventEmbed(event, config, COLORS.added);
}

export function changedEmbed(
  event: CalendarEvent,
  previous: TrackedEvent,
  config: Config,
): DiscordEmbed {
  const changes: string[] = [];

  if (previous.title !== event.title) {
    changes.push(`**Title** — was “${truncate(previous.title, 200)}”`);
  }

  const startMoved = Date.parse(previous.start) !== event.start.getTime();
  const endMoved = Date.parse(previous.end) !== event.end.getTime();
  if (startMoved || endMoved) {
    const previousEvent: CalendarEvent = {
      ...event,
      start: new Date(previous.start),
      end: new Date(previous.end),
      allDay: previous.allDay,
    };
    changes.push(`**Time** — was ${formatWhen(previousEvent, config.timezone)}`);
  }

  if ((previous.location ?? '') !== (event.location ?? '')) {
    changes.push(`**Location** — was ${previous.location ? `“${previous.location}”` : '_not set_'}`);
  }

  const fields: DiscordEmbedField[] =
    changes.length > 0
      ? [{ name: 'What changed', value: truncate(changes.join('\n'), 1024), inline: false }]
      : [];

  return eventEmbed(event, config, COLORS.changed, fields);
}

export function cancelledEmbed(previous: TrackedEvent, config: Config): DiscordEmbed {
  const asEvent: CalendarEvent = {
    id: 'cancelled',
    title: previous.title,
    start: new Date(previous.start),
    end: new Date(previous.end),
    allDay: previous.allDay,
    location: previous.location,
    description: null,
    url: previous.url,
    subcalendarIds: [],
  };

  const embed = eventEmbed(asEvent, config, COLORS.cancelled);
  embed.title = truncate(`~~${previous.title}~~`, 256);
  embed.fields = [
    {
      name: 'Was scheduled for',
      value: truncate(formatWhen(asEvent, config.timezone), 1024),
      inline: false,
    },
  ];
  embed.description = `This event is no longer on the calendar.\n\n[Full chapter calendar](${config.teamup.publicUrl})`;
  delete embed.url;
  return embed;
}

/** Description limit is 4096; the remainder is reserved for closing lines. */
const DIGEST_BODY_BUDGET = 3600;
const DIGEST_DETAIL_LIMIT = 160;

/** One line per event: date and time, title, optional links, then details. */
export function digestLine(event: CalendarEvent, config: Config): string {
  const parts = [
    `**${formatDigestWhen(event, config.timezone)}** — ${linkedTitle(event)}`,
  ];

  const add = compactAddToCalendarLink(event, config);
  if (add !== null) parts.push(` (${add})`);
  else if (event.url) parts.push(` ([details](${event.url}))`);

  // Location first, then notes.
  const detail = [
    event.location ? oneLine(event.location) : null,
    event.description ? oneLine(event.description) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  if (detail.length > 0) parts.push(` — ${truncate(detail, DIGEST_DETAIL_LIMIT)}`);

  return parts.join('');
}

function digestShell(
  config: Config,
  rangeLabel: string,
  description: string,
  fields: DiscordEmbedField[] = [],
): DiscordEmbed {
  return {
    title: `On the calendar: ${rangeLabel}`,
    url: config.teamup.publicUrl,
    color: COLORS.digest,
    description: truncate(description, 4096),
    fields,
    footer: { text: config.orgName },
  };
}

/** The event title, linked to its Teamup entry when there is one. */
function linkedTitle(event: CalendarEvent): string {
  const title = event.title.trim();
  return event.url ? `[${title}](${event.url})` : title;
}

/** Groups events into calendar days, preserving order. */
function byDay(events: CalendarEvent[], timezone: string): Array<[string, CalendarEvent[]]> {
  const days = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const key = DateTime.fromJSDate(event.start, { zone: timezone }).toISODate() ?? '';
    const bucket = days.get(key);
    if (bucket) bucket.push(event);
    else days.set(key, [event]);
  }
  return [...days.entries()];
}

/**
 * Both links are offered: the .ics covers Apple, Outlook desktop, Thunderbird
 * and Android, while Google Calendar on the web requires its own URL because a
 * downloaded file would need manual import.
 */
function addLink(event: CalendarEvent, config: Config, verbose: boolean): string | null {
  if (!config.addToCalendarEnabled) return null;

  const payload = toLinkEvent(event);
  const ics = icsDownloadUrl(payload, config);
  const google = googleCalendarUrl(payload, config.timezone);

  if (ics === null) return `add to [Google Calendar](${google})`;

  return verbose
    ? `add to [Apple/Outlook](${ics}) · [Google](${google})`
    : `add: [Apple/Outlook](${ics}) · [Google](${google})`;
}

function closingLine(config: Config, overflow: number): string {
  return overflow > 0
    ? `\n-# …and ${overflow} more on the [full calendar](${config.teamup.publicUrl}).`
    : `\n-# [Full chapter calendar](${config.teamup.publicUrl})`;
}

/** Day headings, with location and notes in subtext. */
function groupedDigest(events: CalendarEvent[], config: Config, rangeLabel: string): DiscordEmbed {
  const blocks: string[] = [];
  let used = 0;
  let rendered = 0;

  for (const [, dayEvents] of byDay(events, config.timezone)) {
    const first = dayEvents[0];
    if (first === undefined) continue;

    const lines = [`### ${formatDayHeading(first.start, config.timezone)}`];
    for (const event of dayEvents) {
      lines.push(`**${formatTimeOnly(event, config.timezone)}** · ${linkedTitle(event)}`);
      const detail = [
        event.location ? oneLine(event.location) : null,
        event.description ? truncate(oneLine(event.description), 140) : null,
        addLink(event, config, true),
      ].filter((part): part is string => part !== null && part.length > 0);
      if (detail.length > 0) lines.push(`-# ${detail.join(' · ')}`);
    }

    const block = lines.join('\n');
    if (used + block.length + 2 > DIGEST_BODY_BUDGET) break;
    blocks.push(block);
    used += block.length + 2;
    rendered += dayEvents.length;
  }

  return digestShell(
    config,
    rangeLabel,
    `${blocks.join('\n\n')}\n${closingLine(config, events.length - rendered)}`,
  );
}

/** Two lines per event: heading, then location and link in subtext. */
function compactDigest(events: CalendarEvent[], config: Config, rangeLabel: string): DiscordEmbed {
  const blocks: string[] = [];
  let used = 0;

  for (const event of events) {
    const head = `**${formatShortDay(event.start, config.timezone)} · ${formatTimeOnly(event, config.timezone)}** — ${linkedTitle(event)}`;
    const detail = [event.location ? oneLine(event.location) : null, addLink(event, config, false)]
      .filter((part): part is string => part !== null && part.length > 0)
      .join(' · ');
    const block = detail.length > 0 ? `${head}\n-# ${detail}` : head;

    if (used + block.length + 2 > DIGEST_BODY_BUDGET) break;
    blocks.push(block);
    used += block.length + 2;
  }

  return digestShell(
    config,
    rangeLabel,
    `${blocks.join('\n\n')}\n${closingLine(config, events.length - blocks.length)}`,
  );
}

/** One embed field per event, using Discord's own field spacing. */
function cardsDigest(events: CalendarEvent[], config: Config, rangeLabel: string): DiscordEmbed {
  const shown = events.slice(0, 24);
  const fields: DiscordEmbedField[] = shown.map((event) => {
    const lines = [`**${linkedTitle(event)}**`];
    if (event.location) lines.push(oneLine(event.location));
    const detail = [
      event.description ? truncate(oneLine(event.description), 140) : null,
      addLink(event, config, true),
    ].filter((part): part is string => part !== null && part.length > 0);
    if (detail.length > 0) lines.push(`-# ${detail.join(' · ')}`);

    return {
      name: truncate(
        `${formatDayHeading(event.start, config.timezone)} · ${formatTimeOnly(event, config.timezone)}`,
        256,
      ),
      value: truncate(lines.join('\n'), 1024),
      inline: false,
    };
  });

  return digestShell(
    config,
    rangeLabel,
    closingLine(config, events.length - shown.length).trimStart(),
    fields,
  );
}

/** One-line-per-event layout. */
function flatDigest(events: CalendarEvent[], config: Config, rangeLabel: string): DiscordEmbed {
  const lines: string[] = [];
  let used = 0;
  for (const event of events) {
    const line = digestLine(event, config);
    if (used + line.length + 1 > DIGEST_BODY_BUDGET) break;
    lines.push(line);
    used += line.length + 1;
  }

  const overflow = events.length - lines.length;
  lines.push(
    overflow > 0
      ? `\n…and ${overflow} more on the [full calendar](${config.teamup.publicUrl}).`
      : `\n[Full chapter calendar](${config.teamup.publicUrl})`,
  );

  return digestShell(config, rangeLabel, lines.join('\n'));
}

export function digestEmbed(
  events: CalendarEvent[],
  config: Config,
  rangeLabel: string,
  layout: DigestLayout = config.digestLayout,
): DiscordEmbed {
  if (events.length === 0) {
    return digestShell(
      config,
      rangeLabel,
      `Nothing on the chapter calendar for ${rangeLabel}.\n\n[Full chapter calendar](${config.teamup.publicUrl})`,
    );
  }

  switch (layout) {
    case 'grouped':
      return groupedDigest(events, config, rangeLabel);
    case 'compact':
      return compactDigest(events, config, rangeLabel);
    case 'cards':
      return cardsDigest(events, config, rangeLabel);
    default:
      return flatDigest(events, config, rangeLabel);
  }
}
