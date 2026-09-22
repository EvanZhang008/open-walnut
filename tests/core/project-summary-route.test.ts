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
import { generateProjectSummary } from '../../src/core/project-summary.js';
import { directFastRoute } from '../../src/core/cheap-model.js';
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
