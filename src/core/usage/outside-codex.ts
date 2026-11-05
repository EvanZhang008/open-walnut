/**
 * Codex runs Walnut did not start a session for (an agent's `codex exec`, the desktop app, the
 * terminal UI), read by each host's daemon from Codex's own rollout files and stored beside the
 * Walnut sessions' rows: engine codex, source session, the run's id as its session id. What a
 * run came from (who started it, where, on which account) goes to the origin table.
 *
 * A run Walnut started is `outside: false`; its session's own rows are not rewritten here, only
 * its account is noted. A child thread Codex made inside a Walnut run has no session record, so
 * it is stored here (still `outside: false`). A run that already has rows from Walnut's records
 * is never counted twice.
 */
import { log } from '../../logging/index.js';
import type { CodexOutsideScan } from '../../providers/codex-outside-core.js';
import type { CostRollup, DayBucket, RunOrigin } from './cost-rollup.js';
import { taskIdOfCwd } from './codex-account.js';

const PAGE_BUDGET_MS = 20_000;
const PAGE_TIMEOUT_MS = 45_000;
/** One host's pass stops here and is continued by the next collection, from where it ended. */
const PASS_BUDGET_MS = 5 * 60_000;
/** Re-read overlap for an incremental pass, so a run still being written is read again. */
const OVERLAP_MS = 2 * 60 * 60_000;
const MAX_KNOWN = 5000;
/** A file that cannot be read this many passes in a row stops holding the watermark back (counted per file). */
const MAX_RETRY_PASSES = 3;

export interface OutsideReader {
  readCodexOutside(params: { thresholds: number[]; byDay: { timeZone: string }; known: string[]; since?: string; cursor?: string; budgetMs?: number }, timeoutMs?: number): Promise<unknown | null>;
}

/** Every host whose Codex files are read: those with a collected session, any engine, and the configured ones. */
export function outsideHosts(...lists: Iterable<string>[]): string[] {
  return [...new Set(lists.flatMap(l => [...l]))];
}

export async function collectOutsideCodex(opts: {
  rollup: CostRollup; hosts: Iterable<string>; knownIds: (host: string) => string[]; timeZone: string;
  reader: (host: string) => OutsideReader; now?: () => Date; passBudgetMs?: number;
}): Promise<{ hosts: number; runs: number; skipped: number; failed: number }> {
  const { rollup } = opts;
  // The bands this whole call reads with: a change meanwhile leaves the host marked as read with the old ones.
  const key = rollup.key;
  const thresholds = JSON.parse(key || '[]') as number[];
  let runs = 0, skipped = 0, failed = 0, done = 0;
  for (const host of opts.hosts) {
    const now = opts.now ?? (() => new Date());
    const prior = rollup.outsideScan(host);
    // A pass a time budget cut short goes on from its cursor, with the window and start it had.
    const resume = rollup.outsideResume(host);
    const continued = resume && resume.key === key ? resume : undefined;
    const started = continued?.startedAt ?? now().toISOString();
    // The first read, and a read after the price bands changed, covers every file.
    const since = continued ? continued.since
      : prior.key === key && prior.at ? new Date(Date.parse(prior.at) - OVERLAP_MS).toISOString() : undefined;
    let cursor: string | undefined = continued?.cursor;
    let complete = false, supported = true;
    const unreadable = new Set<string>(continued?.unreadable ?? []);
    const deadline = Date.now() + (opts.passBudgetMs ?? PASS_BUDGET_MS);
    try {
      for (;;) {
        const scan = await opts.reader(host).readCodexOutside({ thresholds, byDay: { timeZone: opts.timeZone }, known: opts.knownIds(host).slice(0, MAX_KNOWN),
          ...(since ? { since } : {}), ...(cursor ? { cursor } : {}), budgetMs: PAGE_BUDGET_MS }, PAGE_TIMEOUT_MS) as CodexOutsideScan | null;
        if (!scan) { supported = false; break; } // a daemon without codex-outside-v1
        const stored = await storePage(rollup, host, scan);
        runs += stored.runs; skipped += stored.skipped;
        for (const name of scan.failed ?? []) unreadable.add(name);
        if (!scan.next) { complete = true; break; }
        cursor = scan.next;
        if (Date.now() >= deadline) break;
      }
    } catch (error) {
      failed++;
      log.usage.warn('outside codex read failed', { host, error: String(error) });
      continue;
    }
    if (complete) {
      // A file that could not be read keeps the watermark where it was, so the next pass reads it again; a file that
      // fails MAX_RETRY_PASSES passes in a row (counted per file) is left behind.
      const before = rollup.outsideMisses(host);
      const misses: Record<string, number> = {};
      for (const name of unreadable) misses[name] = (before[name] ?? 0) + 1;
      const holding = Object.entries(misses).filter(([, n]) => n < MAX_RETRY_PASSES).map(([name]) => name);
      rollup.setOutsideResume(host, undefined);
      rollup.setOutsideMisses(host, Object.fromEntries(Object.entries(misses).filter(([, n]) => n < MAX_RETRY_PASSES)));
      if (holding.length) {
        log.usage.warn('outside codex files unreadable', { host, files: holding.slice(0, 5) });
        failed++;
      } else { rollup.markOutsideScanned(host, started, key); done++; }
    }
    else if (supported && cursor) { // the next pass goes on from here, remembering what it could not read
      rollup.setOutsideResume(host, { cursor, since, startedAt: started, key, ...(unreadable.size ? { unreadable: [...unreadable].slice(0, 20) } : {}) });
    }
  }
  return { hosts: done, runs, skipped, failed };
}

async function storePage(rollup: CostRollup, host: string, scan: CodexOutsideScan): Promise<{ runs: number; skipped: number }> {
  const dateOf = new Intl.DateTimeFormat('en-CA', { timeZone: scan.byDay.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const origins: RunOrigin[] = [];
  const writes: { entry: CodexOutsideScan['entries'][number] }[] = [];
  for (const e of scan.entries) {
    // A run Walnut started says so in its first line (originator); everything else is outside Walnut, also one the
    // automatic import gave a session record (a terminal run Walnut found), whose rows are then not stored again.
    const hasRows = e.counted && rollup.hasOwnSession(host, e.sessionId, 'codex');
    const ownRecord = !e.counted || hasRows;
    const outside = !e.walnut && (e.originator !== '' || !ownRecord);
    const stored = e.counted && !hasRows;
    origins.push({ host, sessionId: e.sessionId, originator: e.originator, provider: e.provider, cwd: e.cwd, outside, stored, firstAt: e.firstAt ?? '', lastAt: e.lastAt ?? '' });
    if (stored) writes.push({ entry: e });
  }
  // The origin goes down first: rows with no origin behind them would read as a Walnut session's own, and never be updated.
  rollup.recordOrigins(origins);
  for (const { entry: e } of writes) {
    const buckets: DayBucket[] = (e.buckets ?? []).flatMap(b => {
      const day = b.day ?? (b.lastAt ? dateOf.format(Date.parse(b.lastAt)) : undefined);
      return day ? [{ day, model: b.model, band: b.band, responses: b.responses, input: b.input, output: b.output, cacheRead: b.cacheRead,
        cacheWrite5m: b.cacheWrite5m, cacheWrite1h: b.cacheWrite1h, cacheWrite: b.cacheWrite }] : [];
    });
    await rollup.replaceSession({ sessionId: e.sessionId, host, engine: 'codex', taskId: taskIdOfCwd(e.cwd) ?? null, source: 'session' }, buckets, { byDay: true });
  }
  return { runs: writes.length, skipped: scan.entries.length - writes.length };
}
