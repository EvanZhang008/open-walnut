/**
 * A Claude Code session never stays stuck on "Prompt is too long" (2026-11-05: a
 * session whose host had Claude Code's auto-compact off reached the CLI's hard
 * stop at 88% of its 200K window; every message after that, the user's "hi"
 * included, was refused before it reached the model, and the banner's Reconnect
 * could not help).
 *
 * When a turn ends with that error (sessions/context-full.ts isContextFullText),
 * Walnut compacts the conversation itself: it sends `/compact` as a quiet turn
 * (sessions/quiet-turn.ts: no phase move, no turn-end hook, no push), the same
 * way the idle compaction does, and once the compaction's result is clean it
 * sends one note that hands the session the messages that got no answer (their
 * text as it reached the session, kept in memory from the queue's own events),
 * so the work goes on where it stopped. With nothing kept (a server restart in
 * between) the note names the time from which messages went unanswered; the
 * compaction's summary holds them.
 *
 * At most MAX_ATTEMPTS_PER_HOUR compactions an hour start by themselves: one that
 * does not free enough room, or a compaction that fails, leaves the session in
 * `contextRecovery.state: 'failed'` with the reason, and the error banner's
 * "Compact and resend" (POST /sessions/:id/retry, which comes here for this
 * error) runs it again on a person's click. Claude Code sessions only: a lane,
 * the embedded runner and ACP engines are left alone. Primary only (server.ts).
 */
import { randomUUID } from 'node:crypto';
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import { log } from '../../logging/index.js';
import type { ContextRecoveryState, SessionRecord } from '../types.js';
import { isContextFullText } from './context-full.js';
import {
  addQuietTurnEndListener, beginQuietTurn, endQuietTurn, isQuietTurn, noteQuietTurnSettled, noteTurnStart,
  quietTurnKind, quietTurnRow, QUIET_ROW_PREFIX, type QuietTurnEnd,
} from './quiet-turn.js';
import { isAcpEngine } from '../agents/engine-registry.js';
import { CONTEXT_COMPACT_COMMAND } from './walnut-commands.js';

/** The send source of the recovery's `/compact` (send-frame passes it raw; an agent's, never a person's). */
export const CONTEXT_COMPACT_SOURCE = 'context-compact';
/** The send source of the note that resends what got no answer. */
export const CONTEXT_RESEND_SOURCE = 'context-recovery';
/** Its line: the command, and words that tell every history reader Walnut sent it (sessions/walnut-commands.ts). */
export const CONTEXT_COMPACT_TEXT = CONTEXT_COMPACT_COMMAND;
/** Compactions that start by themselves per session per hour; a person's click is not counted against it. */
export const MAX_ATTEMPTS_PER_HOUR = 2;
const HOUR_MS = 60 * 60_000;
/** Messages kept per session to resend, the characters kept of each, and of the whole note. */
const KEEP_ROWS = 40;
const KEEP_CHARS = 40_000;
const NOTE_CHARS = 160_000;

/** A message that reached the session, as the queue reported it. */
interface SeenRow {
  id: string;
  text: string;
  source?: string;
  sentBy?: 'person' | 'agent';
  at: string;
  delivered?: boolean;
  /** The model got it (`session:user-line`): a clean turn after this answered it. */
  taken?: boolean;
}

/** One recovery of a session, from the overflow to the resend's send. */
interface Run {
  /** The /compact's queue row, once sent. */
  rowId?: string;
  /** `ending`: a terminal path is writing the run's last state. */
  phase: 'deciding' | 'compacting' | 'resending' | 'ending';
  manual: boolean;
  /** The attempt this run counted against the hour's cap (absent for a person's click). */
  attemptAt?: string;
  /** The stop fence the overflow came under: a Stop after it refuses every send of this run. */
  fence: string | null;
  /** Someone else's send went out with the /compact already in the CLI: its next turn end is the compaction's. */
  unquiet?: boolean;
  /** An overflow came after the resend went out: the run that follows takes it. */
  overflowAgain?: boolean;
  /** A person pressed Stop (`session:interrupt`; a UI Stop moves no stop fence): nothing more is sent. */
  stopped?: boolean;
  /** Its last state is being written: a second terminal path does nothing. */
  finishing?: boolean;
  /** A person's click came while this run was letting go: it runs once the run released the session. */
  retryAfter?: boolean;
  /** Armed once the compaction is no longer a quiet turn (whose own clock then stopped). */
  deadline?: ReturnType<typeof setTimeout>;
}

/** How long a compaction that stopped being quiet may run before the run gives up (the quiet turn's own limit). */
const UNQUIET_DEADLINE_MS = 30 * 60_000;

export interface ContextFullRecoveryDeps {
  now: () => number;
  getSession: (sessionId: string) => Promise<SessionRecord | null>;
  saveSession: (sessionId: string, updates: Partial<SessionRecord>) => Promise<unknown>;
  send: (sessionId: string, text: string, opts: { source: string; taskId?: string; messageId?: string; userUuid?: string; stillWanted?: () => boolean; stopFence?: string | null }) => Promise<unknown>;
  emitNote: (sessionId: string, taskId: string | undefined, message: string, variant: 'info' | 'error') => void;
  /** Tell the open panels Walnut compacts the session (their working line says so), or stopped. */
  announce: (sessionId: string, active: boolean) => void;
  /** Tell the open panels the recovery's state changed (their banner reads it). */
  announceState: (sessionId: string, state: ContextRecoveryState) => void;
  /**
   * The recovery gave up: the session's failure is the user's now (the server raises its error card
   * and moves the phase). `failedAt` is the failed state's time: the server acts only while the
   * record still holds that failure (a click may have recovered it meanwhile).
   */
  gaveUp: (rec: SessionRecord, reason: string, failedAt: string) => Promise<void>;
  /** The session's stop fence now (sessions/session-stop.ts): a send bound to it is refused after a Stop. */
  stopFence: (sessionId: string) => Promise<string | null>;
  /** Whether the task is still open: a completed task's session is never set to work again. */
  taskOpen: (taskId: string) => Promise<boolean>;
  /** Take a queued row back before it goes out (a Stop after the resend was queued). */
  deleteQueued: (sessionId: string, messageId: string) => Promise<boolean>;
  /**
   * Whether the session's transcript, in its host, shows a compaction at or after `since`: true or
   * false, or null when it cannot be read now (the host is away). A restart that caught a compaction
   * asks it (2026-11-06: the compaction had finished in its host while Walnut restarted).
   */
  compactedSince: (rec: SessionRecord, since: string) => Promise<boolean | null>;
}

/**
 * Told whenever a recovery fails (gave up, or was stopped): a reader that held a turn's end for the
 * recovery settles it then (triage/runs.ts: a run held on "Prompt is too long" settles as the error).
 */
export interface ContextRecoveryFail { sessionId: string; taskId?: string; reason: string }
const failListeners = new Set<(fail: ContextRecoveryFail) => void>();
export function addContextRecoveryFailListener(listener: (fail: ContextRecoveryFail) => void): () => void {
  failListeners.add(listener);
  return () => { failListeners.delete(listener); };
}

/** How long, and how often, a compaction a restart caught is looked for in its host. */
export const RESTART_CHECK_MS = 30 * 60_000;
export const RESTART_CHECK_EVERY_MS = 30_000;

/** A stop still waits for its host: the session takes no new work until it settles. */
const PENDING_STOP = Symbol('pending-stop');

/** The WebSocket event the panels read (web/src/components/sessions/ContextFullBanner.tsx). */
export const CONTEXT_RECOVERY_EVENT = 'session:context-recovery';

function defaultDeps(): ContextFullRecoveryDeps {
  return {
    now: () => Date.now(),
    getSession: async (id) => (await import('../session-tracker.js')).getSessionByClaudeId(id),
    saveSession: async (id, updates) => (await import('../session-tracker.js'))
      .updateSessionRecordConditionally(id, updates, () => true, { preserveLastActiveAt: true }),
    send: async (id, text, opts) => (await import('../session-message-queue.js')).sendMessageToSession(id, text, opts),
    emitNote: (sessionId, taskId, message, variant) => {
      bus.emit(EventNames.SESSION_SYSTEM_EVENT, { sessionId, taskId, variant, message },
        ['main-ai'], { source: CONTEXT_COMPACT_SOURCE, urgency: 'urgent' });
    },
    announce: (sessionId, active) => {
      // The idle compaction's event: the panels say "Walnut is compacting" on it, and `reason` says
      // this one is for a conversation that no longer fits (an older page reads it as idle).
      void import('./idle-compaction.js').then(({ IDLE_COMPACTION_EVENT }) =>
        import('../../web/ws/handler.js').then(({ broadcastEvent }) => broadcastEvent(IDLE_COMPACTION_EVENT, { sessionId, active, reason: 'context' })))
        .catch(() => {});
    },
    announceState: (sessionId, state) => {
      // The words still owed stay on the record; the banner needs none of them.
      const { owed: _owed, ...shown } = state;
      void import('../../web/ws/handler.js').then(({ broadcastEvent }) => broadcastEvent(CONTEXT_RECOVERY_EVENT, { sessionId, contextRecovery: shown }))
        .catch(() => {});
    },
    gaveUp: async () => {},
    stopFence: async (id) => (await import('./session-stop.js')).sessionStops.fence(id),
    deleteQueued: async (id, messageId) => (await import('../session-message-queue.js')).deleteMessage(id, messageId),
    taskOpen: async (taskId) => {
      const { getTask } = await import('../task-manager.js');
      const task = await getTask(taskId).catch(() => null);
      return !!task && task.phase !== 'COMPLETE';
    },
    compactedSince: async (rec, since) => {
      const { readSessionHistoryTail } = await import('../session-history.js');
      const rows = await readSessionHistoryTail(rec.claudeSessionId, rec.cwd, rec.host ?? undefined, rec.outputFile, 2 * 1024 * 1024)
        .catch(() => null);
      return rows?.length ? compactedAtOrAfter(rows, since) : null;
    },
  };
}

/** How far a host's clock may run behind the server's, for a compaction told apart by its time only. */
const HOST_CLOCK_SKEW_MS = 10 * 60_000;

/**
 * Whether a history shows a finished compaction after the overflow it was for. Told by order: a
 * compaction row after the last "Prompt is too long" (2026-11-06 review: the server's clock against
 * the host's missed a real one on a host running behind, and a row with no time of its own reads as
 * now). Only when the overflow is out of the window read, by its time, give or take a host clock.
 * Pure; exported for tests.
 */
export function compactedAtOrAfter(rows: ReadonlyArray<{ role: string; systemVariant?: string; text: string; timestamp: string }>, since: string): boolean {
  const compacted = (r: (typeof rows)[number]) => r.role === 'system' && r.systemVariant === 'compact' && r.text.startsWith('Context compacted');
  let overflow = -1;
  // The CLI's reply reads as an error row (session-history.ts cliError), an older parse's as an answer.
  rows.forEach((r, i) => { if (r.role !== 'user' && r.systemVariant !== 'compact' && isContextFullText(r.text)) overflow = i; });
  if (overflow >= 0) return rows.slice(overflow + 1).some(compacted);
  const from = Date.parse(since) - HOST_CLOCK_SKEW_MS;
  return rows.some((r) => compacted(r) && Date.parse(r.timestamp) >= from);
}

/** The owed rows a record keeps: newest first into the note's budget, kept oldest first. */
function owedForRecord(rows: ReadonlyArray<SeenRow>): ContextRecoveryState['owed'] {
  let budget = NOTE_CHARS;
  const kept: NonNullable<ContextRecoveryState['owed']> = [];
  for (const r of [...rows].reverse()) {
    if (budget <= 0) break;
    const text = r.text.slice(0, Math.min(KEEP_CHARS, budget));
    budget -= text.length;
    kept.unshift({ id: r.id, text, at: r.at, ...(r.sentBy ? { sentBy: r.sentBy } : {}), ...(r.source ? { source: r.source } : {}) });
  }
  return kept;
}

/** The words of the note that hands the session what got no answer. Pure; exported for tests. */
export function resendNoteText(rows: ReadonlyArray<Pick<SeenRow, 'text' | 'sentBy' | 'at'>>, failedSince: string | undefined): string {
  const head = 'Walnut compacted this conversation: it no longer fit the model\'s context window, and Claude Code '
    + 'answered "Prompt is too long" to every message that reached you'
    + (failedSince ? ` from ${failedSince}` : '') + ', so none of them got an answer.';
  if (rows.length === 0) {
    return `${head} Their words are in the summary above. Answer them now, in order, and carry on with the work they ask for.`;
  }
  // Newest first into the budget (the latest ask matters most), then shown oldest first.
  let budget = NOTE_CHARS;
  let cut = false;
  const kept = [...rows].reverse().map((r) => {
    const room = Math.max(0, Math.min(KEEP_CHARS, budget));
    const text = r.text.length > room ? r.text.slice(0, room) : r.text;
    if (text.length < r.text.length) cut = true;
    budget -= text.length;
    return { ...r, text, left: r.text.length - text.length };
  }).reverse();
  const items = kept.map((r, i) => {
    const who = r.sentBy === 'person' ? 'the user' : 'Walnut or another task';
    const tail = r.left > 0 ? `\n[${r.left} more characters of this message are left out here; the summary above holds its gist]` : '';
    return `--- Message ${i + 1} of ${kept.length}, from ${who}, at ${r.at} ---\n${r.text}${tail}`;
  });
  const how = cut ? 'as they reached you, the longest cut where marked' : 'exactly as they reached you';
  return `${head} Here they are again, oldest first, ${how}. Answer them now and carry on with the work they ask for.\n\n${items.join('\n\n')}`;
}

/** Whether a recovery may start by itself now: the attempts of the last hour are under the cap. Pure. */
export function attemptsLeft(state: ContextRecoveryState | undefined, nowMs: number): { recent: string[]; left: number } {
  const recent = (state?.attempts ?? []).filter((t) => nowMs - Date.parse(t) < HOUR_MS);
  return { recent, left: MAX_ATTEMPTS_PER_HOUR - recent.length };
}

/** Why a session is not one this recovery handles, or null. Pure. */
export function notRecoverable(rec: SessionRecord | null): string | null {
  if (!rec || rec.archived) return 'session-gone';
  if (rec.lane || rec.provider === 'embedded' || isAcpEngine(rec.engine)) return 'not-a-claude-session';
  if (rec.supersededBy) return 'superseded';
  return null;
}

export class ContextFullRecovery {
  private readonly deps: ContextFullRecoveryDeps;
  /** sessionId → the messages the queue reported for it, newest last. */
  private readonly seen = new Map<string, SeenRow[]>();
  /** sessionId → the messages that got "Prompt is too long" since its last clean turn. */
  private readonly failed = new Map<string, SeenRow[]>();
  /**
   * sessionId → the recovery that holds it, from the overflow to the resend's send: while it holds,
   * nothing else starts one and nothing else writes its state (2026-11-05 review: a late write of
   * one run overwrote the next one's).
   */
  private readonly running = new Map<string, Run>();
  /** Sessions whose CLI reports which lines the model took (`session:user-line`). */
  private readonly linesKnown = new Set<string>();
  /** Sessions whose record says the recovery failed: a clean turn of their own settles it. */
  private readonly failedState = new Set<string>();
  /** sessionId → the slash command queued last (a person's `/compact`, `/clear`): its turn answers nothing. */
  private readonly slashQueued = new Map<string, string>();
  /** Sessions the model replied to live since their last result (`liveReply` usage). */
  private readonly replied = new Set<string>();
  /** sessionId → the resend note's queue row, until a clean turn answered it. */
  private readonly resendRow = new Map<string, { id: string; taken?: boolean }>();
  /** Sessions a restart caught compacting: their next clean result is that compaction's end. */
  private readonly restartCompacting = new Set<string>();
  /** The host checks of those sessions (rebuild): stopped with the recovery. */
  private readonly restartChecks = new Map<string, ReturnType<typeof setTimeout>>();
  /** The stop fence each of those sessions stood under at boot: a Stop after it refuses their resend. */
  private readonly restartFence = new Map<string, string | null>();
  private stopped = false;

  constructor(deps: Partial<ContextFullRecoveryDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  handleEvent = (event: BusEvent): void => {
    const d = event.data as Record<string, unknown> & { sessionId?: string };
    if (this.stopped) return;
    if (event.name === EventNames.SESSION_DELETED) {
      const ids = Array.isArray(d.sessionIds) ? d.sessionIds : [d.sessionId];
      for (const id of ids) if (typeof id === 'string') this.forget(id);
      return;
    }
    const sessionId = typeof d.sessionId === 'string' ? d.sessionId : undefined;
    if (!sessionId) return;
    switch (event.name) {
      case EventNames.SESSION_MESSAGE_QUEUED:
        this.noteQueued(sessionId, d);
        return;
      case EventNames.SESSION_MESSAGES_DELIVERED:
        this.noteDelivered(sessionId, d.messageIds);
        return;
      case EventNames.SESSION_USER_LINE:
        this.noteTaken(sessionId, d.rowIds);
        return;
      case EventNames.SESSION_QUEUED_CANCELLED:
        // Stopped before the model got them (the CLI hands them back to the composer): never resent.
        this.noteCancelled(sessionId, d.messageIds);
        return;
      case EventNames.SESSION_USAGE_UPDATE:
        if (d.liveReply === true) this.replied.add(sessionId);
        return;
      case EventNames.SESSION_INTERRUPT: {
        const run = this.running.get(sessionId);
        if (run) run.stopped = true;
        // A resend still waiting in the queue was the recovery's, not the person's: a Stop takes it back.
        const row = this.resendRow.get(sessionId);
        if (row && !row.taken) void this.deps.deleteQueued(sessionId, row.id).catch(() => false);
        // A compaction a restart caught: a Stop ends the hold, and nothing is resent by itself.
        if (this.endRestartHold(sessionId)) {
          void this.fail(sessionId, undefined, 'The compaction was stopped.', undefined, { card: false }).catch(() => {});
        }
        return;
      }
      case EventNames.SESSION_RESULT: {
        const turnGen = typeof d.turnGen === 'number' ? d.turnGen : undefined;
        const outcome = d.interrupted === true || d.compactionStopped === true ? 'stopped' as const
          : d.isError === true ? String(d.result ?? '') : null;
        const run = this.running.get(sessionId);
        if (quietTurnKind(sessionId) === 'context-compact' && isQuietTurn(sessionId, turnGen)) {
          const restartEnd = !run && this.restartCompacting.has(sessionId);
          // A turn begun before the restart: its generation is remembered now, so the result's late
          // readers still read it as quiet once the resend went out.
          if (restartEnd && typeof turnGen === 'number' && !quietTurnRow(sessionId)) noteTurnStart(sessionId, turnGen);
          noteQuietTurnSettled(sessionId);
          if (run?.phase === 'compacting') void this.onCompactionEnd(sessionId, run, outcome);
          else if (restartEnd) this.onRestartCompactionEnd(sessionId, outcome);
          return;
        }
        // A compaction that stopped being quiet (someone else's send went out with it already in
        // the CLI) still runs first: the next turn end is its end.
        if (run?.phase === 'compacting' && run.unquiet && !d.teamActive && !d.backgroundActive) {
          void this.onCompactionEnd(sessionId, run, outcome);
          return;
        }
        if (d.teamActive || d.backgroundActive) return;
        const slash = this.slashQueued.get(sessionId);
        const modelReplied = this.replied.has(sessionId);
        this.slashQueued.delete(sessionId);
        this.replied.delete(sessionId);
        // A compaction a restart caught whose quiet mark is gone (its 30 minutes ran out): its end all the same.
        if (!run && this.restartCompacting.has(sessionId) && (outcome === null || !isContextFullText(outcome))) {
          this.onRestartCompactionEnd(sessionId, outcome);
          return;
        }
        // The turn that took the resend did not answer it: the words are still owed.
        const resend = this.resendRow.get(sessionId);
        if (outcome !== null && resend) resend.taken = false;
        if (d.isError === true && isContextFullText(String(d.result ?? ''))) {
          void this.onOverflow(sessionId).catch((err) => log.session.warn('context recovery: overflow not handled', {
            sessionId, error: err instanceof Error ? err.message : String(err),
          }));
          return;
        }
        if (outcome !== null || isQuietTurn(sessionId, turnGen)) return;
        if (slash && !modelReplied) {
          // A command the CLI ran itself (no model reply) answered nothing (2026-11-05 review: a
          // person's own /compact read as a clean turn and dropped the words still owed). A
          // compaction of theirs frees the room, so what got no answer goes out now.
          if (slash === '/compact') void this.resendOwed(sessionId);
          return;
        }
        // A clean, finished turn of the session's own answered what the model took before it ended.
        this.noteCleanTurn(sessionId);
        return;
      }
      case EventNames.SESSION_ERROR: {
        const run = this.running.get(sessionId);
        if (run?.phase !== 'compacting') return;
        if ((quietTurnKind(sessionId) === 'context-compact' && isQuietTurn(sessionId)) || run.unquiet) {
          noteQuietTurnSettled(sessionId);
          void this.onCompactionEnd(sessionId, run, String(d.error ?? 'The compaction did not run.'));
        }
        return;
      }
    }
  };

  /** A quiet turn ended: one of this recovery's that never went out, or that someone else's send cut short. */
  readonly onQuietEnd = (end: QuietTurnEnd): void => {
    if (end.kind !== 'context-compact') return;
    const run = this.running.get(end.sessionId);
    if (!run || run.phase !== 'compacting' || run.rowId !== end.rowId || end.why === 'settled' || end.why === 'next-turn') return;
    const cutShort = end.why === 'other-send' || end.why === 'other-line' || end.why === 'turn-before-delivery' || end.why === 'replaced';
    if (cutShort && end.delivered) {
      // The CLI has the /compact and runs it before the newer message; its own turn end tells how it
      // went. The quiet turn's clock stopped with it, so the run keeps one of its own.
      run.unquiet = true;
      run.deadline ??= setTimeout(() => {
        if (this.running.get(end.sessionId) !== run || run.phase !== 'compacting') return;
        run.phase = 'ending';
        this.deps.announce(end.sessionId, false);
        void this.finish(end.sessionId, run, () => this.fail(end.sessionId, undefined, 'The compaction did not finish.'));
      }, UNQUIET_DEADLINE_MS);
      run.deadline.unref?.();
      return;
    }
    run.phase = 'ending';
    if (cutShort) {
      // Not delivered: the queue drops the /compact (session-message-queue.ts markProcessing), so no
      // compaction runs. The newer message gets "Prompt is too long" too, and that starts the next one.
      void this.abandon(end.sessionId, run);
      return;
    }
    void this.finish(end.sessionId, run, () => this.fail(end.sessionId, undefined, end.delivered
      ? 'The compaction did not finish.'
      : 'The compaction never reached the session.'));
  };

  private noteQueued(sessionId: string, d: Record<string, unknown>): void {
    const source = typeof d.source === 'string' ? d.source : undefined;
    if (source === CONTEXT_COMPACT_SOURCE || source === CONTEXT_RESEND_SOURCE) return;
    const id = typeof d.messageId === 'string' ? d.messageId : undefined;
    // The row as it reached the session: an agent's envelope, a person's image references and hints.
    const text = typeof d.rowText === 'string' ? d.rowText
      : typeof d.queuedText === 'string' ? d.queuedText : typeof d.message === 'string' ? d.message : '';
    const shown = typeof d.message === 'string' ? d.message : text;
    if (shown.trim().startsWith('/')) {
      this.slashQueued.set(sessionId, shown.trim().split(/\s+/)[0]!.toLowerCase());
      return;
    }
    if (!id || !text.trim()) return;
    const rows = this.seen.get(sessionId) ?? [];
    rows.push({
      id, text: text.slice(0, NOTE_CHARS), source,
      ...(d.sentBy === 'person' || d.sentBy === 'agent' ? { sentBy: d.sentBy } : {}),
      at: typeof d.enqueuedAt === 'string' ? d.enqueuedAt : new Date(this.deps.now()).toISOString(),
    });
    this.seen.set(sessionId, rows.slice(-KEEP_ROWS));
  }

  private noteDelivered(sessionId: string, ids: unknown): void {
    if (!Array.isArray(ids)) return;
    const resend = this.resendRow.get(sessionId);
    // A CLI that reports no lines it takes: a delivered resend counts as taken.
    if (resend && ids.includes(resend.id) && !this.linesKnown.has(sessionId)) resend.taken = true;
    for (const row of this.seen.get(sessionId) ?? []) if (ids.includes(row.id)) row.delivered = true;
  }

  private noteCancelled(sessionId: string, ids: unknown): void {
    if (!Array.isArray(ids)) return;
    const gone = (r: SeenRow) => !ids.includes(r.id);
    const seen = this.seen.get(sessionId);
    if (seen) this.seen.set(sessionId, seen.filter(gone));
    const failed = this.failed.get(sessionId);
    if (failed) this.failed.set(sessionId, failed.filter(gone));
  }

  /** A queued message was edited before it went out (session-message-queue.ts editMessage): resend the new words. */
  noteEdited(sessionId: string, messageId: string, text: string): void {
    const row = this.seen.get(sessionId)?.find((r) => r.id === messageId);
    if (row) row.text = text.slice(0, NOTE_CHARS);
  }

  private noteTaken(sessionId: string, ids: unknown): void {
    this.linesKnown.add(sessionId);
    if (!Array.isArray(ids)) return;
    const resend = this.resendRow.get(sessionId);
    if (resend && ids.includes(resend.id)) resend.taken = true;
    for (const row of this.seen.get(sessionId) ?? []) if (ids.includes(row.id)) { row.delivered = true; row.taken = true; }
  }

  /**
   * A clean turn answered what the model took in it. A row written to the CLI while the turn ran but
   * not taken yet is the next turn's (2026-11-05 review: it was dropped here and lost when that turn
   * overflowed). A CLI that never reports the lines it takes: every delivered row counts as taken.
   */
  private noteCleanTurn(sessionId: string): void {
    const rows = this.seen.get(sessionId);
    const known = this.linesKnown.has(sessionId);
    if (rows) this.seen.set(sessionId, rows.filter((r) => !(known ? r.taken : r.delivered)));
    if (this.running.has(sessionId)) return;
    // The words that got "Prompt is too long" are answered only by a turn that took the resend
    // carrying them (2026-11-05 review: any clean turn, a "ping" after a failed resend, dropped them).
    const owed = this.failed.get(sessionId)?.length ?? 0;
    if (owed > 0 && !this.resendRow.get(sessionId)?.taken) {
      // The session works again, so there is room now: send what is still owed.
      if (this.failedState.has(sessionId)) void this.resendOwed(sessionId);
      return;
    }
    this.failed.delete(sessionId);
    this.resendRow.delete(sessionId);
    if (this.failedState.has(sessionId)) {
      this.failedState.delete(sessionId);
      void this.settleFailed(sessionId);
    }
  }

  /** The session works again: its "failed" state no longer describes it (the banner then follows its own error). */
  private async settleFailed(sessionId: string): Promise<void> {
    const rec = await this.deps.getSession(sessionId).catch(() => null);
    const prior = rec?.contextRecovery;
    if (prior?.state !== 'failed' || this.running.has(sessionId)) return;
    // Answered: nothing is owed any more (a later failure must not resend these).
    const { reason: _reason, owed: _owed, ...rest } = prior;
    await this.setState(sessionId, { ...rest, state: 'done', at: new Date(this.deps.now()).toISOString() });
  }

  /**
   * The messages the failed turn got: every one delivered since the session's last clean turn end
   * (a clean end drops what it answered). Turn generations do not pair a delivery with its result:
   * the runner counts a turn at the write and again when the CLI starts it.
   */
  private takeFailedRows(sessionId: string): SeenRow[] {
    const rows = this.seen.get(sessionId) ?? [];
    const failed = this.failed.get(sessionId) ?? [];
    const counted = new Set(failed.map((r) => r.id));
    const these = rows.filter((r) => r.delivered && !counted.has(r.id));
    const all = [...failed, ...these].slice(-KEEP_ROWS);
    this.failed.set(sessionId, all);
    this.seen.set(sessionId, rows.filter((r) => !these.includes(r)));
    return all;
  }

  /** A turn of the session ended with "Prompt is too long": compact it, unless one already runs or the cap is reached. */
  async onOverflow(sessionId: string): Promise<'started' | string> {
    const rows = this.takeFailedRows(sessionId);
    const held = this.running.get(sessionId);
    if (held) {
      // Its words are in `failed` already; a run still compacting resends them. One past its
      // compaction starts the next run once it lets go (unless its resend still carries them).
      if (held.phase === 'resending' || held.phase === 'ending') held.overflowAgain = true;
      return 'already-running';
    }
    const run: Run = { phase: 'deciding', manual: false, fence: null };
    this.running.set(sessionId, run);
    try {
      const fence = await this.fenceNow(sessionId);
      if (fence === PENDING_STOP) { this.release(sessionId, run); return 'stopped'; }
      run.fence = fence;
      const result = await this.decide(sessionId, run, rows);
      if (result !== 'started') this.release(sessionId, run);
      return result;
    } catch (err) {
      this.release(sessionId, run);
      throw err;
    }
  }

  /** The session's stop fence, or PENDING_STOP while a stop awaits its host (the fence read throws then). */
  private async fenceNow(sessionId: string): Promise<string | null | typeof PENDING_STOP> {
    try {
      return await this.deps.stopFence(sessionId);
    } catch (err) {
      if (stopSuperseded(err)) return PENDING_STOP;
      throw err;
    }
  }

  /** Why the session may not be set to work now (a lane, an ACP engine, a closed task, a Stop), or null. */
  private async refusal(sessionId: string, rec: SessionRecord | null, run: Run): Promise<string | null> {
    const why = notRecoverable(rec);
    if (why) return why;
    if (run.stopped || this.stopped) return 'stopped';
    if (rec!.taskId && !(await this.deps.taskOpen(rec!.taskId))) return 'task-complete';
    if ((await this.fenceNow(sessionId)) !== run.fence || run.stopped) return 'stopped';
    return null;
  }

  private async decide(sessionId: string, run: Run, rows: SeenRow[]): Promise<'started' | string> {
    const rec = await this.deps.getSession(sessionId);
    const why = await this.refusal(sessionId, rec, run);
    if (why) return why;
    const nowMs = this.deps.now();
    const failedSince = rec!.contextRecovery?.state !== 'done' && rec!.contextRecovery?.failedSince
      ? rec!.contextRecovery.failedSince : (rows[0]?.at ?? new Date(nowMs).toISOString());
    const { left } = attemptsLeft(rec!.contextRecovery, nowMs);
    if (left <= 0) {
      await this.fail(sessionId, rec!, 'Compacting it again did not free enough room: the conversation still does not fit. '
        + 'Compact and resend tries once more; if that fails too, start a new session for this task.', failedSince);
      return 'cap-reached';
    }
    return this.start(sessionId, run, rec!, failedSince);
  }

  /**
   * A person (the banner's Compact and resend, a Retry from any surface) asks for the recovery: it
   * runs whatever the cap says. Returns false when the session is not one it can recover.
   */
  async recoverNow(sessionId: string): Promise<boolean> {
    const held = this.running.get(sessionId);
    if (held) {
      // A compaction already runs: that is what the click asks for. A run still deciding, resending
      // or letting go: the click runs right after it (2026-11-05: a click while a run that had just
      // given up raised its card was answered "compacting" and nothing ran).
      if (held.phase !== 'compacting') held.retryAfter = true;
      return true;
    }
    const run: Run = { phase: 'deciding', manual: true, fence: null };
    this.running.set(sessionId, run);
    try {
      const fence = await this.fenceNow(sessionId);
      if (fence === PENDING_STOP) { this.release(sessionId, run); return false; }
      run.fence = fence;
      const rec = await this.deps.getSession(sessionId);
      // A person's click past the cap, never past a closed task or a stop.
      if (await this.refusal(sessionId, rec, run)) { this.release(sessionId, run); return false; }
      const failedSince = rec!.contextRecovery?.state !== 'done' ? rec!.contextRecovery?.failedSince : undefined;
      const result = await this.start(sessionId, run, rec!, failedSince ?? this.failed.get(sessionId)?.[0]?.at);
      if (result !== 'started') this.release(sessionId, run);
      return result === 'started';
    } catch (err) {
      this.release(sessionId, run);
      throw err;
    }
  }

  /**
   * Whether this error result is one the recovery takes (the server then holds the session's error
   * card): a "Prompt is too long" of a session it can recover. Any other session keeps its card.
   */
  takes(result: string | null | undefined, rec: SessionRecord | null | undefined): boolean {
    return !this.stopped && isContextFullText(result) && notRecoverable(rec ?? null) === null;
  }

  private async start(sessionId: string, run: Run, rec: SessionRecord, failedSince: string | undefined): Promise<'started' | string> {
    const nowMs = this.deps.now();
    const rowId = `${QUIET_ROW_PREFIX}context-compact-${randomUUID()}`;
    run.phase = 'compacting';
    run.rowId = rowId;
    beginQuietTurn(sessionId, 'context-compact', CONTEXT_COMPACT_SOURCE, nowMs, rowId);
    const at = new Date(nowMs).toISOString();
    if (!run.manual) run.attemptAt = at;
    const { recent } = attemptsLeft(rec.contextRecovery, nowMs);
    const owed = owedForRecord(this.failed.get(sessionId) ?? []);
    await this.setState(sessionId, {
      state: 'compacting', at, attempts: run.attemptAt ? [...recent, run.attemptAt] : recent,
      ...(failedSince ? { failedSince } : {}),
      ...(owed?.length ? { owed } : {}),
    });
    this.deps.announce(sessionId, true);
    const waiting = this.failed.get(sessionId)?.length ?? 0;
    this.deps.emitNote(sessionId, rec.taskId,
      'This conversation no longer fits the model\'s context window ("Prompt is too long"). Walnut is compacting it, then '
      + (waiting ? `resends the ${waiting === 1 ? 'message' : `${waiting} messages`} that got no answer.` : 'asks the session to answer what got no answer.'),
      'info');
    try {
      await this.deps.send(sessionId, CONTEXT_COMPACT_TEXT, {
        source: CONTEXT_COMPACT_SOURCE, ...(rec.taskId ? { taskId: rec.taskId } : {}),
        messageId: rowId, userUuid: randomUUID(), stillWanted: () => quietTurnRow(sessionId) === rowId && !run.stopped && !this.stopped,
        stopFence: run.fence,
      });
      log.session.info('context recovery: compaction sent', { sessionId, taskId: rec.taskId, manual: run.manual, waiting });
      return 'started';
    } catch (err) {
      // Ending now, before the quiet turn's end listener (onQuietEnd) could take it as its own end.
      run.phase = 'ending';
      if (quietTurnRow(sessionId) === rowId) endQuietTurn(sessionId, 'send-failed');
      if (notWanted(err) && run.stopped) {
        await this.finish(sessionId, run, () => this.fail(sessionId, undefined, 'The session was stopped.', undefined, { card: false }));
        return 'stopped';
      }
      if (notWanted(err)) {
        // Another message went out first: the quiet turn is over and nothing was queued.
        await this.abandon(sessionId, run);
        return 'cut-short';
      }
      if (stopSuperseded(err)) {
        await this.finish(sessionId, run, () => this.fail(sessionId, undefined, 'The session was stopped.', undefined, { card: false }));
        return 'stopped';
      }
      const message = err instanceof Error ? err.message : String(err);
      await this.finish(sessionId, run, () => this.fail(sessionId, undefined, `The compaction could not be sent: ${message}`));
      return 'send-failed';
    }
  }

  /** The compaction's turn ended: `outcome` is its error text, 'stopped' when someone stopped it, null when it was clean. */
  async onCompactionEnd(sessionId: string, run: Run, outcome: string | null): Promise<void> {
    if (this.running.get(sessionId) !== run || run.phase !== 'compacting') return;
    run.phase = 'resending';
    this.deps.announce(sessionId, false);
    try {
      const rec = await this.deps.getSession(sessionId);
      if (outcome === 'stopped') {
        // A person stopped it: nothing is resent and nothing restarts by itself; the banner offers it again.
        await this.finish(sessionId, run, () => this.fail(sessionId, rec ?? undefined, 'The compaction was stopped.', undefined, { card: false }));
        return;
      }
      if (outcome !== null) {
        await this.finish(sessionId, run, () => this.fail(sessionId, rec ?? undefined, isContextFullText(outcome)
          ? 'The compaction itself did not fit the context window.'
          : `The compaction failed: ${outcome.slice(0, 300)}`));
        return;
      }
      await this.resend(sessionId, run, rec);
    } catch (err) {
      // Never left holding the session: a read that threw ends the run as failed.
      await this.finish(sessionId, run, () => this.fail(sessionId, undefined,
        `The compaction ended, but Walnut could not go on: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /**
   * Send the note that hands the session what got no answer, and record the run done. Refused
   * (stopped, closed) on the way, nothing is sent. The words stay kept until a turn of the
   * session's own ends clean: a resend that fails, or overflows again, still has them next time.
   */
  private async resend(sessionId: string, run: Run, rec: SessionRecord | null): Promise<void> {
    const why = await this.refusal(sessionId, rec, run);
    if (why) {
      await this.finish(sessionId, run, () => this.fail(sessionId, rec ?? undefined,
        why === 'task-complete' ? 'The task was completed meanwhile.' : 'The session was stopped.', undefined, { card: false }));
      return;
    }
    const rows = this.failed.get(sessionId) ?? [];
    const failedSince = rec?.contextRecovery?.failedSince;
    // Every overflow so far is in this note; only one after it went out needs another run.
    run.overflowAgain = false;
    const rowId = `qm-context-resend-${randomUUID()}`;
    // Known before the send, so a Stop that lands while the queue stores it can take it back.
    this.resendRow.set(sessionId, { id: rowId });
    try {
      await this.deps.send(sessionId, resendNoteText(rows, failedSince), {
        source: CONTEXT_RESEND_SOURCE, ...(rec?.taskId ? { taskId: rec.taskId } : {}), stopFence: run.fence,
        messageId: rowId, stillWanted: () => !run.stopped && !this.stopped && this.running.get(sessionId) === run,
      });
      if (run.stopped || this.stopped) {
        // Stopped while the row was being stored: it goes back out of the queue.
        void this.deps.deleteQueued(sessionId, rowId).catch(() => false);
        this.resendRow.delete(sessionId);
        await this.finish(sessionId, run, () => this.fail(sessionId, rec ?? undefined, 'The session was stopped.', undefined, { card: false }));
        return;
      }
    } catch (err) {
      if (this.resendRow.get(sessionId)?.id === rowId) this.resendRow.delete(sessionId);
      const stoppedMeanwhile = stopSuperseded(err) || (notWanted(err) && run.stopped);
      await this.finish(sessionId, run, () => this.fail(sessionId, rec ?? undefined, stoppedMeanwhile
        ? 'The session was stopped.'
        : `Compacted, but resending the messages failed: ${err instanceof Error ? err.message : String(err)}`,
      undefined, { card: !stoppedMeanwhile }));
      return;
    }
    await this.finish(sessionId, run, async () => {
      const latest = await this.deps.getSession(sessionId);
      const { reason: _reason, owed: _owed, ...prior } = latest?.contextRecovery ?? rec?.contextRecovery ?? { attempts: [] as string[] };
      await this.setState(sessionId, { ...prior, state: 'done', at: new Date(this.deps.now()).toISOString(), resent: rows.length });
    });
    log.session.info('context recovery: compacted and resent', { sessionId, taskId: rec?.taskId, resent: rows.length, manual: run.manual });
  }

  /**
   * The session has room again (a person's own /compact, a compaction a restart caught, a clean
   * turn after a failed resend): what got no answer goes out now.
   */
  private async resendOwed(sessionId: string, opts: { evenEmpty?: boolean; bound?: { fence: string | null } } = {}): Promise<void> {
    if (this.running.has(sessionId) || (!opts.evenEmpty && !(this.failed.get(sessionId)?.length))) return;
    const run: Run = { phase: 'resending', manual: true, fence: null };
    this.running.set(sessionId, run);
    try {
      const fence = await this.fenceNow(sessionId);
      if (fence === PENDING_STOP || (opts.bound && fence !== opts.bound.fence)) {
        // Stopped since the fence this resend is bound to (a restart's: a Stop or a team stop while
        // Walnut looked for the compaction): nothing goes out, a click still can.
        this.release(sessionId, run);
        if (opts.bound) await this.fail(sessionId, undefined, 'The session was stopped.', undefined, { card: false });
        return;
      }
      run.fence = opts.bound ? opts.bound.fence : fence;
      await this.resend(sessionId, run, await this.deps.getSession(sessionId));
    } catch (err) {
      this.release(sessionId, run);
      log.session.warn('context recovery: resend after a manual compaction failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Write the run's last state while it still holds the session, then let go; an overflow that came meanwhile starts the next run. */
  private async finish(sessionId: string, run: Run, write: () => Promise<void>): Promise<void> {
    if (this.running.get(sessionId) !== run || run.finishing) return;
    run.finishing = true;
    run.phase = 'ending';
    if (run.deadline) clearTimeout(run.deadline);
    try {
      await write();
    } finally {
      this.release(sessionId, run);
    }
    if (run.overflowAgain && !this.stopped && !run.stopped) {
      void this.onOverflow(sessionId).catch((err) => log.session.warn('context recovery: overflow not handled', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  private release(sessionId: string, run: Run): void {
    if (this.running.get(sessionId) !== run) return;
    this.running.delete(sessionId);
    if (run.retryAfter && !this.stopped) {
      run.retryAfter = false;
      void this.recoverNow(sessionId).catch((err) => log.session.warn('context recovery: click not run', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  /** A /compact the queue dropped before it went out: no compaction ran, so its attempt is handed back. */
  private async abandon(sessionId: string, run: Run): Promise<void> {
    this.deps.announce(sessionId, false);
    await this.finish(sessionId, run, async () => {
      const rec = await this.deps.getSession(sessionId);
      const prior = rec?.contextRecovery;
      await this.setState(sessionId, {
        attempts: (prior?.attempts ?? []).filter((t) => t !== run.attemptAt),
        ...(prior?.failedSince ? { failedSince: prior.failedSince } : {}),
        ...(prior?.owed?.length ? { owed: prior.owed } : {}),
        state: 'failed', at: new Date(this.deps.now()).toISOString(),
        reason: 'Another message went out before the compaction could. Walnut compacts when that message gets "Prompt is too long" too.',
      });
      this.failedState.add(sessionId);
      log.session.info('context recovery: compaction cut short before it went out', { sessionId });
    });
  }

  private async setState(sessionId: string, state: ContextRecoveryState): Promise<void> {
    await this.deps.saveSession(sessionId, { contextRecovery: state });
    this.deps.announceState(sessionId, state);
  }

  private async fail(sessionId: string, rec: SessionRecord | undefined, reason: string, failedSince?: string, opts: { card?: boolean } = {}): Promise<void> {
    const current = rec ?? await this.deps.getSession(sessionId);
    const prior = current?.contextRecovery;
    const failedAt = new Date(this.deps.now()).toISOString();
    // What is still owed stays on the record, so a click after a restart resends it too.
    const known = owedForRecord(this.failed.get(sessionId) ?? []);
    const owed = known?.length ? known : prior?.owed;
    await this.setState(sessionId, {
      attempts: prior?.attempts ?? [], ...(prior?.failedSince || failedSince ? { failedSince: prior?.failedSince ?? failedSince } : {}),
      ...(owed?.length ? { owed } : {}),
      state: 'failed', at: failedAt, reason,
    });
    this.failedState.add(sessionId);
    for (const listener of failListeners) {
      try { listener({ sessionId, taskId: current?.taskId, reason }); } catch { /* a listener's own fault */ }
    }
    this.deps.emitNote(sessionId, current?.taskId, `Walnut could not recover this session by itself. ${reason}`, 'error');
    log.session.warn('context recovery failed', { sessionId, taskId: current?.taskId, reason });
    if (opts.card !== false && current) {
      // Not awaited: raising the card and moving the phase never holds the session from a click.
      void this.deps.gaveUp(current, `This conversation no longer fits the model's context window ("Prompt is too long"). ${reason}`, failedAt)
        .catch((err) => log.session.warn('context recovery: error card not raised', { sessionId, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /**
   * At boot. The messages a recovery still owed come back from the record. A compaction a restart
   * caught is looked for in its host before anything is decided (2026-11-06: one had finished there
   * while Walnut restarted, and the old rule failed it outright: the task was handed back, its asker
   * read "Prompt is too long" as the answer, and nothing was resent for six hours). Found: the session
   * is told to answer now. Not found once the session is idle, or not readable for
   * RESTART_CHECK_MS: the banner offers it again. A clean end of the compaction meanwhile resends
   * too (handleEvent).
   */
  async rebuild(listSessions: () => Promise<SessionRecord[]>): Promise<number> {
    let n = 0;
    for (const rec of await listSessions()) {
      const state = rec.contextRecovery?.state;
      if (state !== 'failed' && state !== 'compacting') continue;
      const sid = rec.claudeSessionId;
      if (rec.contextRecovery?.owed?.length && !this.failed.get(sid)?.length) {
        this.failed.set(sid, rec.contextRecovery.owed.map((r) => ({ ...r, delivered: true, taken: true })));
      }
      if (state === 'failed') { this.failedState.add(sid); continue; }
      const fence = await this.fenceNow(sid);
      if (fence === PENDING_STOP) {
        await this.fail(sid, rec, 'The session was stopped.', undefined, { card: false }).catch(() => {});
        continue;
      }
      this.restartCompacting.add(sid);
      this.restartFence.set(sid, fence);
      // Its end is the compaction's, as quiet as it was before the restart: no hand-back, no notice.
      if (!quietTurnKind(sid)) beginQuietTurn(sid, 'context-compact', CONTEXT_COMPACT_SOURCE, this.deps.now());
      void this.checkRestarted(sid, this.deps.now() + RESTART_CHECK_MS);
      n++;
    }
    return n;
  }

  /** Whether the recovery holds this session now: a run of its own, or a compaction a restart caught. */
  holds(sessionId: string): boolean {
    return !this.stopped && (this.running.has(sessionId) || this.restartCompacting.has(sessionId));
  }

  /** Look in its host for the compaction a restart caught (rebuild). */
  private async checkRestarted(sessionId: string, deadline: number): Promise<void> {
    this.restartChecks.delete(sessionId);
    if (this.stopped || !this.restartCompacting.has(sessionId)) return;
    const again = () => {
      if (this.stopped) return;
      const t = setTimeout(() => { void this.checkRestarted(sessionId, deadline); }, RESTART_CHECK_EVERY_MS);
      t.unref?.();
      this.restartChecks.set(sessionId, t);
    };
    try {
      const rec = await this.deps.getSession(sessionId);
      if (!this.restartCompacting.has(sessionId)) return;
      if (!rec || rec.contextRecovery?.state !== 'compacting') { this.endRestartHold(sessionId); return; }
      const found = await this.deps.compactedSince(rec, rec.contextRecovery.at);
      if (!this.restartCompacting.has(sessionId)) return;
      // A turn still runs: the compaction is not over until it ends (its result resends), even with
      // its boundary already written (2026-11-06 review: a resend went in under the summary).
      if (rec.process_status === 'running' && this.deps.now() < deadline) { again(); return; }
      if (found) {
        log.session.info('context recovery: the compaction a restart caught finished in its host', { sessionId, taskId: rec.taskId });
        this.resendAfterRestart(sessionId);
        return;
      }
      // Not readable now: look again, up to the deadline.
      if (found === null && this.deps.now() < deadline) { again(); return; }
      this.endRestartHold(sessionId);
      await this.fail(sessionId, rec, found === null
        ? 'A Walnut restart interrupted the compaction, and its host could not be read since.'
        : 'A Walnut restart interrupted the compaction, and the session shows no compaction since.');
    } catch (err) {
      log.session.warn('context recovery: restart check failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
      if (this.deps.now() < deadline) again();
      else { this.endRestartHold(sessionId); await this.fail(sessionId, undefined, 'A Walnut restart interrupted the compaction.').catch(() => {}); }
    }
  }

  /** The end of a compaction a restart caught, seen as its turn's result. */
  private onRestartCompactionEnd(sessionId: string, outcome: string | null): void {
    // Its quiet mark ends by its own grace, for the result's late readers.
    if (outcome === null) { this.resendAfterRestart(sessionId, false); return; }
    this.endRestartHold(sessionId, false);
    if (isContextFullText(outcome)) {
      // It overflowed itself: the next run compacts again.
      void this.onOverflow(sessionId).catch(() => {});
      return;
    }
    void this.fail(sessionId, undefined, outcome === 'stopped' ? 'The compaction was stopped.' : `The compaction failed: ${outcome.slice(0, 300)}`,
      undefined, { card: outcome !== 'stopped' }).catch(() => {});
  }

  /** The compaction a restart caught is over: the session is told to answer now, under the fence it had at boot. */
  private resendAfterRestart(sessionId: string, endQuiet = true): void {
    const fence = this.restartFence.get(sessionId) ?? null;
    // resendOwed takes the session before its first await, so the hold never lapses in between.
    void this.resendOwed(sessionId, { evenEmpty: true, bound: { fence } });
    this.endRestartHold(sessionId, endQuiet);
  }

  /** Let go of a compaction a restart caught. Whether one was held. */
  private endRestartHold(sessionId: string, endQuiet = true): boolean {
    if (!this.restartCompacting.delete(sessionId)) return false;
    this.restartFence.delete(sessionId);
    const check = this.restartChecks.get(sessionId);
    if (check) clearTimeout(check);
    this.restartChecks.delete(sessionId);
    // The quiet mark rebuild set (no row of its own; a run's own compaction has one).
    if (endQuiet && quietTurnKind(sessionId) === 'context-compact' && !quietTurnRow(sessionId)) endQuietTurn(sessionId, 'settled');
    return true;
  }

  forget(sessionId: string): void {
    this.seen.delete(sessionId);
    this.failed.delete(sessionId);
    this.running.delete(sessionId);
    this.linesKnown.delete(sessionId);
    this.failedState.delete(sessionId);
    this.slashQueued.delete(sessionId);
    this.replied.delete(sessionId);
    this.resendRow.delete(sessionId);
    this.restartCompacting.delete(sessionId);
    this.restartFence.delete(sessionId);
    const check = this.restartChecks.get(sessionId);
    if (check) clearTimeout(check);
    this.restartChecks.delete(sessionId);
  }

  stop(): void {
    this.stopped = true;
    // Work in flight sends nothing more, and no clock of a run fires after the server stopped.
    for (const run of this.running.values()) {
      run.stopped = true;
      if (run.deadline) clearTimeout(run.deadline);
    }
    for (const check of this.restartChecks.values()) clearTimeout(check);
    this.restartChecks.clear();
  }

  /** Tests only. */
  isRunning(sessionId: string): boolean { return this.running.has(sessionId); }
}

/** The queue refused the send: a newer send ended the quiet turn first (session-message-queue.ts SendNoLongerWantedError). */
function notWanted(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'SendNoLongerWantedError';
}

/** The queue refused the send: a Stop came after the fence it was bound to (sessions/session-stop.ts). */
function stopSuperseded(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'SESSION_STOP_SUPERSEDED';
}

let instance: ContextFullRecovery | null = null;

/** The running recovery (null before the primary started it, or on a replica). */
export function contextFullRecovery(): ContextFullRecovery | null {
  return instance;
}

/**
 * Whether a session's turn end belongs to the recovery: it holds the session (a compaction, a resend,
 * one a restart caught), or the turn ended on a "Prompt is too long" it takes. Whatever acts on a
 * turn's end (closing a run, closing a handed-over task, a hand-back) waits while this says so: such
 * a turn answered nothing (2026-11-06). Guard: tests/core/sessions/context-full-turn-end-guard.test.ts.
 */
export async function contextRecoveryHoldsTurn(sessionId: string | undefined, result?: string | null): Promise<boolean> {
  const recovery = instance;
  if (!recovery || !sessionId) return false;
  if (recovery.holds(sessionId)) return true;
  if (!isContextFullText(result)) return false;
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const rec = await getSessionByClaudeId(sessionId).catch(() => null);
  // The recovery's own listener of this result may have taken the session meanwhile.
  return recovery.holds(sessionId) || recovery.takes(result, rec);
}

/** Start the recovery on the primary. */
export function startContextFullRecovery(deps: Partial<ContextFullRecoveryDeps> = {}): { stop: () => void; instance: ContextFullRecovery } {
  const recovery = new ContextFullRecovery(deps);
  instance = recovery;
  const removeQuietListener = addQuietTurnEndListener(recovery.onQuietEnd);
  bus.subscribe('context-full-recovery', recovery.handleEvent, {
    global: true,
    interest: ['session:message-queued', 'session:messages-delivered', 'session:user-line', 'session:queued-cancelled', 'session:usage-update',
      'session:interrupt', 'session:result', 'session:error', 'session:deleted'],
  });
  void import('../session-tracker.js').then(({ listSessions }) => recovery.rebuild(listSessions))
    .then((n) => { if (n) log.session.info('context recovery: compactions a restart caught, looked for in their hosts', { count: n }); })
    .catch((err) => log.session.warn('context recovery rebuild failed', { error: err instanceof Error ? err.message : String(err) }));
  return {
    instance: recovery,
    stop: () => {
      bus.unsubscribe('context-full-recovery');
      removeQuietListener();
      recovery.stop();
      if (instance === recovery) instance = null;
    },
  };
}
