/**
 * One way to wait for a session's turn to end before acting on it: an engine switch or a
 * move, a team stop with `when: 'turn_end'`, the stop of a session that completed its own
 * task, the close of a lead after its handover (lifecycle-waits.ts lists them).
 *
 * Each of them used to listen for the session's status leaving `running` and nothing else
 * (2026-11-03: a task's move to the Mac stayed pending 1 h 50 min, because the turn that
 * asked for it had started a test run in the background, the session read `running` all
 * along, and only a status event could start the move). So a wait here always ends:
 *  - a status change of the session looks at once (after a short settle: a background
 *    command's follow-up turn starts about 0.1 s after the turn ends), and a poll every
 *    TURN_END_POLL_MS looks again, so a missed event costs one poll;
 *  - what holds it is read each time (turnHold): a queued message, a turn the model runs,
 *    or only work the finished turn left running (a detached command, an armed wakeup);
 *  - each wait names its limits: background work holds it `backgroundGraceMs` from when it
 *    was first seen holding it, anything else at most `maxMs` from the ask; then the wait's
 *    own `act` runs with the verdict (run over the background work, or the deadline's
 *    result: run anyway, or fail with a reason), never pending for good.
 * In memory; a wait whose ask is on disk is watched again at startup by its owner, with
 * the ask's own time, so a restart keeps its deadline.
 */
import { log } from '../../logging/index.js';
import { bus, EventNames } from '../event-bus.js';
import type { SessionRecord } from '../types.js';

export const TURN_END_POLL_MS = 30_000;

// One import each, shared: two looks importing a module for the first time at once must not
// get two answers (bun's test runner has handed one of them a hang).
let trackerMod: Promise<typeof import('../session-tracker.js')> | null = null;
let queueMod: Promise<typeof import('../session-queue-store.js')> | null = null;
let runnerMod: Promise<typeof import('../../providers/claude-code-session.js')> | null = null;
const tracker = () => (trackerMod ??= import('../session-tracker.js'));
const queueStore = () => (queueMod ??= import('../session-queue-store.js'));
const runner = () => (runnerMod ??= import('../../providers/claude-code-session.js'));
export const TURN_END_SETTLE_MS = 3_000;
const QUEUE_POLL_MS = 5_000;

/** What holds a wait back now; `free` lets it act. */
export type TurnHold = 'free' | 'queue' | 'turn' | 'background';
export type TurnEndVerdict = 'wait' | 'run' | 'run-over-background' | 'expire';

export interface TurnEndLimits {
  /** How long work the finished turn left running may hold the wait. */
  backgroundGraceMs: number;
  /** How long anything may hold it, from the ask. */
  maxMs: number;
}

/** What a wait does now, from what holds it and for how long. */
export function turnEndVerdict(input: { hold: TurnHold; askedAt: number; backgroundSince?: number; now: number; limits: TurnEndLimits }): TurnEndVerdict {
  const { hold, askedAt, now, limits } = input;
  if (hold === 'free') return 'run';
  const overdue = !(now - askedAt < limits.maxMs); // an unreadable time counts as overdue
  if (hold === 'background') {
    const since = input.backgroundSince ?? now;
    return overdue || now - since >= limits.backgroundGraceMs ? 'run-over-background' : 'wait';
  }
  return overdue ? 'expire' : 'wait';
}

/** What holds a session: `queue` counts only when the wait asks for it (a message about to start a turn). */
export async function turnHold(rec: Pick<SessionRecord, 'claudeSessionId' | 'process_status'>, opts: { queue: boolean }): Promise<TurnHold> {
  // A session the context recovery holds is mid-work even between turns: its last turn ended on
  // "Prompt is too long", answered nothing, and the recovery compacts and resends (2026-11-06).
  const { contextFullRecovery } = await import('./context-full-recovery.js');
  if (contextFullRecovery()?.holds(rec.claudeSessionId)) return 'turn';
  if (opts.queue) {
    const { getStore } = await queueStore();
    const rows = (await getStore().catch(() => null))?.queues[rec.claudeSessionId] ?? [];
    if (rows.some((r) => r.status === 'pending' || r.status === 'processing')) return 'queue';
  }
  if (rec.process_status !== 'running') return 'free';
  try {
    const { sessionRunner } = await runner();
    // Background work counts only once the model's turn is over: a turn that started a
    // background command and keeps working is still a turn.
    if (sessionRunner.isInTurn(rec.claudeSessionId) !== false) return 'turn';
    return sessionRunner.hasWorkOutlivingTurn(rec.claudeSessionId) ? 'background' : 'turn';
  } catch {
    return 'turn';
  }
}

export interface TurnEndWaitSpec<T> {
  /** The bus subscriber's name and the log's word for it. */
  name: string;
  limits: TurnEndLimits;
  /** Whether a queued message holds it as a turn does. */
  queue: boolean;
  settleMs?: number;
  /** The first look without an event: at once by default. A wait whose turn is still to start
   *  (a notice just queued) looks first after this long, so an idle moment before that turn
   *  is never read as its end. */
  firstLookMs?: number;
  /** Still wanted? Its ask time when so, null to drop the wait. Read before every look. */
  asked(sessionId: string, data: T): Promise<{ askedAt: number } | null>;
  /** Extra reasons to hold (a notice not read yet): read after turnHold says free. */
  holdsToo?(sessionId: string, data: T): Promise<boolean>;
  /** The wait is over: act on the verdict. Errors are logged; the wait is gone either way. */
  act(sessionId: string, data: T, verdict: Exclude<TurnEndVerdict, 'wait'>, hold: TurnHold): Promise<void>;
}

interface Entry<T> { data: T; backgroundSince?: number; timer?: ReturnType<typeof setTimeout>; checking?: boolean }

/** Every waiter made, by name: the ratchet reads it (lifecycle-waits.ts). */
export const TURN_END_WAITERS = new Map<string, TurnEndLimits>();

export class TurnEndWait<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private subscribed = false;

  private pollMs = TURN_END_POLL_MS;

  constructor(private readonly spec: TurnEndWaitSpec<T>) {
    TURN_END_WAITERS.set(spec.name, spec.limits);
  }

  /** Tests: shorter limits and poll (no argument restores them). */
  setClockForTest(clock?: { limits: TurnEndLimits; pollMs: number }): void {
    this.limitsOverride = clock?.limits;
    this.pollMs = clock?.pollMs ?? TURN_END_POLL_MS;
  }
  private limitsOverride?: TurnEndLimits;

  /** Wait for `sessionId`'s turn to end (a new wait for the same session replaces the old one). */
  watch(sessionId: string, data: T): void {
    const prev = this.entries.get(sessionId);
    if (prev?.timer) clearTimeout(prev.timer);
    this.entries.set(sessionId, { data });
    void this.subscribe().then(() => this.look(sessionId, this.spec.firstLookMs ?? 0)).catch((err: unknown) => log.session.warn(`${this.spec.name}: watching the turn failed`, {
      sessionId, error: err instanceof Error ? err.message : String(err),
    }));
  }

  has(sessionId: string): boolean { return this.entries.has(sessionId); }
  get(sessionId: string): T | undefined { return this.entries.get(sessionId)?.data; }
  keys(): string[] { return [...this.entries.keys()]; }
  values(): Array<[string, T]> { return [...this.entries].map(([sid, e]) => [sid, e.data]); }

  cancel(sessionId: string): boolean {
    const e = this.entries.get(sessionId);
    if (!e) return false;
    if (e.timer) clearTimeout(e.timer);
    this.entries.delete(sessionId);
    return true;
  }

  clear(): void {
    for (const sid of this.keys()) this.cancel(sid);
  }

  private async subscribe(): Promise<void> {
    if (this.subscribed) return;
    this.subscribed = true;
    bus.subscribe(this.spec.name, (event) => {
      const data = event.data as { sessionId?: string; process_status?: string } | undefined;
      const sid = data?.sessionId;
      if (!sid || !this.entries.has(sid) || !data?.process_status || data.process_status === 'running') return;
      const e = this.entries.get(sid)!;
      this.schedule(sid, e, this.spec.settleMs ?? TURN_END_SETTLE_MS, true);
    }, { global: true, interest: [EventNames.SESSION_STATUS_CHANGED] });
  }

  /** `settled`: the look comes a settle after the session was seen free, so a free reading may act. */
  private schedule(sessionId: string, e: Entry<T>, ms: number, settled = false): void {
    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => { e.timer = undefined; void this.look(sessionId, 0, settled); }, ms);
    e.timer.unref?.();
  }

  /** Look (after `delayMs`) and act, or keep waiting. Never throws. */
  private async look(sessionId: string, delayMs: number, settled = false): Promise<void> {
    const e = this.entries.get(sessionId);
    if (!e) return;
    if (delayMs) { this.schedule(sessionId, e, delayMs); return; }
    if (e.checking) { if (settled) this.schedule(sessionId, e, this.spec.settleMs ?? TURN_END_SETTLE_MS, true); return; }
    e.checking = true;
    try {
      const asked = await this.spec.asked(sessionId, e.data);
      if (!asked) { this.drop(sessionId, e); return; }
      const { getSessionByClaudeId } = await tracker();
      const rec = await getSessionByClaudeId(sessionId).catch(() => null);
      let hold: TurnHold = rec ? await turnHold(rec, { queue: this.spec.queue }) : 'free';
      if (hold === 'free' && this.spec.holdsToo && await this.spec.holdsToo(sessionId, e.data)) hold = 'queue';
      const now = Date.now();
      if (hold === 'background') e.backgroundSince ??= now; else e.backgroundSince = undefined;
      const verdict = turnEndVerdict({ hold, askedAt: asked.askedAt, backgroundSince: e.backgroundSince, now, limits: this.limitsOverride ?? this.spec.limits });
      // Cancelled or replaced while this look read: the newer wait decides.
      if (this.entries.get(sessionId) !== e) return;
      // A queued message turns into a turn within seconds: look again sooner.
      if (verdict === 'wait') { this.schedule(sessionId, e, hold === 'queue' ? Math.min(QUEUE_POLL_MS, this.pollMs) : this.pollMs); return; }
      // Free on a poll: a background command's follow-up turn may start a moment later, so
      // look once more after the settle before acting.
      if (verdict === 'run' && !settled) { this.schedule(sessionId, e, this.spec.settleMs ?? TURN_END_SETTLE_MS, true); return; }
      this.drop(sessionId, e);
      if (verdict !== 'run') {
        log.session.warn(`${this.spec.name}: the wait for the turn's end ran out`, {
          sessionId, verdict, hold, waitedMs: now - asked.askedAt,
        });
      }
      await this.spec.act(sessionId, e.data, verdict, hold);
    } catch (err) {
      log.session.warn(`${this.spec.name}: acting at the turn's end failed`, { sessionId, error: err instanceof Error ? err.message : String(err) });
      // A look that failed before it acted looks again; one that acted is over.
      if (this.entries.get(sessionId) === e) this.schedule(sessionId, e, this.pollMs);
    } finally {
      e.checking = false;
    }
  }

  private drop(sessionId: string, e: Entry<T>): void {
    if (e.timer) clearTimeout(e.timer);
    if (this.entries.get(sessionId) === e) this.entries.delete(sessionId);
  }
}
