/**
 * Stale-while-revalidate for one value per session (the session cost): a read answers at once
 * with the last value worth keeping and starts one background refresh, so the picker and the
 * phone show a number on their first frame instead of waiting on the host's transcript read
 * (a cold long transcript takes up to the daemon's 15 s soft deadline, then answers `pending`).
 * With nothing kept yet a read waits for the real one, as before. A refresh that comes back
 * with a value not worth keeping (`pending`, `unavailable`) leaves the kept one in place.
 *
 * The kept values also live on disk across restarts (`keepOnDisk`). The server restarts about
 * 55 times a day (every land deploys), and each restart emptied this cache: on 2026-11-24/25,
 * 73 of the 77 cost reads over 1 s were a session's first read after a restart, waiting on the
 * host for a 120 to 290 MB transcript (10,000 to 25,000 responses), while the reads after it
 * answered in 1 to 8 ms. A value read back answers like any stale one: at once, with one refresh.
 */
import { keptCacheFile, readKeptJson, removeStaleTemps, type KeptCacheFile } from '../kept-cache-file.js';

export interface SwrCacheOptions<T> {
  /** The real read; may throw (a 404 stays the caller's to answer). */
  read: (id: string) => Promise<T>;
  /** A value worth answering later reads with. */
  keep: (value: T) => boolean;
  /** Entries kept, least recently used dropped first. */
  max: number;
  /** A kept value younger than this answers without starting a refresh. */
  freshMs: number;
  now?: () => number;
  onRefreshError?: (id: string, err: unknown) => void;
}

/** `stale`: the session changed after this value was read (a turn ended). */
interface Entry<T> { value: T; at: number; stale: boolean }

export class SwrCache<T> {
  private entries = new Map<string, Entry<T>>();
  private inflight = new Map<string, Promise<T>>();
  /** Turn ends seen per session: a read begun before the latest one lands already stale. */
  private changes = new Map<string, number>();
  private now: () => number;
  /** Called when the kept values changed (a value kept, one dropped): the disk copy asks for a write. */
  onChange: (() => void) | undefined;

  constructor(private opts: SwrCacheOptions<T>) {
    this.now = opts.now ?? Date.now;
  }

  /** The kept value at once (refreshing it when not fresh), or the real read when none is kept. */
  async get(id: string): Promise<T> {
    const hit = this.entries.get(id);
    if (hit) {
      // Most recently used goes last, so the cap drops the coldest session.
      this.entries.delete(id);
      this.entries.set(id, hit);
      if (hit.stale || this.now() - hit.at >= this.opts.freshMs) this.refresh(id);
      return hit.value;
    }
    return this.load(id);
  }

  /** The session changed (its turn ended): a kept value is stale, so the next read refreshes it. */
  invalidate(id: string): void {
    const hit = this.entries.get(id);
    if (!hit && !this.inflight.has(id)) return;
    if (hit) hit.stale = true;
    this.changes.set(id, (this.changes.get(id) ?? 0) + 1);
  }

  peek(id: string): T | undefined { return this.entries.get(id)?.value; }

  /** The kept values, least recently used first (what a disk copy writes). */
  kept(): [string, T][] { return [...this.entries].map(([id, e]) => [id, e.value]); }

  /**
   * Take back values a previous process kept (least recently used first). They are stale (the
   * first read answers with one and refreshes it) and older than anything kept since: a session
   * already kept or being read keeps its own, and the cap drops restored values first.
   */
  restore(values: [string, T][]): void {
    const live = [...this.entries];
    const known = new Set(this.entries.keys());
    this.entries.clear();
    for (const [id, value] of values.slice(-this.opts.max)) {
      if (known.has(id) || this.inflight.has(id)) continue;
      this.entries.set(id, { value, at: 0, stale: true });
    }
    for (const [id, e] of live) { this.entries.delete(id); this.entries.set(id, e); }
    this.trim();
  }

  clear(): void {
    this.entries.clear();
    this.changes.clear();
    this.inflight.clear();
  }

  /** One background refresh per session at a time; its failure keeps the kept value. */
  private refresh(id: string): void {
    if (this.inflight.has(id)) return;
    this.load(id).catch((err: unknown) => {
      if ((err as { statusCode?: number })?.statusCode === 404 && this.entries.delete(id)) this.onChange?.();
      this.opts.onRefreshError?.(id, err);
    });
  }

  private load(id: string): Promise<T> {
    const running = this.inflight.get(id);
    if (running) return running;
    const seen = this.changes.get(id) ?? 0;
    const p = this.opts.read(id).then((value) => {
      if (this.opts.keep(value)) {
        this.entries.delete(id);
        this.entries.set(id, { value, at: this.now(), stale: (this.changes.get(id) ?? 0) !== seen });
        this.trim();
        this.onChange?.();
      }
      return value;
    }).finally(() => { this.inflight.delete(id); });
    this.inflight.set(id, p);
    return p;
  }

  private trim(): void {
    while (this.entries.size > this.opts.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
      this.changes.delete(oldest);
    }
  }
}

export interface SwrDisk {
  /** Resolves when the boot's readback is done (it never rejects). */
  readback: Promise<void>;
  /** Write now what is asked and not yet written (server stop; the caller bounds the wait). */
  flush(): Promise<void>;
}

/**
 * Keep `cache`'s values in `file` (WALNUT_HOME/cache/, not synced): read back now, written at
 * most every `delayMs` after a change, the newest values that fit in `maxBytes`. A file that
 * does not parse or carries another version reads as empty; a value `valid` refuses is skipped.
 */
export function keepOnDisk<T>(cache: SwrCache<T>, opts: {
  file: string; version: number; maxBytes: number; delayMs: number;
  valid: (id: string, value: unknown) => value is T;
  onError: (err: unknown) => void;
}): SwrDisk {
  const file: KeptCacheFile = keptCacheFile(opts.file, { delayMs: opts.delayMs, onError: opts.onError });
  const body = (): string => {
    const rows: string[] = [];
    let bytes = 32;
    for (const [id, value] of cache.kept().reverse()) {
      const row = JSON.stringify([id, value]);
      if (bytes + row.length + 1 > opts.maxBytes) break;
      rows.push(row);
      bytes += row.length + 1;
    }
    return `{"v":${opts.version},"entries":[${rows.reverse().join(',')}]}`;
  };
  const readback = (async () => {
    const saved = await readKeptJson(opts.file, opts.version);
    await removeStaleTemps(opts.file);
    const entries = Array.isArray(saved?.entries) ? saved.entries : [];
    const values: [string, T][] = [];
    for (const row of entries) {
      if (Array.isArray(row) && typeof row[0] === 'string' && opts.valid(row[0], row[1])) values.push([row[0], row[1]]);
    }
    cache.restore(values);
  })().catch(opts.onError).finally(() => { cache.onChange = () => file.save(body); });
  return { readback, flush: () => file.flush() };
}
