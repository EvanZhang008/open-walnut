/**
 * The backend title channel's FAILURE semantics — which is where the whole feature
 * lived or died in production.
 *
 * The channel is "never throws, null on failure", and that swallowed the one failure
 * that actually happened: the `claude` CLI adapter resolves an ABORTED spawn with
 * whatever text it had (usually none) instead of throwing, so a call that ran out of
 * budget looked exactly like a model that chose to say nothing — no log line, and the
 * in-call retry never fired because nothing was thrown. Chips kept the truncated
 * question as their label about half the time (prod, 2026-09-04).
 *
 * Pinned here: an aborted turn and an empty answer are retryable failures, a REFUSAL
 * is not (it is a considered answer, retrying just burns a call), and the budget is
 * per-channel because a CLI spawn is not an API call.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-title-backend'));

const sendMessage = vi.hoisted(() => vi.fn());
vi.mock('../../src/agent/model.js', () => ({ sendMessage }));

const configRef = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => configRef.value,
}));

// Under VITEST the unprompted-call gate is closed by design; this suite is about what
// the channel does once it is allowed to run.
vi.mock('../../src/core/cheap-model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/cheap-model.js')>()),
  backgroundAiDisabled: () => false,
}));

const cliInstalled = vi.hoisted(() => ({ value: false }));
vi.mock('../../src/agent/providers/default-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/providers/default-provider.js')>();
  return {
    ...actual,
    resolveMainProviderName: (config: { agent?: { main_provider?: string } }) =>
      actual.resolveMainProviderName(config as never, cliInstalled.value),
  };
});

import {
  titleViaBackendModel, titleBudgetMs, cleanTitleAnswer,
  __setBackendRetryDelayForTesting,
} from '../../src/core/session-title-backend.js';

const textResult = (text: string) => ({ content: [{ type: 'text', text }] });

beforeEach(() => {
  sendMessage.mockReset();
  configRef.value = {};
  cliInstalled.value = false;
  __setBackendRetryDelayForTesting(0);
});

describe('titleViaBackendModel — a failure must look like a failure', () => {
  it('retries an ABORTED turn and returns the second attempt', async () => {
    // The adapter's abort path: resolved, not thrown, and usually with no text.
    sendMessage
      .mockResolvedValueOnce({ content: [], aborted: true })
      .mockResolvedValueOnce(textResult('Provisioner CloudFormation handler'));

    await expect(titleViaBackendModel('why does bind() need this', 'why does…', null))
      .resolves.toBe('Provisioner CloudFormation handler');
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('retries an EMPTY answer (a fast model returning no text is a transport hiccup)', async () => {
    sendMessage
      .mockResolvedValueOnce({ content: [] })
      .mockResolvedValueOnce(textResult('Step function quota throttling'));

    await expect(titleViaBackendModel('throttling on the quota', 'throttling…', null))
      .resolves.toBe('Step function quota throttling');
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('gives up after two failures, without throwing', async () => {
    sendMessage.mockResolvedValue({ content: [], aborted: true });
    await expect(titleViaBackendModel('q', 'placeholder', null)).resolves.toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a refusal — it is an answer, and a second call would waste a turn', async () => {
    sendMessage.mockResolvedValue(textResult('I cannot determine a title from this.'));
    await expect(titleViaBackendModel('q', 'placeholder', null)).resolves.toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('returns a usable title on the first try without retrying', async () => {
    sendMessage.mockResolvedValue(textResult('Architecture diagram redraw'));
    await expect(titleViaBackendModel('q', 'placeholder', null))
      .resolves.toBe('Architecture diagram redraw');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('titleBudgetMs — the deadline fits the channel, not the model', () => {
  it('gives the CLI provider room for a process spawn', async () => {
    cliInstalled.value = true;
    expect(await titleBudgetMs({} as never)).toBe(60_000);
  });

  it('keeps the tight budget for a direct API provider', async () => {
    configRef.value = { agent: { main_provider: 'bedrock' } };
    expect(await titleBudgetMs(configRef.value as never)).toBe(15_000);
  });
});

describe('cleanTitleAnswer', () => {
  it('rejects nothing-answers and refusals, strips wrappers', () => {
    expect(cleanTitleAnswer('')).toBeNull();
    expect(cleanTitleAnswer('  ')).toBeNull();
    expect(cleanTitleAnswer("I'm sorry, I can't help with that")).toBeNull();
    expect(cleanTitleAnswer('**Title: Fork prefix cache**')).toBe('Fork prefix cache');
  });
});
