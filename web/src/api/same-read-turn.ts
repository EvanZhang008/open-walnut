/**
 * Identical reads take turns: a GET of a URL that the page is already reading waits until that
 * read ends, so one URL never holds more than one of the page's connections. It still starts
 * after the earlier one ended, so it sees whatever changed meanwhile.
 *
 * 2026-11-22, live: the page's few connections were held for 60 to 137 s by the same read sent
 * again and again (4 copies of one session's permission-decisions at once; a lead's Threads 2 to
 * 4 at a time the day before), and every other request waited out its queue time and was
 * rejected. A window in the background runs its timers late, so a read stuck on the network
 * keeps its connection far past its own timeout; copies of it must not pile up behind it.
 */

interface Waiter { go: () => void }

/**
 * A read that holds its answer on purpose (a long poll, a stream): two of them in flight together
 * is by design, so they never take turns (the shape the server's real-use monitor reads too).
 */
export function isLongPollPath(path: string): boolean {
  return /[?&](?:wait|wait_ms|waitMs|wait_for|timeout_ms|long_poll|follow)=/i.test(path)
    || /\/(?:wait|events|stream)(?:\/|$)/.test(path.split('?')[0] ?? '');
}

const lines = new Map<string, Waiter[]>();

export interface TurnWait {
  /** When the caller stops waiting (its admission deadline, Date.now() based). */
  deadline: number;
  /** How long that wait was, for the log line. */
  waitMs: number;
  /** `GET /path`, for the log line. */
  label: string;
  signal?: AbortSignal;
  /** What holds the page's connections now, for the log line. */
  holding: () => string[];
}

/**
 * This URL's turn. Free: the release at once, in the same tick (a read enters the connection
 * queue as it did, synchronously). Taken: a promise of the release once the reads ahead ended;
 * it rejects with a TimeoutError at the deadline and an AbortError on the caller's abort, never
 * holding the turn then. The caller calls the release once its read ended, whatever the outcome.
 */
export function sameReadTurn(key: string, wait: TurnWait): (() => void) | Promise<() => void> {
  if (wait.signal?.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  let line = lines.get(key);
  if (!line) { line = []; lines.set(key, line); }
  const mine = line;
  let released = false;
  const me: Waiter = { go: () => undefined };
  const release = () => {
    if (released) return;
    released = true;
    const at = mine.indexOf(me);
    if (at >= 0) mine.splice(at, 1);
    if (!mine.length) { if (lines.get(key) === mine) lines.delete(key); return; }
    if (at === 0) mine[0].go();
  };
  mine.push(me);
  if (mine.length === 1) return release;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      wait.signal?.removeEventListener('abort', onAbort);
    };
    // A waiter that leaves before its turn: the head is someone else, so nobody else moves.
    const drop = () => {
      cleanup();
      released = true;
      const at = mine.indexOf(me);
      if (at > 0) mine.splice(at, 1);
    };
    const onAbort = () => { drop(); reject(new DOMException('The operation was aborted.', 'AbortError')); };
    me.go = () => { cleanup(); resolve(release); };
    wait.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      drop();
      // A warning, not a page error: the read on its way still answers (or reports its own failure).
      console.warn(`[api] ${wait.label} gave up after ${wait.waitMs}ms waiting for the same read in flight`, { holding: wait.holding() });
      reject(new DOMException(`Request queued ${wait.waitMs}ms behind the same read in flight`, 'TimeoutError'));
    }, Math.max(0, wait.deadline - Date.now()));
  });
}

/** A caller's own copy of a shared answer, so no caller can change another's (shared-get.ts too). */
export function copyOf<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/** How far ahead a read's lane is (a read never waits behind one of a lower lane). */
const LANE_RANK: Record<string, number> = { low: 0, normal: 1, urgent: 2, interactive: 2 };
const rank = (p: string) => LANE_RANK[p] ?? 1;
/** A read of a URL the page is making now: its answer, whether it has left the queue, and whether its caller can cancel it. */
interface SharedAttempt { priority: string; sent: boolean; cancellable: boolean; result: Promise<unknown>; onSent: Array<() => void> }
/** The read of each URL holding its turn, and the first one waiting for the next. */
const readHeads = new Map<string, SharedAttempt>();
const readNext = new Map<string, SharedAttempt>();

/** A caller's copy of an answer it joined (its own copy, as with a request of its own), ended by its own abort. */
function joined<T>(result: Promise<unknown>, signal?: AbortSignal): Promise<T> {
  const copy = result.then((value) => copyOf(value) as T);
  if (!signal) return copy;
  if (signal.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    copy.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Join a read not sent yet: the caller hears when it leaves the queue (its onDispatch), as with its own request. */
function join<T>(attempt: SharedAttempt, extra: ReadCall | undefined): Promise<T> {
  if (extra?.onDispatch) attempt.onSent.push(extra.onDispatch);
  return joined<T>(attempt.result, extra?.signal);
}

/**
 * One GET of `path` in the page at a time (2026-11-22: copies of the same read held the page's
 * connections for minutes). A read not sent yet answers as a new one would, so a caller joins it
 * (shared-read.ts joinSent:false); one already sent is waited for, and the first caller waiting
 * is joined the same way. A read of a higher lane never waits behind a lower one: it goes alone.
 * A read its caller can cancel is never joined (its abort would end the others).
 */
export interface SameReadDeps {
  /** The caller's queue budget for this lane (client.ts fetchAdmission). */
  admission: (priority: string) => { deadline: number; waitMs: number };
  /** What holds the page's connections now (client.ts holdingSlots). */
  holding: () => string[];
}

/** What sameRead reads of a call's options. */
interface ReadCall { signal?: AbortSignal; onDispatch?: () => void }

export function sameRead<T, E extends ReadCall>(path: string, priority: string, extra: E | undefined, send: (extra: E | undefined) => Promise<T>, deps: SameReadDeps): Promise<T> {
  const head = readHeads.get(path);
  const next = readNext.get(path);
  // A read that claims the kept connection is as urgent as an interactive one.
  if ((extra as { lane?: { interactive?: boolean } } | undefined)?.lane?.interactive) priority = 'interactive';
  if (head && (rank(priority) > rank(head.priority) || (next && rank(priority) > rank(next.priority)))) return send(extra);
  const joinable = (a: SharedAttempt | undefined) => !!a && !a.cancellable && rank(a.priority) >= rank(priority);
  if (head && !head.sent && joinable(head)) return join<T>(head, extra);
  if (head && joinable(next)) return join<T>(next!, extra);
  const me: SharedAttempt = { priority, sent: false, cancellable: !!extra?.signal, result: Promise.resolve(), onSent: [] };
  // Only a read others may join waits as the next one (a cancellable one would make the copies queue again).
  if (head && !next && !me.cancellable) readNext.set(path, me);
  const run = async (): Promise<T> => {
    const { deadline, waitMs } = deps.admission(priority);
    const turn = sameReadTurn(path, { deadline, waitMs, label: `GET ${path}`, signal: extra?.signal, holding: deps.holding });
    // A free turn is taken in this tick: the read reaches the connection queue as before.
    let endTurn: () => void;
    try { endTurn = turn instanceof Promise ? await turn : turn; } finally { if (readNext.get(path) === me) readNext.delete(path); }
    readHeads.set(path, me);
    try {
      return await send({ ...extra, onDispatch: () => { me.sent = true; extra?.onDispatch?.(); for (const f of me.onSent.splice(0)) f(); } } as E);
    } finally {
      if (readHeads.get(path) === me) readHeads.delete(path);
      endTurn();
    }
  };
  const result = run();
  me.result = result;
  return result;
}

/** Test hook: how many reads of each URL are in flight or waiting. */
export function sameReadLines(): Record<string, number> {
  return Object.fromEntries([...lines].map(([k, v]) => [k, v.length]));
}
