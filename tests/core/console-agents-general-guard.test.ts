/**
 * getConsoleAgents must NEVER lose the main agent.
 *
 * Field incident (2026-08-16): a stray config.yaml override
 * `agents: [{ id: general, name: Default, system_prompt: hi }]` (no `console`
 * flag) shadowed the builtin general agent. getConsoleAgents() filtered on
 * `console` alone, so the main agent vanished from every chat picker — the
 * phone's agent menu showed only Mentor + Note Assistant and GET /api/v1/agents
 * had no isMain entry. getConsoleAgent() already special-cased general; the
 * list call now applies the same rule.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js';
import { getConsoleAgents, getConsoleAgent, _resetForTest } from '../../src/core/agent-registry.js';

beforeEach(async () => {
  _resetForTest();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  _resetForTest();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('getConsoleAgents — general is always a console agent', () => {
  it('includes builtin general with no config file', async () => {
    const agents = await getConsoleAgents();
    expect(agents.map((a) => a.id)).toContain('general');
  });

  it('keeps general when a config override omits the console flag (field incident shape)', async () => {
    await fs.writeFile(CONFIG_FILE, yaml.dump({
      version: 1,
      agent: {
        agents: [{
          id: 'general',
          name: 'Default',
          description: 'General-purpose subagent for ad-hoc tasks. No tool restrictions.',
          runner: 'embedded',
          system_prompt: 'hi',
        }],
      },
    }));

    const agents = await getConsoleAgents();
    const general = agents.find((a) => a.id === 'general');
    expect(general).toBeDefined();
    // The override's fields still win — only its console visibility is repaired.
    expect(general?.name).toBe('Default');

    // The single-lookup path agrees (it already had this rule).
    expect(await getConsoleAgent('general')).toBeDefined();
  });

  it('still hides non-general agents that lack the console flag', async () => {
    await fs.writeFile(CONFIG_FILE, yaml.dump({
      version: 1,
      agent: {
        agents: [
          { id: 'worker-x', name: 'Worker X', runner: 'embedded' },
          { id: 'chatty', name: 'Chatty', runner: 'embedded', console: true },
        ],
      },
    }));

    const ids = (await getConsoleAgents()).map((a) => a.id);
    expect(ids).toContain('general');
    expect(ids).toContain('chatty');
    expect(ids).not.toContain('worker-x');
  });
});
