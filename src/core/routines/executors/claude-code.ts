/**
 * claude-code executor — starts a REAL Claude Code session for the routine,
 * on the local machine or a configured remote host, through the exact same
 * path as the UI's Quick Start (task create → SESSION_START → session-runner).
 *
 * The session shows up in the normal SessionPanel; the user can watch it,
 * open its transcript, and take over the conversation mid-run.
 */

import { quickStartSession } from '../../sessions/quick-start.js';
import { getConfig } from '../../config-manager.js';
import type { ExecutorDefinition } from '../types.js';

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
      return { ok: true, config: out };
    },
    async run(job, executor, message) {
      const config = executor.config as {
        cwd: string; host?: string; model?: string; taskTitle?: string;
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

      const task = await quickStartSession({
        message,
        cwd: config.cwd,
        host: config.host,
        model: config.model,
        taskTitle: config.taskTitle || `Routine: ${job.name}`,
        // Routines are background automation: an explicit null keeps every run
        // OFF the pinned board (a daily job would otherwise add a card a day),
        // where an omitted pinTier would take the new-task board default.
        taskMeta: { pinTier: null },
        project: 'Routines',
        source: 'routine',
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
