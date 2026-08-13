/**
 * "Start (or resume) a session for an EXISTING task" core — extracted from the
 * old in-process `open-walnut start <task_id>` command so the CLI can drive it
 * over HTTP (POST /api/v1/tasks/:id/start) instead of writing sessions.json
 * from its own process.
 *
 * Deliberately NOT quickStartSession(): that path creates/reuses a task from a
 * cwd (the mobile/web launcher shape, cwd REQUIRED). This one starts from a
 * task that already exists and lets the session-runner resolve cwd the way it
 * always has for bus-driven starts (task.cwd → parent chain → project
 * default_cwd → project memory dir).
 *
 * Callers: the v1 route (server process, runner already initialized) and the
 * CLI's WALNUT_CLI_DIRECT escape hatch (which inits the runner itself first).
 */

import { getTask } from '../task-manager.js';
import { getSessionsForTask } from '../session-tracker.js';
import { bus, EventNames } from '../event-bus.js';
import { QuickStartError } from './quick-start.js';

export interface TaskStartParams {
  /** Task id or unique id prefix. */
  taskIdPrefix: string;
  /** Prefer sending into an already-live session for this task. */
  resume?: boolean;
  /** Initial prompt / message. Defaults to a sentence naming the task. */
  prompt?: string;
  /** Event-bus source tag, e.g. 'cli'. */
  source: string;
}

export interface TaskStartResult {
  action: 'start' | 'resume';
  taskId: string;
  title: string;
  /** Present for action:'resume' — the live session the message went into. */
  sessionId?: string;
  /** True when --resume was asked for but no live session existed. */
  resume_missed?: boolean;
}

/** Live enough to accept a message instead of spawning a new session. */
const RESUMABLE_STATUSES = new Set(['running', 'idle']);

export async function startSessionForTask(params: TaskStartParams): Promise<TaskStartResult> {
  const { taskIdPrefix, resume, prompt, source } = params;

  let task;
  try {
    task = await getTask(taskIdPrefix);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No task found matching')) {
      throw new QuickStartError(`No task found matching "${taskIdPrefix}"`, 404);
    }
    if (msg.includes('Ambiguous ID prefix')) throw new QuickStartError(msg, 400);
    throw err;
  }

  if (resume) {
    const sessions = await getSessionsForTask(task.id);
    const existing = sessions.find((s) => RESUMABLE_STATUSES.has(s.process_status));
    if (existing) {
      const message = prompt ?? `Continuing work on: ${task.title}`;
      const { sendMessageToSession } = await import('../session-message-queue.js');
      await sendMessageToSession(existing.claudeSessionId, message, { source, taskId: task.id });
      return { action: 'resume', taskId: task.id, title: task.title, sessionId: existing.claudeSessionId };
    }
  }

  const message = prompt ?? `Working on task: ${task.title}`;
  bus.emit(EventNames.SESSION_START, {
    taskId: task.id,
    message,
    project: task.project,
  }, ['session-runner'], { source });

  return {
    action: 'start',
    taskId: task.id,
    title: task.title,
    ...(resume ? { resume_missed: true } : {}),
  };
}
