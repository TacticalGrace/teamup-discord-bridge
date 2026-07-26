import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Store, type TrackedEvent } from '../src/state.js';
import { withTempDir } from './helpers.js';

function tracked(overrides: Partial<TrackedEvent> = {}): TrackedEvent {
  return {
    fingerprint: 'abc123',
    title: 'General Meeting',
    start: '2026-08-06T23:30:00.000Z',
    end: '2026-08-07T01:00:00.000Z',
    allDay: false,
    location: null,
    url: null,
    lastSeen: new Date().toISOString(),
    ...overrides,
  };
}

describe('Store', () => {
  it('starts unprimed and empty when there is no file', async () => {
    await withTempDir(async (dir) => {
      const store = new Store(join(dir, 'state.json'));
      await store.load();
      assert.equal(store.isPrimed, false);
      assert.deepEqual(store.trackedEvents, {});
    });
  });

  it('round-trips events and posted keys through disk', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'state.json');
      const store = new Store(path);
      await store.load();
      store.markPrimed();
      store.putEvent('a', tracked());
      store.markPosted('reminder:a:1440');
      await store.save();

      const reloaded = new Store(path);
      await reloaded.load();
      assert.equal(reloaded.isPrimed, true);
      assert.equal(reloaded.getEvent('a')?.title, 'General Meeting');
      assert.equal(reloaded.hasPosted('reminder:a:1440'), true);
      assert.equal(reloaded.hasPosted('reminder:a:120'), false);
    });
  });

  it('creates the parent directory when saving', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'nested', 'deeper', 'state.json');
      const store = new Store(path);
      await store.load();
      store.markPrimed();
      await store.save();
      assert.ok(JSON.parse(await readFile(path, 'utf8')).primed);
    });
  });

  it('deletes events', async () => {
    await withTempDir(async (dir) => {
      const store = new Store(join(dir, 'state.json'));
      await store.load();
      store.putEvent('a', tracked());
      store.deleteEvent('a');
      assert.equal(store.getEvent('a'), undefined);
    });
  });

  it('prunes events well past their start date', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'state.json');
      const store = new Store(path);
      await store.load();
      const longAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();
      store.putEvent('old', tracked({ start: longAgo }));
      store.putEvent('recent', tracked({ start: new Date().toISOString() }));
      await store.save();

      const reloaded = new Store(path);
      await reloaded.load();
      assert.equal(reloaded.getEvent('old'), undefined);
      assert.ok(reloaded.getEvent('recent'));
    });
  });

  it('prunes posted keys older than the retention window', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'state.json');
      const store = new Store(path);
      await store.load();
      store.markPosted('old', new Date(Date.now() - 120 * 86_400_000));
      store.markPosted('recent');
      await store.save();

      const reloaded = new Store(path);
      await reloaded.load();
      assert.equal(reloaded.hasPosted('old'), false);
      assert.equal(reloaded.hasPosted('recent'), true);
    });
  });

  it('starts fresh rather than throwing on a corrupt file', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'state.json');
      await writeFile(path, 'not json at all', 'utf8');
      const store = new Store(path);
      await store.load();
      assert.equal(store.isPrimed, false);
      assert.deepEqual(store.trackedEvents, {});
    });
  });

  it('discards state written by an incompatible version', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'state.json');
      await writeFile(
        path,
        JSON.stringify({ version: 999, primed: true, events: { a: tracked() }, posted: {} }),
        'utf8',
      );
      const store = new Store(path);
      await store.load();
      assert.equal(store.isPrimed, false);
      assert.deepEqual(store.trackedEvents, {});
    });
  });
});
