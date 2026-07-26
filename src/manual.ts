import { DateTime } from 'luxon';
import type { Config } from './config.js';
import { DiscordWebhook } from './discord.js';
import { appendMessageLog } from './demo.js';
import { digestEmbed, reminderEmbed } from './embeds.js';
import { humanizeRemaining } from './format.js';
import { sleep } from './http.js';
import { log } from './logger.js';
import { createCalendarSource } from './teamup/index.js';

/**
 * Posts a digest from the live calendar immediately, independent of the
 * configured schedule. The deployed service still posts on its own cadence.
 */
export async function postLiveDigest(config: Config, days = 7): Promise<void> {
  const source = createCalendarSource(config);
  const now = new Date();
  const until = new Date(now.getTime() + days * 86_400_000);

  const events = (await source.fetchEvents(now, until))
    .filter((event) => event.start >= now && event.start < until)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const zoned = DateTime.fromJSDate(now, { zone: config.timezone });
  const rangeLabel = `${zoned.toFormat('LLLL d')} – ${zoned.plus({ days: days - 1 }).toFormat('LLLL d')}`;

  log.info(`Found ${events.length} event(s) in the next ${days} days from ${source.name}`);
  for (const event of events) {
    log.info(`  ${DateTime.fromJSDate(event.start, { zone: config.timezone }).toFormat('ccc LLL d h:mm a')}  ${event.title}`);
  }

  const discord = new DiscordWebhook(config);
  const mention = discord.mention;
  const ids = await discord.post({
    content: `${mention ? `${mention} ` : ''}${config.digest.intro}`,
    embeds: [digestEmbed(events, config, rangeLabel)],
    allowMention: true,
  });
  await appendMessageLog(config, ids);

  log.info(`Posted the ${rangeLabel} digest.`);
}

/**
 * Posts a countdown reminder for the next upcoming event, using the same
 * construction as the scheduled reminder path.
 */
export async function postLiveReminder(config: Config, count = 1): Promise<void> {
  const source = createCalendarSource(config);
  const now = new Date();
  const until = new Date(now.getTime() + config.horizonDays * 86_400_000);

  const upcoming = (await source.fetchEvents(now, until))
    .filter((event) => event.start > now)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, count);

  if (upcoming.length === 0) {
    log.warn('Nothing upcoming on the calendar, so there is no reminder to send.');
    return;
  }

  const discord = new DiscordWebhook(config);
  const mention = discord.mention;
  const posted: string[] = [];

  for (const event of upcoming) {
    log.info(`Reminding about "${event.title}" (${humanizeRemaining(now, event.start)})`);
    const ids = await discord.post({
      content: `${mention ? `${mention} ` : ''}**${event.title}** — ${humanizeRemaining(now, event.start)}`,
      embeds: [reminderEmbed(event, config)],
      allowMention: true,
    });
    posted.push(...ids);
    if (upcoming.length > 1) await sleep(1_200);
  }

  await appendMessageLog(config, posted);
}
