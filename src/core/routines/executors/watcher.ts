/**
 * watcher executor — a routine that LOOKS at something every tick and only
 * acts when there is something to act on.
 *
 * This is the general shape of a trigger: the schedule says when to look, the
 * user's own sentence says what to look at and what counts, and the outcome
 * tools are the only way anything reaches them. A routine is a trigger whose
 * source happens to be a clock; nothing here assumes that, so an event source
 * can drive the same executor later.
 *
 * Engine: runMicroAgent, not a Claude Code session. A watcher fires hundreds of
 * times a day and almost always finds nothing, so it must be a cheap in-process
 * turn (haiku by default, tight round cap, small prompt) rather than a CLI spawn
 * whose 32k-token prefix would be paid per tick. The consequence, stated so it
 * is not mistaken for an oversight: a watcher gets Walnut's own read-only tools
 * plus an allowlist of PLUGIN tools, not arbitrary MCP servers — those only
 * mount into spawned sessions. When a watcher genuinely needs one, its outcome
 * is trigger_session, and the session it starts has the full CLI tool belt.
 *
 * Plugin tools are allowlisted BY NAME on purpose: the mail plugin ships
 * mail_draft and mail_request_send next to mail_list, and an unattended watcher
 * with a default-everything tool belt would have write paths that bypass the
 * outcome budget entirely.
 */

import { WALNUT_HOME } from '../../../constants.js';
import { log } from '../../../logging/index.js';
import type { ExecutorDefinition } from '../types.js';
import type { CronJob } from '../../cron/types.js';
import {
  WATCHER_SYSTEM_PROMPT, buildWatcherUserMessage, summarizeWatcherRun,
} from '../watcher-contract.js';
import { createWatcherTools, WATCHER_TOOL_NAMES, type WatcherToolDeps } from '../watcher-tools.js';
import { loadTriggerState, updateTriggerState } from '../trigger-state.js';

const DEFAULT_MAX_OUTCOMES = 3;
const DEFAULT_MAX_SESSIONS_PER_DAY = 3;
const DEFAULT_TIMEOUT_SECONDS = 90;
const DEFAULT_MAX_TOOL_ROUNDS = 8;
/** Enough for a one-line answer plus the tool calls that precede it. */
const MAX_OUTPUT_TOKENS = 1200;

export interface WatcherExecutorConfig {
  instructions: string;
  /** Comma-separated plugin tool names, e.g. "mail_list, mail_read". */
  tools?: string;
  model?: string;
  maxOutcomesPerRun?: number;
  maxSessionsPerDay?: number;
  timeoutSeconds?: number;
  /** Project for tasks the watcher creates. Empty = Inbox. */
  project?: string;
  /** Working dir for trigger_session. Empty = a Personal AI session at home. */
  sessionCwd?: string;
  sessionHost?: string;
}

/** Test seam: the model turn. Real implementation is runMicroAgent. */
export type WatcherEngine = (opts: {
  system: string;
  userMessage: string;
  tools: import('../../../agent/tools.js').ToolDefinition[];
  model?: string;
  timeoutMs: number;
  jobId: string;
}) => Promise<{ response: string; aborted: boolean }>;

export interface WatcherExecutorDeps {
  engine?: WatcherEngine;
  toolDeps?: WatcherToolDeps;
  /** Plugin tools available right now. Defaults to the live registry. */
  pluginTools?: () => import('../../../agent/tools.js').ToolDefinition[];
  /** Read-only Walnut tools. Defaults to the built-in allowlist. */
  readOnlyTools?: () => import('../../../agent/tools.js').ToolDefinition[];
  nowMs?: () => number;
  /** Gate that keeps unprompted model calls off test servers. */
  backgroundDisabled?: () => boolean;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function parseToolNames(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function defaultEngine(opts: Parameters<WatcherEngine>[0]) {
  const { runMicroAgent } = await import('../../../agent/micro-agent.js');
  const result = await runMicroAgent({
    system: opts.system,
    userMessage: opts.userMessage,
    tools: opts.tools,
    ...(opts.model ? { model: opts.model } : { tier: 'haiku' as const }),
    maxTokens: MAX_OUTPUT_TOKENS,
    maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
    timeoutMs: opts.timeoutMs,
    usageSource: 'cron',
  });
  return { response: result.response, aborted: result.aborted };
}

/** Real outcome wiring. Kept out of the executor body so tests can swap it. */
function defaultToolDeps(): WatcherToolDeps {
  return {
    async createTask(input) {
      const { addTask } = await import('../../task-manager.js');
      const { task } = await addTask({
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        ...(input.project ? { project: input.project } : {}),
        ...(input.pinned ? { pinned: true } : {}),
        ...(input.pinTier ? { pinTier: input.pinTier } : {}),
      });
      return { id: task.id, title: task.title };
    },
    async notify(input) {
      const { addNotification } = await import('../../notifications/store.js');
      await addNotification({
        kind: 'cron',
        severity: input.severity,
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        dedupKey: input.dedupKey,
        ...(input.taskId ? { taskId: input.taskId } : {}),
      });
    },
    async sendToSingleton(input) {
      const { quickStartSession } = await import('../../sessions/quick-start.js');
      // A recorded task is the singleton's durable home: its session can die and
      // be restarted without the conversation losing its place on the board.
      if (input.taskId) {
        const { getSessionsForTask } = await import('../../session-tracker.js');
        const sessions = await getSessionsForTask(input.taskId).catch(() => []);
        const live = sessions.find((s) => !s.archived && (s.process_status === 'running' || s.process_status === 'idle'));
        if (live) {
          const { sendMessageToSession } = await import('../../session-message-queue.js');
          await sendMessageToSession(live.claudeSessionId, input.message, {
            source: 'routine-watcher',
            taskId: input.taskId,
          });
          return { taskId: input.taskId, startedSession: false };
        }
        // Task still exists but its session is gone → resume on the same task.
        const { getTask } = await import('../../task-manager.js');
        const existing = await getTask(input.taskId).catch(() => null);
        if (existing) {
          await quickStartSession({
            message: input.message,
            existingTaskId: input.taskId,
            cwd: input.cwd ?? WALNUT_HOME,
            ...(input.cwd ? {} : { walnutAgent: true }),
            ...(input.host ? { host: input.host } : {}),
            ...(input.model ? { model: input.model } : {}),
            source: 'routine-watcher',
          });
          return { taskId: input.taskId, startedSession: true };
        }
      }
      const task = await quickStartSession({
        message: input.message,
        cwd: input.cwd ?? WALNUT_HOME,
        ...(input.cwd ? {} : { walnutAgent: true }),
        ...(input.host ? { host: input.host } : {}),
        ...(input.model ? { model: input.model } : {}),
        taskTitle: input.title,
        // Background automation never grabs the pinned board.
        taskMeta: { pinTier: null },
        project: 'Routines',
        source: 'routine-watcher',
      });
      return { taskId: task.id, startedSession: true };
    },
  };
}

export function createWatcherExecutor(deps: WatcherExecutorDeps = {}): ExecutorDefinition {
  const nowMs = deps.nowMs ?? (() => Date.now());

  return {
    type: 'watcher',
    label: 'Watcher',
    description:
      'Look at something every tick and only act when there is something new: create a task, '
      + 'notify, or send into a long-running session. Remembers what it already handled.',
    configSchema: [
      {
        name: 'instructions',
        label: 'What to watch',
        kind: 'textarea',
        required: true,
        placeholder: 'Check my unread mail. If something needs a reply from me, make a task for it. Ignore newsletters.',
      },
      {
        name: 'tools',
        label: 'Data tools',
        kind: 'text',
        placeholder: 'mail_list, mail_read — none by default; each one costs tokens every run',
      },
      { name: 'model', label: 'Model', kind: 'select', optionsKey: 'models' },
      { name: 'project', label: 'Put tasks in project', kind: 'text', placeholder: 'Leave empty for the Inbox' },
      { name: 'maxOutcomesPerRun', label: 'Max outcomes per run', kind: 'number', placeholder: '3' },
      { name: 'maxSessionsPerDay', label: 'Max new sessions per day', kind: 'number', placeholder: '3', min: 0 },
      { name: 'timeoutSeconds', label: 'Timeout (seconds)', kind: 'number', placeholder: '90' },
      { name: 'sessionCwd', label: 'Session working directory', kind: 'path', placeholder: 'Empty = a Personal AI session' },
      { name: 'sessionHost', label: 'Session host', kind: 'select', optionsKey: 'hosts' },
    ],

    validate(config: unknown) {
      if (typeof config !== 'object' || config === null) {
        return { ok: false, error: 'config must be an object' };
      }
      const c = config as Record<string, unknown>;
      const instructions = typeof c.instructions === 'string' ? c.instructions.trim() : '';
      if (!instructions) return { ok: false, error: 'instructions is required' };

      const out: Record<string, unknown> = { instructions };
      const toolNames = parseToolNames(c.tools);
      // Reject a collision here rather than at run time: a plugin tool named
      // trigger_* would shadow the outcome layer, which is the one thing that
      // must never be replaceable from config.
      const clash = toolNames.find((n) => WATCHER_TOOL_NAMES.has(n));
      if (clash) return { ok: false, error: `"${clash}" is a built-in watcher tool — remove it from Data tools` };
      if (toolNames.length > 0) out.tools = toolNames.join(', ');

      if (typeof c.model === 'string' && c.model.trim()) out.model = c.model.trim();
      if (typeof c.project === 'string' && c.project.trim()) out.project = c.project.trim();
      if (typeof c.sessionCwd === 'string' && c.sessionCwd.trim()) {
        const cwd = c.sessionCwd.trim();
        if (!cwd.startsWith('/')) return { ok: false, error: 'sessionCwd must be an absolute path' };
        out.sessionCwd = cwd;
      }
      if (typeof c.sessionHost === 'string' && c.sessionHost.trim() && c.sessionHost !== '__local__') {
        out.sessionHost = c.sessionHost.trim();
      }
      if (c.maxOutcomesPerRun !== undefined && c.maxOutcomesPerRun !== '') {
        out.maxOutcomesPerRun = num(c.maxOutcomesPerRun, DEFAULT_MAX_OUTCOMES, 1, 20);
      }
      if (c.maxSessionsPerDay !== undefined && c.maxSessionsPerDay !== '') {
        out.maxSessionsPerDay = num(c.maxSessionsPerDay, DEFAULT_MAX_SESSIONS_PER_DAY, 0, 20);
      }
      if (c.timeoutSeconds !== undefined && c.timeoutSeconds !== '') {
        out.timeoutSeconds = num(c.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, 10, 600);
      }
      return { ok: true, config: out };
    },

    async run(job: CronJob, executor, message: string) {
      const config = executor.config as unknown as WatcherExecutorConfig;

      // ── Tool belt ──
      // Resolved BEFORE the background-AI gate on purpose: a watcher naming a
      // data tool that does not exist is misconfigured, and that has to be loud
      // even on a box that never calls a model. Hiding it behind the gate would
      // mean the mistake only ever surfaces in production.
      //
      // ONE pool, no freebies: read-only Walnut tools and plugin tools are named
      // the same way, and an unnamed tool is simply absent. See the note in
      // watcher-contract.ts for the measurement behind that.
      const wantedNames = parseToolNames(config.tools);
      let dataTools: import('../../../agent/tools.js').ToolDefinition[] = [];
      if (wantedNames.length > 0) {
        const agentTools = await import('../../../agent/tools.js');
        const available = [
          ...(deps.readOnlyTools ?? agentTools.getReadOnlyTools)(),
          ...(deps.pluginTools ?? agentTools.getPluginTools)(),
        ];
        const byName = new Map(available.map((t) => [t.name, t]));
        const missing = wantedNames.filter((n) => !byName.has(n));
        if (missing.length > 0) {
          // NAME what exists: a watcher that silently ran without its data tools
          // would report "nothing new" forever, which reads as working. Same
          // rule as the claude-code executor's unknown-host check.
          const known = [...byName.keys()];
          return {
            status: 'error',
            error: `unknown data tool(s): ${missing.join(', ')} — available: ${known.length ? known.join(', ') : '(none)'}`,
          };
        }
        // De-duplicated in the order named, so a repeated name cannot pay twice.
        dataTools = [...new Set(wantedNames)].map((n) => byName.get(n)!);
      }

      const backgroundDisabled = deps.backgroundDisabled
        ?? (await import('../../cheap-model.js')).backgroundAiDisabled;
      if (backgroundDisabled()) {
        // Not an error: a test server / WALNUT_DISABLE_BACKGROUND_AI box is
        // supposed to hold unprompted model calls. Say so in the summary rather
        // than recording a failure that would engage the error backoff.
        return { status: 'ok', summary: 'skipped — background model calls are disabled here' };
      }

      const now = nowMs();
      const state = await loadTriggerState(job.id, now);
      const maxOutcomesPerRun = config.maxOutcomesPerRun ?? DEFAULT_MAX_OUTCOMES;
      const maxSessionsPerDay = config.maxSessionsPerDay ?? DEFAULT_MAX_SESSIONS_PER_DAY;
      const { tools: watcherTools, outcomes } = createWatcherTools({
        jobId: job.id,
        jobName: job.name,
        state,
        maxOutcomesPerRun,
        maxSessionsPerDay,
        ...(config.sessionCwd ? { sessionCwd: config.sessionCwd } : {}),
        ...(config.sessionHost ? { sessionHost: config.sessionHost } : {}),
        // config.model is the WATCHER's cheap model and is deliberately NOT
        // forwarded: a session started by trigger_session does real work and
        // must not inherit haiku just because the poll runs on it.
        project: config.project ?? '',
        nowMs,
      }, deps.toolDeps ?? defaultToolDeps());

      // `message` (not config.instructions) is what the engine hands us: it
      // already carries any init-processor output prepended by the cron engine.
      const userMessage = buildWatcherUserMessage({
        instructions: message,
        notes: state.notes,
        budget: {
          outcomesPerRun: maxOutcomesPerRun,
          sessionsPerDay: maxSessionsPerDay,
          sessionsUsedToday: state.day.sessions,
        },
        dataTools: dataTools.map((t) => t.name),
        nowIso: new Date(now).toISOString(),
        ...(state.lastRunAtMs ? { lastRunIso: new Date(state.lastRunAtMs).toISOString() } : {}),
      });

      const engine = deps.engine ?? defaultEngine;
      let response = '';
      let aborted = false;
      let engineError: string | undefined;
      try {
        const result = await engine({
          system: WATCHER_SYSTEM_PROMPT,
          userMessage,
          tools: [...dataTools, ...watcherTools],
          ...(config.model ? { model: config.model } : {}),
          timeoutMs: (config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
          jobId: job.id,
        });
        response = result.response;
        aborted = result.aborted;
      } catch (err) {
        engineError = err instanceof Error ? err.message : String(err);
      }

      // lastRunAtMs is recorded even on a failed turn: it means "when we last
      // looked", and the next run's prompt is more honest with it than without.
      await updateTriggerState(job.id, (s) => { s.lastRunAtMs = now; }, now);

      const summary = summarizeWatcherRun(outcomes, response, { aborted });
      log.cron.info('watcher run finished', {
        jobId: job.id, jobName: job.name, outcomes: outcomes.length, aborted,
        ...(engineError ? { error: engineError } : {}),
      });

      if (engineError) {
        // Outcomes already applied are real and stay; the run is still an error
        // so the cron engine backs off instead of hammering a broken source.
        return { status: 'error', error: engineError, summary };
      }
      // A timeout that produced NOTHING is a failure, not a quiet run: reporting
      // ok would reset consecutiveErrors, so a watcher timing out on every tick
      // would keep polling forever and read as healthy in the UI. A timeout that
      // DID act is a partial success and stays ok — the work landed.
      if (aborted && outcomes.length === 0) {
        return { status: 'error', error: 'watcher timed out before it reported anything', summary };
      }
      return { status: 'ok', summary };
    },
  };
}
