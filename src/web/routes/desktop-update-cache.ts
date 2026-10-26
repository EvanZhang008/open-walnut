/**
 * The last answer of the local daemon's `desktop.updateStatus`, for
 * GET /api/system/desktop-update.
 *
 * The page polls every 30 s and the route used to wait for the daemon each
 * time. The daemon's own work is small (one file read and a 30 to 45 ms helper
 * process), but it runs on the daemon's one thread, behind transcript parses:
 * over 4 days (2026-10-22 to 25) the route took p50 86 ms, p99 3.1 s, and 597
 * requests took over 1 s, six of them the full 7 to 8 s, each holding one of
 * the browser's six connections. The update it reports changes once in hours,
 * so the route now answers from the last reply and asks the daemon again in the
 * background (one ask at a time). Two cases still wait, briefly:
 *  - no reply yet (a fresh server): up to COLD_WAIT_MS, then empty;
 *  - a restart was asked for in the last RESTART_LIVE_MS: the page polls every
 *    2 s for `restarting` / `error` and must see them as they happen.
 */

export interface DesktopUpdateAnswer {
  available: boolean;
  token: string | null;
  version: string | null;
  restarting?: boolean;
  error?: string;
  windows?: number;
}

export const EMPTY_DESKTOP_UPDATE: DesktopUpdateAnswer = { available: false, token: null, version: null };

/** An answer this old is refreshed in the background on the next request. */
export const REFRESH_AFTER_MS = 10_000;
/** A fresh server waits this long for its first answer. */
export const COLD_WAIT_MS = 1_000;
/** After a restart request, every request waits for a live answer this long. */
export const RESTART_LIVE_MS = 60_000;

type Ask = () => Promise<DesktopUpdateAnswer>;

export interface DesktopUpdateCache {
  /** The answer for one request. `owner` identifies the daemon connection: a
   *  different one (a daemon restart) never serves the old one's answer. */
  get(owner: object, ask: Ask): Promise<DesktopUpdateAnswer>;
  /** A restart was requested: answer live for a while. */
  noteRestart(): void;
}

export function createDesktopUpdateCache(now: () => number = Date.now): DesktopUpdateCache {
  let cached: { owner: object; answer: DesktopUpdateAnswer; at: number } | null = null;
  let inflight: { owner: object; promise: Promise<DesktopUpdateAnswer> } | null = null;
  let restartAt = -Infinity;

  const refresh = (owner: object, ask: Ask): Promise<DesktopUpdateAnswer> => {
    if (inflight && inflight.owner === owner) return inflight.promise;
    const promise = ask()
      .then((answer) => {
        cached = { owner, answer, at: now() };
        return answer;
      })
      .catch(() => EMPTY_DESKTOP_UPDATE)
      .finally(() => { if (inflight?.promise === promise) inflight = null; });
    inflight = { owner, promise };
    return promise;
  };

  const within = (promise: Promise<DesktopUpdateAnswer>, ms: number): Promise<DesktopUpdateAnswer> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<DesktopUpdateAnswer>((resolve) => {
      timer = setTimeout(() => resolve(EMPTY_DESKTOP_UPDATE), ms);
      timer.unref?.();
    });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  };

  return {
    get(owner, ask) {
      if (now() - restartAt < RESTART_LIVE_MS) return refresh(owner, ask);
      const hit = cached && cached.owner === owner ? cached : null;
      if (!hit) return within(refresh(owner, ask), COLD_WAIT_MS);
      if (now() - hit.at >= REFRESH_AFTER_MS) void refresh(owner, ask);
      return Promise.resolve(hit.answer);
    },
    noteRestart() {
      restartAt = now();
    },
  };
}
