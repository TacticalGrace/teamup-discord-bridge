import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { DiscordWebhook, type DiscordEmbed } from '../src/discord.js';
import { redact } from '../src/http.js';
import { makeConfig } from './helpers.js';

interface Sent {
  url: string;
  body: Record<string, unknown>;
  method: string;
}

const realFetch = globalThis.fetch;

/** Captures outbound requests instead of performing them. */
function captureFetch(status = 200): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    // 204 and 304 forbid a body in the Response constructor.
    const body = status === 204 || status === 304 ? null : JSON.stringify({ id: `${sent.length}` });
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return sent;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function embeds(count: number): DiscordEmbed[] {
  return Array.from({ length: count }, (_, i) => ({ title: `Embed ${i}` }));
}

describe('DiscordWebhook.post', () => {
  it('requests the created message so its id can be returned', async () => {
    const sent = captureFetch();
    const ids = await new DiscordWebhook(makeConfig()).post({ content: 'hello' });
    assert.deepEqual(ids, ['1']);
    assert.match(sent[0]?.url ?? '', /\?wait=true$/);
  });

  it('sends a single message for ten or fewer embeds', async () => {
    const sent = captureFetch();
    await new DiscordWebhook(makeConfig()).post({ content: 'hi', embeds: embeds(10) });
    assert.equal(sent.length, 1);
  });

  it('splits larger batches across messages', async () => {
    const sent = captureFetch();
    const ids = await new DiscordWebhook(makeConfig()).post({ content: 'hi', embeds: embeds(23) });
    assert.equal(sent.length, 3);
    assert.equal(ids.length, 3);
    assert.equal((sent[0]?.body.embeds as unknown[]).length, 10);
    assert.equal((sent[2]?.body.embeds as unknown[]).length, 3);
  });

  it('puts the content on the first message only', async () => {
    const sent = captureFetch();
    await new DiscordWebhook(makeConfig()).post({ content: 'headline', embeds: embeds(12) });
    assert.equal(sent[0]?.body.content, 'headline');
    assert.equal(sent[1]?.body.content, undefined);
  });

  it('suppresses all mentions by default', async () => {
    const sent = captureFetch();
    await new DiscordWebhook(makeConfig()).post({ content: 'hi' });
    assert.deepEqual(sent[0]?.body.allowed_mentions, { parse: [] });
  });

  it('allows only the configured role when asked', async () => {
    const sent = captureFetch();
    const config = makeConfig({
      discord: { ...makeConfig().discord, mentionRoleId: '123456789' },
    });
    await new DiscordWebhook(config).post({ content: 'hi', allowMention: true });
    assert.deepEqual(sent[0]?.body.allowed_mentions, { parse: [], roles: ['123456789'] });
  });

  it('maps the everyone pseudo-role onto the parse form', async () => {
    const sent = captureFetch();
    const config = makeConfig({ discord: { ...makeConfig().discord, mentionRoleId: 'everyone' } });
    await new DiscordWebhook(config).post({ content: 'hi', allowMention: true });
    assert.deepEqual(sent[0]?.body.allowed_mentions, { parse: ['everyone'] });
  });

  it('does not ping when a role is configured but not requested', async () => {
    const sent = captureFetch();
    const config = makeConfig({ discord: { ...makeConfig().discord, mentionRoleId: '123' } });
    await new DiscordWebhook(config).post({ content: 'hi' });
    assert.deepEqual(sent[0]?.body.allowed_mentions, { parse: [] });
  });

  it('sends nothing in dry-run mode', async () => {
    const sent = captureFetch();
    const ids = await new DiscordWebhook(makeConfig({ dryRun: true })).post({ content: 'hi' });
    assert.deepEqual(sent, []);
    assert.deepEqual(ids, []);
  });
});

describe('DiscordWebhook.mention', () => {
  it('is null when no role is configured', () => {
    assert.equal(new DiscordWebhook(makeConfig()).mention, null);
  });

  it('renders a role id as a mention', () => {
    const config = makeConfig({ discord: { ...makeConfig().discord, mentionRoleId: '42' } });
    assert.equal(new DiscordWebhook(config).mention, '<@&42>');
  });

  it('renders the here pseudo-role literally', () => {
    const config = makeConfig({ discord: { ...makeConfig().discord, mentionRoleId: 'here' } });
    assert.equal(new DiscordWebhook(config).mention, '@here');
  });
});

describe('DiscordWebhook.deleteMessage', () => {
  it('issues a DELETE against the message route', async () => {
    const sent = captureFetch(204);
    await new DiscordWebhook(makeConfig()).deleteMessage('999');
    assert.equal(sent[0]?.method, 'DELETE');
    assert.ok(sent[0]?.url.endsWith('/messages/999'));
  });

  it('treats an already-deleted message as a non-error', async () => {
    globalThis.fetch = (async () => new Response('missing', { status: 404 })) as typeof fetch;
    assert.equal(await new DiscordWebhook(makeConfig()).deleteMessage('gone'), false);
  });
});

describe('redact', () => {
  it('masks the webhook token', () => {
    assert.equal(
      redact('https://discord.com/api/webhooks/123456/supersecrettoken'),
      'https://discord.com/api/webhooks/123456/***',
    );
  });

  it('masks token query parameters', () => {
    assert.match(redact('https://example.org/run?token=abcdef'), /token=\*\*\*/);
  });

  it('leaves ordinary URLs alone', () => {
    assert.equal(redact('https://teamup.com/kstest/events'), 'https://teamup.com/kstest/events');
  });
});
