/**
 * After a compaction, a long-lived session whose stored prompt is far behind moves onto its
 * current prompt: once its turn has ended and it stayed quiet, Walnut respawns its CLI with no
 * turn (the Restart path), keeping the conversation, and the new process runs on the current
 * default instructions.
 *
 * Why (2026-11-11, the org review): a resume replays the spawn-time prompt to keep its cache, and
 * prompt-refresh.ts gave that up only for an expired cache, which a busy node never reaches. The
 * Walnut VP, spawned 2026-10-24 on a 3 KB prompt, was restated about 33 KB of instructions after
 * each compaction (the hook's part, then a 31 KB notice in front of its next message), 4 to 6
 * times a day for weeks. The respawn writes the conversation to the cache once; it is tried right
 * after a compaction, where the conversation is smallest, and only when that costs less than the
 * restatements it saves (`refreshPays`: about a week of compactions for Main, a VP or a lead, one
 * for any other session; after Walnut's own idle compaction nothing read the context yet, so then
 * it costs only the old prompt).
 *
 * Decided once per compaction boundary (`SessionRecord.promptRefresh`). Never while anything could
 * be cut: only a live idle CLI on a clean turn end, quiet for QUIET_MS, with no prompt open, no
 * queued message, no quiet turn, no idle compaction armed (its own compaction comes first, and the
 * respawn after it is free), no work that outlives the turn (a background command or subagent, a
 * wakeup or a /loop it armed, outlivingWorkOf: a respawn would end it), a task not complete, and for an org node
 * an org that is on. Any send to the session meanwhile cancels it (that message carries the notice,
 * and the next turn end decides again). Primary only (server.ts). WALNUT_PROMPT_REFRESH=0 turns it
 * off with the cold-resume refresh; WALNUT_PROMPT_REFRESH_RESPAWN=0 turns off only this.
 */
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import { log } from '../../logging/index.js';
import type { SessionRecord, Task } from '../types.js';
import type { PromptCacheFacts } from './prompt-cache.js';
import { quietTurnRunning } from './quiet-turn.js';
import { statusQuestionPending } from './status-question.js';
import {
  nothingReadSinceCompaction, promptDebtBytes, promptRefreshable, refreshHorizon, refreshPays,
} from './prompt-refresh.js';

/** How long a session stays quiet after its turn end before it is respawned. */
export const QUIET_MS = 20_000;
/** A side question still on its way at the quiet time's end is waited for this many more times. */
const ASKING_RETRIES = 3;

export interface PromptRefreshRespawnDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (t: ReturnType<typeof setTimeout>) => void;
  quietMs: number;
  getSession: (sessionId: string) => Promise<SessionRecord | null>;
  saveSession: (sessionId: string, updates: Partial<SessionRecord>) => Promise<unknown>;
  getTask: (taskId: string) => Promise<Task | null>;
  /** What the live runner knows; `inTurn` null when it holds no runner for the session. */
  live: (sessionId: string) => { promptCache?: PromptCacheFacts; inTurn: boolean | null; outliving: number; asking: number };
  /** The turn-end status question is waiting for its quiet time or on its way. */
  statusQuestion: (sessionId: string) => boolean;
  /** Rows waiting in Walnut's queue for the session. */
  queued: (sessionId: string) => Promise<number>;
  /** The idle compaction has a timer set for the session. */
  idleCompactionArmed: (sessionId: string) => boolean;
  /** The org is off and this task is Main or a VP. */
  orgOffFor: (task: Task) => Promise<boolean>;
  /** Respawn on the current prompt; `stillWanted` is asked right before the old CLI is stopped. */
  respawn: (sessionId: string, stillWanted: () => boolean) => Promise<'respawned' | 'not-due' | 'gave-way'>;
  emitNote: (sessionId: string, taskId: string | undefined, message: string) => void;
  /** Re-read the user's profile and Reply language, which the default instructions read. */
  refreshInputs: () => Promise<void>;
  /** Bytes of the current default instructions the stored prompt lacks (prompt-refresh.ts). */
  debtBytes: (rec: SessionRecord, task: Task) => number;
}

type RunnerView = {
  promptCacheOf(id: string): PromptCacheFacts | undefined;
  isInTurn(id: string): boolean | null;
  outlivingWorkOf(id: string): readonly string[];
  controlRequestsPendingOf(id: string): number;
  respawnOnCurrentPrompt(id: string, stillWanted: () => boolean): Promise<'respawned' | 'not-due' | 'gave-way'>;
};

function defaultDeps(runner: RunnerView, idleArmed: (id: string) => boolean): PromptRefreshRespawnDeps {
  const quiet = Number(process.env.WALNUT_PROMPT_REFRESH_QUIET_MS);
  return {
    now: () => Date.now(),
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimer: (t) => clearTimeout(t),
    quietMs: Number.isFinite(quiet) && quiet > 0 ? quiet : QUIET_MS,
    getSession: async (id) => (await import('../session-tracker.js')).getSessionByClaudeId(id),
    // Its own bookkeeping is no activity of the session's.
    saveSession: async (id, updates) => (await import('../session-tracker.js')).updateSessionRecordConditionally(id, updates, () => true, { preserveLastActiveAt: true }),
    getTask: async (id) => (await import('../task-manager.js')).getTask(id).catch(() => null),
    live: (id) => ({
      promptCache: runner.promptCacheOf(id),
      inTurn: runner.isInTurn(id),
      outliving: runner.outlivingWorkOf(id).length,
      asking: runner.controlRequestsPendingOf(id),
    }),
    statusQuestion: (id) => statusQuestionPending(id),
    queued: async (id) => {
      const { getQueue } = await import('../session-message-queue.js');
      return (await getQueue(id)).filter((m) => m.status === 'pending' || m.status === 'processing').length;
    },
    idleCompactionArmed: idleArmed,
    orgOffFor: async (task) => {
      const { isOrgEnabled, isOrgNode } = await import('../org/org-enabled.js');
      return isOrgNode(task) && !(await isOrgEnabled());
    },
    respawn: (id, stillWanted) => runner.respawnOnCurrentPrompt(id, stillWanted),
    emitNote: (sessionId, taskId, message) => {
      bus.emit(EventNames.SESSION_SYSTEM_EVENT, { sessionId, taskId, variant: 'info' as const, message },
        ['main-ai'], { source: 'prompt-refresh' });
    },
    debtBytes: (rec, task) => promptDebtBytes(rec, task),
    refreshInputs: async () => {
      const [{ refreshUserProfile }, { refreshReplyLanguage }] = await Promise.all([
        import('./user-profile-context.js'), import('./reply-language-context.js'),
      ]);
      await Promise.all([refreshUserProfile(), refreshReplyLanguage()]);
    },
  };
}

/** The words of the timeline note when the session moved onto its current prompt. */
export function promptRefreshNote(debtBytes: number): string {
  return `Restarted this session on its current instructions after its compaction (its prompt lacked ${Math.round(debtBytes / 1024)} KB of them); the conversation is kept.`;
}

/** Why a session's respawn is not done now, or null to do it. Pure; exported for tests. */
export function respawnSkipReason(input: {
  rec: SessionRecord | null;
  task: Task | null;
  boundary: string;
  live: { inTurn: boolean | null; outliving: number; asking: number };
  /** The turn-end status question has not been answered yet. */
  statusQuestion: boolean;
  queued: number;
  quietTurn: boolean;
  idleCompactionArmed: boolean;
  orgOff: boolean;
}): string | null {
  const { rec, task, live } = input;
  if (!rec || rec.archived || rec.supersededBy) return 'session-gone';
  if (rec.provider === 'embedded' || !promptRefreshable(rec)) return 'not-refreshable';
  if (rec.lastCompactUuid !== input.boundary) return 'newer-boundary';
  if (rec.promptRefresh?.compactUuid === input.boundary) return 'decided';
  // Only a live CLI between turns: a stopped one moves onto the current prompt at its next resume.
  if (rec.process_status !== 'idle') return `status-${rec.process_status}`;
  if (rec.pendingPermission) return 'prompt-open';
  if (rec.stopRequest?.state === 'pending') return 'stop-pending';
  // A context-full recovery resends what got no answer once its compaction ends.
  if (rec.contextRecovery?.state === 'compacting') return 'context-recovery';
  if (!task || task.phase === 'COMPLETE') return 'task-complete';
  if (input.orgOff) return 'org-off';
  if (live.inTurn !== false) return live.inTurn === null ? 'no-runner' : 'turn-running';
  if (live.outliving > 0) return 'work-outlives-turn';
  // A side question in flight (the turn-end status question, a person's /btw) dies with the CLI.
  if (input.statusQuestion || live.asking > 0) return 'asking';
  if (input.quietTurn) return 'quiet-turn';
  if (input.idleCompactionArmed) return 'idle-compaction-armed';
  if (input.queued > 0) return 'messages-queued';
  return null;
}

export class PromptRefreshRespawn {
  private readonly deps: PromptRefreshRespawnDeps;
  /** sessionId → the timer and the turn end it was set at. */
  private readonly timers = new Map<string, { timer: ReturnType<typeof setTimeout>; token: string; retries: number }>();
  /** Sessions being respawned now; a send to one takes it out, and the respawn gives way. */
  private readonly firing = new Set<string>();
  /** When a send to each session last came: one during a turn end's own reads still cancels it. */
  private readonly sentAt = new Map<string, number>();
  private stopped = false;

  constructor(deps: PromptRefreshRespawnDeps) {
    this.deps = deps;
  }

  handleEvent = (event: BusEvent): void => {
    const d = event.data as { sessionId?: string; isError?: boolean; interrupted?: boolean; teamActive?: boolean; backgroundActive?: boolean; sessionIds?: string[] };
    switch (event.name) {
      case EventNames.SESSION_RESULT:
        if (!d.sessionId) return;
        if (d.isError || d.interrupted || d.teamActive || d.backgroundActive) { this.cancel(d.sessionId, 'turn-not-clean'); return; }
        void this.onTurnEnd(d.sessionId, this.deps.now()).catch((err) => log.session.warn('prompt refresh: turn end failed', {
          sessionId: d.sessionId, error: err instanceof Error ? err.message : String(err),
        }));
        return;
      case EventNames.SESSION_ERROR:
        if (d.sessionId) this.cancel(d.sessionId, 'session-error');
        return;
      case EventNames.SESSION_SEND:
        if (d.sessionId) { this.cancel(d.sessionId, 'send'); this.firing.delete(d.sessionId); this.sentAt.set(d.sessionId, this.deps.now()); }
        return;
      case EventNames.SESSION_DELETED:
        for (const id of d.sessionIds ?? (d.sessionId ? [d.sessionId] : [])) { this.cancel(id, 'deleted'); this.sentAt.delete(id); }
        return;
    }
  };

  /**
   * A clean turn end of a session that compacted: set the quiet timer. Everything is decided when
   * it fires, from the record then: the CLI writes the boundary just before the result of a
   * `/compact` turn, and the record learns it a moment after the result.
   */
  async onTurnEnd(sessionId: string, endedAt = this.deps.now()): Promise<void> {
    if (this.stopped || process.env.WALNUT_PROMPT_REFRESH_RESPAWN === '0') return;
    const rec = await this.deps.getSession(sessionId);
    if (!rec || !promptRefreshable(rec)) return;
    // A send that came while the record was read (context-full recovery resends on this result).
    if ((this.sentAt.get(sessionId) ?? -Infinity) >= endedAt) return;
    const compactedAt = this.deps.live(sessionId).promptCache?.compactedAt;
    const recorded = rec.lastCompactAt ? Date.parse(rec.lastCompactAt) : NaN;
    // A compaction the record has not learnt yet is newer than its last one.
    const unseen = !!compactedAt && !(Date.parse(compactedAt) <= recorded);
    if (!unseen && (!rec.lastCompactUuid || rec.promptRefresh?.compactUuid === rec.lastCompactUuid)) return;
    const prev = this.timers.get(sessionId);
    if (prev) this.deps.clearTimer(prev.timer);
    this.arm(sessionId, String(this.deps.now()), 0);
  }

  private arm(sessionId: string, token: string, retries: number): void {
    const timer = this.deps.setTimer(() => { void this.fire(sessionId, token); }, this.deps.quietMs);
    this.timers.set(sessionId, { timer, token, retries });
  }

  private verdict(rec: SessionRecord, task: Task): { pays: boolean; debtBytes: number; rewriteTokens?: number } {
    const facts = this.deps.live(rec.claudeSessionId).promptCache ?? rec.promptCache;
    const debtBytes = this.deps.debtBytes(rec, task);
    const pays = refreshPays({
      facts, debtBytes, storedPromptBytes: Buffer.byteLength(rec.appliedAppendSystemPrompt ?? '', 'utf8'),
      horizon: refreshHorizon(task), now: this.deps.now(),
    });
    return { pays, debtBytes, ...(facts ? { rewriteTokens: nothingReadSinceCompaction(facts) ? 0 : facts.tokens } : {}) };
  }

  cancel(sessionId: string, why: string): void {
    const t = this.timers.get(sessionId);
    if (!t) return;
    this.deps.clearTimer(t.timer);
    this.timers.delete(sessionId);
    log.session.debug('prompt refresh: respawn disarmed', { sessionId, why });
  }

  /** The quiet time passed: decide, and respawn if it pays and nothing could be cut. */
  async fire(sessionId: string, token: string): Promise<'respawned' | string> {
    const mine = this.timers.get(sessionId);
    if (!mine || mine.token !== token) return 'superseded';
    this.timers.delete(sessionId);
    if (this.stopped) return 'stopped';
    const rec = await this.deps.getSession(sessionId);
    const boundary = rec?.lastCompactUuid;
    if (!rec || !boundary || rec.promptRefresh?.compactUuid === boundary) return 'decided';
    const task = rec.taskId ? await this.deps.getTask(rec.taskId) : null;
    if (!task || task.phase === 'COMPLETE') return 'task-complete';
    await this.deps.refreshInputs();
    const verdict = this.verdict(rec, task);
    const base = { compactUuid: boundary, debtBytes: verdict.debtBytes, ...(verdict.rewriteTokens !== undefined ? { rewriteTokens: verdict.rewriteTokens } : {}) };
    const stamp = () => new Date(this.deps.now()).toISOString();
    if (!verdict.pays) {
      // Decided for this context: its later turn ends only grow what a respawn would write again.
      const outcome = verdict.debtBytes > 0 ? 'not-worth' as const : 'current' as const;
      await this.deps.saveSession(sessionId, { promptRefresh: { ...base, at: stamp(), outcome } });
      if (outcome === 'not-worth') log.session.info('prompt refresh: not worth a respawn', { sessionId, taskId: rec.taskId, ...base });
      return outcome;
    }
    // Nothing decided on a busy moment: the next clean turn end asks again.
    const why = respawnSkipReason({
      rec, task, boundary, live: this.deps.live(sessionId),
      queued: await this.deps.queued(sessionId),
      quietTurn: quietTurnRunning(sessionId), idleCompactionArmed: this.deps.idleCompactionArmed(sessionId),
      statusQuestion: this.deps.statusQuestion(sessionId),
      orgOff: await this.deps.orgOffFor(task),
    });
    // The status question comes 5 s after the turn end and may still run: it ends with no turn
    // end of its own to arm this again, so wait for it here.
    if (why === 'asking' && mine.retries < ASKING_RETRIES && !this.timers.has(sessionId)) {
      this.arm(sessionId, token, mine.retries + 1);
      return 'waiting';
    }
    if (why) {
      log.session.info('prompt refresh: respawn skipped', { sessionId, taskId: rec.taskId, why });
      return why;
    }
    // Recorded before the respawn: a crash or a failure never makes it try again on this context.
    this.firing.add(sessionId);
    await this.deps.saveSession(sessionId, { promptRefresh: { ...base, at: stamp(), outcome: 'respawned' } });
    try {
      const done = await this.deps.respawn(sessionId, () => this.firing.has(sessionId) && !this.stopped);
      if (done !== 'respawned') {
        // A message came first: that context is not decided, its next quiet turn end asks again.
        if (done === 'gave-way') await this.deps.saveSession(sessionId, { promptRefresh: undefined });
        else await this.deps.saveSession(sessionId, { promptRefresh: { ...base, at: stamp(), outcome: 'current' } });
        log.session.info('prompt refresh: respawn not done', { sessionId, taskId: rec.taskId, why: done });
        return done;
      }
      this.deps.emitNote(sessionId, rec.taskId, promptRefreshNote(verdict.debtBytes));
      log.session.info('prompt refresh: respawned on the current prompt', { sessionId, taskId: rec.taskId, ...base });
      return 'respawned';
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.deps.saveSession(sessionId, { promptRefresh: { ...base, at: stamp(), outcome: 'failed', error: error.slice(0, 300) } }).catch(() => {});
      log.session.warn('prompt refresh: respawn failed', { sessionId, taskId: rec.taskId, error });
      return 'failed';
    } finally {
      this.firing.delete(sessionId);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) this.deps.clearTimer(t.timer);
    this.timers.clear();
  }

  /** Tests only. */
  armed(sessionId: string): boolean { return this.timers.has(sessionId); }
}

/** Start it on the primary. */
export function startPromptRefreshRespawn(
  runner: RunnerView,
  idleCompactionArmed: (sessionId: string) => boolean,
  deps: Partial<PromptRefreshRespawnDeps> = {},
): { stop: () => void; instance: PromptRefreshRespawn } {
  const instance = new PromptRefreshRespawn({ ...defaultDeps(runner, idleCompactionArmed), ...deps });
  bus.subscribe('prompt-refresh-respawn', instance.handleEvent, {
    global: true,
    interest: ['session:result', 'session:error', 'session:send', 'session:deleted'],
  });
  return {
    instance,
    stop: () => {
      bus.unsubscribe('prompt-refresh-respawn');
      instance.stop();
    },
  };
}
