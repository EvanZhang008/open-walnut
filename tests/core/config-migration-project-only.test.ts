/**
 * Tests for the one-time config.yaml migration to the project-only model
 * (category removal).
 *
 * Two layers:
 *  - `migrateConfigToProjectOnly` — the pure field-level rewrite.
 *  - `migrateConfigFileToProjectOnly` — the on-disk pass: must rewrite once,
 *    be a no-op on the second run, and never drop unrelated sections.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-config-project-only'));

import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js';
import {
  getConfig,
  migrateConfigToProjectOnly,
  migrateConfigFileToProjectOnly,
  _resetWriteLockForTest,
} from '../../src/core/config-manager.js';

/** A config.yaml as written by the pre-refactor (category) code. */
const LEGACY_CONFIG = {
  version: 1,
  user: { name: 'Tester' },
  defaults: { priority: 'none', category: 'Inbox', platform: 'local', project: 'Marina' },
  provider: { type: 'claude-code' },
  local: { categories: ['Local', 'Inbox', 'Private'] },
  favorites: { categories: ['Work'], projects: ['Marina'], notes: ['PARA/a.md'] },
  ordering: {
    categories: ['Work', 'Personal'],
    projects: {
      Work: ['Marina', 'Acme'],
      Personal: ['marina', 'Garden'],
      Leftover: ['Attic'],
    },
  },
  plugins: { jira: { enabled: true, category: 'Work', host: 'example.invalid' } },
  // Unrelated sections that must survive untouched.
  stt: { engine: 'whisper', model_path: '/tmp/model.bin' },
  hosts: { devbox: { hostname: 'dev.invalid' } },
};

async function writeLegacyConfig(): Promise<void> {
  await fs.writeFile(CONFIG_FILE, yaml.dump(LEGACY_CONFIG), 'utf-8');
}

async function readConfigFile(): Promise<Record<string, any>> {
  return yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as Record<string, any>;
}

beforeEach(async () => {
  _resetWriteLockForTest();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('migrateConfigToProjectOnly (pure)', () => {
  it('deletes the retired category fields', () => {
    const config = structuredClone(LEGACY_CONFIG) as Record<string, any>;
    expect(migrateConfigToProjectOnly(config)).toBe(true);

    expect(config.defaults.category).toBeUndefined();
    expect(config.defaults.project).toBe('Marina'); // untouched
    expect(config.local).toBeUndefined();
    expect(config.favorites.categories).toBeUndefined();
    expect(config.favorites.projects).toEqual(['Marina']);
    expect(config.ordering.categories).toBeUndefined();
  });

  it('flattens the nested ordering map in category order, NOCASE-deduped', () => {
    const config = structuredClone(LEGACY_CONFIG) as Record<string, any>;
    migrateConfigToProjectOnly(config);
    // Work first (configured order), then Personal, then the leftover key.
    // 'marina' collapses into the already-seen 'Marina'.
    expect(config.ordering.projects).toEqual(['Marina', 'Acme', 'Garden', 'Attic']);
  });

  it('renames plugins.jira.category to plugins.jira.project', () => {
    const config = structuredClone(LEGACY_CONFIG) as Record<string, any>;
    migrateConfigToProjectOnly(config);
    expect(config.plugins.jira.category).toBeUndefined();
    expect(config.plugins.jira.project).toBe('Work');
    expect(config.plugins.jira.enabled).toBe(true);
  });

  it('keeps an existing plugins.jira.project over the legacy category', () => {
    const config = { plugins: { jira: { category: 'Work', project: 'Marina' } } } as Record<string, any>;
    migrateConfigToProjectOnly(config);
    expect(config.plugins.jira.project).toBe('Marina');
    expect(config.plugins.jira.category).toBeUndefined();
  });

  it('reports no change for an already-migrated config', () => {
    const clean = {
      version: 1,
      defaults: { priority: 'none', platform: 'local' },
      favorites: { projects: ['Marina'] },
      ordering: { projects: ['Marina', 'Acme'] },
      plugins: { jira: { project: 'Work' } },
    } as Record<string, any>;
    expect(migrateConfigToProjectOnly(clean)).toBe(false);
    expect(clean.ordering.projects).toEqual(['Marina', 'Acme']);
  });
});

describe('migrateConfigFileToProjectOnly (on disk)', () => {
  it('rewrites the file once and is a no-op on the second run', async () => {
    await writeLegacyConfig();

    expect(await migrateConfigFileToProjectOnly()).toBe(true);
    const first = await readConfigFile();
    expect(first.defaults.category).toBeUndefined();
    expect(first.local).toBeUndefined();
    expect(first.favorites.categories).toBeUndefined();
    expect(first.ordering).toEqual({ projects: ['Marina', 'Acme', 'Garden', 'Attic'] });
    expect(first.plugins.jira.project).toBe('Work');

    // Second run: nothing left to change, file byte-identical.
    const before = await fs.readFile(CONFIG_FILE, 'utf-8');
    expect(await migrateConfigFileToProjectOnly()).toBe(false);
    expect(await fs.readFile(CONFIG_FILE, 'utf-8')).toBe(before);
  });

  it('preserves unrelated sections', async () => {
    await writeLegacyConfig();
    await migrateConfigFileToProjectOnly();
    const after = await readConfigFile();
    expect(after.stt).toEqual({ engine: 'whisper', model_path: '/tmp/model.bin' });
    expect(after.hosts).toEqual({ devbox: { hostname: 'dev.invalid' } });
    expect(after.user).toEqual({ name: 'Tester' });
    expect(after.provider).toEqual({ type: 'claude-code' });
  });

  it('is a no-op when there is no config file at all (first run)', async () => {
    expect(await migrateConfigFileToProjectOnly()).toBe(false);
    await expect(fs.access(CONFIG_FILE)).rejects.toThrow();
  });

  it('getConfig never surfaces the retired fields, even before the file is rewritten', async () => {
    await writeLegacyConfig();
    const config = (await getConfig()) as unknown as Record<string, any>;
    expect(config.defaults.category).toBeUndefined();
    expect(config.local).toBeUndefined();
    expect(config.favorites.categories).toBeUndefined();
    expect(config.ordering.projects).toEqual(['Marina', 'Acme', 'Garden', 'Attic']);
    expect(config.plugins.jira.project).toBe('Work');
  });
});
