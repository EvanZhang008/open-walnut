/**
 * main-agent executor — delivers the routine's instructions to the main agent:
 * the CURRENT Main task's conversation, resolved at every run
 * (runMainAgentWithPrompt → routines/main-target.ts). The TYPE string
 * 'main-agent' is a legacy storage format (saved jobs carry it); it no longer
 * runs on the home chat's taskless lane session.
 *
 * NOTE: jobs with this executor type are dispatched through the cron engine's
 * legacy 'main' path (timer.ts), which owns the notification/wake plumbing.
 * This definition still provides run() (used if the legacy path is ever
 * retired) plus the validate/configSchema that drive the REST API and UI form.
 */

import type { ExecutorDefinition } from '../types.js';

export type MainAgentExecutorDeps = {
  broadcastCronNotification: (text: string, jobName: string, opts?: { agentWillRespond?: boolean }) => Promise<void>;
  runMainAgentWithPrompt: (prompt: string, jobName: string, job?: import('../../cron/types.js').CronJob) => Promise<void>;
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
      await deps.broadcastCronNotification(message, job.name, { agentWillRespond: false });
      if (job.wakeMode === 'now') {
        await deps.runMainAgentWithPrompt(message, job.name, job);
      } else {
        deps.queueCronNotificationForAgent?.(message, job.name);
      }
      return { status: 'ok', summary: message };
    },
  };
}
