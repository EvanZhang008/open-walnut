/**
 * main-agent executor — delivers the routine's instructions into the home chat
 * conversation. The TYPE string 'main-agent' is a legacy storage format (saved
 * jobs carry it); the engine behind it is an ordinary Claude Code lane session
 * (runMainAgentWithPrompt → runLaneTurn) — the old in-process agent is gone.
 *
 * NOTE: jobs with this executor type are dispatched through the cron engine's
 * legacy 'main' path (timer.ts), which owns the notification/wake plumbing.
 * This definition still provides run() (used if the legacy path is ever
 * retired) plus the validate/configSchema that drive the REST API and UI form.
 */

import type { ExecutorDefinition } from '../types.js';

export type MainAgentExecutorDeps = {
  broadcastCronNotification: (text: string, jobName: string, opts?: { agentWillRespond?: boolean }) => Promise<void>;
  runMainAgentWithPrompt: (prompt: string, jobName: string) => Promise<void>;
  queueCronNotificationForAgent?: (text: string, jobName: string) => void;
};

export function createMainAgentExecutor(deps: MainAgentExecutorDeps): ExecutorDefinition {
  return {
    type: 'main-agent',
    label: 'Home Chat',
    description: 'Deliver the instructions into your home chat conversation at the scheduled time.',
    configSchema: [
      {
        name: 'instructions',
        label: 'Instructions',
        kind: 'textarea',
        required: true,
        placeholder: 'What should Walnut be told?',
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
      return { ok: true, config: { instructions: c.instructions.trim() } };
    },
    async run(job, _executor, message) {
      await deps.broadcastCronNotification(message, job.name, { agentWillRespond: job.wakeMode === 'now' });
      if (job.wakeMode === 'now') {
        await deps.runMainAgentWithPrompt(message, job.name);
      } else {
        deps.queueCronNotificationForAgent?.(message, job.name);
      }
      return { status: 'ok', summary: message };
    },
  };
}
