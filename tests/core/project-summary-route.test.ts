/**
 * project-summary × model routing — contract pinned:
 *   - claude_cli main provider: generation rides a configured direct-API haiku
 *     (provider passed to sendMessage), NEVER a `claude -p` spawn first
 *   - the direct route failing falls back to the main-provider path, so a
 *     CLI-only setup loses nothing
 *   - a direct-API main provider is untouched (no provider override)
 *   - directFastRoute picks the first non-CLI configured provider with a
 *     haiku; CLI-only explicit providers mean "no direct route"
 *
 * Real: summary code, task-manager (SQLite temp store), directFastRoute.
 * Fake: sendMessage, config-manager.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-project-summary-route'));

const sendMessageMock = vi.fn();
vi.mock('../../src/model/model.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));
const config = {
  version: 1,
  user: {},
  defaults: { priority: 'backlog' },
  agent: { main_provider: 'claude_cli' as string },
  providers: { bedrock: {} } as Record<string, object> | undefined,
};
// Keep the real module (task-manager needs seedConfigDefaults etc.); only
// getConfig is faked so the routing sees a controlled provider setup.
vi.mock('../../src/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/config-manager.js')>()),
  getConfig: async () => config,
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { generateProjectSummary, SUMMARY_REGENERATE_DEADLINE_MS } from '../../src/core/project-summary.js';
import { CLI_FAST_CALL_BUDGET_MS, directFastRoute, fastCallBudgetMs } from '../../src/core/cheap-model.js';
import { addTask, _resetForTesting as resetTaskManager } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import type { Config } from '../../src/core/types.js';

function textResult(text: string) {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

beforeEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue(textResult('{"summary":"Routed."}'));
  config.agent.main_provider = 'claude_cli';
  config.providers = { bedrock: {} };
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('directFastRoute', () => {
  const base = { version: 1, user: {}, defaults: {}, agent: {} } as unknown as Config;

  it('picks the first configured non-CLI provider with a haiku entry', () => {
    const route = directFastRoute({ ...base, providers: { claude_cli: {}, bedrock: {} } } as Config);
    expect(route?.provider).toBe('bedrock');
    expect(route?.model.toLowerCase()).toContain('haiku');
  });

  it('returns undefined when only the CLI is configured', () => {
    expect(directFastRoute({ ...base, providers: { claude_cli: {} } } as Config)).toBeUndefined();
  });

  it('falls back to legacy-synthesized bedrock when no providers map exists', () => {
    const route = directFastRoute(base);
    expect(route?.provider).toBe('bedrock');
    expect(route?.model.toLowerCase()).toContain('haiku');
  });

  it("honors the user's agent.fast_model when the direct provider serves it", () => {
    const bedrockIds = (id: string) => directFastRoute({
      ...base, agent: { fast_model: id }, providers: { bedrock: {} },
    } as Config);
    // A real bedrock catalog id is used as-is…
    const haiku = directFastRoute({ ...base, providers: { bedrock: {} } } as Config)!.model;
    expect(bedrockIds(haiku)?.model).toBe(haiku);
    // …an id the provider does not serve (e.g. a CLI alias) falls back to haiku.
    expect(bedrockIds('claude-cli-alias')?.model.toLowerCase()).toContain('haiku');
  });
});

describe('generateProjectSummary routing', () => {
  it('under claude_cli, generation rides the direct-API haiku, not a CLI spawn', async () => {
    await addTask({ title: 'A real task', project: 'walnut' });

    const result = await generateProjectSummary('walnut');

    expect(result?.summary).toBe('Routed.');
    expect(sendMessageMock).toHaveBeenCalledOnce();
    const [{ config: sent }] = sendMessageMock.mock.calls[0] as [{ config: { provider?: string; model?: string } }];
    expect(sent.provider).toBe('bedrock');
    expect(sent.model?.toLowerCase()).toContain('haiku');
  });

  it('falls back to the main-provider path when the direct route throws', async () => {
    await addTask({ title: 'A real task', project: 'walnut' });
    sendMessageMock
      .mockRejectedValueOnce(new Error('no credentials'))
      .mockResolvedValueOnce(textResult('{"summary":"Via CLI."}'));

    const result = await generateProjectSummary('walnut');

    expect(result?.summary).toBe('Via CLI.');
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    const [{ config: retry }] = sendMessageMock.mock.calls[1] as [{ config: { provider?: string } }];
    expect(retry.provider).toBeUndefined(); // second attempt = original main-provider behavior
  });

  it('a caller that stopped the call gets no CLI fallback after the direct attempt fails', async () => {
    await addTask({ title: 'A real task', project: 'walnut' });
    // The direct API rejects on abort (as the SDK does), which used to look like
    // "direct route unavailable" and start a CLI turn nobody waited for.
    sendMessageMock.mockImplementationOnce((opts: { signal: AbortSignal }) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const stop = new AbortController();
    const pending = generateProjectSummary('walnut', { signal: stop.signal });
    while (sendMessageMock.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 10));
    stop.abort();
    expect(await pending).toBeNull();
    expect(sendMessageMock).toHaveBeenCalledOnce();
  });

  it('a direct-API main provider is untouched — no provider override', async () => {
    config.agent.main_provider = 'bedrock';
    await addTask({ title: 'A real task', project: 'walnut' });

    await generateProjectSummary('walnut');

    const [{ config: sent }] = sendMessageMock.mock.calls[0] as [{ config: { provider?: string } }];
    expect(sent.provider).toBeUndefined();
  });

  it('an explicit modelOverride skips routing entirely', async () => {
    await addTask({ title: 'A real task', project: 'walnut' });

    await generateProjectSummary('walnut', { modelOverride: 'pinned-model' });

    const [{ config: sent }] = sendMessageMock.mock.calls[0] as [{ config: { provider?: string; model?: string } }];
    expect(sent.provider).toBeUndefined();
    expect(sent.model).toBe('pinned-model');
  });
});

describe('generateProjectSummary attempt budget', () => {
  /** The budget of each model attempt: the timer the attempt arms right before
   *  it calls sendMessage (nothing runs between the two). */
  async function attemptBudgets(): Promise<number[]> {
    const timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      await generateProjectSummary('walnut')
      // Mocks share one call counter: pair each model call with the last timer before it.
      const order = timers.mock.invocationCallOrder
      return sendMessageMock.mock.invocationCallOrder.map((at) => {
        let i = -1
        for (let k = 0; k < order.length; k++) if (order[k] < at) i = k
        return Number(timers.mock.calls[i]?.[1])
      })
    } finally {
      timers.mockRestore()
    }
  }

  it('a CLI-only setup gives the call the CLI budget, not the direct 15 s', async () => {
    config.providers = { claude_cli: {} }
    await addTask({ title: 'A real task', project: 'walnut' })
    expect(await attemptBudgets()).toEqual([CLI_FAST_CALL_BUDGET_MS])
  })

  it('the direct attempt keeps 15 s and the CLI fallback gets the CLI budget', async () => {
    await addTask({ title: 'A real task', project: 'walnut' })
    sendMessageMock
      .mockRejectedValueOnce(new Error('no credentials'))
      .mockResolvedValueOnce(textResult('{"summary":"Via CLI."}'))
    expect(await attemptBudgets()).toEqual([15_000, CLI_FAST_CALL_BUDGET_MS])
  })

  it('the regenerate deadline covers both attempts', () => {
    expect(SUMMARY_REGENERATE_DEADLINE_MS).toBe(15_000 + CLI_FAST_CALL_BUDGET_MS)
  })
})

describe('fastCallBudgetMs', () => {
  it('gives a call that rides the CLI at least a minute and leaves a direct call its own budget', () => {
    const cli = { version: 1, user: {}, agent: { main_provider: 'claude_cli' } } as unknown as Config;
    const direct = { version: 1, user: {}, agent: { main_provider: 'bedrock' } } as unknown as Config;
    expect(CLI_FAST_CALL_BUDGET_MS).toBe(60_000);
    expect(fastCallBudgetMs(cli, 15_000)).toBe(60_000);
    expect(fastCallBudgetMs(cli, 10_000)).toBe(60_000);
    expect(fastCallBudgetMs(cli, 90_000)).toBe(90_000);
    expect(fastCallBudgetMs(direct, 15_000)).toBe(15_000);
    // The provider the call names wins over the main one (a summary's direct route).
    expect(fastCallBudgetMs(cli, 15_000, 'bedrock')).toBe(15_000);
    expect(fastCallBudgetMs(direct, 15_000, 'claude_cli')).toBe(60_000);
  });
});
