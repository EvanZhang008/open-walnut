/**
 * Stale-while-revalidate for one value per session (the session cost): a read answers at once
 * with the last value worth keeping and starts one background refresh, so the picker and the
 * phone show a number on their first frame instead of waiting on the host's transcript read
 * (a cold long transcript takes up to the daemon's 15 s soft deadline, then answers `pending`).
 * With nothing kept yet a read waits for the real one, as before. A refresh that comes back
 * with a value not worth keeping (`pending`, `unavailable`) leaves the kept one in place.
 */

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

  clear(): void {
    this.entries.clear();
    this.changes.clear();
    this.inflight.clear();
  }

  /** One background refresh per session at a time; its failure keeps the kept value. */
  private refresh(id: string): void {
    if (this.inflight.has(id)) return;
    this.load(id).catch((err: unknown) => {
      if ((err as { statusCode?: number })?.statusCode === 404) this.entries.delete(id);
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
        while (this.entries.size > this.opts.max) {
          const oldest = this.entries.keys().next().value as string;
          this.entries.delete(oldest);
          this.changes.delete(oldest);
        }
      }
      return value;
    }).finally(() => { this.inflight.delete(id); });
    this.inflight.set(id, p);
    return p;
  }
}
