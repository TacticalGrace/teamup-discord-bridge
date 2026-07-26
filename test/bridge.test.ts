import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCheck, type Deps } from '../src/bridge.js';
import type { Config } from '../src/config.js';
import { Store } from '../src/state.js';
import { FakeSource, Recorder, at, embedText, makeConfig, makeEvent, withTempDir } from './helpers.js';

interface Harness {
  deps: Deps;
  source: FakeSource;
  discord: Recorder;
  config: Config;
  stateFile: string;
}

async function withBridge(
  body: (harness: Harness) => Promise<void>,
  overrides: Partial<Config> = {},
): Promise<void> {
  await withTempDir(async (dir) => {
    const stateFile = join(dir, 'state.json');
    const config = makeConfig({ stateFile, ...overrides });
    const source = new FakeSource();
    const discord = new Recorder();
    const store = new Store(stateFile);
    await store.load();
    await body({ deps: { config, source, discord, store }, source, discord, config, stateFile });
  });
}

describe('priming', () => {
  it('records the calendar without announcing it', async () => {
    await withBridge(async ({ deps, source, discord }) => {
      source.events = [
        makeEvent({ id: 'a', start: at('2026-08-06T18:30') }),
        makeEvent({ id: 'b', title: 'Electoral Committee', start: at('2026-08-01T18:00') }),
      ];

      const result = await runCheck(deps, at('2026-08-01T09:00'));

      assert.equal(result.primed, true);
      assert.equal(result.added, 0);
      assert.deepEqual(discord.messages, []);
    });
  });

  it('suppresses reminders that were already due', async () => {
    await withBridge(async ({ deps, source }) => {
      // Starts within the 1440-minute window at the priming moment.
      source.events = [makeEvent({ id: 'a', start: at('2026-08-01T18:00') })];
      const result = await runCheck(deps, at('2026-08-01T09:00'));
      assert.equal(result.reminders, 0);
    });
  });
});

describe('change alerts', () => {
  it('announces a newly added event', async () => {
    await withBridge(async ({ deps, source, discord }) => {
      source.events = [makeEvent({ id: 'a', start: at('2026-08-20T18:30') })];
      await runCheck(deps, at('2026-08-01T09:00'));
      discord.drain();

      source.events.push(makeEvent({ id: 'b', title: 'Canvass', start: at('2026-08-22T10:00') }));
      const result = await runCheck(deps, at('2026-08-01T09:10'));
      const posts = discord.drain();

      assert.equal(result.added, 1);
      assert.equal(posts.length, 1);
      assert.match(posts[0]?.content ?? '', /New on the chapter calendar/);
    });
  });

  it('stays silent when nothing changed', async () => {
    await withBridge(async ({ deps, source, discord }) => {
      source.events = [makeEvent({ id: 'a', start: at('2026-08-20T18:30') })];
      await runCheck(deps, at('2026-08-01T09:00'));
      discord.drain();

      const result = await runCheck(deps, at('2026-08-01T09:10'));
      assert.equal(result.added + result.changed + result.cancelled, 0);
      assert.deepEqual(discord.drain(), []);
    });
  });

  it('reports the previous time and location when an event moves', async () => {
    await withBridge(async ({ deps, source, discord }) => {
      source.events = [makeEvent({ id: 'a', start: at('2026-08-20T18:30') })];
      await runCheck(deps, at('2026-08-01T09:00'));
      discord.drain();

      source.events = [
        makeEvent({ id: 'a', start: at('2026-08-20T19:30'), location: 'Union Hall' }),
      ];
      const result = await runCheck(deps, at('2026-08-01T09:10'));
      const posts = discord.drain();

      assert.equal(result.changed, 1);
      const changed = posts[0]?.embeds?.[0]?.fields?.find((f) => f.name === 'What changed');
      assert.match(changed?.value ?? '', /\*\*Time\*\*/);
      assert.match(changed?.value ?? '', /\*\*Location\*\*/);
    });
  });

  it('ignores edits to fields an announcement does not report', async () => {
    await withBridge(async ({ deps, source, discord }) => {
      source.events = [makeEvent({ id: 'a', start: at('2026-08-20T18:30') })];
      await runCheck(deps, at('2026-08-01T09:00'));
      discord.drain();

      source.events = [
        makeEvent({ id: 'a', start: at('2026-08-20T18:30'), description: 'Childcare provided.' }),
      ];
      const result = await runCheck(deps, at('2026-08-01T09:10'));
      assert.equal(result.changed, 0);
      assert.deepEqual(discord.drain(), []);
    });
  });

  it('announces a removal once and not again', async () => {
    await withBridge(async ({ deps, source, discord }) => {
      source.events = [
        makeEvent({ id: 'a', start: at('2026-08-20T18:30') }),
        makeEvent({ id: 'b', title: 'Canvass', start: at('2026-08-22T10:00') }),
      ];
      await runCheck(deps, at('2026-08-01T09:00'));
      discord.drain();

      source.events = source.events.filter((event) => event.id !== 'b');
      const first = await runCheck(deps, at('2026-08-01T09:10'));
      const posts = discord.drain();
      assert.equal(first.cancelled, 1);
      assert.match(embedText(posts[0]?.embeds?.[0] ?? {}), /Canvass/);

      const second = await runCheck(deps, at('2026-08-01T09:20'));
      assert.equal(second.cancelled, 0);
      assert.deepEqual(discord.drain(), []);
    });
  });

  it('treats an empty response as suspect rather than a mass cancellation', async () => {
    await withBridge(async ({ deps, source, discord }) => {
      source.events = [
        makeEvent({ id: 'a', start: at('2026-08-20T18:30') }),
        makeEvent({ id: 'b', start: at('2026-08-21T18:30') }),
      ];
      await runCheck(deps, at('2026-08-01T09:00'));
      discord.drain();

      source.events = [];
      const result = await runCheck(deps, at('2026-08-01T09:10'));
      assert.equal(result.cancelled, 0);
      assert.deepEqual(discord.drain(), []);
    });
  });

  it('can be turned off entirely', async () => {
    await withBridge(
      async ({ deps, source, discord }) => {
        source.events = [makeEvent({ id: 'a', start: at('2026-08-20T18:30') })];
        await runCheck(deps, at('2026-08-01T09:00'));
        discord.drain();

        source.events.push(makeEvent({ id: 'b', start: at('2026-08-22T10:00') }));
        const result = await runCheck(deps, at('2026-08-01T09:10'));
        assert.equal(result.added, 0);
        assert.deepEqual(discord.drain(), []);
      },
      { changeAlertsEnabled: false },
    );
  });
});

describe('reminders', () => {
  it('fires once per configured offset', async () => {
    await withBridge(async ({ deps, source, discord }) => {
      source.events = [makeEvent({ id: 'a', start: at('2026-08-20T18:30') })];
      await runCheck(deps, at('2026-08-01T09:00'));
      discord.drain();

      assert.equal((await runCheck(deps, at('2026-08-18T18:30'))).reminders, 0);

      const dayOut = await runCheck(deps, at('2026-08-19T18:35'));
      assert.equal(dayOut.reminders, 1);
      assert.match(discord.drain()[0]?.content ?? '', /in 1 day/);

      assert.equal((await runCheck(deps, at('2026-08-19T20:00'))).reminders, 0);
      assert.equal((await runCheck(deps, at('2026-08-20T14:00'))).reminders, 0);

      const hoursOut = await runCheck(deps, at('2026-08-20T16:45'));
      assert.equal(hoursOut.reminders, 1);
      assert.match(discord.drain()[0]?.content ?? '', /hour/);

      assert.equal((await runCheck(deps, at('2026-08-20T17:30'))).reminders, 0);
      assert.equal((await runCheck(deps, at('2026-08-20T19:00'))).reminders, 0);
    });
  });

  it('posts at most one catch-up after an outage', async () => {
    await withBridge(async ({ deps, source, discord }) => {
      source.events = [makeEvent({ id: 'a', start: at('2026-08-20T18:30') })];
      await runCheck(deps, at('2026-08-01T09:00'));
      discord.drain();

      // Down through the entire 1-day window; first tick back is 90 minutes out.
      const result = await runCheck(deps, at('2026-08-20T17:00'));
      assert.equal(result.reminders, 1);
      assert.match(discord.drain()[0]?.content ?? '', /in about 2 hours/);
    });
  });

  it('describes the real time remaining, not the configured offset', async () => {
    await withBridge(async ({ deps, source, discord }) => {
      source.events = [makeEvent({ id: 'a', start: at('2026-08-20T18:30') })];
      await runCheck(deps, at('2026-08-01T09:00'));
      discord.drain();

      source.events.push(
        makeEvent({ id: 'late', title: 'Emergency Rally', start: at('2026-08-01T09:50') }),
      );
      const result = await runCheck(deps, at('2026-08-01T09:10'));

      assert.equal(result.reminders, 1);
      const reminder = discord.messages.find((m) => m.content?.includes('Emergency Rally'));
      assert.match(reminder?.content ?? '', /in 40 minutes/);
    });
  });

  it('does not repeat a reminder after a restart', async () => {
    await withBridge(async ({ deps, source, discord, stateFile }) => {
      source.events = [makeEvent({ id: 'a', start: at('2026-08-20T18:30') })];
      await runCheck(deps, at('2026-08-01T09:00'));
      await runCheck(deps, at('2026-08-19T18:35'));
      assert.equal(discord.drain().length, 1);

      const reloaded = new Store(stateFile);
      await reloaded.load();
      assert.equal(reloaded.isPrimed, true);

      const result = await runCheck({ ...deps, store: reloaded }, at('2026-08-19T19:00'));
      assert.equal(result.reminders, 0);
      assert.deepEqual(discord.drain(), []);
    });
  });
});

describe('weekly digest', () => {
  it('posts once on the configured day and not again that week', async () => {
    await withBridge(async ({ deps, source, discord }) => {
      source.events = [
        makeEvent({ id: 'a', start: at('2026-08-05T18:30') }),
        makeEvent({ id: 'b', title: 'Reading Group', start: at('2026-08-07T19:00') }),
        makeEvent({ id: 'far', title: 'Convention', start: at('2026-09-15T09:00') }),
      ];
      await runCheck(deps, at('2026-07-31T12:00'));
      discord.drain();

      assert.equal((await runCheck(deps, at('2026-08-03T08:55'))).digest, false);

      const posted = await runCheck(deps, at('2026-08-03T09:05'));
      assert.equal(posted.digest, true);

      const digest = discord.messages.find((m) =>
        m.embeds?.[0]?.title?.includes('On the calendar'),
      );
      const body = embedText(digest?.embeds?.[0] ?? {});
      assert.ok(body.includes('General Meeting') && body.includes('Reading Group'), body);
      assert.ok(!body.includes('Convention'), 'events beyond the week must not appear');
      discord.drain();

      assert.equal((await runCheck(deps, at('2026-08-03T11:00'))).digest, false);
      assert.equal((await runCheck(deps, at('2026-08-03T20:00'))).digest, false);
      assert.equal((await runCheck(deps, at('2026-08-05T09:05'))).digest, false);
      assert.equal((await runCheck(deps, at('2026-08-10T09:05'))).digest, true);
    });
  });

  it('opens with the configured greeting', async () => {
    await withBridge(
      async ({ deps, source, discord }) => {
        source.events = [makeEvent({ id: 'a', start: at('2026-08-08T18:30') })];
        await runCheck(deps, at('2026-08-06T12:00'));
        discord.drain();

        const result = await runCheck(deps, at('2026-08-07T09:05'));
        assert.equal(result.digest, true);
        assert.equal(discord.drain()[0]?.content, "Here's what we have going on this week.");
      },
      { digest: { enabled: true, weekday: 5, hour: 9, minute: 0, intro: "Here's what we have going on this week." } },
    );
  });

  it('can be turned off', async () => {
    await withBridge(
      async ({ deps, source, discord }) => {
        source.events = [makeEvent({ id: 'a', start: at('2026-08-05T18:30') })];
        await runCheck(deps, at('2026-07-31T12:00'));
        discord.drain();
        assert.equal((await runCheck(deps, at('2026-08-03T09:05'))).digest, false);
        assert.deepEqual(discord.drain(), []);
      },
      { digest: { enabled: false, weekday: 1, hour: 9, minute: 0, intro: 'x' } },
    );
  });
});
