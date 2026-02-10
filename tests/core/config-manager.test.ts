import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js';
import {
  getConfig,
  saveConfig,
  updateConfig,
  _resetWriteLockForTest,
} from '../../src/core/config-manager.js';

beforeEach(async () => {
  _resetWriteLockForTest();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('updateConfig', () => {
  it('preserves unmentioned top-level keys', async () => {
    // Write initial config with ms_todo section
    const initial = {
      version: 1,
      user: { name: 'TestUser' },
      defaults: { priority: 'none', category: 'personal' },
      ms_todo: { client_id: 'abc-123', tenant_id: 'xyz-789' },
    };
    await fs.writeFile(CONFIG_FILE, yaml.dump(initial), 'utf-8');

    // Update only 'defaults' — ms_todo must survive
    await updateConfig({ defaults: { priority: 'immediate', category: 'work' } } as any);

    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(raw) as any;

    expect(result.ms_todo).toEqual({ client_id: 'abc-123', tenant_id: 'xyz-789' });
    expect(result.defaults.priority).toBe('immediate');
    expect(result.user.name).toBe('TestUser');
  });

  it('adds new top-level keys without affecting existing ones', async () => {
    const initial = { version: 1, user: { name: 'TestUser' } };
    await fs.writeFile(CONFIG_FILE, yaml.dump(initial), 'utf-8');

    await updateConfig({ defaults: { priority: 'backlog', category: 'life' } } as any);

    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(raw) as any;

    expect(result.version).toBe(1);
    expect(result.user.name).toBe('TestUser');
    expect(result.defaults.priority).toBe('backlog');
  });

  it('works when no config file exists yet', async () => {
    await updateConfig({ user: { name: 'New User' } } as any);

    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(raw) as any;

    expect(result.user.name).toBe('New User');
  });

  it('replaces a top-level key entirely (not deep merge)', async () => {
    const initial = {
      version: 1,
      defaults: { priority: 'none', category: 'personal' },
    };
    await fs.writeFile(CONFIG_FILE, yaml.dump(initial), 'utf-8');

    // Send defaults with only priority — category should be gone (top-level key replacement)
    await updateConfig({ defaults: { priority: 'immediate' } } as any);

    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(raw) as any;

    expect(result.defaults.priority).toBe('immediate');
    expect(result.defaults.category).toBeUndefined();
  });

  it('does not write undefined values', async () => {
    const initial = { version: 1, user: { name: 'TestUser' } };
    await fs.writeFile(CONFIG_FILE, yaml.dump(initial), 'utf-8');

    await updateConfig({ version: 1, user: undefined } as any);

    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(raw) as any;

    // user should not be overwritten because the value was undefined
    expect(result.user.name).toBe('TestUser');
  });
});

describe('saveConfig (full replace)', () => {
  it('replaces entire file, dropping unmentioned keys', async () => {
    const initial = {
      version: 1,
      user: { name: 'TestUser' },
      ms_todo: { client_id: 'abc-123' },
    };
    await fs.writeFile(CONFIG_FILE, yaml.dump(initial), 'utf-8');

    // saveConfig with no ms_todo — it should be gone
    await saveConfig({ version: 1, user: { name: 'TestUser' }, defaults: { priority: 'none', category: 'personal' }, provider: { type: 'claude-code' } });

    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(raw) as any;

    expect(result.ms_todo).toBeUndefined();
    expect(result.user.name).toBe('TestUser');
  });
});
