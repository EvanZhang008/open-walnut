/**
 * walnut-agent executor — runs the instructions as an isolated in-process
 * agent turn (fresh context, no chat history).
 *
 * NOTE: like main-agent, jobs of this type are dispatched through the cron
 * engine's legacy 'isolated' path (timer.ts), which owns the delivery/announce
 * plumbing. run() here mirrors that behavior for future direct dispatch;
 * validate/configSchema drive the REST API and UI form.
 */

import type { CronJob } from '../../cron/types.js';
import type { ExecutorDefinition } from '../types.js';

export type WalnutAgentExecutorDeps = {
  runIsolatedAgentJob: (params: { job: CronJob; message: string }) => Promise<{
    status: 'ok' | 'error';
    summary?: string;
    error?: string;
  }>;
};

export function createWalnutAgentExecutor(deps: WalnutAgentExecutorDeps): ExecutorDefinition {
  return {
    type: 'walnut-agent',
    label: 'Walnut Agent',
    description: 'Run the instructions in an isolated built-in agent with a fresh context.',
    configSchema: [
      {
        name: 'instructions',
        label: 'Instructions',
        kind: 'textarea',
        required: true,
        placeholder: 'What should the agent do?',
      },
      {
        name: 'model',
        label: 'Model',
        kind: 'select',
        optionsKey: 'models',
      },
      {
        name: 'timeoutSeconds',
        label: 'Timeout (seconds)',
        kind: 'number',
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
      const out: Record<string, unknown> = { instructions: c.instructions.trim() };
      if (typeof c.model === 'string' && c.model.trim()) out.model = c.model.trim();
      if (typeof c.timeoutSeconds === 'number' && Number.isFinite(c.timeoutSeconds)) {
        out.timeoutSeconds = Math.max(1, Math.floor(c.timeoutSeconds));
      }
      return { ok: true, config: out };
    },
    async run(job, _executor, message) {
      return await deps.runIsolatedAgentJob({ job, message });
    },
  };
}
