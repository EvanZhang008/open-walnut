/**
 * claude-code executor — starts a REAL Claude Code session for the routine,
 * on the local machine or a configured remote host, through the exact same
 * path as the UI's Quick Start (task create → SESSION_START → session-runner).
 *
 * The session shows up in the normal SessionPanel; the user can watch it,
 * open its transcript, and take over the conversation mid-run.
 *
 * Four fields exist for routines that run as one of Walnut's own console agents
 * (Inbox Triage is the first): `walnutAgent` + `agentId` give the session that
 * agent's persona and standing memory, `project` files the run's task where that
 * agent's asks are listed, and `titleTemplate` names the run after its clock and
 * its batch size. All four are OPTIONAL and nothing about an ordinary routine
 * changes when they are absent — that is pinned by a test, because this executor
 * runs every user-authored routine on the box.
 *
 * `engine` is deliberately NOT a field: an omitted engine inherits
 * `config.defaults.engine` inside quickStartSession, so a user who switches
 * Walnut's default engine switches their routines with it.
 */

import { quickStartSession } from '../../sessions/quick-start.js';
import { getConfig } from '../../config-manager.js';
import type { ExecutorDefinition } from '../types.js';

/**
 * The private channel an init processor uses to tell this executor how many
 * items its batch carried: ONE line, anywhere in the first few lines of the
 * message. The line is consumed here (stripped before the session ever sees it),
 * so it is bookkeeping between two Walnut layers and not text a model reads.
 *
 * A message that has no such line is passed through byte-identical.
 */
const COUNT_HINT_RE = /^[ \t]*WALNUT_TRIAGE_COUNT:[ \t]*(\d{1,9})[ \t]*$/;

/** How far into the message the hint may sit (it is meant to be prepended). */
const COUNT_HINT_SCAN_LINES = 5;

/** The hint's value, or undefined when the message carries none. */
export function readTriageCountHint(message: string): number | undefined {
  const lines = message.split('\n', COUNT_HINT_SCAN_LINES);
  for (const line of lines) {
    const m = COUNT_HINT_RE.exec(line);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** The message with the hint line removed (unchanged when there is none). */
export function stripTriageCountHint(message: string): string {
  const head = message.split('\n', COUNT_HINT_SCAN_LINES);
  if (!head.some((line) => COUNT_HINT_RE.test(line))) return message;
  const lines = message.split('\n');
  const kept = lines.filter((line, i) => !(i < COUNT_HINT_SCAN_LINES && COUNT_HINT_RE.test(line)));
  // A hint on its own line leaves a blank line behind; drop leading blanks so
  // the session's first message still starts with real content.
  while (kept.length > 0 && kept[0].trim() === '') kept.shift();
  return kept.join('\n');
}

/** Local HH:MM, zero-padded. */
function localHhMm(nowMs: number): string {
  const d = new Date(nowMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Render a task-title template. `{time}` is the run's local HH:MM; `{count}` is
 * the batch size, which only an init processor knows.
 *
 * When the count is unknown, the ` · `-separated SEGMENT that needed it is
 * dropped instead of substituting a zero: "Triage · 14:10" is honest about a
 * batch nobody counted, while "Triage · 14:10 · 0 items" is a claim.
 */
export function renderRoutineTitleTemplate(
  template: string,
  opts: { nowMs: number; count?: number },
): string {
  const withTime = template.split('{time}').join(localHhMm(opts.nowMs));
  const rendered = opts.count === undefined
    ? withTime.split(' · ').filter((seg) => !seg.includes('{count}')).join(' · ')
    : withTime.split('{count}').join(String(opts.count));
  return rendered.trim();
}

export function createClaudeCodeExecutor(): ExecutorDefinition {
  return {
    type: 'claude-code',
    label: 'Claude Code',
    description: 'Start a real Claude Code session in a working directory (local or remote host).',
    configSchema: [
      {
        name: 'instructions',
        label: 'Instructions',
        kind: 'textarea',
        required: true,
        placeholder: 'What should the session do?',
      },
      {
        name: 'cwd',
        label: 'Working directory',
        kind: 'path',
        required: true,
        placeholder: '/path/to/repo',
      },
      {
        name: 'host',
        label: 'Host',
        kind: 'select',
        optionsKey: 'hosts',
      },
      {
        name: 'model',
        label: 'Model',
        kind: 'select',
        optionsKey: 'models',
      },
      {
        name: 'taskTitle',
        label: 'Task title',
        kind: 'text',
        placeholder: 'Defaults to the routine name',
      },
    ],
    validate(config: unknown) {
      if (typeof config !== 'object' || config === null) {
        return { ok: false, error: 'config must be an object' };
      }
      const c = config as Record<string, unknown>;
      if (typeof c.instructions !== 'string' || !c.instructions.trim()) {
        return { ok: false, error: 'instructions is required' };
      }
      if (typeof c.cwd !== 'string' || !c.cwd.trim()) {
        return { ok: false, error: 'cwd is required' };
      }
      const out: Record<string, unknown> = {
        instructions: c.instructions.trim(),
        cwd: c.cwd.trim(),
      };
      if (typeof c.host === 'string' && c.host.trim() && c.host !== '__local__') {
        out.host = c.host.trim();
      }
      if (typeof c.model === 'string' && c.model.trim()) out.model = c.model.trim();
      if (typeof c.taskTitle === 'string' && c.taskTitle.trim()) out.taskTitle = c.taskTitle.trim();
      // Walnut-agent routines. Each one is only written out when the caller set
      // it, so a routine authored in the form validates to exactly the same
      // object it always did.
      if (c.walnutAgent === true) out.walnutAgent = true;
      if (typeof c.agentId === 'string' && c.agentId.trim()) out.agentId = c.agentId.trim();
      if (typeof c.project === 'string' && c.project.trim()) out.project = c.project.trim();
      if (typeof c.titleTemplate === 'string' && c.titleTemplate.trim()) {
        out.titleTemplate = c.titleTemplate.trim();
      }
      return { ok: true, config: out };
    },
    async run(job, executor, message) {
      const config = executor.config as {
        cwd: string; host?: string; model?: string; taskTitle?: string;
        walnutAgent?: boolean; agentId?: string; project?: string; titleTemplate?: string;
      };

      // Host must exist in config.hosts — fail the run with a clear error
      // instead of letting the session-runner time out on an unknown alias.
      if (config.host) {
        const walnutConfig = await getConfig();
        const hosts = walnutConfig.hosts ?? {};
        if (!hosts[config.host]) {
          const known = Object.keys(hosts);
          return {
            status: 'error',
            error: `unknown host '${config.host}' — configured hosts: ${known.length ? known.join(', ') : '(none)'}`,
          };
        }
      }

      // A walnutAgent run needs a real console agent: quickStartSession throws a
      // 400 for an unknown id, and registry.runExecutor would mark that throw
      // RETRYABLE — so a routine pointing at a deleted agent would be replayed
      // forever. Same shape as the host guard above: refuse with a sentence.
      if (config.walnutAgent && config.agentId) {
        const { resolveAskAgent } = await import('../../sessions/ask-agent.js');
        if (!await resolveAskAgent(config.agentId)) {
          return {
            status: 'error',
            error: `unknown console agent '${config.agentId}' — this routine cannot start a session for it`,
          };
        }
      }

      // The count hint is consumed here, not forwarded: it is bookkeeping
      // between the init processor and this executor.
      const count = readTriageCountHint(message);
      const sessionMessage = stripTriageCountHint(message);

      const task = await quickStartSession({
        message: sessionMessage,
        cwd: config.cwd,
        host: config.host,
        model: config.model,
        taskTitle: config.titleTemplate
          ? renderRoutineTitleTemplate(config.titleTemplate, { nowMs: Date.now(), count })
          : config.taskTitle || `Routine: ${job.name}`,
        // Routines are background automation: an explicit null keeps every run
        // OFF the pinned board (a daily job would otherwise add a card a day),
        // where an omitted pinTier would take the new-task board default.
        taskMeta: { pinTier: null },
        project: config.project || 'Routines',
        source: 'routine',
        // Engine stays unset on purpose — quickStartSession inherits
        // config.defaults.engine for it.
        ...(config.walnutAgent ? { walnutAgent: true } : {}),
        ...(config.agentId ? { agentId: config.agentId } : {}),
      });

      // Fire-and-forget by design: the session's lifecycle is observable in the
      // SessionPanel; the routine run is "ok" once the session has been started.
      return {
        status: 'ok',
        summary: `Started Claude Code session for task ${task.id} (${config.cwd}${config.host ? ` @ ${config.host}` : ''})`,
      };
    },
  };
}
