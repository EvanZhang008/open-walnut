/**
 * Quick-start core — create a task and start a real Claude Code session for it.
 *
 * Extracted from the POST /api/sessions/quick-start handler so non-HTTP callers
 * (the claude-code routine executor) can start sessions through the exact same
 * path: task creation → TASK_CREATED → SESSION_START bus emit → session-runner
 * spawns the CLI (locally or via the remote daemon).
 */

import path from 'node:path';
import { log } from '../../logging/index.js';
import { addTask, getTask, updateTask, togglePin, setFocusTier } from '../task-manager.js';
import { getSessionsForTask, updateSessionRecord } from '../session-tracker.js';
import { bus, EventNames } from '../event-bus.js';
import type { Task, SessionEngine } from '../types.js';
import { spillLargePromptToFile } from './quick-start-spill.js';

export interface QuickStartTaskMeta {
  starred?: boolean;
  needs_attention?: boolean;
  priority?: 'immediate' | 'important' | 'backlog' | 'none';
  pinTier?: 'focus' | 'satellite' | 'wait';
}

export interface QuickStartParams {
  message: string;
  /**
   * Prepended to the (possibly spilled) message — NOT subject to spill.
   * The HTTP route uses this for the attached-images context block, matching
   * the original handler's order: spill first, then prefix.
   */
  messagePrefix?: string;
  cwd: string;
  host?: string;
  model?: string;
  mode?: string;
  /** Retry mode: reuse this task instead of creating a new one. */
  existingTaskId?: string;
  taskMeta?: QuickStartTaskMeta;
  /** Task title; defaults to "Session: <basename(cwd)>". */
  taskTitle?: string;
  /** Task project; defaults to 'Quick Start'. */
  project?: string;
  /** Event-bus source tag, e.g. 'quick-start' | 'routine'. */
  source: string;
  requestTs?: number;
  /** Coding-agent engine; defaults to 'claude' (native path). */
  engine?: SessionEngine;
  /**
   * Caller-minted session id, forwarded to the CLI as `--session-id`. Lets the
   * HTTP route return the session id in its response instead of making the UI
   * poll for it — the CLI adopts this id when it spawns. Native (claude) engine
   * only: the ACP path derives its own ids from the adapter.
   */
  preassignedSessionId?: string;
}

export class QuickStartError extends Error {
  constructor(message: string, public statusCode: number = 400) {
    super(message);
    this.name = 'QuickStartError';
  }
}

/**
 * The placeholder title a quick-start task gets when the caller supplies none.
 * Exported as the single definition of "still untitled" — the session
 * auto-title hook compares against this exact string to decide whether a
 * task's title is safe to replace with an AI-generated one.
 */
export function defaultSessionTaskTitle(cwd: string): string {
  return `Session: ${path.basename(cwd.replace(/\/+$/, '') || '/')}`;
}

/**
 * Create (or reuse) the task and emit SESSION_START. Returns the task.
 * Throws QuickStartError with an HTTP-ish statusCode on invalid input so the
 * route wrapper can map it 1:1.
 */
export async function quickStartSession(params: QuickStartParams): Promise<Task> {
  const {
    message, messagePrefix, cwd, host, model, mode, existingTaskId, taskMeta,
    source, requestTs = Date.now(), engine, preassignedSessionId,
  } = params;
  const project = params.project ?? 'Quick Start';

  // Spill-to-disk: messages above the inline limit are saved to a temp file and
  // replaced with a short pointer prompt so Claude reads the full context via the Read tool.
  let sessionMessage = message;
  let largePromptFile: { localPath: string; originalLength: number } | undefined;
  const spill = spillLargePromptToFile(message);
  if (spill) {
    sessionMessage = spill.promptWithPointer;
    largePromptFile = { localPath: spill.filePath, originalLength: spill.originalLength };
    log.web.info(`${source}: spilled large prompt to file`, {
      filePath: spill.filePath,
      originalLength: spill.originalLength,
      host,
    });
  }
  if (messagePrefix) {
    sessionMessage = messagePrefix + sessionMessage;
  }

  // Quick Start tasks always go to the built-in 'Local' category (source=local,
  // hard-reserved via config.local.categories so no sync plugin can claim it).
  // The session AI will move the task to the correct category/project after completion.
  const taskCategory = 'Local';

  let updatedTask: Task;

  if (existingTaskId) {
    // Retry mode: reuse existing task, archive error sessions.
    // Note: footer taskMeta picks (starred/needs_attention/priority/pinTier) are
    // intentionally IGNORED on retry — we preserve the original task's metadata.
    updatedTask = await getTask(existingTaskId);
    if (!updatedTask) {
      throw new QuickStartError(`Task "${existingTaskId}" not found`, 404);
    }
    // Archive all error/stopped sessions under this task to free the slot
    const existingSessions = await getSessionsForTask(updatedTask.id);
    for (const s of existingSessions) {
      if (!s.archived && (s.process_status === 'error' || s.process_status === 'stopped')) {
        await updateSessionRecord(s.claudeSessionId, { archived: true, archive_reason: 'retry' });
        try {
          const { clearSession, clearSessionSlot } = await import('../task-manager.js');
          await clearSession(updatedTask.id, s.claudeSessionId);
          await clearSessionSlot(updatedTask.id, s.claudeSessionId);
        } catch { /* task may not exist */ }
      }
    }
  } else {
    // Normal mode: create new task
    const title = params.taskTitle?.trim() || defaultSessionTaskTitle(cwd);
    const { task } = await addTask({
      title,
      category: taskCategory,
      project,
      source: 'local',
    });
    // Merge taskMeta into initial update; `starred` defaults to true for quick-start.
    const updates: Partial<Task> = {
      starred: taskMeta?.starred ?? true,
      cwd,
    };
    if (taskMeta?.needs_attention) updates.needs_attention = true;
    // 'none' is a sentinel meaning "don't write priority" — lets a future retry
    // branch or other caller omit the field without clearing an existing value.
    if (taskMeta?.priority && taskMeta.priority !== 'none') updates.priority = taskMeta.priority;
    await updateTask(task.id, updates, { source });
    // Pin + tier — only for new tasks, only when the caller picked a tier.
    //
    // Sequencing matters: setFocusTier() throws if the task isn't pinned, so
    // togglePin() MUST run first. Best-effort: if either call fails, we log and
    // let the session start anyway.
    if (taskMeta?.pinTier) {
      try {
        await togglePin(task.id);
        await setFocusTier(task.id, taskMeta.pinTier);
      } catch (err) {
        log.web.warn(`${source}: failed to apply pin/tier`, {
          taskId: task.id,
          tier: taskMeta.pinTier,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    updatedTask = await getTask(task.id);
  }

  if (!existingTaskId) {
    bus.emit(EventNames.TASK_CREATED, { task: updatedTask }, ['web-ui', 'main-agent'], { source });
  }

  // A start targeting a remote host is deliberate (human click or a routine the
  // user configured) — forget any cached connection failure so we reconnect
  // fresh rather than fast-fail.
  if (host) {
    const { clearDaemonFailureCache } = await import('../../providers/daemon-connection.js');
    clearDaemonFailureCache(host);
  }

  // Seed the session record BEFORE the spawn when the id is caller-minted.
  //
  // Why this is required, not just nice: returning the id lets the UI mount the
  // real session panel immediately, and that panel's first act is
  // GET /api/sessions/:id. Until the spawn is confirmed (~200ms local, seconds
  // for a cold remote daemon) no record exists, so that GET 404s — and a 404 is
  // treated as "session does not exist" (not a transient error), so the panel
  // would settle permanently into its "Untitled session" empty state. Writing a
  // minimal row up front makes the read succeed from the first frame; the spawn's
  // own persistSessionRecord then fills in pid/outputFile/model (it takes the
  // "row exists" branch and updates in place — same id, so no duplicate).
  //
  // Safe against the orphan sweepers: a pid-less non-terminal row is only reaped
  // after a 2-minute grace period on last_status_change (session-health-monitor's
  // ORPHAN_GRACE_MS), which is far longer than any spawn.
  if (preassignedSessionId && engine !== 'codex') {
    try {
      const { createSessionRecord } = await import('../session-tracker.js');
      await createSessionRecord(preassignedSessionId, updatedTask.id, project, cwd, {
        title: updatedTask.title,
        mode: mode as import('../types.js').SessionMode | undefined,
        host,
        // No turn has begun (the CLI isn't up yet) — 'running' would show a
        // phantom "working…" badge on a session that hasn't started.
        initialProcessStatus: 'idle',
        // Marks "no pid YET" so the liveness overlay doesn't read the missing pid
        // as a dead process and persist 'stopped' on a session just launched.
        initialStatusReason: 'awaiting_spawn',
      });
    } catch (err) {
      // Non-fatal: the spawn path persists the record too. Worst case the UI's
      // first metadata read 404s and the panel shows its empty state briefly.
      log.web.warn(`${source}: pre-spawn session record seed failed`, {
        sessionId: preassignedSessionId, taskId: updatedTask.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Emit SESSION_START event (sessionMessage includes image path annotations if the caller prepended them)
  bus.emit(EventNames.SESSION_START, {
    taskId: updatedTask.id,
    message: sessionMessage,
    cwd,
    project,
    mode,
    model,
    host,
    largePromptFile,
    requestTs,
    engine,
    // ACP (codex) mints its own ids inside the adapter — only forward for native.
    ...(preassignedSessionId && engine !== 'codex' ? { preassignedSessionId } : {}),
  }, ['session-runner'], { source });

  log.web.info(`${source}: created task + started session`, {
    taskId: updatedTask.id, cwd, host, category: taskCategory, retry: !!existingTaskId,
  });

  return updatedTask;
}
