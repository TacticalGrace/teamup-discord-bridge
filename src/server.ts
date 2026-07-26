import { createServer, type Server } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { buildIcsDocument, decodeLinkEvent, icsFilename } from './calendar-links.js';
import type { Config } from './config.js';
import { log } from './logger.js';

/** Stable UID per event link so re-adding updates rather than duplicates. */
function uidFor(encoded: string): string {
  return createHash('sha1').update(encoded).digest('hex').slice(0, 24);
}

export interface ServerStatus {
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  lastError: string | null;
  runs: number;
}

export interface ServerHooks {
  status(): ServerStatus;
  triggerRun(): Promise<void>;
}

/**
 * Render web services must bind $PORT. Free instances sleep after 15 minutes
 * without traffic; /healthz is the endpoint an uptime pinger polls.
 */
export function startServer(config: Config, hooks: ServerHooks): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/')) {
      const status = hooks.status();
      json(res, 200, {
        service: 'teamup-discord-bridge',
        ok: status.lastRunOk !== false,
        dryRun: config.dryRun,
        timezone: config.timezone,
        pollIntervalMinutes: config.pollIntervalMinutes,
        ...status,
      });
      return;
    }

    // Serves a calendar file, the only route to Apple Calendar, Outlook
    // desktop, and Thunderbird.
    if (req.method === 'GET' && url.pathname === '/event.ics') {
      const d = url.searchParams.get('d');
      const signature = url.searchParams.get('s');
      if (d === null || signature === null) {
        json(res, 400, { error: 'Missing event data' });
        return;
      }

      const payload = decodeLinkEvent(d, signature, config.linkSecret);
      if (payload === null) {
        json(res, 403, { error: 'Bad or unsigned event link' });
        return;
      }

      const body = buildIcsDocument(payload, {
        timezone: config.timezone,
        uid: `${uidFor(d)}@teamup-discord-bridge`,
        orgName: config.orgName,
      });
      res.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${icsFilename(payload.t)}"`,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'public, max-age=300',
      });
      res.end(body);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/run') {
      if (config.adminToken === null) {
        json(res, 404, { error: 'Manual runs are disabled; set ADMIN_TOKEN to enable them.' });
        return;
      }
      const provided = url.searchParams.get('token') ?? req.headers['x-admin-token'];
      if (typeof provided !== 'string' || !constantTimeEquals(provided, config.adminToken)) {
        json(res, 401, { error: 'Bad token' });
        return;
      }
      hooks
        .triggerRun()
        .then(() => log.info('Manual run finished'))
        .catch((error: unknown) => log.error('Manual run failed', error));
      json(res, 202, { accepted: true });
      return;
    }

    json(res, 404, { error: 'Not found' });
  });

  server.listen(config.port, () => log.info(`Listening on :${config.port}`));
  return server;
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
