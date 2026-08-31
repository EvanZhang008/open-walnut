/**
 * Session lifecycle core — PATCH (rename/archive/mode/human note), terminate,
 * restart, retry, permission response, execute-continue, session detail,
 * Changed-files data, and rich history reads. Shared by the web routes
 * (src/web/routes/sessions.ts), the /api/v1 mobile routes
 * (session-lifecycle-v1.ts), and the daemon control relay (cloud companion
 * path) so there is exactly ONE implementation of each behavior — the same
 * contract session-controls.ts established for model/effort/fork.
 *
 * Error contract: validation/lookup failures throw SessionControlError with an
 * HTTP-ish statusCode. Callers map it onto their own frozen error shape.
 *
 * Provider/tracker imports are dynamic where a static import would risk a load
 * cycle (same convention as session-controls.ts).
 */

import { SessionControlError } from './session-controls.js';
import { bus, EventNames } from '../event-bus.js';
import { safeKillProcessGroup } from '../process-group-kill.js';
import { log } from '../../logging/index.js';
import type { SessionRecord, SessionMode, SessionOutputMode } from '../types.js';
import { SESSION_MODE_IDS, SESSION_OUTPUT_MODE_IDS } from '../types.js';
import type { SessionHistoryMessage } from '../session-history.js';
import { DEFAULT_ENGINE, engineCaps, isAcpEngine } from '../agents/engine-registry.js';

// ── Shared helpers (moved from src/web/routes/sessions.ts) ──────────────────

/** Selectable Claude permission modes, safest → loosest. Derived from the one
 *  registry (core/types.ts) so adding a mode there reaches every validator. */
export const CLAUDE_SESSION_MODES: readonly SessionMode[] = SESSION_MODE_IDS;

/**
 * Read one provider's history in its native shape. Codex sessions read the ACP
 * journal; Claude sessions read the canonical JSONL (local or over the daemon).
 */
export async function readProviderSessionHistory(
  sessionId: string,
  record: SessionRecord | null | undefined,
  nativeHost: string | null | undefined,
  skipSubagents = true,
  opts?: {
    /** Tail-bounded caller: bound a COLD full read to the last N bytes (marked
     *  windowed) instead of transferring + parsing the whole JSONL. Both
     *  engines; a warm ACP fold cache ignores it (incremental reads are cheap). */
    maxColdReadBytes?: number;
  },
): Promise<{
  messages: SessionHistoryMessage[];
  sourceAvailable: boolean;
  windowed: boolean;
  /** Orphan finished-agent toolUseIds (nested agents proven stopped by a
   *  <task-notification> but with NO tool row in the parse) — absorption
   *  evidence the client can't derive from the rows (inc-1786496042099).
   *  Absent/empty for Codex and for parses with no orphans. */
  finishedAgentIds?: string[];
}> {
  if (record && engineCaps(record.engine).historySource === 'acp-journal') {
    const { readAcpSessionHistoryState } = await import('../../providers/acp-session-history.js');
    const state = await readAcpSessionHistoryState(record,
      opts?.maxColdReadBytes ? { maxColdReadBytes: opts.maxColdReadBytes } : {});
    return { messages: state.messages, sourceAvailable: state.journalExists, windowed: state.windowed === true };
  }
  const { readSessionHistory, isWindowedHistory, isSourceFoundHistory, getOrphanFinishedAgentIds } = await import('../session-history.js');
  const messages = await readSessionHistory(
    sessionId,
    record?.cwd,
    nativeHost ?? undefined,
    record?.outputFile,
    { skipSubagents, ...(opts?.maxColdReadBytes ? { maxColdReadBytes: opts.maxColdReadBytes } : {}) },
  );
  // `windowed`, `sourceAvailable` and `finishedAgentIds` must be read HERE,
  // while we still hold the exact array the reader returned — all three live on
  // that object (see isWindowedHistory / isSourceFoundHistory /
  // getOrphanFinishedAgentIds); downstream transforms (image rewriting, fork
  // concatenation) REPLACE the array and lose the marks.
  //
  // sourceAvailable = "the transcript file EXISTS", NOT "the parse produced rows".
  // A just-spawned session's JSONL holds only system/hook lines for its first
  // seconds, so `messages.length > 0` (the old proxy) reported the file missing on
  // a perfectly healthy session and the UI rendered "History unavailable — Session
  // history file not found" on every task launch. Fall back to the length proxy
  // only when the reader gave us no verdict at all (fake/mocked readers in tests).
  const orphanIds = getOrphanFinishedAgentIds(messages);
  return {
    messages,
    sourceAvailable: isSourceFoundHistory(messages) || messages.length > 0,
    windowed: isWindowedHistory(messages),
    ...(orphanIds && orphanIds.size > 0 ? { finishedAgentIds: [...orphanIds].sort() } : {}),
  };
}

/**
 * Clear a task's session slots after the session was archived. Returns true
 * when links were cleared. `requireAuthoritativeArchive` re-reads the record
 * first (compensation path).
 */
export async function clearArchivedSessionTaskLinks(
  sessionId: string,
  taskId: string,
  eventSource: string,
  requireAuthoritativeArchive = false,
): Promise<boolean> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  if (requireAuthoritativeArchive) {
    const authoritative = await getSessionByClaudeId(sessionId);
    if (!authoritative?.archived) return false;
  }

  const { clearSession, clearSessionSlot } = await import('../task-manager.js');
  await clearSession(taskId, sessionId);
  const { task } = await clearSessionSlot(taskId, sessionId);
  bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: eventSource });
  return true;
}

/** Apply a permission-mode change onto the LIVE provider (Codex or Claude). */
async function applySessionModeControl(
  record: SessionRecord,
  sessionId: string,
  mode: SessionMode,
): Promise<void> {
  const { sessionRunner } = await import('../../providers/claude-code-session.js');
  if (engineCaps(record.engine).modeControl === 'config-options') {
    const session = await sessionRunner.findOrAttachAcpSession(sessionId).catch((err: unknown) => {
      log.session.warn('Codex mode compatibility update could not attach; persisting record only', {
        sessionId, mode, error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    });
    if (!session) return;
    const collaborationMode = mode === 'plan' ? 'plan' : 'default';
    if (!await session.setConfigOption('collaboration_mode', collaborationMode)) {
      throw new Error('Codex collaboration mode change was rejected');
    }
    return;
  }

  const application = await sessionRunner.changePermissionMode(sessionId, mode);
  const expectedLive = record.pid != null
    && record.process_status !== 'stopped'
    && record.process_status !== 'error';
  if (application === 'not-live' && expectedLive) {
    // The record is already persisted by the time this runs (persist-first
    // contract in changeSessionMode) — the mode applies at the next turn.
    throw new Error('Live session is unavailable; permission mode applies next turn');
  }
}

/** Persist a mode change + reconcile the owning task's plan/exec slots. */
export async function persistSessionModeChange(
  existingRecord: SessionRecord,
  sessionId: string,
  mode: SessionMode,
  updates: Partial<SessionRecord> = {},
): Promise<SessionRecord> {
  const { updateSessionRecord, emitSessionStatusChanged } = await import('../session-tracker.js');
  const updated = await updateSessionRecord(sessionId, { ...updates, mode });
  emitSessionStatusChanged(updated, {}, ['*']);

  if (updated.taskId && existingRecord.mode !== mode) {
    try {
      const { getTask, linkSessionSlot, clearSessionSlot } = await import('../task-manager.js');
      const task = await getTask(updated.taskId);
      if (mode === 'plan') {
        if (!task.plan_session_id || task.plan_session_id === sessionId) {
          if (task.exec_session_id === sessionId) await clearSessionSlot(updated.taskId, sessionId, 'exec');
          await linkSessionSlot(updated.taskId, sessionId, 'plan');
          const updatedTask = await getTask(updated.taskId);
          bus.emit(EventNames.TASK_UPDATED, { task: updatedTask }, ['web-ui'], { source: 'session-mode-change' });
        }
      } else if (task.plan_session_id === sessionId) {
        await clearSessionSlot(updated.taskId, sessionId, 'plan');
        if (!task.exec_session_id) await linkSessionSlot(updated.taskId, sessionId, 'exec');
        const updatedTask = await getTask(updated.taskId);
        bus.emit(EventNames.TASK_UPDATED, { task: updatedTask }, ['web-ui'], { source: 'session-mode-change' });
      }

      const compensated = await clearArchivedSessionTaskLinks(
        sessionId,
        updated.taskId,
        'session-mode-archive-compensation',
        true,
      );
      if (compensated) {
        log.session.info('cleared task slots relinked during session archive', {
          sessionId, taskId: updated.taskId,
        });
      }
    } catch { /* task not found or lock contention — ignore */ }
  }
  return updated;
}

/**
 * Persist + live-apply a mode change (the full flow the web PATCH uses).
 *
 * Order matters and is deliberately persist-FIRST, notify-CLI-in-background:
 *
 * The CLI only drains its stdin control queue between streaming chunks, so a
 * mid-turn `set_permission_mode` round-trip takes 6–15s measured — and can
 * blow the client's 15s budget outright. Awaiting it here held the user's
 * click hostage to inference speed (the "mode pill takes 30s" report).
 *
 * Persisting first is safe because record.mode is the durable source of
 * truth: spawn args map it through the registry and processNext falls back to
 * it on a cold --resume, so even if the live hand-shake never lands the very
 * next turn runs in the chosen mode. persistSessionModeChange also emits the
 * status event, so every UI updates immediately off the record.
 *
 * A live-apply failure therefore does NOT revert the record — it logs and
 * the mode simply takes effect at the next turn boundary instead of mid-turn.
 */
export async function changeSessionMode(
  existingRecord: SessionRecord,
  sessionId: string,
  mode: SessionMode,
  updates: Partial<SessionRecord> = {},
): Promise<SessionRecord> {
  const updated = await persistSessionModeChange(existingRecord, sessionId, mode, updates);

  void applySessionModeControl(existingRecord, sessionId, mode).catch((err: unknown) => {
    log.session.warn('live permission mode apply failed after persist; mode takes effect next turn', {
      sessionId, mode, error: err instanceof Error ? err.message : String(err),
    });
  });

  return updated;
}

// ── PATCH (rename / archive / human note / mode) ────────────────────────────

export interface SessionPatchInput {
  title?: unknown;
  activity?: unknown;
  human_note?: unknown;
  archived?: unknown;
  archive_reason?: unknown;
  mode?: unknown;
  /** Reply-style preference ('markdown' | 'rich'). Metadata only — it reaches
   *  the model as an instruction on the next send, not through the live CLI. */
  output_mode?: unknown;
  /** Full replacement list of pinned messages (the client owns the order). */
  pinned_messages?: unknown;
}

/** Hard caps for the pin list. A pin is a navigation aid, not storage: the whole
 *  list rides every session record read (and the mobile projection), so a
 *  runaway client must not be able to grow it without bound. */
const MAX_PINNED_MESSAGES = 200;
const MAX_PIN_LABEL_CHARS = 300;
const MAX_PIN_ID_CHARS = 200;

/**
 * Validate + normalize a `pinned_messages` patch into records we're willing to
 * persist. Rejects the whole patch (400) rather than silently dropping bad
 * entries: a pin the client believes it saved but that vanished on reload is
 * worse than a visible error.
 *
 * Duplicate msgIds collapse to the FIRST occurrence (a double-click on the pin
 * button must not create two TOC rows pointing at one message).
 */
export function normalizePinnedMessages(value: unknown): import('../types.js').SessionPinnedMessage[] {
  if (!Array.isArray(value)) {
    throw new SessionControlError('pinned_messages must be an array', 400);
  }
  if (value.length > MAX_PINNED_MESSAGES) {
    throw new SessionControlError(`pinned_messages holds at most ${MAX_PINNED_MESSAGES} entries`, 400);
  }
  const out: import('../types.js').SessionPinnedMessage[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      throw new SessionControlError('each pinned_messages entry must be an object', 400);
    }
    const entry = raw as Record<string, unknown>;
    const msgId = entry.msgId;
    if (typeof msgId !== 'string' || !msgId.trim() || msgId.length > MAX_PIN_ID_CHARS) {
      throw new SessionControlError('pinned_messages[].msgId must be a non-empty string', 400);
    }
    if (seen.has(msgId)) continue;
    seen.add(msgId);
    const role = entry.role === 'user' || entry.role === 'assistant' || entry.role === 'system'
      ? entry.role
      : 'assistant';
    const label = typeof entry.label === 'string' ? entry.label.trim().slice(0, MAX_PIN_LABEL_CHARS) : '';
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
    const pinnedAt = typeof entry.pinnedAt === 'string' ? entry.pinnedAt : new Date().toISOString();
    out.push({ msgId, label, role, ...(timestamp ? { timestamp } : {}), pinnedAt });
  }
  return out;
}

/**
 * Update session record fields. Identical semantics to the web PATCH
 * /api/sessions/:sessionId (validation, archive terminal-state guard, live
 * mode apply, task-slot clearing on archive). Returns the CURRENT record after
 * all side effects, so callers can't optimistically merge stale fields.
 */
export async function patchSession(sessionId: string, input: SessionPatchInput): Promise<SessionRecord> {
  const { title, activity, human_note, archived, archive_reason, mode, output_mode, pinned_messages } = input;

  if (title !== undefined && (typeof title !== 'string' || title.length > 500)) {
    throw new SessionControlError('title must be a string (max 500 chars)', 400);
  }
  if (activity !== undefined && typeof activity !== 'string') {
    throw new SessionControlError('activity must be a string', 400);
  }
  if (human_note !== undefined && (typeof human_note !== 'string' || human_note.length > 50000)) {
    throw new SessionControlError('human_note must be a string (max 50000 chars)', 400);
  }
  if (archived !== undefined && typeof archived !== 'boolean') {
    throw new SessionControlError('archived must be a boolean', 400);
  }
  if (archive_reason !== undefined && typeof archive_reason !== 'string') {
    throw new SessionControlError('archive_reason must be a string', 400);
  }
  if (mode !== undefined && !CLAUDE_SESSION_MODES.includes(mode as SessionMode)) {
    throw new SessionControlError(`mode must be one of: ${CLAUDE_SESSION_MODES.join(', ')}`, 400);
  }
  if (output_mode !== undefined && !SESSION_OUTPUT_MODE_IDS.includes(output_mode as SessionOutputMode)) {
    throw new SessionControlError(`output_mode must be one of: ${SESSION_OUTPUT_MODE_IDS.join(', ')}`, 400);
  }
  // NOTE: an empty patch is tolerated (no-op update) — the web PATCH has always
  // accepted it. The v1 route layers its own at-least-one-field 400 on top.

  const { getSessionByClaudeId, updateSessionRecord, emitSessionStatusChanged } = await import('../session-tracker.js');
  const existingRecord = await getSessionByClaudeId(sessionId);
  if (!existingRecord) throw new SessionControlError('session not found', 404);

  // Archive: validate the session is in a terminal state first.
  if (archived === true
      && existingRecord.process_status !== 'stopped' && existingRecord.process_status !== 'error') {
    throw new SessionControlError('Stop session before archiving', 400);
  }

  const updates: Partial<SessionRecord> = {};
  if (title !== undefined) updates.title = title as string;
  if (activity !== undefined) updates.activity = activity as string;
  if (human_note !== undefined) updates.human_note = human_note as string;
  if (output_mode !== undefined) updates.output_mode = output_mode as SessionOutputMode;
  if (pinned_messages !== undefined) updates.pinnedMessages = normalizePinnedMessages(pinned_messages);
  if (archived !== undefined) {
    updates.archived = archived as boolean;
    if (archived && archive_reason) updates.archive_reason = archive_reason as string;
    if (!archived) updates.archive_reason = undefined; // clear reason on unarchive
  }

  let updated: SessionRecord;
  if (mode !== undefined) {
    try {
      updated = await changeSessionMode(existingRecord, sessionId, mode as SessionMode, updates);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.session.warn('live permission mode change rejected', { sessionId, mode, error: message });
      throw new SessionControlError(message, 409);
    }
  } else {
    updated = await updateSessionRecord(sessionId, updates);
  }
  log.session.info('session patched via lifecycle core', { sessionId, fields: Object.keys(updates) });

  // Emit status change so frontends update in real time — for EVERY metadata
  // patch, not just archive flips. A title/human_note-only patch used to emit
  // nothing, so the session projection (interest: session:status-changed) and
  // the mobile events feed never re-exported, and a phone-side rename looked
  // reverted until some unrelated status change (the projection-lag family).
  // The mode branch already emits inside persistSessionModeChange.
  if (mode === undefined && Object.keys(updates).length > 0) {
    emitSessionStatusChanged(updated, {}, ['*']);
  }

  // Archive: clear task session slots to free them for new sessions.
  if (archived === true && updated.taskId) {
    try {
      await clearArchivedSessionTaskLinks(sessionId, updated.taskId, 'session-archived');
    } catch { /* task may not exist */ }
  }

  return await getSessionByClaudeId(sessionId) ?? updated;
}

// ── Terminate ────────────────────────────────────────────────────────────────

export interface TerminateResult { status: 'terminated'; sessionId: string; tookMs?: number }

/**
 * Close the CLI process, full stop. No respawn, no queue drain, no error
 * banner — the intentional kill is suppressed via the live session's
 * interrupt() (sets resultEmitted so the daemon's reap isn't surfaced as
 * "exited with code -1"). Pending messages stay in the queue.
 */
export async function terminateSession(
  sessionId: string,
  opts: { force?: boolean } = {},
): Promise<TerminateResult> {
  const startedAt = Date.now();
  const { getSessionByClaudeId, updateSessionRecord, emitSessionStatusChanged } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record) throw new SessionControlError('Session not found', 404);

  const { sessionRunner } = await import('../../providers/claude-code-session.js');

  // Cron-owner guard: the CLI's scheduler lock is DIRECTORY-scoped, so killing
  // a session that owns recurring crons doesn't stop them — they migrate to
  // whichever session in the same cwd next holds the lock, and fire there as
  // bare prompts with no provenance (incident 2026-08-09). Require an explicit
  // force for that footgun instead of doing it silently.
  if (!opts.force && sessionRunner.isCronArmed?.(sessionId)) {
    log.session.warn('session terminate: refused — session owns scheduled crons (pass force to override)', { sessionId });
    throw new SessionControlError(
      'This session owns recurring scheduled tasks (crons). Stopping it will NOT stop them — '
        + 'they persist in the project directory and will fire into any other session sharing that '
        + 'directory, without provenance. Delete the crons first, or force-terminate.',
      409,
      { code: 'cron_owner' },
    );
  }

  const acpLive = sessionRunner.findAcpSession(sessionId);
  if (acpLive) {
    log.session.info('session terminate: stopping ACP session', { sessionId });
    await acpLive.gracefulStop();
    await updateSessionRecord(sessionId, {
      process_status: 'stopped', activity: undefined,
      last_status_change: new Date().toISOString(),
      status_reason: 'user_stopped', status_changed_by: 'user',
    }).catch(() => {});
    return { status: 'terminated', sessionId, tookMs: Date.now() - startedAt };
  }
  const live = sessionRunner.findSessionByClaudeId(sessionId);
  if (live) {
    log.session.info('session terminate: interrupting live session', { sessionId, host: record.host });
    await live.interrupt();
  } else {
    const { getRegisteredSessionManager } = await import('../../providers/session-manager.js');
    const mgr = getRegisteredSessionManager(sessionId);
    if (mgr) {
      log.session.info('session terminate: killing via SessionManager', { sessionId, managerKind: mgr.constructor.name });
      mgr.kill();
    } else if (record.pid != null && !record.host) {
      // Local session, no manager — SIGTERM the process group directly.
      if (safeKillProcessGroup(record.pid, 'SIGTERM')) {
        log.session.info('session terminate: SIGTERM sent to process group', { sessionId, pgid: record.pid });
      } else {
        log.session.warn('session terminate: group kill not delivered (dead, or pid failed the safety floor)', {
          sessionId, pgid: record.pid,
        });
      }
    } else {
      log.session.info('session terminate: no live session/manager to kill', { sessionId, host: record.host });
    }
  }

  // Settle any killed mid-turn batch so the UI stops the streaming spinner
  // immediately instead of waiting out the 60s safety timeout.
  sessionRunner.settleInFlightTurn(sessionId);

  const updated = await updateSessionRecord(sessionId, {
    process_status: 'stopped',
    errorMessage: undefined,
    activity: undefined,
    pid: undefined,
    status_reason: 'user_terminated',
    status_changed_by: 'user',
  } as Record<string, unknown>);
  emitSessionStatusChanged(updated, {}, ['*'], { source: 'terminate' });

  return { status: 'terminated', sessionId, tookMs: Date.now() - startedAt };
}

// ── Restart ──────────────────────────────────────────────────────────────────

export interface RestartResult { status: 'restarted'; sessionId: string; pendingMessages: number }

/**
 * Respawn a fresh `claude -p --resume` process so the session RE-INITIALIZES
 * (init event + SessionStart hook + spawn-time settings reload). This is the
 * documented "wake a dead/idle-reaped session" action. Pending queue survives
 * and drains after the respawn.
 */
export async function restartSession(sessionId: string): Promise<RestartResult> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record) throw new SessionControlError('Session not found', 404);
  if (record.archived) throw new SessionControlError('Cannot restart an archived session', 400);

  // Revert any in-flight 'processing' messages back to 'pending' — if the old
  // CLI was mid-send when we respawn, those messages must survive and re-deliver.
  const { getQueue, revertToPending } = await import('../session-message-queue.js');
  const queue = await getQueue(sessionId);
  const stuck = queue.filter((m) => m.status === 'processing');
  if (stuck.length > 0) {
    await revertToPending(stuck);
    log.session.info('session restart: reverted processing → pending', { sessionId, count: stuck.length });
  }

  // Respawn a fresh CLI (idle — no turn). reinitialize() owns the graceful
  // transport swap that suppresses the old process's exit.
  const { sessionRunner } = await import('../../providers/claude-code-session.js');
  await sessionRunner.reinitialize(sessionId);

  // If messages are pending after the revert, kick processNext so the fresh
  // CLI drains them (reinitialize itself delivers nothing).
  const pendingAfterRevert = queue.filter((m) => m.status === 'pending').length + stuck.length;
  if (pendingAfterRevert > 0) {
    bus.emit(EventNames.SESSION_SEND, { sessionId, taskId: record.taskId, message: '' }, ['session-runner'], { source: 'restart' });
    log.session.info('session restart: kicked pending queue after reinit', { sessionId, pendingMessages: pendingAfterRevert });
  }

  return { status: 'restarted', sessionId, pendingMessages: pendingAfterRevert };
}

// ── Retry ────────────────────────────────────────────────────────────────────

export type RetryResult =
  | { status: 'reconnected'; sessionId: string }
  | { status: 'resuming'; sessionId: string; restoredMessages?: number }
  | { status: 'pending'; taskId: string; oldSessionId: string };

/**
 * Pre-flight for the --resume path: does the CLI's canonical conversation
 * JSONL (~/.claude/projects/<encoded-cwd>/<sid>.jsonl) actually exist on the
 * session's execution host?
 *
 * WHY (2026-08-13 incident): a CLI killed within ~2s of its FIRST spawn never
 * persists a conversation at all. Every `claude --resume <sid>` then exits 1
 * with "No conversation found", so the retry button was an unfixable loop —
 * the user pressed it twice, spawned two more doomed processes. The existing
 * conversation-lost auto-archive only fires AFTER such a doomed spawn fails;
 * this check skips the doomed spawn entirely and reroutes to a fresh session.
 *
 * Returns true when the file exists, false when provably absent, and true on
 * any probe error (daemon unreachable etc.) — fail OPEN, --resume itself will
 * produce the authoritative error.
 */
async function resumeConversationExists(record: SessionRecord): Promise<boolean> {
  // Only the claude CLI has this on-disk layout; ACP/other engines manage
  // their own persistence — don't second-guess them. An engine this build
  // does NOT know must also fail open here: engineCaps degrades unknowns to
  // claude-shaped defaults, and probing ~/.claude for a foreign engine would
  // answer "absent" and send retrySession down the archive-and-replace path.
  if (record.provider && record.provider !== 'cli') return true;
  if (record.engine && record.engine !== DEFAULT_ENGINE) return true;
  if (engineCaps(record.engine).historySource !== 'provider-jsonl') return true;
  try {
    if (!record.host || record.host === '__local__') {
      const { findLocalJsonlPath } = await import('../session-file-reader.js');
      return (await findLocalJsonlPath(record.claudeSessionId, record.cwd ?? undefined)) !== null;
    }
    // DaemonFileReader directly (not the SessionFileReader interface): we only
    // need the path probe, findSession would pull the whole file's content.
    const { DaemonFileReader } = await import('../daemon-file-reader.js');
    const reader = new DaemonFileReader(record.host);
    return (await reader.findSessionPath(record.claudeSessionId)) !== null;
  } catch (err) {
    log.session.warn('retry: conversation pre-flight probe failed — assuming resumable', {
      sessionId: record.claudeSessionId, host: record.host,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/**
 * Retry a failed/stopped session. Three paths, identical to the web route:
 * (1) process alive → clear error state; (2) process dead + conversation on
 * disk → --resume via the message queue; (3) never initialized OR conversation
 * never persisted → archive + start a new session.
 */
export async function retrySession(sessionId: string): Promise<RetryResult> {
  const { getSessionByClaudeId, updateSessionRecord, emitSessionStatusChanged } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record) throw new SessionControlError('Session not found', 404);

  if (record.process_status !== 'error' && record.process_status !== 'stopped') {
    throw new SessionControlError(`Session is ${record.process_status}, not retryable`, 400);
  }
  if (!record.taskId) {
    throw new SessionControlError('Session has no associated task', 400);
  }

  if (record.claudeSessionId) {
    const { isSessionProcessAlive } = await import('../../utils/session-liveness.js');
    const alive = await isSessionProcessAlive(record);

    if (alive) {
      const updated = await updateSessionRecord(sessionId, {
        process_status: 'running',
        errorMessage: undefined,
        status_reason: 'retry_reconnect',
        status_changed_by: 'user',
      } as Partial<SessionRecord>);
      emitSessionStatusChanged(updated, {}, ['*']);
      log.session.info('session retry: reconnected (process alive)', { sessionId, taskId: record.taskId });
      return { status: 'reconnected', sessionId };
    }

    // Process dead. --resume only works if the CLI persisted a conversation;
    // otherwise fall through to the fresh-start path below (same handling as
    // "failed before init" — because that's what it effectively is).
    if (await resumeConversationExists(record)) {
      // Resume via --resume. If the pending queue already holds the user's
      // original message, re-trigger processNext (sends the ORIGINAL text).
      const { sendMessageToSession, getQueue, unparkMessage } = await import('../session-message-queue.js');
      const pendingMsgs = await getQueue(sessionId);
      // Retry is an explicit human action, so it also revives PARKED rows — they
      // are counted below and would otherwise be reported as restored while
      // markProcessing skipped them (a retry that silently did nothing).
      for (const parked of pendingMsgs.filter((m) => m.status === 'parked')) {
        await unparkMessage(sessionId, parked.id);
      }
      if (pendingMsgs.length > 0) {
        bus.emit(EventNames.SESSION_SEND, { sessionId, taskId: record.taskId }, ['session-runner'], { source: 'retry' });
        log.session.info('session retry: re-processing pending queue messages', { sessionId, taskId: record.taskId, count: pendingMsgs.length });
        return { status: 'resuming', sessionId, restoredMessages: pendingMsgs.length };
      }
      await sendMessageToSession(sessionId, 'continue', { source: 'retry', taskId: record.taskId });
      log.session.info('session retry: resuming via --resume (no pending messages)', { sessionId, taskId: record.taskId });
      return { status: 'resuming', sessionId };
    }
    log.session.warn('session retry: conversation never persisted — starting fresh instead of --resume', {
      sessionId, taskId: record.taskId, host: record.host, cwd: record.cwd,
    });
  }

  // Fresh start: no claudeSessionId (failed before init) or the conversation
  // JSONL never made it to disk (killed during first spawn) → archive + new.
  const conversationLost = !!record.claudeSessionId;
  const { getTask } = await import('../task-manager.js');
  let task;
  try {
    task = await getTask(record.taskId);
  } catch {
    task = undefined;
  }
  if (!task) throw new SessionControlError('Associated task not found', 404);

  await updateSessionRecord(sessionId, {
    archived: true,
    archive_reason: conversationLost ? 'conversation_never_persisted' : 'retry',
  });
  try {
    const { clearSession, clearSessionSlot } = await import('../task-manager.js');
    await clearSession(task.id, sessionId);
    await clearSessionSlot(task.id, sessionId);
  } catch { /* task may not exist */ }

  let retryMessage = 'Retry session';
  try {
    // Prefer the pending queue (the exact message the user tried to send);
    // fall back to the walnut-side stream history's first user message.
    const { getQueue } = await import('../session-message-queue.js');
    const pendingMsgs = await getQueue(sessionId);
    const pendingText = pendingMsgs.map((m) => m.message).filter(Boolean).join('\n');
    if (pendingText) {
      retryMessage = pendingText;
    } else {
      const { messages } = await readProviderSessionHistory(sessionId, record, record.host, false);
      const firstUser = messages.find((m) => m.role === 'user');
      if (firstUser?.text) retryMessage = firstUser.text;
    }
  } catch { /* history may be unavailable */ }

  bus.emit(EventNames.SESSION_START, {
    taskId: task.id,
    message: retryMessage,
    cwd: record.cwd,
    project: task.project ?? '',
    mode: record.mode !== 'default' ? record.mode : undefined,
    model: record.model,
    host: record.host,
  }, ['session-runner'], { source: 'retry' });

  log.session.info('session retry: started new session', {
    oldSessionId: sessionId, taskId: task.id, conversationLost,
  });
  return { status: 'pending', taskId: task.id, oldSessionId: sessionId };
}

// ── Permission response ──────────────────────────────────────────────────────

export interface PermissionResult { status: 'resolved'; requestId: string; allow: boolean }

/**
 * Resolve a pending permission request (approve/deny a CLI tool prompt).
 * ACP sessions answer via the daemon acpRespond RPC; Claude sessions resolve
 * on the live session object. `optionId` (ACP only) selects a specific
 * provider option (e.g. codex "Allow for Session") instead of the allow
 * heuristic.
 *
 * `answers` (Claude CLI AskUserQuestion only) maps question text → the chosen
 * option label. It is merged into the allow response's `updatedInput`, which the
 * AskUserQuestion tool echoes back to the model as "User has answered your
 * questions". Without it a bypass-mode session hands the model empty answers.
 */
export async function respondSessionPermission(
  sessionId: string,
  requestId: unknown,
  allow: unknown,
  denyMessage?: unknown,
  optionId?: unknown,
  answers?: unknown,
): Promise<PermissionResult> {
  if (typeof requestId !== 'string' || !requestId || typeof allow !== 'boolean') {
    throw new SessionControlError('requestId (string) and allow (boolean) are required', 400);
  }
  if (denyMessage !== undefined && typeof denyMessage !== 'string') {
    throw new SessionControlError('message must be a string', 400);
  }
  if (optionId !== undefined && typeof optionId !== 'string') {
    throw new SessionControlError('optionId must be a string', 400);
  }
  // answers must be a plain object of string values — it is forwarded verbatim into
  // the CLI's tool input, so anything else (array, nested object, number) would
  // reach the model as a malformed answer set.
  if (answers !== undefined) {
    if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) {
      throw new SessionControlError('answers must be an object mapping question to answer string', 400);
    }
    for (const value of Object.values(answers as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new SessionControlError('answers values must be strings', 400);
      }
    }
  }
  const answerPatch = answers !== undefined && Object.keys(answers as Record<string, string>).length > 0
    ? { answers: answers as Record<string, string> }
    : undefined;
  const { sessionRunner } = await import('../../providers/claude-code-session.js');
  // findOrAttach, not find: after a server restart the live map is empty but
  // the worker (and its pending permission) may still be alive. A bare find
  // 404'd every approve clicked in that window (2026-08-10 incident).
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  const acpSession = isAcpEngine(record?.engine)
    ? await sessionRunner.findOrAttachAcpSession(sessionId)
    : sessionRunner.findAcpSession(sessionId);
  if (acpSession) {
    // `answers` is intentionally dropped here: ACP providers (codex) have no
    // AskUserQuestion tool, so there is no updatedInput to patch.
    const ok = await acpSession.resolvePermissionRequest(requestId, allow, optionId as string | undefined);
    if (!ok) throw new SessionControlError('Permission request not found or already resolved', 404);
    return { status: 'resolved', requestId, allow };
  }
  const session = sessionRunner.findByClaudeId(sessionId);
  if (!session) throw new SessionControlError('Live session not found', 404);
  const resolved = session.resolvePermissionRequest(requestId, allow, denyMessage as string | undefined, answerPatch);
  if (!resolved) throw new SessionControlError('Permission request not found or already resolved', 404);
  return { status: 'resolved', requestId, allow };
}

// ── Execute-continue ─────────────────────────────────────────────────────────

export interface ExecuteContinueResult { status: 'started'; sessionId: string }

/** Resume a completed plan session with bypass permissions ("Continue"). */
export async function executeContinueSession(sessionId: string): Promise<ExecuteContinueResult> {
  const { getSessionByClaudeId, updateSessionRecord } = await import('../session-tracker.js');
  const session = await getSessionByClaudeId(sessionId);
  if (!session) throw new SessionControlError('Session not found', 404);
  if (!session.planCompleted && !session.fromPlanSessionId) {
    throw new SessionControlError('Not a plan or execution session', 400);
  }
  await updateSessionRecord(session.claudeSessionId, { mode: 'bypass' });

  const needsInterrupt = session.process_status !== 'stopped';
  const message = 'Execute the plan. Implement all steps as planned.';
  const { sendMessageToSession } = await import('../session-message-queue.js');
  await sendMessageToSession(session.claudeSessionId, message, {
    source: 'web-api',
    taskId: session.taskId,
    mode: 'bypass',
    interrupt: needsInterrupt || undefined,
  });

  log.session.info('execute-continue: resuming plan session with bypass', { sessionId: session.claudeSessionId });
  return { status: 'started', sessionId: session.claudeSessionId };
}

// ── Session detail ───────────────────────────────────────────────────────────

export interface SessionDetailResult {
  session: SessionRecord;
  pendingPermissions: SessionPendingPermission[];
}

export interface SessionPendingPermission {
  requestId: string;
  toolName?: string;
  input?: Record<string, unknown>;
  reason?: string;
  acpOptions?: Array<{ optionId?: string; kind?: string; name?: string }>;
}

/**
 * Read pending permissions from the live provider when it is attached. During
 * restart recovery the provider map is briefly empty, so a non-terminal
 * record's durable pendingPermission is the fallback until attach completes.
 */
export async function getSessionPendingPermissions(
  record: SessionRecord,
): Promise<SessionPendingPermission[]> {
  try {
    const { sessionRunner } = await import('../../providers/claude-code-session.js');
    const liveSession = isAcpEngine(record.engine)
      ? sessionRunner.findAcpSession(record.claudeSessionId)
      : sessionRunner.findByClaudeId(record.claudeSessionId);
    if (liveSession) return liveSession.getPendingPermissionRequests();

    const canAttach = isAcpEngine(record.engine)
      && (record.process_status === 'running' || record.process_status === 'idle');
    if (canAttach) {
      void sessionRunner.findOrAttachAcpSession(record.claudeSessionId).catch((err: unknown) => {
        log.session.warn('failed to restore pending Codex permissions in background', {
          sessionId: record.claudeSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch (err) {
    log.session.warn('failed to read pending session permissions from live provider', {
      sessionId: record.claudeSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const pending = record.pendingPermission;
  const canRestore = record.process_status === 'running' || record.process_status === 'idle';
  if (!pending || !canRestore) return [];
  return [{
    requestId: pending.requestId,
    toolName: pending.toolName,
    input: pending.input,
    reason: pending.reason,
    acpOptions: pending.acpOptions,
  }];
}

/**
 * Full session detail: the record (liveness-corrected + hostname-resolved)
 * plus provider-neutral live pending permissions — the payload the permission
 * response endpoint pairs with.
 */
export async function getSessionDetail(sessionId: string): Promise<SessionDetailResult> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record) throw new SessionControlError('session not found', 404);

  const { enrichWithLiveStatus, enrichWithHostnames } = await import('./session-enrich.js');
  const [enriched] = await enrichWithHostnames(await enrichWithLiveStatus([record]));

  const pendingPermissions = await getSessionPendingPermissions(enriched);
  return { session: enriched, pendingPermissions };
}

// ── Changed-files data ───────────────────────────────────────────────────────

export interface SessionChangesInput {
  base?: unknown;
  scope?: unknown;
  light?: boolean;
  refresh?: boolean;
  /** Stale-while-revalidate: serve the last cached/disk result instantly
   *  (stale:true + refreshing:true) and recompute in the background. Only
   *  meaningful for base=session. */
  swr?: boolean;
}

const GIT_BASES: ReadonlySet<string> = new Set(['uncommitted', 'previous', 'remote']);

/**
 * The files a session changed, with reconstructed before/after content.
 * Same base/scope semantics as GET /api/sessions/:sessionId/changes.
 * `light` strips before/after (names/roots only).
 */
export async function getSessionChanges(
  sessionId: string,
  input: SessionChangesInput = {},
): Promise<Record<string, unknown>> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record) throw new SessionControlError('Session not found', 404);

  const base = typeof input.base === 'string' && input.base ? input.base : 'session';
  const scope = input.scope === 'all' ? 'all' : 'session';
  const noCache = input.refresh === true;

  let result: Record<string, unknown>;
  try {
    if (GIT_BASES.has(base)) {
      const { computeSessionGitDiff } = await import('../session-git-diff.js');
      result = await computeSessionGitDiff(
        sessionId,
        base as import('../session-git-diff.js').GitDiffBase,
        record.cwd, record.host, scope, record.outputFile, { noCache },
      ) as unknown as Record<string, unknown>;
    } else if (input.swr === true && !noCache) {
      const { computeSessionChangesSwr } = await import('../session-changes.js');
      result = await computeSessionChangesSwr(
        sessionId, record.cwd, record.host, record.outputFile,
      ) as unknown as Record<string, unknown>;
    } else {
      const { computeSessionChanges } = await import('../session-changes.js');
      result = await computeSessionChanges(
        sessionId, record.cwd, record.host, record.outputFile, { noCache },
      ) as unknown as Record<string, unknown>;
    }
  } catch (err) {
    // Remote read errors (SSH/daemon) + git failures surface as 502 like the web route.
    const msg = err instanceof Error ? err.message : String(err);
    log.session.warn('session changes read failed', { sessionId, host: record.host, base, scope, error: msg });
    throw new SessionControlError(msg, 502);
  }

  if (input.light === true) {
    const light = result as { groups?: Array<{ files: Array<Record<string, unknown>> }> };
    return {
      ...result,
      groups: (light.groups ?? []).map((g) => ({
        ...g,
        files: g.files.map((f) => ({ ...f, before: '', after: '' })),
      })),
    };
  }
  return result;
}

/**
 * One file's full change record (before/after included) from the session-scope
 * changes. Serves the Changed tab's lazy per-file diff: the list ships light
 * (no content), and each file's diff loads on selection. computeSessionChanges
 * dedups via its in-flight chain and hits the mtime fast-path right after a
 * list fetch, so this is normally a pure cache read — no file I/O.
 */
export async function getSessionFileChange(
  sessionId: string,
  filePath: string,
): Promise<Record<string, unknown>> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record) throw new SessionControlError('Session not found', 404);

  const { computeSessionChanges, peekSessionFileChange, fetchSessionFileChangeViaDaemon } =
    await import('../session-changes.js');

  // Serve from the cache even if it's outdated: a click must not queue behind
  // a 20-40s whale recompute holding the in-flight chain. Slightly-stale
  // content self-corrects (the list refresh clears the frontend's per-file
  // cache and re-fetches). Daemon-backed entries are light, so peek declines
  // them and the daemon serves the content from ITS full-output cache.
  const peeked = peekSessionFileChange(sessionId, record.host, filePath);
  if (peeked) return { sessionId, ...peeked };

  try {
    const viaDaemon = await fetchSessionFileChangeViaDaemon(sessionId, record.cwd, record.host, filePath);
    if (viaDaemon) return { sessionId, ...viaDaemon };
  } catch { /* fall through to the compute path */ }

  let result: import('../session-changes.js').SessionChangesResult;
  try {
    result = await computeSessionChanges(sessionId, record.cwd, record.host, record.outputFile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.session.warn('session file change read failed', { sessionId, host: record.host, filePath, error: msg });
    throw new SessionControlError(msg, 502);
  }
  for (const group of result.groups) {
    const file = group.files.find((f) => f.filePath === filePath);
    if (file) {
      // A light result carries no before/after (daemon path with changes.file
      // unavailable) — an empty diff would look like "no change". Report it.
      if (result.light) throw new SessionControlError('File content temporarily unavailable', 503);
      return { sessionId, repoRoot: group.repoRoot, file };
    }
  }
  throw new SessionControlError('File not in session changes', 404);
}

// ── Rich history ─────────────────────────────────────────────────────────────

export interface RichHistoryResult {
  messages: SessionHistoryMessage[];
  total: number;
  forkedFromSessionId?: string;
  forkBoundaryIndex?: number;
  historyUnavailable?: string;
  /** True when only a tail window of a whale transcript was read — `total` is
   *  then the WINDOW's count, not the conversation's. v1 clients should show a
   *  "conversation truncated" affordance instead of trusting `total`. */
  windowed?: boolean;
}

/** Backstop against pathological/cyclic fork chains. */
const MAX_FORK_DEPTH = 5;

/**
 * Grace window for "the transcript doesn't exist YET". Matches the two other
 * clocks that govern a pid-less/just-spawned row — api-v1's SPAWN_GRACE_MS and
 * the health monitor's ORPHAN_GRACE_MS — so a wedged record stops qualifying on
 * all three at once instead of one masking the others.
 */
const HISTORY_STARTUP_GRACE_MS = 2 * 60 * 1000;

/**
 * True when this session is still in its STARTUP window, i.e. an absent
 * transcript file is the expected state rather than a fault.
 *
 * Why this exists: creating a task launches a session, and the UI opens its panel
 * and fetches history IMMEDIATELY. The CLI needs a few seconds to boot and write
 * the first JSONL line (measured on a real launch: history fetched at +0.77s, the
 * first JSONL line at +4.8s). During that gap "file not found" is TRUE but not a
 * problem — reporting it made every task creation flash "History unavailable —
 * Session history file not found", which is exactly what the user reported.
 *
 * The window is bounded on purpose: after it, a genuinely missing transcript
 * (spawn failed, file deleted) must still surface. Terminal rows never qualify —
 * a stopped/errored session that never produced a transcript is a real fault the
 * user should see immediately, not after a 2-minute silence.
 */
export function isHistoryStartupWindow(record: SessionRecord, nowMs = Date.now()): boolean {
  if (record.process_status === 'stopped' || record.process_status === 'error') return false;
  // Anchor on the LATER of the two clocks: startedAt is the launch instant, and
  // last_status_change moves as the row progresses (awaiting_spawn → running), so
  // taking the max keeps the window measured from the most recent lifecycle beat.
  const started = new Date(record.startedAt ?? 0).getTime();
  const changed = new Date(record.last_status_change ?? 0).getTime();
  const anchor = Math.max(Number.isFinite(started) ? started : 0, Number.isFinite(changed) ? changed : 0);
  if (anchor <= 0) return false;
  return nowMs - anchor < HISTORY_STARTUP_GRACE_MS;
}

function unavailableHistoryReason(record: SessionRecord): string {
  if (engineCaps(record.engine).historySource === 'acp-journal') {
    if (!record.acpRuntimeId) {
      return 'Codex session has no ACP runtime ID, so its history journal cannot be located';
    }
    return record.host
      ? `Codex session history journal is unavailable on remote host "${record.host}"`
      : 'Codex session history journal not found';
  }
  return record.host
    ? `Remote host "${record.host}" is unreachable — session history is stored on that machine`
    : 'Session history file not found';
}

/**
 * Full rich-block history for a session (tool detail/results, subagent-lane
 * markers, fork-ancestor prefix), tail-windowed. This is the mobile parity
 * read behind GET /api/v1/sessions/:id/history — a snapshot API: no delta
 * cursors (live rendering rides the SSE stream + fresh transcript).
 * Rows whose content can still change carry `unsettled: true`.
 */
export async function readSessionRichHistory(sessionId: string, tail?: number): Promise<RichHistoryResult> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record) throw new SessionControlError('Session not found', 404);

  let messages: SessionHistoryMessage[];
  let sourceAvailable = false;
  let historyWindowed = false;
  try {
    // Snapshot API with a tail → bound a COLD read too (same rationale as the
    // web /history route; see ReadHistoryOptions.maxColdReadBytes).
    const { HISTORY_COLD_TAIL_READ_BYTES } = await import('../session-history.js');
    const history = await readProviderSessionHistory(sessionId, record, record.host, true,
      tail && tail > 0 ? { maxColdReadBytes: HISTORY_COLD_TAIL_READ_BYTES } : undefined);
    messages = history.messages;
    sourceAvailable = history.sourceAvailable;
    historyWindowed = history.windowed;
  } catch (err) {
    throw new SessionControlError(err instanceof Error ? err.message : String(err), 502);
  }

  // "Nothing to show" may ONLY be decided after the fork ancestors are consulted
  // (see the fork-aware block below). A fresh fork's OWN transcript is legitimately
  // empty — its whole value is the inherited parent conversation — so returning
  // here would answer "History unavailable" on a fork that has plenty of history to
  // show. Skip the short-circuit whenever an ancestor might supply the content.
  if (messages.length === 0 && !sourceAvailable && !record.forkedFromSessionId) {
    // Still booting: an absent transcript is expected, not a fault. Answer a plain
    // empty history so the client shows its normal "starting…" empty state instead
    // of a scary "History unavailable" card (see isHistoryStartupWindow).
    if (isHistoryStartupWindow(record)) return { messages: [], total: 0 };
    return { messages: [], total: 0, historyUnavailable: unavailableHistoryReason(record) };
  }

  const { rewriteHistoryRemoteImages } = await import('../session-history.js');
  if (record.host) {
    messages = await rewriteHistoryRemoteImages(messages, record.host, sessionId, record.cwd);
  }

  // Fork-aware: prepend ancestor history in chain order (root-first). The
  // pointer walk is a cheap local lookup; the expensive history fetches run
  // in parallel (same two-phase strategy the web /history route uses).
  let forkedFromSessionId: string | undefined;
  let forkBoundaryIndex: number | undefined;
  if (record.forkedFromSessionId) {
    forkedFromSessionId = record.forkedFromSessionId;
    try {
      const ancestors: SessionRecord[] = [];
      const visited = new Set<string>([sessionId]);
      let currentForkId: string | undefined = record.forkedFromSessionId;
      while (currentForkId && !visited.has(currentForkId) && ancestors.length < MAX_FORK_DEPTH) {
        visited.add(currentForkId);
        const sourceRecord = await getSessionByClaudeId(currentForkId);
        if (!sourceRecord) break;
        ancestors.push(sourceRecord);
        currentForkId = sourceRecord.forkedFromSessionId;
      }
      const ordered = [...ancestors].reverse();
      const fetched = await Promise.all(
        ordered.map(async (sourceRecord) => {
          const src = await readProviderSessionHistory(
            sourceRecord.claudeSessionId, sourceRecord, sourceRecord.host,
          );
          let sourceMessages = src.messages;
          if (sourceRecord.host) {
            sourceMessages = await rewriteHistoryRemoteImages(
              sourceMessages, sourceRecord.host, sourceRecord.claudeSessionId, sourceRecord.cwd,
            );
          }
          return sourceMessages;
        }),
      );
      const allSourceMessages = fetched.flat();
      if (allSourceMessages.length > 0) {
        messages = [...allSourceMessages, ...messages];
        forkBoundaryIndex = allSourceMessages.length;
      }
    } catch (err) {
      // Snapshot API: a transient ancestor failure degrades to own-session
      // history only (no cursor space to poison — unlike the delta route).
      log.session.warn('rich history: failed to load fork source history', {
        sessionId, forkedFrom: record.forkedFromSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      forkedFromSessionId = undefined;
    }
  }

  // Deferred verdict for forks: the short-circuit above was skipped so the
  // ancestors got their chance. If they produced nothing either, THIS is the
  // point where "nothing to show" becomes true, so report it here instead.
  if (messages.length === 0 && !sourceAvailable && record.forkedFromSessionId) {
    if (isHistoryStartupWindow(record)) return { messages: [], total: 0 };
    return { messages: [], total: 0, historyUnavailable: unavailableHistoryReason(record) };
  }

  const total = messages.length;
  const sliced = tail && tail > 0 ? messages.slice(-tail) : messages;
  const adjustedForkBoundary = forkBoundaryIndex != null && tail && tail > 0
    ? (forkBoundaryIndex >= total - tail ? forkBoundaryIndex - (total - tail) : undefined)
    : forkBoundaryIndex;

  // Stamp `unsettled: true` so a client that loads mid-flight knows which rows
  // may still change (same predicate the web delta path uses).
  const { isUnsettledRow } = await import('../history-delta.js');
  const marked = sliced.map((m) => (isUnsettledRow(m) ? { ...m, unsettled: true } : m));

  return {
    messages: marked,
    total,
    ...(forkedFromSessionId ? { forkedFromSessionId } : {}),
    ...(adjustedForkBoundary != null ? { forkBoundaryIndex: adjustedForkBoundary } : {}),
    ...(historyWindowed ? { windowed: true } : {}),
  };
}
