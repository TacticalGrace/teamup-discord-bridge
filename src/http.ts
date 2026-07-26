import { log } from './logger.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    url: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 400)}`);
    this.name = 'HttpError';
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RetryOptions {
  attempts?: number;
  timeoutMs?: number;
  /** Called with the response before the status check; return ms to wait, or null. */
  retryAfterMs?: (response: Response) => number | null;
}

/**
 * fetch() with a timeout and exponential backoff on network errors, 429, and
 * 5xx. Other 4xx responses fail immediately.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<Response> {
  const attempts = options.attempts ?? 4;
  const timeoutMs = options.timeoutMs ?? 20_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });

      if (response.ok) return response;

      const retryable = response.status === 429 || response.status >= 500;
      const body = await response.text().catch(() => '');

      if (!retryable || attempt === attempts) {
        throw new HttpError(response.status, body, url);
      }

      const hinted = options.retryAfterMs?.(response) ?? retryAfterFromHeader(response);
      const backoff = hinted ?? Math.min(30_000, 500 * 2 ** (attempt - 1));
      log.warn(`${response.status} from ${redact(url)}, retrying in ${backoff}ms`);
      await sleep(backoff);
      continue;
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof HttpError) throw error;
      lastError = error;
      if (attempt === attempts) break;
      const backoff = Math.min(30_000, 500 * 2 ** (attempt - 1));
      log.warn(`Request to ${redact(url)} failed (${String(error)}), retrying in ${backoff}ms`);
      await sleep(backoff);
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function retryAfterFromHeader(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null;
}

/** Strips webhook tokens and API keys from URLs before logging. */
export function redact(url: string): string {
  return url.replace(/(webhooks\/\d+\/)[\w-]+/, '$1***').replace(/([?&](?:api|token)[^=]*=)[^&]+/gi, '$1***');
}
