/**
 * The watcher's tool belt: two memory tools and three outcome tools.
 *
 * A background loop with unrestricted task_create can create duplicate work
 * after its history drops a prompt-only limit. Every limit therefore lives at
 * the tool boundary, where the model has no say:
 *
 *   - a per-run outcome cap,
 *   - a per-day cap on new sessions,
 *   - a dedup key check on every outcome.
 *
 * Refusals are returned as ordinary tool results, never thrown: a watcher that
 * hits its budget should summarize and stop, not fail the whole run.
 *
 * Order of operations in every outcome tool: check budget → check key → DO the
 * thing → record it. Recording last means a crash costs one duplicate the user
 * can see, rather than a key marked done for an outcome that never happened.
 */

import type { ToolDefinition } from '../../model/tools.js';
import {
  hasActed, markSeen, updateTriggerState, NOTES_MAX_CHARS,
  type TriggerState,
} from './trigger-state.js';
import type { WatcherOutcome } from './watcher-contract.js';
import { log } from '../../logging/index.js';

export interface WatcherToolContext {
  jobId: string;
  jobName: string;
  /** Snapshot loaded at run start; tools re-read under the lock before writing. */
  state: TriggerState;
  maxOutcomesPerRun: number;
  maxSessionsPerDay: number;
  /** Where a singleton session runs. Defaults to the Walnut home dir. */
  sessionCwd?: string;
  sessionHost?: string;
  sessionModel?: string;
  /** Project new tasks land in. */
  project: string;
  nowMs: () => number;
}

/** Seams so tests can assert what the tools DID without a server. */
export interface WatcherToolDeps {
  createTask: (input: {
    title: string; description?: string; project?: string; pinned?: boolean; pinTier?: string;
  }) => Promise<{ id: string; title: string }>;
  notify: (input: {
    title: string; body?: string; severity: 'info' | 'warning' | 'error'; dedupKey: string; taskId?: string;
  }) => Promise<void>;
  /** Resolve-or-create the singleton, then deliver. Returns whether it had to
   *  start a session (which is what the per-day cap counts). */
  sendToSingleton: (input: {
    taskId?: string; title: string; message: string;
    cwd?: string; host?: string; model?: string;
  }) => Promise<{ taskId: string; startedSession: boolean }>;
}

export interface WatcherToolBelt {
  tools: ToolDefinition[];
  /** What actually happened, in call order. The run summary is built from this,
   *  never from the model's own claims. */
  outcomes: WatcherOutcome[];
}

const MAX_SEEN_IDS_PER_CALL = 200;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function createWatcherTools(ctx: WatcherToolContext, deps: WatcherToolDeps): WatcherToolBelt {
  const outcomes: WatcherOutcome[] = [];

  /** Shared gate for the three outcome tools. Returns a refusal string, or null. */
  const gate = (key: string): string | null => {
    if (!key) return 'Refused: every outcome needs a stable "key" taken from the source item id.';
    if (outcomes.length >= ctx.maxOutcomesPerRun) {
      return `Refused: this run's outcome budget (${ctx.maxOutcomesPerRun}) is used up. `
        + 'Stop acting and answer with one line summarizing what you found. '
        + 'Anything you did not get to stays new for the next run.';
    }
    if (hasActed(ctx.state, key)) {
      return `Refused: key "${key}" was already acted on for this routine. `
        + 'That item is done — move on, and do not retry with a different key.';
    }
    return null;
  };

  /** Record an outcome under the lock. Runs AFTER the outcome succeeded. */
  const record = async (tool: string, key: string, label?: string): Promise<void> => {
    const now = ctx.nowMs();
    ctx.state.acted[key] = now;
    outcomes.push({ tool, key, ...(label ? { label } : {}) });
    await updateTriggerState(ctx.jobId, (s) => { s.acted[key] = now; }, now);
  };

  const seenTool: ToolDefinition = {
    name: 'trigger_seen',
    description:
      'Filter a list of item ids down to the ones this routine has NEVER looked at before, '
      + 'and remember them. Call this right after fetching, before judging anything: the ids it '
      + 'does not return were handled on an earlier run and must be ignored.',
    input_schema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: `Ids of everything you just fetched, up to ${MAX_SEEN_IDS_PER_CALL}. Use the source's own ids.`,
        },
      },
      required: ['ids'],
    },
    async execute(params) {
      const raw = Array.isArray(params.ids) ? params.ids : [];
      if (raw.length === 0) return 'new: (none) — you passed no ids.';
      const ids = raw.slice(0, MAX_SEEN_IDS_PER_CALL).map((v) => String(v));
      const now = ctx.nowMs();
      // Mark in the snapshot first so two calls in one turn agree, then persist.
      const { newIds } = markSeen(ctx.state, ids, now);
      await updateTriggerState(ctx.jobId, (s) => { markSeen(s, ids, now); }, now);
      const skipped = ids.length - newIds.length;
      if (newIds.length === 0) return `new: (none) — all ${ids.length} were already seen.`;
      return `new: ${newIds.join(', ')}${skipped > 0 ? `\n(${skipped} already seen, ignore them)` : ''}`;
    },
  };

  const noteTool: ToolDefinition = {
    name: 'trigger_note',
    description:
      'Leave a short note for this routine\'s NEXT run — a cursor, a pending question, '
      + 'anything the next run should know. Replaces the previous note. Keep it to a few lines.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The note. Empty clears it.' } },
      required: ['text'],
    },
    async execute(params) {
      const text = str(params.text).slice(0, NOTES_MAX_CHARS);
      ctx.state.notes = text;
      await updateTriggerState(ctx.jobId, (s) => { s.notes = text; }, ctx.nowMs());
      return text ? 'Note saved for the next run.' : 'Note cleared.';
    },
  };

  const taskTool: ToolDefinition = {
    name: 'trigger_task',
    description:
      'Create a task for the user. Use this for anything that needs the user to DO something. '
      + 'Counts against this run\'s outcome budget.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Stable id of the source item this task is for.' },
        title: { type: 'string', description: 'Short imperative title, e.g. "Reply to Dana about the invoice".' },
        description: { type: 'string', description: 'What and why, including where it came from. A few lines.' },
        pin: {
          type: 'string',
          enum: ['focus', 'satellite', 'backlog', 'wait'],
          description: 'Put it on the pinned board in this tier. Omit to leave it unpinned — the default, and right for most items.',
        },
      },
      required: ['key', 'title'],
    },
    async execute(params) {
      const key = str(params.key);
      const refusal = gate(key);
      if (refusal) return refusal;
      const title = str(params.title);
      if (!title) return 'Refused: title is required.';
      const pin = str(params.pin);
      const task = await deps.createTask({
        title,
        ...(str(params.description) ? { description: str(params.description) } : {}),
        project: ctx.project,
        ...(pin ? { pinned: true, pinTier: pin } : {}),
      });
      await record('trigger_task', key, title);
      return `Created task ${task.id} "${task.title}".`;
    },
  };

  const notifyTool: ToolDefinition = {
    name: 'trigger_notify',
    description:
      'Put one line in the user\'s notification centre. Use this for something they should KNOW '
      + 'but not necessarily do. Counts against this run\'s outcome budget.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Stable id of the source item this is about.' },
        title: { type: 'string', description: 'One short line.' },
        body: { type: 'string', description: 'Optional detail, a couple of sentences.' },
        severity: { type: 'string', enum: ['info', 'warning', 'error'], description: 'Default info.' },
      },
      required: ['key', 'title'],
    },
    async execute(params) {
      const key = str(params.key);
      const refusal = gate(key);
      if (refusal) return refusal;
      const title = str(params.title);
      if (!title) return 'Refused: title is required.';
      const severityRaw = str(params.severity);
      const severity = severityRaw === 'warning' || severityRaw === 'error' ? severityRaw : 'info';
      await deps.notify({
        title,
        ...(str(params.body) ? { body: str(params.body) } : {}),
        severity,
        dedupKey: `routine:${ctx.jobId}:${key}`,
      });
      await record('trigger_notify', key, title);
      return 'Notified.';
    },
  };

  const sessionTool: ToolDefinition = {
    name: 'trigger_session',
    description:
      'Send a prompt into this routine\'s own long-running session, identified by a name you choose '
      + '("triage", "reviews"). The first send starts it; later sends land in the SAME conversation, so '
      + 'it accumulates context across runs. Use it when the work needs a real agent rather than a task '
      + 'or a notice. Counts against the outcome budget, and starting a new one counts against today\'s '
      + 'session limit.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Stable id of the source item, for dedup.' },
        name: { type: 'string', description: 'Which long-running session, e.g. "triage". Reused across runs.' },
        message: { type: 'string', description: 'The prompt to send. Self-contained — it may be read days later.' },
      },
      required: ['key', 'name', 'message'],
    },
    async execute(params) {
      const key = str(params.key);
      const refusal = gate(key);
      if (refusal) return refusal;
      const name = str(params.name) || 'default';
      const message = str(params.message);
      if (!message) return 'Refused: message is required.';

      const existingTaskId = ctx.state.singletons[name];
      // The cap is on STARTING sessions, not on sending: talking more to a
      // session that already exists is cheap and is the whole point.
      if (!existingTaskId && ctx.state.day.sessions >= ctx.maxSessionsPerDay) {
        return `Refused: this routine already started ${ctx.maxSessionsPerDay} session(s) today, its limit. `
          + 'Create a task or send a notification instead.';
      }

      const res = await deps.sendToSingleton({
        ...(existingTaskId ? { taskId: existingTaskId } : {}),
        title: `${ctx.jobName} — ${name}`,
        message,
        ...(ctx.sessionCwd ? { cwd: ctx.sessionCwd } : {}),
        ...(ctx.sessionHost ? { host: ctx.sessionHost } : {}),
        ...(ctx.sessionModel ? { model: ctx.sessionModel } : {}),
      });

      const now = ctx.nowMs();
      ctx.state.singletons[name] = res.taskId;
      if (res.startedSession) ctx.state.day.sessions += 1;
      await updateTriggerState(ctx.jobId, (s) => {
        s.singletons[name] = res.taskId;
        if (res.startedSession) s.day.sessions += 1;
      }, now);
      await record('trigger_session', key, name);

      log.cron.info('watcher sent to singleton session', {
        jobId: ctx.jobId, name, taskId: res.taskId, started: res.startedSession,
      });
      return res.startedSession
        ? `Started session "${name}" (task ${res.taskId}) and sent the prompt.`
        : `Sent the prompt into session "${name}" (task ${res.taskId}).`;
    },
  };

  return { tools: [seenTool, noteTool, taskTool, notifyTool, sessionTool], outcomes };
}

/** The watcher's own tool names — used to reject a colliding plugin tool. */
export const WATCHER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'trigger_seen', 'trigger_note', 'trigger_task', 'trigger_notify', 'trigger_session',
]);
