/**
 * Idle compaction: a Claude Code session left idle that is close to compacting by
 * itself (`session.idle_compaction.limit_percent`, 85% by default, of its
 * auto-compaction window, else of the model's window; never when neither is
 * known) is compacted shortly before its prompt cache expires (2026-11-04).
 * Measured on Claude Code 2.1.312, a `/compact` writes the whole conversation to
 * the cache once, warm or cold (it read 13K of a 299K prefix), so it pays only
 * for a session that would soon compact anyway: then the next message, and
 * every one after, reads the summary.
 *
 * At every turn end the session's prompt cache facts (sessions/prompt-cache.ts,
 * kept by the runner from the request's own usage) are stored on its record,
 * and a timer is set for IDLE_COMPACT_LEAD_MS before the cache expires. When it
 * fires and the session is still idle on that same request, Walnut sends
 * `/compact` as a quiet turn (sessions/quiet-turn.ts): no phase move, no
 * turn-end hook, no push, no Working. Anything sent to the session meanwhile
 * cancels the timer; the next turn end sets a new one.
 *
 * When the idle reap is about to end the CLI first (session:will-reap; 15 minutes
 * under memory pressure), an armed compaction goes out then, while the CLI and
 * its cache are alive.
 *
 * Skipped: a session below its threshold, a cache
 * that lives under 30 minutes (5-minute caches: compacting is the user's call),
 * a cache already expired (it would save nothing that time; never once expired,
 * whichever way in), a session already compacted since, a running turn, a prompt for
 * the user, queued messages, work that outlives the turn (a background command,
 * a wakeup, a CLI cron), a lane or ACP session, a completed task, an org node
 * while the org is off, and a session whose CLI process is gone (stopped: a
 * resume would build its prompt again and likely miss the cache, so it would pay
 * the full read the compaction exists to save). `session.idle_compaction.enabled:
 * false` or WALNUT_IDLE_COMPACTION=0 turns it off. Primary only (server.ts). The
 * timers are rebuilt from the records at boot.
 *
 * The `/compact` row has its own id and a user uuid, so it always goes out alone
 * (batch-uuid.ts splitBatchAtUuid) and the quiet turn is bound to it. A quiet turn
 * that ends before its row went out (a person wrote first, the line failed) takes
 * the row back: a stale `/compact` never runs in front of what they wrote.
 */
import { randomUUID } from 'node:crypto';
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import { log } from '../../logging/index.js';
import type { SessionRecord, Task } from '../types.js';
import {
  IDLE_COMPACT_LEAD_MS, idleCompactLineUuid, idleCompactionWindow, idleCompactReasonText, idleCompactThreshold,
  resolveIdleCompactLimitPercent, type IdleCompactReason, type PromptCacheFacts,
} from './prompt-cache.js';
import {
  beginQuietTurn, endQuietTurn, isQuietTurn, noteQuietTurnSettled, onQuietTurnEnd, quietTurnRow, QUIET_ROW_PREFIX, type QuietTurnEnd,
} from './quiet-turn.js';
import { isAcpEngine } from '../agents/engine-registry.js';
import { IDLE_COMPACT_COMMAND } from './walnut-commands.js';

/** The send source of the idle compaction's `/compact` (send-sent-by: an agent's; framing passes it raw). */
export const IDLE_COMPACT_SOURCE = 'idle-compact';
/** Its line: the command, and words that tell every history reader Walnut sent it (sessions/walnut-commands.ts). */
export const IDLE_COMPACT_TEXT = IDLE_COMPACT_COMMAND;
/** A cache this close to expiring is left alone: the compaction would not start in time. */
const TOO_LATE_MS = 15_000;

export interface IdleCompactionConfig {
  enabled: boolean;
  /** Compacts a session at this share (%) of where it compacts by itself. */
  limitPercent: number;
  leadMs: number;
}

export function resolveIdleCompactionConfig(
  session: { idle_compaction?: { enabled?: boolean; limit_percent?: number | null } } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): IdleCompactionConfig {
  // Tests and demos move the send earlier (a lead near the whole lifetime fires right after the turn).
  const lead = Number(env.WALNUT_IDLE_COMPACT_LEAD_MS);
  return {
    enabled: session?.idle_compaction?.enabled !== false && env.WALNUT_IDLE_COMPACTION !== '0',
    limitPercent: resolveIdleCompactLimitPercent(session?.idle_compaction?.limit_percent),
    leadMs: Number.isFinite(lead) && lead > 0 ? lead : IDLE_COMPACT_LEAD_MS,
  };
}

export interface IdleCompactionDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (t: ReturnType<typeof setTimeout>) => void;
  config: () => Promise<IdleCompactionConfig>;
  getSession: (sessionId: string) => Promise<SessionRecord | null>;
  listSessions: () => Promise<SessionRecord[]>;
  saveSession: (sessionId: string, updates: Partial<SessionRecord>) => Promise<unknown>;
  getTask: (taskId: string) => Promise<Task | null>;
  /** What the live runner knows: its cache facts, a running turn, work that outlives the turn. */
  live: (sessionId: string) => { promptCache?: PromptCacheFacts; inTurn: boolean | null; outliving: boolean; cron: boolean };
  /** Rows waiting in Walnut's queue for the session. */
  queued: (sessionId: string) => Promise<number>;
  /** The org is off and this task is Main or a VP. */
  orgOffFor: (task: Task) => Promise<boolean>;
  send: (sessionId: string, text: string, opts: { source: string; taskId?: string; messageId: string; userUuid: string; stillWanted: () => boolean }) => Promise<unknown>;
  /** Take back a row that has not gone out; false when it is gone or on its way. */
  dropRow: (sessionId: string, rowId: string) => Promise<boolean>;
  /** Whether the row still waits in the queue (pending or on its way). */
  rowQueued: (sessionId: string, rowId: string) => Promise<boolean>;
  emitNote: (sessionId: string, taskId: string | undefined, message: string) => void;
  /** Tell the open panels it runs (their working line says Walnut is compacting) or ended. */
  announce: (sessionId: string, active: boolean) => void;
}

function defaultDeps(): IdleCompactionDeps {
  return {
    now: () => Date.now(),
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimer: (t) => clearTimeout(t),
    config: async () => {
      const { getConfig } = await import('../config-manager.js');
      return resolveIdleCompactionConfig((await getConfig()).session);
    },
    getSession: async (id) => (await import('../session-tracker.js')).getSessionByClaudeId(id),
    listSessions: async () => (await import('../session-tracker.js')).listNonTerminalSessions(),
    // Its own bookkeeping is no activity of the session's: the session keeps its last-active time.
    saveSession: async (id, updates) => (await import('../session-tracker.js')).updateSessionRecordConditionally(id, updates, () => true, { preserveLastActiveAt: true }),
    getTask: async (id) => (await import('../task-manager.js')).getTask(id).catch(() => null),
    live: (id) => {
      const runner = liveRunner;
      return {
        promptCache: runner?.promptCacheOf(id),
        inTurn: runner?.isInTurn(id) ?? null,
        outliving: runner?.hasWorkOutlivingTurn(id) ?? false,
        cron: runner?.isCronArmed(id) ?? false,
      };
    },
    queued: async (id) => {
      const { getQueue } = await import('../session-message-queue.js');
      return (await getQueue(id)).filter((m) => m.status === 'pending' || m.status === 'processing').length;
    },
    orgOffFor: async (task) => {
      const { isOrgEnabled, isOrgNode } = await import('../org/org-enabled.js');
      return isOrgNode(task) && !(await isOrgEnabled());
    },
    send: async (id, text, opts) => (await import('../session-message-queue.js')).sendMessageToSession(id, text, opts),
    dropRow: async (id, rowId) => (await import('../session-message-queue.js')).deleteMessage(id, rowId),
    rowQueued: async (id, rowId) => (await import('../session-message-queue.js')).isMessageQueued(id, rowId),
    emitNote: (sessionId, taskId, message) => {
      bus.emit(EventNames.SESSION_SYSTEM_EVENT, { sessionId, taskId, variant: 'info' as const, message },
        ['main-ai'], { source: IDLE_COMPACT_SOURCE, urgency: 'urgent' });
    },
    announce: (sessionId, active) => {
      void import('../../web/ws/handler.js').then(({ broadcastEvent }) => broadcastEvent(IDLE_COMPACTION_EVENT, { sessionId, active })).catch(() => {});
    },
  };
}

/** The WebSocket event the panels read (web/src/components/sessions/CompactContext.tsx useIdleCompacting). */
export const IDLE_COMPACTION_EVENT = 'session:idle-compaction';

type RunnerView = {
  promptCacheOf(id: string): PromptCacheFacts | undefined;
  isInTurn(id: string): boolean | null;
  hasWorkOutlivingTurn(id: string): boolean;
  isCronArmed(id: string): boolean;
};
let liveRunner: RunnerView | null = null;

/** The words of the timeline note when an idle compaction starts (it says why, and from what). */
export function idleCompactNote(reason: IdleCompactReason, minutesLeft: number): string {
  return `Compacting this idle session before its prompt cache expires in about ${Math.max(1, Math.round(minutesLeft))} min: ${idleCompactReasonText(reason)}.`;
}

/** Why these facts compact under these settings, or null when they would not. */
export function idleCompactReasonOf(facts: PromptCacheFacts | undefined, limitPercent: number): IdleCompactReason | null {
  const threshold = idleCompactThreshold(facts, limitPercent);
  if (!facts || threshold === null || !facts.compactsAt) return null;
  return { tokens: facts.tokens, threshold, limitPercent, compactsAt: facts.compactsAt, source: facts.compactsAtSource ?? 'model' };
}

/** How many past idle compactions a record keeps the reasons of (their rows show them). */
const REASON_LOG_MAX = 20;

/** Why a due compaction is not sent now, or null to send it. Pure; exported for tests. */
export function skipReason(input: {
  rec: SessionRecord | null;
  task: Task | null;
  facts: PromptCacheFacts | undefined;
  scheduledFor: string;
  live: { inTurn: boolean | null; outliving: boolean; cron: boolean };
  queued: number;
  orgOff: boolean;
  nowMs: number;
  cfg: IdleCompactionConfig;
}): string | null {
  const { rec, task, facts, live, cfg, nowMs } = input;
  if (!cfg.enabled) return 'off';
  if (!rec || rec.archived) return 'session-gone';
  if (rec.lane || rec.provider === 'embedded' || isAcpEngine(rec.engine)) return 'not-a-claude-session';
  if (rec.supersededBy) return 'superseded';
  // Only a live CLI between turns: a stopped one (the user's Stop, an idle reap) is resumed only by a person.
  if (rec.process_status !== 'idle') return `status-${rec.process_status}`;
  if (rec.pendingPermission) return 'prompt-open';
  if (!task || task.phase === 'COMPLETE') return 'task-complete';
  if (input.orgOff) return 'org-off';
  if (!facts || facts.requestAt !== input.scheduledFor) return 'newer-request';
  if (rec.idleCompaction && Date.parse(rec.idleCompaction.sentAt) >= Date.parse(facts.requestAt)) return 'already-compacted';
  const window = idleCompactionWindow(facts, nowMs, { limitPercent: cfg.limitPercent, leadMs: cfg.leadMs });
  if (!window) return 'no-window';
  if (window.expiresAtMs - nowMs < TOO_LATE_MS) return 'too-late';
  if (live.inTurn === true) return 'turn-running';
  if (live.outliving) return 'work-outlives-turn';
  if (live.cron) return 'cron-armed';
  if (input.queued > 0) return 'messages-queued';
  return null;
}

export class IdleCompaction {
  private readonly deps: IdleCompactionDeps;
  /** sessionId → the timer and the request it was set for. */
  private readonly timers = new Map<string, { timer: ReturnType<typeof setTimeout>; requestAt: string }>();
  private stopped = false;
  private rearmTimer: ReturnType<typeof setTimeout> | null = null;
  /** Sessions disarmed by what happened to them (a failed or stopped turn, a send) until their next clean turn end: a settings change does not arm them again. */
  private readonly held = new Set<string>();
  /** The settings the timers were last set under (a config change of another key re-arms nothing). */
  private lastCfg: string | undefined;

  constructor(deps: Partial<IdleCompactionDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  handleEvent = (event: BusEvent): void => {
    const d = event.data as { sessionId?: string; isError?: boolean; interrupted?: boolean; teamActive?: boolean; backgroundActive?: boolean; sessionIds?: string[] };
    switch (event.name) {
      case EventNames.SESSION_RESULT: {
        if (!d.sessionId) return;
        if (isQuietTurn(d.sessionId, (d as { turnGen?: number }).turnGen)) {
          noteQuietTurnSettled(d.sessionId);
          void this.noteQuietEnd(d.sessionId);
        }
        if (d.teamActive || d.backgroundActive) return;
        if (d.isError || d.interrupted) { this.cancel(d.sessionId, 'turn-not-clean'); return; }
        void this.onTurnEnd(d.sessionId).catch((err) => log.session.warn('idle compaction: turn end failed', {
          sessionId: d.sessionId, error: err instanceof Error ? err.message : String(err),
        }));
        return;
      }
      case EventNames.SESSION_ERROR:
        if (!d.sessionId) return;
        if (isQuietTurn(d.sessionId)) {
          // The line never reached the CLI: its row is back in the queue, and goes no further.
          const row = quietTurnRow(d.sessionId);
          if ((event.data as { errorKind?: string }).errorKind === 'delivery_failed' && row) void this.takeBack(d.sessionId, row, 'delivery-failed');
          noteQuietTurnSettled(d.sessionId);
          void this.noteQuietEnd(d.sessionId);
        }
        this.cancel(d.sessionId, 'session-error');
        return;
      case EventNames.SESSION_SEND:
        // Someone else drives the session now: its next turn end decides again.
        if (d.sessionId && event.source !== IDLE_COMPACT_SOURCE) this.cancel(d.sessionId, 'send');
        return;
      case EventNames.SESSION_DELETED:
        for (const id of d.sessionIds ?? (d.sessionId ? [d.sessionId] : [])) this.cancel(id, 'deleted');
        return;
      case EventNames.CONFIG_CHANGED:
        // Switched on, or a lower threshold: sessions already idle are armed now, not at their next turn.
        if (this.rearmTimer) this.deps.clearTimer(this.rearmTimer);
        this.rearmTimer = this.deps.setTimer(() => {
          this.rearmTimer = null;
          void this.rearm().catch((err) => log.session.warn('idle compaction: rearm failed', { error: err instanceof Error ? err.message : String(err) }));
        }, 1_000);
        return;
      case EventNames.SESSION_WILL_REAP: {
        // The idle reap ends the CLI before its armed time (15 min under memory pressure): compact now,
        // while the CLI and its cache are alive. A reaped session is not compacted later.
        const armed = d.sessionId ? this.timers.get(d.sessionId) : undefined;
        // Under a minute left: the reap would cut the compaction off halfway.
        if (!d.sessionId || !armed || ((event.data as { remainingMs?: number }).remainingMs ?? 0) < 60_000) return;
        this.deps.clearTimer(armed.timer);
        void this.fire(d.sessionId, armed.requestAt).then((why) => {
          if (why === 'sent') log.session.info('idle compaction sent before an idle reap', { sessionId: d.sessionId });
        }).catch(() => {});
        return;
      }
    }
  };

  /** A quiet turn ended, whichever way: a row that never went out is taken back, and the end is stored. */
  readonly onQuietEnd = (end: QuietTurnEnd): void => {
    if (end.kind !== 'idle-compact') return;
    // A person's message after the line went out ends the quiet turn, but the CLI still compacts
    // first: the panels keep saying so until the compaction's own result (they clear on it).
    const stillCompacting = end.delivered && (end.why === 'other-send' || end.why === 'other-line');
    if (!stillCompacting) this.deps.announce(end.sessionId, false);
    if (end.rowId && !end.delivered) void this.takeBack(end.sessionId, end.rowId, end.why);
    void this.noteQuietEnd(end.sessionId);
  };

  /** Take the compaction's row back while it has not gone out (one retry: a failed line returns to the queue a moment later). */
  private async takeBack(sessionId: string, rowId: string, why: string): Promise<void> {
    try {
      for (let i = 0; i < 2; i++) {
        if (await this.deps.dropRow(sessionId, rowId)) {
          log.session.info('idle compaction taken back', { sessionId, why });
          return;
        }
        if (!(await this.deps.rowQueued(sessionId, rowId))) return;
        await new Promise((r) => this.deps.setTimer(() => r(undefined), 2_000));
      }
    } catch (err) {
      log.session.warn('idle compaction row not taken back', { sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** The quiet compaction's turn ended: its record says when (status-reconcile reads it). */
  private async noteQuietEnd(sessionId: string): Promise<void> {
    try {
      const rec = await this.deps.getSession(sessionId);
      if (!rec?.idleCompaction || rec.idleCompaction.endedAt) return;
      await this.deps.saveSession(sessionId, { idleCompaction: { ...rec.idleCompaction, endedAt: new Date(this.deps.now()).toISOString() } });
    } catch (err) {
      log.session.warn('idle compaction: end not stored', { sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** A turn ended: store the facts the runner holds, and set the timer from them. */
  async onTurnEnd(sessionId: string): Promise<void> {
    this.held.delete(sessionId);
    const facts = this.deps.live(sessionId).promptCache;
    if (!facts) return;
    const rec = await this.deps.getSession(sessionId);
    if (!rec) return;
    if (JSON.stringify(rec.promptCache) !== JSON.stringify(facts)) await this.deps.saveSession(sessionId, { promptCache: facts });
    await this.schedule(sessionId, facts);
  }

  /** Set (or clear) the session's timer for these facts. */
  async schedule(sessionId: string, facts: PromptCacheFacts | undefined): Promise<void> {
    if (this.stopped) return;
    const cfg = await this.deps.config();
    const window = cfg.enabled ? idleCompactionWindow(facts, this.deps.now(), { limitPercent: cfg.limitPercent, leadMs: cfg.leadMs }) : null;
    if (!window || !facts) { this.cancel(sessionId, 'no-window'); return; }
    const prev = this.timers.get(sessionId);
    if (prev?.requestAt === facts.requestAt) return;
    // Facts read before a newer turn end armed its own timer: the newer one stands.
    if (prev && Date.parse(prev.requestAt) > Date.parse(facts.requestAt)) return;
    if (prev) this.deps.clearTimer(prev.timer);
    const delay = Math.max(0, window.fireAtMs - this.deps.now());
    const requestAt = facts.requestAt;
    const timer = this.deps.setTimer(() => { void this.fire(sessionId, requestAt); }, delay);
    this.timers.set(sessionId, { timer, requestAt });
    log.session.info('idle compaction armed', { sessionId, tokens: facts.tokens, inMs: delay, expiresAt: facts.expiresAt });
  }

  cancel(sessionId: string, why: string): void {
    if (why === 'turn-not-clean' || why === 'session-error' || why === 'send') this.held.add(sessionId);
    if (why === 'deleted') this.held.delete(sessionId);
    const t = this.timers.get(sessionId);
    if (!t) return;
    this.deps.clearTimer(t.timer);
    this.timers.delete(sessionId);
    log.session.debug('idle compaction disarmed', { sessionId, why });
  }

  /** The timer fired: send the compaction if the session is still idle on the same request. */
  async fire(sessionId: string, scheduledFor: string): Promise<'sent' | string> {
    const mine = this.timers.get(sessionId);
    if (mine?.requestAt === scheduledFor) this.timers.delete(sessionId);
    if (this.stopped) return 'stopped';
    const cfg = await this.deps.config();
    const rec = await this.deps.getSession(sessionId);
    const task = rec?.taskId ? await this.deps.getTask(rec.taskId) : null;
    const live = this.deps.live(sessionId);
    const facts = live.promptCache ?? rec?.promptCache;
    const why = skipReason({
      rec, task, facts, scheduledFor, live,
      queued: rec ? await this.deps.queued(sessionId) : 0,
      orgOff: task ? await this.deps.orgOffFor(task) : false,
      nowMs: this.deps.now(), cfg,
    });
    if (why) {
      log.session.info('idle compaction skipped', { sessionId, taskId: rec?.taskId, why });
      return why;
    }
    const now = this.deps.now();
    const rowId = `${QUIET_ROW_PREFIX}idle-compact-${randomUUID()}`;
    // Bound to its row from here: a send of anyone else's from now on ends it (and the send below then
    // stores nothing), so a person's message is never the quiet one.
    beginQuietTurn(sessionId, 'idle-compact', IDLE_COMPACT_SOURCE, now, rowId);
    const mineStill = () => quietTurnRow(sessionId) === rowId;
    // Asked again now that it is bound: a turn or a message that began during the checks above wins.
    if (this.deps.live(sessionId).inTurn === true || await this.deps.queued(sessionId) > 0) {
      endQuietTurn(sessionId, 'busy');
      log.session.info('idle compaction skipped', { sessionId, taskId: rec?.taskId, why: 'busy' });
      return 'busy';
    }
    this.deps.announce(sessionId, true);
    const lineUuid = idleCompactLineUuid(randomUUID());
    // skipReason passed, so the facts are past a known threshold.
    const reason = idleCompactReasonOf(facts, cfg.limitPercent)!;
    try {
      await this.deps.send(sessionId, IDLE_COMPACT_TEXT, {
        source: IDLE_COMPACT_SOURCE, ...(rec!.taskId ? { taskId: rec!.taskId } : {}),
        messageId: rowId, userUuid: lineUuid, stillWanted: mineStill,
      });
      if (!mineStill()) {
        // Someone else took the session while the row was being stored: it goes no further.
        await this.takeBack(sessionId, rowId, 'superseded');
        return 'superseded';
      }
      // Stored once it is on its way: status-reconcile reads the turn before it, a restart finds its row.
      const sentAt = new Date(now).toISOString();
      await this.deps.saveSession(sessionId, {
        idleCompaction: {
          sentAt,
          ...(rec!.last_status_change ? { priorTurnEnd: rec!.last_status_change } : {}),
          tokens: facts!.tokens,
          rowId,
        },
        // Its row says why (session-history route): kept by the line's uuid, the row's id.
        idleCompactionLog: [...(rec!.idleCompactionLog ?? []).slice(-(REASON_LOG_MAX - 1)), { lineUuid, sentAt, ...reason }],
      });
      if (!mineStill()) await this.noteQuietEnd(sessionId);
      const expiresAtMs = Date.parse(facts!.expiresAt ?? '');
      this.deps.emitNote(sessionId, rec!.taskId, idleCompactNote(reason, (expiresAtMs - now) / 60_000));
      log.session.info('idle compaction sent', { sessionId, taskId: rec!.taskId, tokens: facts!.tokens, expiresAt: facts!.expiresAt });
      return 'sent';
    } catch (err) {
      if (!mineStill()) return 'superseded';
      endQuietTurn(sessionId, 'send-failed');
      log.session.warn('idle compaction send failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
      return 'send-failed';
    }
  }

  /**
   * At boot: a timer for every session whose stored facts still have a window. A compaction the
   * restart cut off is not resumed: its row, if still waiting, is taken back, and its end stored
   * (a restart forgets which turn was quiet, so a late result reads as an ordinary turn end).
   */
  async rebuild(): Promise<number> {
    this.lastCfg ??= JSON.stringify(await this.deps.config());
    let n = 0;
    for (const rec of await this.deps.listSessions()) {
      const ic = rec.idleCompaction;
      if (ic && !ic.endedAt) {
        if (ic.rowId) await this.takeBack(rec.claudeSessionId, ic.rowId, 'restart');
        await this.noteQuietEnd(rec.claudeSessionId);
      }
      if (!rec.promptCache) continue;
      await this.schedule(rec.claudeSessionId, rec.promptCache);
      if (this.timers.has(rec.claudeSessionId)) n++;
    }
    return n;
  }

  /** Every session's timer again from its facts, under the settings now (a config change). */
  async rearm(): Promise<number> {
    const cfg = JSON.stringify(await this.deps.config());
    if (cfg === this.lastCfg) return 0;
    this.lastCfg = cfg;
    let n = 0;
    for (const rec of await this.deps.listSessions()) {
      if (this.held.has(rec.claudeSessionId)) continue;
      const facts = this.deps.live(rec.claudeSessionId).promptCache ?? rec.promptCache;
      if (!facts) continue;
      const sent = rec.idleCompaction && Date.parse(rec.idleCompaction.sentAt) >= Date.parse(facts.requestAt);
      if (sent) continue;
      await this.schedule(rec.claudeSessionId, facts);
      if (this.timers.has(rec.claudeSessionId)) n++;
    }
    return n;
  }

  stop(): void {
    this.stopped = true;
    if (this.rearmTimer) this.deps.clearTimer(this.rearmTimer);
    for (const t of this.timers.values()) this.deps.clearTimer(t.timer);
    this.timers.clear();
  }

  /** Tests only. */
  armedFor(sessionId: string): string | undefined { return this.timers.get(sessionId)?.requestAt; }
}

/** Start the idle compaction on the primary. */
export function startIdleCompaction(
  runner: RunnerView,
  deps: Partial<IdleCompactionDeps> = {},
): { stop: () => void; instance: IdleCompaction } {
  liveRunner = runner;
  const ic = new IdleCompaction(deps);
  onQuietTurnEnd(ic.onQuietEnd);
  bus.subscribe('idle-compaction', ic.handleEvent, {
    global: true,
    interest: ['session:result', 'session:error', 'session:send', 'session:deleted', 'session:will-reap', 'config:changed'],
  });
  void ic.rebuild().then((n) => { if (n) log.session.info('idle compaction timers rebuilt', { armed: n }); })
    .catch((err) => log.session.warn('idle compaction rebuild failed', { error: err instanceof Error ? err.message : String(err) }));
  return {
    instance: ic,
    stop: () => {
      bus.unsubscribe('idle-compaction');
      onQuietTurnEnd(null);
      ic.stop();
      if (liveRunner === runner) liveRunner = null;
    },
  };
}
