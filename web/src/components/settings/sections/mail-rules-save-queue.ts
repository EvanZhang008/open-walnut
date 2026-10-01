/**
 * The Mail rules panel's write queue: at most ONE `PUT /rules` in flight, each chained on the
 * `fileRev` the previous one returned, and a burst of Move up / Move down folded into one write.
 *
 * Why a queue (spec 12, C63): every save carries `baseRev`, the file's revision the client last saw,
 * and the server answers 409 `changed` when it does not match. Two quick clicks sent side by side both
 * carry the revision from before the first, so the second is refused as "changed on disk" although the
 * only writer was this very panel. Chained, the second click's write carries the first one's answer.
 *
 * Coalescing: a move asks with `coalesce: true`, which (re)starts a 600 ms clock; only the newest doc
 * is sent when it runs out, so three clicks are one write and the `.bak` keeps the pre-edit file.
 * Everything else (an edit, a toggle, a delete) sends right away, after whatever is in flight.
 */
import type { MailRule } from '@/api/mail-groups';

export const COALESCE_MS = 600;

export interface RulesDoc { groups: string[]; rules: MailRule[] }

export interface RulesSaveResult { rulesRev: string; fileRev: string }

export interface RulesSaveQueueDeps {
  put: (body: RulesDoc & { baseRev: string }) => Promise<RulesSaveResult>;
  onSaved?: (result: RulesSaveResult & { doc: RulesDoc }) => void;
  onError?: (error: unknown, doc: RulesDoc) => void;
  coalesceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface RulesSaveQueue {
  /** The file revision the panel just read (`GET /rules`); the next write chains on it. */
  setBase: (fileRev: string) => void;
  base: () => string | null;
  save: (doc: RulesDoc, options?: { coalesce?: boolean }) => Promise<RulesSaveResult>;
  /** Sends a waiting coalesced doc now and resolves when nothing is left to send. */
  flush: () => Promise<void>;
  /** A write is waiting or in flight. */
  busy: () => boolean;
  /** Drops a waiting doc (its callers are rejected) and stops the clock. */
  cancel: () => void;
}

interface Waiter { resolve: (result: RulesSaveResult) => void; reject: (error: unknown) => void }

export class RulesQueueCancelled extends Error {
  constructor() {
    super('The save was cancelled.');
    this.name = 'RulesQueueCancelled';
  }
}

export function createRulesSaveQueue(deps: RulesSaveQueueDeps): RulesSaveQueue {
  const coalesceMs = deps.coalesceMs ?? COALESCE_MS;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let baseRev: string | null = null;
  let pendingDoc: RulesDoc | null = null;
  let waiters: Waiter[] = [];
  let timer: unknown = null;
  let running: Promise<void> | null = null;
  /** A PUT is on the wire. Cleared BEFORE its callers hear back, so a caller asking `busy()` from its
   * own `.then` sees the truth rather than the tail of the loop that resolved it. */
  let inflight = false;

  const stopClock = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const drain = async (): Promise<void> => {
    while (pendingDoc && timer === null) {
      const doc = pendingDoc;
      const mine = waiters;
      pendingDoc = null;
      waiters = [];
      if (baseRev === null) {
        const error = new Error('The rules file has not been read yet.');
        deps.onError?.(error, doc);
        for (const one of mine) one.reject(error);
        continue;
      }
      inflight = true;
      try {
        const result = await deps.put({ ...doc, baseRev }).finally(() => { inflight = false; });
        baseRev = result.fileRev;
        deps.onSaved?.({ ...result, doc });
        for (const one of mine) one.resolve(result);
      } catch (error) {
        deps.onError?.(error, doc);
        for (const one of mine) one.reject(error);
      }
    }
  };

  const pump = (): Promise<void> => {
    if (running) return running;
    running = drain().finally(() => {
      running = null;
      // A save made from a caller's own `.then` lands after the loop's last check: send it too.
      if (pendingDoc && timer === null) void pump();
    });
    return running;
  };

  return {
    setBase: (fileRev) => { baseRev = fileRev; },
    base: () => baseRev,
    save: (doc, options = {}) => new Promise<RulesSaveResult>((resolve, reject) => {
      pendingDoc = doc;
      waiters.push({ resolve, reject });
      stopClock();
      if (options.coalesce) {
        timer = setTimer(() => { timer = null; void pump(); }, coalesceMs);
      } else {
        void pump();
      }
    }),
    flush: async () => {
      stopClock();
      // `running` may finish and a new doc arrive meanwhile; loop until idle.
      while (running || pendingDoc) await pump();
    },
    busy: () => inflight || pendingDoc !== null || timer !== null,
    cancel: () => {
      stopClock();
      const mine = waiters;
      pendingDoc = null;
      waiters = [];
      for (const one of mine) one.reject(new RulesQueueCancelled());
    },
  };
}
