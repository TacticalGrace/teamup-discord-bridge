import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { log } from './logger.js';

const STATE_VERSION = 1;
const POSTED_RETENTION_DAYS = 60;
const EVENT_RETENTION_DAYS = 30;

export interface TrackedEvent {
  fingerprint: string;
  title: string;
  /** ISO instant of the event start, used for pruning and cancellations. */
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  url: string | null;
  lastSeen: string;
}

interface StateData {
  version: number;
  /**
   * False until a poll has recorded the existing calendar. Prevents a cold
   * start from announcing every event already present.
   */
  primed: boolean;
  events: Record<string, TrackedEvent>;
  posted: Record<string, string>;
}

function emptyState(): StateData {
  return { version: STATE_VERSION, primed: false, events: {}, posted: {} };
}

export class Store {
  private data: StateData = emptyState();

  constructor(private readonly filePath: string) {}

  get isPrimed(): boolean {
    return this.data.primed;
  }

  markPrimed(): void {
    this.data.primed = true;
  }

  get trackedEvents(): Record<string, TrackedEvent> {
    return this.data.events;
  }

  getEvent(id: string): TrackedEvent | undefined {
    return this.data.events[id];
  }

  putEvent(id: string, event: TrackedEvent): void {
    this.data.events[id] = event;
  }

  deleteEvent(id: string): void {
    delete this.data.events[id];
  }

  hasPosted(key: string): boolean {
    return this.data.posted[key] !== undefined;
  }

  markPosted(key: string, at: Date = new Date()): void {
    this.data.posted[key] = at.toISOString();
  }

  async load(): Promise<void> {
    const path = resolve(this.filePath);
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StateData>;
      if (parsed.version !== STATE_VERSION) {
        log.warn(`State file version ${String(parsed.version)} != ${STATE_VERSION}; starting fresh`);
        this.data = emptyState();
        return;
      }
      this.data = {
        version: STATE_VERSION,
        primed: parsed.primed === true,
        events: parsed.events ?? {},
        posted: parsed.posted ?? {},
      };
      log.info(
        `Loaded state from ${path}: ${Object.keys(this.data.events).length} tracked event(s), primed=${this.data.primed}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        log.info(`No state file at ${path} — this run will prime without announcing.`);
        this.data = emptyState();
        return;
      }
      log.error(`Could not read state at ${path}; starting fresh`, error);
      this.data = emptyState();
    }
  }

  async save(): Promise<void> {
    this.prune();
    const path = resolve(this.filePath);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    await writeFile(temp, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(temp, path);
    log.debug(`Saved state to ${path}`);
  }

  private prune(): void {
    const now = Date.now();

    for (const [key, stamp] of Object.entries(this.data.posted)) {
      const age = now - Date.parse(stamp);
      if (Number.isNaN(age) || age > POSTED_RETENTION_DAYS * 86_400_000) {
        delete this.data.posted[key];
      }
    }

    for (const [id, event] of Object.entries(this.data.events)) {
      const age = now - Date.parse(event.start);
      if (Number.isNaN(age) || age > EVENT_RETENTION_DAYS * 86_400_000) {
        delete this.data.events[id];
      }
    }
  }
}
