import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runDemo } from '../src/demo.js';
import { makeConfig, withTempDir } from './helpers.js';

/** Captures webhook posts without touching the network. */
function captureWebhook(bodies: string[]): typeof fetch {
  let posted = 0;
  return (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response('', { status: 204 });
    posted += 1;
    bodies.push(String(init?.body ?? ''));
    return new Response(JSON.stringify({ id: `message-${posted}` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('runDemo', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // The walkthrough is rehearsed before it is performed, so the second run is
  // the one that matters. Carried-over state used to suppress the digest and a
  // reminder, leaving the live run quieter than the rehearsal.
  it('tells the same story on a re-run', async () => {
    await withTempDir(async (dir) => {
      const config = makeConfig({ stateFile: join(dir, 'state.json') });

      const first: string[] = [];
      globalThis.fetch = captureWebhook(first);
      await runDemo(config, 0);

      const second: string[] = [];
      globalThis.fetch = captureWebhook(second);
      await runDemo(config, 0);

      assert.equal(first.length, 6, 'the walkthrough posts six messages');
      assert.equal(second.length, first.length, 'a re-run must post the same messages');
    });
  });

  it('posts the weekly digest on every run', async () => {
    await withTempDir(async (dir) => {
      const config = makeConfig({ stateFile: join(dir, 'state.json') });
      const digests = (bodies: string[]): number =>
        bodies.filter((body) => body.includes(config.digest.intro)).length;

      const first: string[] = [];
      globalThis.fetch = captureWebhook(first);
      await runDemo(config, 0);

      const second: string[] = [];
      globalThis.fetch = captureWebhook(second);
      await runDemo(config, 0);

      assert.equal(digests(first), 1);
      assert.equal(digests(second), 1, 'step 4 went silent on the second run');
    });
  });
});
