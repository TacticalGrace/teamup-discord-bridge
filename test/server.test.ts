import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { icsDownloadUrl, toLinkEvent } from '../src/calendar-links.js';
import type { Config } from '../src/config.js';
import { startServer } from '../src/server.js';
import { at, makeConfig, makeEvent } from './helpers.js';

describe('HTTP endpoints', () => {
  let server: Server;
  let base: string;
  let config: Config;
  let runs = 0;

  before(async () => {
    // Port 0 lets the OS pick a free port, so the suite cannot collide.
    config = makeConfig({ port: 0, adminToken: 'secret-token' });
    server = startServer(config, {
      status: () => ({ lastRunAt: null, lastRunOk: null, lastError: null, runs }),
      triggerRun: async () => {
        runs += 1;
      },
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
    config = { ...config, publicBaseUrl: base };
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('GET /healthz', () => {
    it('reports service status', async () => {
      const response = await fetch(`${base}/healthz`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.service, 'teamup-discord-bridge');
      assert.equal(body.ok, true);
    });

    it('is also served at the root', async () => {
      assert.equal((await fetch(`${base}/`)).status, 200);
    });
  });

  describe('GET /event.ics', () => {
    const event = makeEvent({ id: 'endpoint', title: 'General Meeting', start: at('2026-08-06T18:30') });

    it('serves a downloadable calendar file', async () => {
      const response = await fetch(icsDownloadUrl(toLinkEvent(event), config) as string);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/calendar/);
      assert.equal(
        response.headers.get('content-disposition'),
        'attachment; filename="general-meeting.ics"',
      );

      const body = await response.text();
      assert.ok(body.startsWith('BEGIN:VCALENDAR'));
      assert.match(body, /SUMMARY:General Meeting/);
    });

    it('rejects an altered signature', async () => {
      const url = new URL(icsDownloadUrl(toLinkEvent(event), config) as string);
      url.searchParams.set('s', 'aaaaaaaaaaaaaaaaaaaaaa');
      assert.equal((await fetch(url)).status, 403);
    });

    it('rejects a missing payload', async () => {
      assert.equal((await fetch(`${base}/event.ics`)).status, 400);
    });
  });

  describe('POST /run', () => {
    it('rejects a bad token', async () => {
      const response = await fetch(`${base}/run?token=wrong`, { method: 'POST' });
      assert.equal(response.status, 401);
    });

    it('accepts the configured token', async () => {
      const before_ = runs;
      const response = await fetch(`${base}/run?token=secret-token`, { method: 'POST' });
      assert.equal(response.status, 202);
      // The handler responds before the run finishes; give it a tick.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(runs, before_ + 1);
    });

    it('accepts the token from a header', async () => {
      const response = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'x-admin-token': 'secret-token' },
      });
      assert.equal(response.status, 202);
    });
  });

  it('returns 404 for unknown routes', async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

describe('POST /run without an admin token', () => {
  let server: Server;
  let base: string;

  before(async () => {
    const config = makeConfig({ port: 0, adminToken: null });
    server = startServer(config, {
      status: () => ({ lastRunAt: null, lastRunOk: null, lastError: null, runs: 0 }),
      triggerRun: async () => {},
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('is not exposed at all', async () => {
    assert.equal((await fetch(`${base}/run?token=anything`, { method: 'POST' })).status, 404);
  });
});
