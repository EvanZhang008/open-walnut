/**
 * Session budgets, kept by the session daemon on the session's own host.
 *
 * Spend is the same number as the model picker's cost line: the engine's own
 * per-request usage (session-cost-core.ts) priced with the price list the server
 * pushed (price-resolve.ts, session-cost-pricing.ts). A session is paused (its
 * process stopped, new sends refused) when that spend reaches its limit, as soon
 * as one of its requests has no price (an unpriced request could be any amount),
 * or when its usage cannot be read for a minute. Raising the limit (or removing
 * it) lets the next send through; nothing restarts on its own.
 *
 * A send is let through only on a decision newer than the last response the
 * session made: a response marks the session, and the next send waits for a
 * check that started after it. A send no check decides in time is held, not
 * paused ('checking'): the server keeps it queued and sends it again.
 *
 * It runs on the host, so a budget holds while the Mac is asleep, and it
 * survives a daemon restart: each configured session is checked again before
 * anything is sent to it, and a stop that was owed is made again.
 */
import { randomUUID } from 'node:crypto';
import { scanSessionCost, type SessionCostBucket, type SessionCostRequest, type SessionCostScan } from './session-cost-core.js';
import { indexSnapshot, type PriceSnapshot } from '../core/usage/price-data.js';
import { resolveWith, thresholdsWith, type UserPriceRates } from '../core/usage/price-resolve.js';
import { priceScanWith } from '../core/usage/session-cost-pricing.js';
import { createBudgetStore, emptyBudget, SID_RE, type BudgetPauseReason, type BudgetPrices, type BudgetState, type StoredBudget } from './usage-budget-store.js';

export type { BudgetPauseReason, BudgetPrices, BudgetState } from './usage-budget-store.js';

/** May a send go: 'ok'; 'paused' (over its limit, unpriced, unreadable or stopping); 'checking' (not decided yet, retry). */
export type BudgetVerdict = 'ok' | 'paused' | 'checking';

export interface BudgetConfigureRequest {
  limitUsd: number | null;
  /** The revision the asker last saw; another writer since is a conflict. */
  revision: number;
  engine: string;
  /** The asking Walnut's data dir. */
  home?: string;
  cwd?: string;
  /** An ACP session's daemon worker id (its usage is keyed by the provider session id). */
  runtimeId?: string;
  prices?: BudgetPrices;
}

export interface UsageBudgetRuntimeOptions {
  dir: string;
  projectsDir: string;
  codexHome?: string;
  /** Stop the session's process (Claude Code, or an ACP worker by its runtime id). */
  pause: (sid: string, engine: string, runtimeId?: string) => Promise<void>;
  /** Whether the session's process runs now; an idle one is checked once a minute. */
  active?: (sid: string, engine: string, runtimeId?: string) => boolean;
  now?: () => number;
  log: (message: string, fields: Record<string, unknown>) => void;
  /** Test seams. */
  scan?: (req: SessionCostRequest) => Promise<SessionCostScan>;
  tickMs?: number;
}

/** The engines whose per-request usage is priced (session-cost-core.ts). */
const BUDGET_ENGINES = ['claude', 'codex', 'opencode'];
/** How often a running session is priced again, by engine (ms): an OpenCode read runs its CLI. */
const CHECK_EVERY: Record<string, number> = { claude: 2_000, codex: 5_000, opencode: 30_000 };
const IDLE_CHECK_EVERY = 60_000;
const PAUSED_CHECK_EVERY = 30_000;
/** Usage that cannot be read this long pauses the session. */
const UNREADABLE_PAUSE_MS = 60_000;
/** How long a send waits for a check before it is refused. */
const ALLOW_WAIT_MS = 15_000;
/** Interval checks run at once at most (a send's or a save's check is never held back). */
const MAX_TICK_CHECKS = 4;

export class BudgetConflictError extends Error {
  code = 'BUDGET_CONFLICT';
  constructor() { super('The budget changed since it was read; refresh and save again.'); }
}

type Prices = { index?: ReturnType<typeof indexSnapshot>; snapshot?: PriceSnapshot; overrides?: Record<string, UserPriceRates>; hash: string };

export function createUsageBudgetRuntime(options: UsageBudgetRuntimeOptions) {
  const now = options.now ?? Date.now;
  const scan = options.scan ?? scanSessionCost;
  const store = createBudgetStore({ dir: options.dir, now, log: options.log });
  const budgets = new Map<string, StoredBudget>();
  const corrupt = new Map<string, string>();
  const lastCheck = new Map<string, number>();
  /** Each check resolves true when it decided (prices known, usage read). */
  const checks = new Map<string, Promise<boolean>>();
  const stopping = new Map<string, Promise<void>>();
  const soon = new Map<string, ReturnType<typeof setTimeout>>();
  /** Sessions with a response newer than their last decision. */
  const dirty = new Set<string>();
  let prices: Prices | undefined;
  let closed = false;

  function installPrices(next: BudgetPrices): void {
    prices = { ...(next.snapshot ? { snapshot: next.snapshot, index: indexSnapshot(next.snapshot) } : {}),
      ...(next.overrides ? { overrides: next.overrides } : {}), hash: next.hash };
  }
  async function setPrices(next: BudgetPrices): Promise<void> {
    if (prices?.hash === next.hash) return;
    installPrices(next);
    await store.savePrices(next);
  }
  async function save(record: StoredBudget): Promise<void> {
    budgets.set(record.sid, record);
    await store.save(record);
  }

  let initializationError: unknown;
  const ready = (async () => {
    const loaded = await store.load();
    if (loaded.prices) installPrices(loaded.prices);
    for (const [sid, error] of loaded.corrupt) corrupt.set(sid, error);
    for (const record of loaded.budgets) {
      // Nothing is sent to a configured session until it has been checked again.
      if (record.limitUsd !== null && record.state !== 'paused') record.state = 'checking';
      budgets.set(record.sid, record);
    }
  })();
  void ready.catch(error => {
    initializationError = error;
    options.log('budget initialization failed; sends to budgeted sessions stay held', { error: String(error) });
  });
  async function withReady(): Promise<void> {
    await ready.catch(() => {});
    if (initializationError) throw initializationError;
  }

  function snapshotOf(sid: string) {
    const record = budgets.get(sid);
    const error = corrupt.get(sid);
    const base = emptyBudget(sid, record?.engine ?? '');
    const r = record ?? base;
    const budget: BudgetState = error && !record
      ? { ...pick(base), engine: null, state: 'paused', reason: 'unreadable', checkError: `The saved budget could not be read (${error}). Set the budget again.` }
      : { ...pick(r), engine: record ? r.engine : null };
    return { budget, checkedAt: record?.checkedAt ?? null };
  }
  function pick(r: StoredBudget): BudgetState {
    return { limitUsd: r.limitUsd, spentUsd: r.spentUsd, state: r.state, reason: r.reason, revision: r.revision, updatedAt: r.updatedAt,
      responses: r.responses, unpricedResponses: r.unpricedResponses, unpricedModel: r.unpricedModel ?? null,
      checkError: r.checkError ?? null, pausedAt: r.pausedAt, pauseId: r.pauseId, stopError: r.stopError, engine: r.engine };
  }

  async function stop(record: StoredBudget): Promise<void> {
    const existing = stopping.get(record.sid);
    if (existing) return existing;
    const work = options.pause(record.sid, record.engine ?? 'claude', record.runtimeId)
      .then(() => { record.stopError = null; record.stopConfirmed = true; })
      .catch((error: unknown) => {
        record.stopError = String(error instanceof Error ? error.message : error);
        options.log('budget pause was not confirmed', { sid: record.sid, error: record.stopError });
      })
      .then(() => save(record));
    stopping.set(record.sid, work);
    try { await work; } finally { if (stopping.get(record.sid) === work) stopping.delete(record.sid); }
  }

  /**
   * `revision` is the budget the deciding check read: a limit removed or changed
   * since is decided by the check that change starts, so this one stops nothing.
   * `stopTried`: this check already tried the owed stop; one try per check.
   */
  async function pauseFor(record: StoredBudget, reason: BudgetPauseReason, decided: { revision: number; stopTried: boolean }): Promise<void> {
    // 'checking' with a pause id: a limit changed during a pause, and the session is still over.
    const wasPaused = record.state === 'paused' || (record.state === 'checking' && !!record.pauseId);
    record.reason = reason;
    record.state = 'paused';
    if (!wasPaused) {
      record.pausedAt = new Date(now()).toISOString();
      record.pauseId = randomUUID();
      record.stopConfirmed = false;
      options.log('budget reached; pausing session', { sid: record.sid, limitUsd: record.limitUsd, spentUsd: record.spentUsd, reason });
    }
    // Saved (stop still owed) before the stop, so a restart in between stops it again.
    await save(record);
    if (record.revision !== decided.revision || record.state !== 'paused' || decided.stopTried) return;
    if (!record.stopConfirmed || record.stopError) await stop(record);
  }

  async function scanAll(record: StoredBudget, thresholds: number[]): Promise<{ scan?: SessionCostScan; pending?: boolean; error?: string }> {
    const scans: SessionCostScan[] = [];
    for (const sid of [record.sid, ...(record.alsoSids ?? [])]) {
      const s = await scan({ engine: record.engine ?? 'claude', sessionId: sid, ...(record.cwd ? { cwd: record.cwd } : {}),
        thresholds, projectsDir: options.projectsDir, ...(options.codexHome ? { codexHome: options.codexHome } : {}), softDeadlineMs: 10_000 });
      if (s.pending) return { pending: true };
      scans.push(s);
    }
    const [main, ...earlier] = scans;
    // A session that never answered has nothing to read yet; one that did must still be readable.
    const unreadable = (!main.found && (record.responses > 0 || record.answered || main.source === 'opencode-export')) ? main
      : earlier.find(s => !s.found);
    if (unreadable) return { error: unreadable.reason ?? 'The session\'s usage could not be read.' };
    const buckets: SessionCostBucket[] = scans.flatMap(s => s.buckets);
    return { scan: { ...main, buckets } };
  }

  /** Price the session now and pause it when it is over its limit, has an unpriced request, or cannot be read. */
  function check(sid: string): Promise<boolean> {
    const existing = checks.get(sid);
    if (existing) return existing;
    const work = (async (): Promise<boolean> => {
      const record = budgets.get(sid);
      if (!record || record.limitUsd === null) return true;
      // A stop that is still owed (a restart cut it, or it failed) is made first.
      const stopTried = record.state === 'paused' && (!record.stopConfirmed || !!record.stopError);
      if (stopTried) await stop(record);
      // Without the server's price list every request would look unpriced: wait for it. One list per check.
      const p = prices;
      if (!p?.snapshot) return false;
      lastCheck.set(sid, now());
      const decided = { revision: record.revision, stopTried };
      // Cleared before the read, so a response landing during it marks the session again;
      // put back when this check decides nothing, so the next send still waits for one.
      const wasDirty = dirty.delete(sid);
      const undecided = () => { if (wasDirty) dirty.add(sid); return false; };
      const thresholds = thresholdsWith(p.snapshot, p.overrides);
      let read: Awaited<ReturnType<typeof scanAll>>;
      try { read = await scanAll(record, thresholds); }
      catch (error) { read = { error: String(error instanceof Error ? error.message : error) }; }
      if (read.pending) return undecided();
      if (budgets.get(sid) !== record || record.limitUsd === null) return undecided();
      record.checkedAt = new Date(now()).toISOString();
      if (read.error || !read.scan) {
        record.checkError = read.error ?? 'The session\'s usage could not be read.';
        record.unreadableSince ??= record.checkedAt;
        if (record.state === 'paused' || now() - Date.parse(record.unreadableSince) >= UNREADABLE_PAUSE_MS) await pauseFor(record, record.state === 'paused' ? record.reason ?? 'unreadable' : 'unreadable', decided);
        else { record.state = 'checking'; await save(record); }
        return undecided();
      }
      record.checkError = null;
      record.unreadableSince = null;
      const asOf = p.snapshot.fetchedAt;
      const priced = priceScanWith(read.scan, thresholds, (model, speed) => resolveWith(p.index, asOf, model, speed, p.overrides),
        { source: 'litellm', asOf });
      record.spentUsd = priced.totalUsd ?? 0;
      record.responses = priced.responses;
      record.unpricedResponses = priced.unpricedResponses;
      record.unpricedModel = priced.models.find(m => m.unpricedResponses > 0)?.model ?? null;
      const reason: BudgetPauseReason | null = record.spentUsd >= record.limitUsd ? 'limit'
        : record.unpricedResponses > 0 ? 'unpriced' : null;
      if (reason) { await pauseFor(record, reason, decided); return true; }
      Object.assign(record, { state: 'active', reason: null, pausedAt: null, pauseId: null, stopError: null, stopConfirmed: undefined });
      await save(record);
      return true;
    })().catch((error: unknown) => {
      options.log('budget check failed', { sid, error: String(error) });
      return false;
    });
    checks.set(sid, work);
    void work.finally(() => { if (checks.get(sid) === work) checks.delete(sid); });
    return work;
  }

  /**
   * A pause a new limit cannot lift: a request with no price stays unpriced, and spend
   * already at the new limit only grows. Such a budget stays paused (and its owed stop due).
   */
  function stillOver(record: StoredBudget, limit: number): boolean {
    return record.reason === 'unpriced' || (record.reason === 'limit' && record.spentUsd !== null && record.spentUsd >= limit);
  }

  /** The daemon saw the session answer: from now on a usage file that cannot be found is unreadable, never $0. */
  function noteAnswered(record: StoredBudget): void {
    if (record.answered) return;
    record.answered = true;
    void save(record).catch(error => options.log('budget answered mark was not saved', { sid: record.sid, error: String(error) }));
  }

  /** A check that starts after this call (waits out the one in flight, which may predate the caller's news). */
  async function freshCheck(sid: string): Promise<boolean> {
    const before = checks.get(sid);
    if (before) await before;
    const current = checks.get(sid);
    return current && current !== before ? current : check(sid);
  }

  /** A response just landed: mark the session and price it as soon as the last check (under a second ago) allows. */
  function checkSoon(sid: string): void {
    dirty.add(sid);
    if (closed || soon.has(sid)) return;
    const wait = checks.has(sid) ? 250 : Math.max(0, 1_000 - (now() - (lastCheck.get(sid) ?? 0)));
    if (wait === 0) { void check(sid); return; }
    const timer = setTimeout(() => { soon.delete(sid); if (dirty.has(sid)) checkSoon(sid); }, wait);
    timer.unref?.();
    soon.set(sid, timer);
  }

  async function tick(): Promise<void> {
    if (closed || initializationError) return;
    await ready;
    const t = now();
    for (const record of budgets.values()) {
      if (record.limitUsd === null || checks.has(record.sid)) continue;
      if (checks.size >= MAX_TICK_CHECKS) break;
      const engine = record.engine ?? 'claude';
      const running = options.active?.(record.sid, engine, record.runtimeId) ?? true;
      const owed = record.state === 'paused' && (!record.stopConfirmed || !!record.stopError);
      const every = owed || record.state === 'checking' ? CHECK_EVERY[engine] ?? 30_000
        : record.state === 'paused' ? PAUSED_CHECK_EVERY
          : running || dirty.has(record.sid) ? CHECK_EVERY[engine] ?? 30_000 : IDLE_CHECK_EVERY;
      if (t - (lastCheck.get(record.sid) ?? 0) >= every) void check(record.sid);
    }
  }
  const timer = setInterval(() => { void tick().catch(error => options.log('budget tick failed', { error: String(error) })); }, options.tickMs ?? 1_000);
  timer.unref?.();

  async function allow(sid: string): Promise<BudgetVerdict> {
    await ready.catch(() => {});
    // The saved budgets could not be loaded: a session with a budget file is held (every send asks again).
    if (initializationError) return await store.anyFile(sid) ? 'checking' : 'ok';
    if (corrupt.has(sid) && !budgets.has(sid)) return 'paused';
    const record = budgets.get(sid);
    if (!record || record.limitUsd === null) return 'ok';
    if (stopping.has(sid)) return 'paused';
    let decided = true;
    // Decided before the latest response (or not at all): decide again first.
    if (record.state === 'checking' || dirty.has(sid) || checks.has(sid) || soon.has(sid)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      decided = await Promise.race([freshCheck(sid),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ALLOW_WAIT_MS); })]).finally(() => clearTimeout(timer));
    }
    const after = budgets.get(sid);
    if (stopping.has(sid) || (after && after.limitUsd !== null && after.state === 'paused')) return 'paused';
    if (!after) return 'checking';
    if (after.limitUsd === null) return 'ok';
    // A response that lands while this send goes is decided by the next check (requests in flight may pass the limit).
    return decided && after.state === 'active' ? 'ok' : 'checking';
  }

  return {
    async read(sid: string) {
      await withReady();
      return snapshotOf(sid);
    },
    async configure(sid: string, request: BudgetConfigureRequest) {
      await withReady();
      if (!SID_RE.test(sid)) throw Object.assign(new Error('usage.budget: bad session id'), { code: 'BAD_REQUEST' });
      const limit = request.limitUsd;
      if (limit !== null && !(typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && limit <= 1_000_000)) {
        throw Object.assign(new Error('The limit must be a dollar amount from $0.01 to $1,000,000.'), { code: 'BAD_REQUEST' });
      }
      if (!BUDGET_ENGINES.includes(request.engine)) throw Object.assign(new Error(`usage.budget: no budget for the ${String(request.engine)} engine`), { code: 'BAD_REQUEST' });
      const previous = budgets.get(sid);
      // One Walnut's budget is changed by that Walnut only, and a session keeps its engine.
      if (previous?.home && request.home && previous.home !== request.home) throw Object.assign(new Error('usage.budget: another Walnut set this budget'), { code: 'NOT_OWNED' });
      if (previous?.engine && previous.limitUsd !== null && previous.engine !== request.engine) throw Object.assign(new Error('usage.budget: the session runs another engine'), { code: 'BAD_REQUEST' });
      if (request.prices) await setPrices(request.prices);
      // A budget file that could not be read is replaced by any new budget.
      if (!(corrupt.has(sid) && !previous) && (previous?.revision ?? 0) !== request.revision) throw new BudgetConflictError();
      corrupt.delete(sid);
      const record: StoredBudget = previous ?? emptyBudget(sid, request.engine);
      record.revision += 1;
      record.limitUsd = limit;
      record.engine = request.engine;
      if (request.home) record.home = request.home;
      if (request.cwd) record.cwd = request.cwd;
      if (request.runtimeId && !record.runtimeBoundAt) record.runtimeId = request.runtimeId;
      if (limit === null) {
        Object.assign(record, { state: 'unlimited', reason: null, pausedAt: null, pauseId: null, stopError: null, stopConfirmed: undefined, checkError: null });
      } else if (record.state === 'unlimited' || (record.state === 'paused' && !stillOver(record, limit))) {
        // A paused budget whose limit changed is decided again. Its pause (id, a stop still
        // owed) carries over only when a check at the new limit still finds the session over.
        record.state = 'checking';
      }
      await save(record);
      await store.mirrorFirstVersion(record);
      if (limit !== null) {
        // A new limit is decided now (by a check that sees it), so the answer says where the session stands.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([freshCheck(sid), new Promise(resolve => { timer = setTimeout(resolve, 12_000); })]).finally(() => clearTimeout(timer));
      }
      return snapshotOf(sid);
    },
    async setPrices(next: BudgetPrices) { await withReady(); await setPrices(next); },
    pricesHash(): string | null { return prices?.hash ?? null; },
    /**
     * Every configured budget the asking Walnut set (or that no Walnut is named
     * on), for the server to tell the user about pauses. The server passes each
     * ACP session's worker id as it knows it; a binding this daemon made itself
     * (at a start or a send) is newer and stays.
     */
    async list(runtimeIds?: Record<string, string>, home?: string) {
      await withReady();
      for (const [sid, runtimeId] of Object.entries(runtimeIds ?? {})) {
        const record = budgets.get(sid);
        if (record && typeof runtimeId === 'string' && runtimeId && !record.runtimeBoundAt && record.runtimeId !== runtimeId) {
          record.runtimeId = runtimeId;
          await save(record);
        }
      }
      return [...budgets.values()].filter(r => r.limitUsd !== null && (!home || !r.home || r.home === home))
        .map(r => ({ sid: r.sid, ...snapshotOf(r.sid).budget }));
    },
    allow,
    /**
     * An ACP worker started (or a turn is about to go) for this session: bind its
     * worker id first, so its very first turn is gated. A session id this daemon
     * has no budget for, on a worker bound to another budgeted session, is that
     * session's thread started over: the budget moves to the new id and keeps
     * counting the old one. Throws when the binding cannot be saved.
     */
    async bindRuntime(sid: string, runtimeId: string): Promise<void> {
      await ready.catch(() => {});
      if (initializationError) {
        if (await store.anyFile(sid)) throw initializationError;
        return;
      }
      let record = budgets.get(sid);
      if (!record) {
        const prior = [...budgets.values()].find(r => r.runtimeId === runtimeId && r.limitUsd !== null && r.engine !== 'claude');
        if (!prior) return;
        record = { ...prior, sid, alsoSids: [...new Set([prior.sid, ...(prior.alsoSids ?? [])])] };
        budgets.delete(prior.sid);
        lastCheck.delete(prior.sid);
        options.log('budget follows its session to a new thread id', { from: prior.sid, to: sid, runtimeId });
        await save(record);
        // The old id's first-version copy is cleared first, so a crash before its v2 file goes
        // leaves nothing a later load adopts as a budget of its own.
        await store.mirrorFirstVersion({ ...prior, limitUsd: null, revision: prior.revision + 1 });
        await store.remove(prior.sid);
        dirty.add(sid);
      }
      if (record.limitUsd === null || (record.runtimeId === runtimeId && record.runtimeBoundAt)) return;
      record.runtimeId = runtimeId;
      record.runtimeBoundAt = new Date(now()).toISOString();
      await save(record);
    },
    /** An ACP turn ended: price the session now rather than at the next interval. */
    observeRuntime(runtimeId: string) {
      for (const record of budgets.values()) {
        if (record.runtimeId === runtimeId && record.limitUsd !== null) { noteAnswered(record); checkSoon(record.sid); }
      }
    },
    /** May a turn be sent to the ACP worker with this runtime id? */
    async allowRuntime(runtimeId: string): Promise<BudgetVerdict> {
      await ready.catch(() => {});
      for (const record of budgets.values()) if (record.runtimeId === runtimeId) return allow(record.sid);
      return allow(runtimeId);
    },
    /** A stream line from the session: a response just landed, price it soon. */
    observe(sid: string, parsed: Record<string, unknown>) {
      const record = budgets.get(sid);
      if (!record || record.limitUsd === null || !['assistant', 'result'].includes(String(parsed.type))) return;
      noteAnswered(record);
      checkSoon(sid);
    },
    check,
    tick,
    /** After a daemon restart: check every configured session (pausing it again when it is over, stopping it when a stop was owed). */
    async recover() {
      await ready.catch(() => {});
      if (initializationError) return;
      for (const record of budgets.values()) if (record.limitUsd !== null) await check(record.sid);
    },
    close() { closed = true; clearInterval(timer); for (const t of soon.values()) clearTimeout(t); soon.clear(); },
  };
}

export type UsageBudgetRuntime = ReturnType<typeof createUsageBudgetRuntime>;
