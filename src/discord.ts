import type { Config } from './config.js';
import { fetchWithRetry, HttpError, redact, sleep } from './http.js';
import { log } from './logger.js';

/** Discord sets a retry-after header on 429 responses. */
function retryAfterHeader(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) + 250 : null;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
  /** Allows the message to ping the configured role. */
  allowMention?: boolean;
}

/** Embed colors by message type. */
export const COLORS = {
  reminder: 0xec1f27,
  digest: 0xec1f27,
  added: 0x2ecc71,
  changed: 0xf1c40f,
  cancelled: 0x95a5a6,
} as const;

const MAX_EMBEDS_PER_MESSAGE = 10;

/** Notifier interface, allowing tests to substitute a recorder. */
export interface Notifier {
  readonly mention: string | null;
  post(message: DiscordMessage): Promise<string[]>;
}

export class DiscordWebhook implements Notifier {
  constructor(private readonly config: Config) {}

  get mention(): string | null {
    const id = this.config.discord.mentionRoleId;
    if (id === null) return null;
    if (id === 'everyone' || id === 'here') return `@${id}`;
    return `<@&${id}>`;
  }

  /** Returns the IDs of created messages so callers can delete them later. */
  async post(message: DiscordMessage): Promise<string[]> {
    const embeds = message.embeds ?? [];
    const batches: DiscordEmbed[][] =
      embeds.length === 0 ? [[]] : chunk(embeds, MAX_EMBEDS_PER_MESSAGE);

    const ids: string[] = [];
    for (const [index, batch] of batches.entries()) {
      const id = await this.send({
        // Only the first message in a batch carries the content and the ping.
        content: index === 0 ? message.content : undefined,
        embeds: batch.length > 0 ? batch : undefined,
        allowMention: index === 0 ? message.allowMention : false,
      });
      if (id !== null) ids.push(id);
      if (index < batches.length - 1) await sleep(1_000);
    }
    return ids;
  }

  /** Webhooks may delete their own messages. A missing message is not an error. */
  async deleteMessage(messageId: string): Promise<boolean> {
    if (this.config.dryRun) {
      log.info(`[DRY RUN] would delete message ${messageId}`);
      return true;
    }

    const url = `${this.config.discord.webhookUrl}/messages/${encodeURIComponent(messageId)}`;
    try {
      await fetchWithRetry(url, { method: 'DELETE' }, { retryAfterMs: retryAfterHeader });
      return true;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        log.debug(`Message ${messageId} was already gone`);
        return false;
      }
      throw error;
    }
  }

  private async send(message: DiscordMessage): Promise<string | null> {
    const body: Record<string, unknown> = {
      allowed_mentions: this.allowedMentions(message.allowMention === true),
    };
    if (message.content) body.content = message.content;
    if (message.embeds && message.embeds.length > 0) body.embeds = message.embeds;
    if (this.config.discord.username) body.username = this.config.discord.username;
    if (this.config.discord.avatarUrl) body.avatar_url = this.config.discord.avatarUrl;

    if (this.config.dryRun) {
      log.info('[DRY RUN] would post to Discord:\n' + JSON.stringify(body, null, 2));
      return null;
    }

    // ?wait=true returns the created message, the only way to obtain its ID
    // and therefore the only way to delete it later.
    const url = `${this.config.discord.webhookUrl}?wait=true`;
    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      { retryAfterMs: retryAfterHeader },
    );

    log.info(`Posted to ${redact(this.config.discord.webhookUrl)}`);

    const created = (await response.json().catch(() => null)) as { id?: string } | null;
    return created?.id ?? null;
  }

  private allowedMentions(allow: boolean): Record<string, unknown> {
    const id = this.config.discord.mentionRoleId;
    if (!allow || id === null) return { parse: [] };
    if (id === 'everyone' || id === 'here') return { parse: ['everyone'] };
    return { parse: [], roles: [id] };
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
