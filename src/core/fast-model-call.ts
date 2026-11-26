/**
 * One short call to the fast model from the server, for a background check that reads a few words
 * and answers a word or a few lines (the thread join check, the thread audit). It is the cheap model
 * of the config (cheap-model.ts fastModelFor), within the budget of the channel it rides
 * (fastCallBudgetMs), `purpose: 'background'`, its usage recorded under the caller's `source`.
 * It is never called under a test run or while the machine policy turns background AI off
 * (backgroundAiDisabled): it throws, and the caller keeps its cheap path. A timeout throws too
 * (fastCallText). Returns the answer's text and how long the call took.
 */
import type { UsageSource } from './usage/types.js';

export interface FastModelCall {
  system: string;
  input: string;
  /** The usage source (and agent id) the call is recorded under. */
  source: UsageSource;
  taskId?: string;
  /** The budget of a direct API call; a CLI or a local model gets more (fastCallBudgetMs). */
  directMs: number;
  /** Room for the model's own thinking before its answer (a 5-token cap answered nothing). */
  maxTokens?: number;
  /** A hard cap on every channel, a CLI or a local model included: a check a write waits on
   *  (same-ask-meaning.ts) gives up rather than hold the write for a minute. */
  capMs?: number;
}

export async function callFastModel(c: FastModelCall): Promise<{ text: string; ms: number }> {
  const [{ ambientTestRun }, { backgroundAiDisabled, fastModelFor, fastCallBudgetMs, fastCallText }] = await Promise.all([import('./test-run.js'), import('./cheap-model.js')]);
  if (ambientTestRun() || backgroundAiDisabled()) throw new Error('the fast model is not available here');
  const [{ sendMessage }, { getConfig }] = await Promise.all([import('../model/model.js'), import('./config-manager.js')]);
  const config = await getConfig();
  const model = fastModelFor(config);
  const budget = Math.min(fastCallBudgetMs(config, c.directMs), c.capMs ?? Infinity);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  const started = Date.now();
  try {
    const result = await sendMessage({
      system: c.system,
      messages: [{ role: 'user', content: c.input }],
      config: { maxTokens: c.maxTokens ?? 1024, ...(model ? { model } : {}) },
      signal: controller.signal,
      purpose: 'background',
      usage: { source: c.source, agentId: c.source, ...(c.taskId ? { taskId: c.taskId } : {}) },
    });
    return { text: fastCallText(result, budget), ms: Date.now() - started };
  } finally { clearTimeout(timer); }
}
