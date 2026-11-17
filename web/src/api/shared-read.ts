import { fetchLaneRaised, type FetchLane } from './client';

/** One caller of a shared read. */
export interface SharedReadCaller {
  /** The caller's claim to the connection kept for what the person waits on (api/client.ts).
   *  The read is interactive while any caller still waiting claims it; a claim raised while the
   *  read waits counts at once. A caller that leaves takes its claim along. */
  lane?: FetchLane;
  /** The caller stops caring. It still gets the shared answer (callers guard with their own
   *  `cancelled` flags); the request itself is cancelled once no caller waits on it. */
  signal?: AbortSignal;
}

export interface SharedReadPolicy {
  /** Join a request already on the wire. Off for a read whose callers need state from after
   *  their call: they join only a request not sent yet, which answers the same as a new one. */
  joinSent: boolean;
  /** The request lets first screens waiting for the kept slot go first (FetchLane.yields). */
  yields?: boolean;
  /** A caller that leaves leaves its claim behind: once someone waited on the read, it keeps the
   *  kept slot for the callers still waiting (the history read). */
  keepClaims?: boolean;
}

/** Starts the request: `markSent` once it leaves the client's queue (apiGet's onDispatch). */
export type SharedReadStart<T> = (signal: AbortSignal, lane: FetchLane, markSent: () => void) => Promise<T>;

interface Entry<T> {
  promise: Promise<T>;
  controller: AbortController;
  claims: FetchLane[];
  sent: boolean;
  waiting: number;
}

/**
 * One in-flight request per key, served to every caller asking for it at the time: the session
 * history read and the session record read (2026-11-17: the panel and the stream read the same
 * record twice per open; the panel and the chat the same history). The request is cancelled only
 * once every caller has left, after the commit: an effect that re-runs (cleanup, then the same
 * read) takes it back instead of sending it again.
 */
export class SharedReads<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly policy: SharedReadPolicy) {}

  read(key: string, start: SharedReadStart<T>, caller: SharedReadCaller = {}): Promise<T> {
    const known = this.entries.get(key);
    const live = known && (this.policy.joinSent || !known.sent) ? known : this.create(key, start);
    live.waiting++;
    const claim = caller.lane;
    if (claim) {
      const wasInteractive = live.claims.some((c) => c.interactive);
      live.claims.push(claim);
      // A claim that joins a read still waiting looks for the kept slot again.
      if (claim.interactive && !wasInteractive && !live.sent) fetchLaneRaised();
    }
    const signal = caller.signal;
    if (!signal) return live.promise;
    const leave = () => {
      live.waiting--;
      if (claim && !this.policy.keepClaims) live.claims = live.claims.filter((c) => c !== claim);
      if (live.waiting > 0) return;
      queueMicrotask(() => {
        if (live.waiting > 0) return;
        // Drop the entry BEFORE aborting: a caller arriving before the rejection settles
        // must get a new request, never the doomed promise.
        if (this.entries.get(key) === live) this.entries.delete(key);
        live.controller.abort();
      });
    };
    if (signal.aborted) leave();
    else {
      signal.addEventListener('abort', leave, { once: true });
      // A long-lived signal (one per stream session) must not collect a listener per read.
      void live.promise.then(() => signal.removeEventListener('abort', leave), () => signal.removeEventListener('abort', leave));
    }
    return live.promise;
  }

  private create(key: string, start: SharedReadStart<T>): Entry<T> {
    const entry: Entry<T> = { promise: undefined as unknown as Promise<T>, controller: new AbortController(), claims: [], sent: false, waiting: 0 };
    const lane: FetchLane = { get interactive() { return entry.claims.some((c) => c.interactive); } };
    if (this.policy.yields) lane.yields = true;
    // Identity-guarded settle-delete: a successor (after an abort, or a newer read because this
    // one was sent) may hold the key before this one settles.
    entry.promise = start(entry.controller.signal, lane, () => { entry.sent = true; })
      .finally(() => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    // Settled by its callers; an unwatched rejection (every caller left) is not an error.
    entry.promise.catch(() => {});
    this.entries.set(key, entry);
    return entry;
  }
}
