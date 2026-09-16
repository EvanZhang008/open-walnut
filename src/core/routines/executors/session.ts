/**
 * session executor — deliver into the conversation on a task: the live session
 * when its CLI is up, the stopped one (cold `--resume`) when the idle reaper got
 * there first, and a new session on the same task only when neither exists.
 *
 * This is the outcome half of walnut-trigger (docs/plan/walnut-trigger.md): the
 * daemon decided something happened, and the conversation that should hear about
 * it is the one that set the trigger up, typically hours ago. The task is the
 * durable home — a session can die and be restarted without the conversation
 * losing its place on the board — which is exactly the resolution the watcher's
 * `trigger_session` outcome performs (the session pick is shared in
 * ../session-target.ts; the rest is duplicated here on purpose, since importing
 * an executor from another executor would tie two independent surfaces together).
 *
 * The one thing it will NOT do: resurrect a task the human closed. A completed
 * or deleted target is an ERROR plus a notification, never a new task — a
 * trigger that keeps recreating work the user finished is worse than one that
 * says it has nowhere to deliver.
 */

import { WALNUT_HOME } from '../../../constants.js';
import { log } from '../../../logging/index.js';
import type { ExecutorDefinition } from '../types.js';
import type { CronJob } from '../../cron/types.js';
import { parseWalnutMessage, sessionHandle } from '../../peers/walnut-message-tag.js';
import { buildScheduledSessionMessage } from '../trigger-envelope.js';
import { isLiveSessionStatus, pickDeliverySession } from '../session-target.js';

export interface SessionExecutorConfig {
  /** Task the session belongs to. Resolved from `session: 'this'` at create time. */
  target: string;
  prompt: string;
  /** Mirror of `prompt` — the cron engine's legacy pipeline reads this name. */
  instructions?: string;
}

/**
 * Everything this executor does to the outside world, in one injectable object
 * (same shape as the watcher's `toolDeps`, for the same reason: the resolution
 * logic is what needs testing, not the four modules it reaches through).
 */
export interface SessionDelivery {
  /** Sessions recorded on the task, in any order (`lastActiveAt` breaks ties). */
  sessionsForTask(taskId: string): Promise<Array<{
    claudeSessionId: string;
    process_status?: string;
    archived?: boolean;
    lastActiveAt?: string;
    title?: string;
    host?: string;
  }>>;
  sendToSession(sessionId: string, message: string, taskId: string): Promise<void>;
  getTask(taskId: string): Promise<{ id: string; cwd?: string; phase?: string } | null>;
  startSession(params: { message: string; taskId: string; cwd: string; host?: string }): Promise<void>;
  notify(input: { title: string; body?: string; dedupKey: string; taskId?: string }): Promise<void>;
}

export interface SessionExecutorDeps {
  delivery?: SessionDelivery;
}

/** Real wiring. Kept out of the executor body so tests can swap it whole. */
function defaultDelivery(): SessionDelivery {
  return {
    async sessionsForTask(taskId) {
      const { getSessionsForTask } = await import('../../session-tracker.js');
      return await getSessionsForTask(taskId).catch(() => []);
    },
    async sendToSession(sessionId, message, taskId) {
      const { sendMessageToSession } = await import('../../session-message-queue.js');
      await sendMessageToSession(sessionId, message, { source: 'routine-trigger', taskId });
    },
    async getTask(taskId) {
      const { getTask } = await import('../../task-manager.js');
      return await getTask(taskId).catch(() => null);
    },
    async startSession(params) {
      const { quickStartSession } = await import('../../sessions/quick-start.js');
      await quickStartSession({
        message: params.message,
        existingTaskId: params.taskId,
        cwd: params.cwd,
        // A session at WALNUT_HOME is the Personal AI, not a coding agent in the
        // data dir — same rule the watcher's singleton restart follows.
        ...(params.cwd === WALNUT_HOME ? { walnutAgent: true } : {}),
        ...(params.host && params.host !== '__local__' ? { host: params.host } : {}),
        source: 'routine-trigger',
      });
    },
    async notify(input) {
      const { addNotification } = await import('../../notifications/store.js');
      await addNotification({
        kind: 'cron',
        severity: 'warning',
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        dedupKey: input.dedupKey,
        ...(input.taskId ? { taskId: input.taskId } : {}),
      });
    },
  };
}

/** The envelope to deliver. A fire arrives already wrapped; a plain scheduled run is wrapped here. */
function envelopeFor(job: CronJob, message: string, prompt: string): string {
  const parsed = parseWalnutMessage(message);
  if (parsed?.kind === 'trigger') return message;
  const body = message.trim() || prompt;
  return buildScheduledSessionMessage(job, body);
}

export function createSessionExecutor(deps: SessionExecutorDeps = {}): ExecutorDefinition {
  const delivery = deps.delivery ?? defaultDelivery();

  return {
    type: 'session',
    label: 'Session',
    description:
      'Send the prompt into the live session on a task, restarting that session on the same task '
      + 'when it has died. The task is the conversation\'s durable home.',
    configSchema: [
      {
        name: 'target',
        label: 'Task id',
        kind: 'text',
        required: true,
        placeholder: 'Task the session belongs to',
      },
      {
        name: 'prompt',
        label: 'Prompt',
        kind: 'textarea',
        required: true,
        placeholder: 'New review comments. Read each one; change code where it asks.',
      },
    ],

    validate(config: unknown) {
      if (typeof config !== 'object' || config === null) {
        return { ok: false, error: 'config must be an object' };
      }
      const c = config as Record<string, unknown>;
      const target = typeof c.target === 'string' ? c.target.trim() : '';
      if (!target) return { ok: false, error: 'target (a task id) is required' };
      const prompt = typeof c.prompt === 'string' ? c.prompt.trim()
        : typeof c.instructions === 'string' ? c.instructions.trim() : '';
      if (!prompt) return { ok: false, error: 'prompt is required' };
      // `instructions` is written too, not as a duplicate but because the cron
      // engine's legacy pipeline (executeJobCore's non-empty check, the derived
      // payload) only knows that name — without it a plain scheduled `session`
      // routine would skip every run with "requires non-empty instructions".
      return { ok: true, config: { target, prompt, instructions: prompt } };
    },

    async run(job: CronJob, executor, message: string) {
      const config = executor.config as unknown as SessionExecutorConfig;
      const taskId = config.target;
      const envelope = envelopeFor(job, message, config.prompt);

      const sessions = await delivery.sessionsForTask(taskId);
      const target = pickDeliverySession(sessions);
      if (target) {
        await delivery.sendToSession(target.claudeSessionId, envelope, taskId);
        // A stopped session is resumed cold (7-14s before the CLI reads it); the
        // run history says so, so a slow landing is not mistaken for a lost one.
        const verb = isLiveSessionStatus(target.process_status) ? 'sent to' : 'resumed';
        return {
          status: 'ok',
          summary: `${verb} session ${sessionHandle(target.title, target.claudeSessionId)}`,
        };
      }

      const task = await delivery.getTask(taskId);
      const state = !task ? 'gone' : task.phase === 'COMPLETE' ? 'complete' : null;
      if (state) {
        const error = `target task ${taskId} is ${state}; the trigger will not resurrect it`;
        await delivery.notify({
          title: `Trigger "${job.name}" has nowhere to deliver`,
          body: error,
          dedupKey: `trigger-target:${job.id}:${state}`,
          ...(task ? { taskId } : {}),
        }).catch(() => { /* the run result already carries the error */ });
        log.cron.warn('trigger session target unusable', { jobId: job.id, taskId, state });
        return { status: 'error', error };
      }

      // No resumable session but the task is open: start a new conversation on
      // the task, where the old one lived. The trigger's own host/cwd is the best
      // guess when the task has none — that is where the check itself runs.
      const host = job.check?.host && job.check.host !== '__local__'
        ? job.check.host
        : sessions.find((s) => s.host)?.host;
      const cwd = task?.cwd || job.check?.cwd || WALNUT_HOME;
      await delivery.startSession({
        message: envelope,
        taskId,
        cwd,
        ...(host ? { host } : {}),
      });
      return { status: 'ok', summary: `restarted session on task ${taskId}` };
    },
  };
}
