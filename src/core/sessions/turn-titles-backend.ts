/**
 * The outline sections' model call: Walnut's fast model, one call for a whole
 * batch of messages, answered as numbered lines. The single-title channel
 * (titleViaBackendModel) keeps only the first line of an answer, so the batch
 * has its own call with the same recipe: never throws, background purpose, the
 * fast-call budget, one retry on a transport failure, null on any failure.
 */

import { log } from '../../logging/index.js';
import { backgroundAiDisabled, fastCallBudgetMs, fastCallText, fastModelFor } from '../cheap-model.js';
import { TURN_TITLES_REQUIREMENT } from './turn-titles-text.js';

const SYSTEM = 'You write the table of contents of a long chat. Reply with ONLY the numbered titles, one per line: no quotes, no markdown, no commentary.';

let retryDelayMs = 2_000;

/** Test-only: shrink the retry pause. */
export function __setTurnTitlesRetryDelayForTesting(ms: number): void {
  retryDelayMs = ms;
}

export async function sectionsViaBackendModel(message: string): Promise<string | null> {
  if (backgroundAiDisabled()) return null;
  const askOnce = async (): Promise<string> => {
    const { sendMessage } = await import('../../model/model.js');
    const { getConfig } = await import('../config-manager.js');
    const config = await getConfig();
    const model = fastModelFor(config);
    const budgetMs = fastCallBudgetMs(config, 30_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      const result = await sendMessage({
        system: SYSTEM,
        messages: [{ role: 'user', content: `${TURN_TITLES_REQUIREMENT}\n\n${message}` }],
        // ~15 tokens a title, 20 titles; small enough for the non-streaming path.
        config: { maxTokens: 800, ...(model ? { model } : {}) },
        signal: controller.signal,
        purpose: 'background',
        usage: { source: 'title', agentId: 'session-turn-titles' },
      });
      const text = fastCallText(result, budgetMs);
      if (!text) throw new Error('model returned no text');
      return text;
    } finally {
      clearTimeout(timer);
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await askOnce();
    } catch (err) {
      log.session.warn('turn titles: model call failed', {
        attempt: attempt + 1, error: err instanceof Error ? err.message : String(err),
      });
      if (attempt === 0) await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  return null;
}
