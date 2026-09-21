/**
 * Manifest `dependencies` end to end, through the real loader and real config file.
 *
 * The properties pinned here are the ones a plugin author and a user actually feel:
 *
 * - A dependency activates BEFORE its dependent, whatever order the directories were
 *   read in (fixture dir names deliberately sort against the answer).
 * - A plugin whose dependency is unmet never has its module EVALUATED. Every fixture
 *   appends its id to `globalThis.__p01.evaluated` at module scope, so "the code was
 *   never imported" is a positive assertion rather than a hope.
 * - A cycle blocks its members and nothing else: `loadPlugins` still resolves and the
 *   `local` task source still comes up, because a mis-declared dependency in some
 *   third-party plugin must never be able to take the server down.
 * - Turning off a plugin others run on either refuses (with the list) or cascades — and
 *   a cascade writes `enabled: false` for the TARGET ONLY. A dependent is blocked, not
 *   disabled: writing an off-switch for it would leave it lying down forever once the
 *   dependency came back. That is asserted against the YAML on disk, not a mock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('plugin-deps-test'));

// The loader's own warnings are part of the contract for a dropped manifest entry
// (nothing else is observable when a manifest field is ignored), so they are captured.
const captured = vi.hoisted(() => ({
  warnings: [] as Array<{ subsystem: string; message: string; meta?: Record<string, unknown> }>,
}));
vi.mock('../../src/logging/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/logging/index.js')>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: (message: string, meta?: Record<string, unknown>) => {
        captured.warnings.push({ subsystem, message, meta });
      },
    }),
  };
});

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js';
import { IntegrationRegistry } from '../../src/core/integration-registry.js';
import {
  disableLoadedPlugin,
  loadNewPlugins,
  loadPlugins,
  disposeLoadedPlugins,
  reloadLoadedPlugin,
  reloadLoadedPlugins,
  getPluginLifecycleRecords,
  setPluginCodeTimeoutForTesting,
  getUnmetDependencyPlugins,
  PluginDependentsError,
} from '../../src/core/integration-loader.js';
import { bus } from '../../src/core/event-bus.js';
import type { PluginLifecycleRecord } from '../../src/core/plugins/plugin-manager.js';

interface Markers {
  evaluated: string[];
  activated: string[];
  deactivated: string[];
}

function marks(): Markers {
  return (globalThis as unknown as { __p01: Markers }).__p01;
}

/**
 * One external apiVersion 1 plugin. `dist/server.mjs` is imported directly (no esbuild),
 * and the loader's cache-buster means every load re-evaluates it — which is what makes
 * the evaluation marker countable across reloads.
 */
async function writePlugin(
  dirName: string,
  manifest: Record<string, unknown>,
  body = '',
): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', dirName);
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
    ...manifest,
  }));
  const id = JSON.stringify(String(manifest.id));
  await fsp.writeFile(path.join(dir, 'dist', 'server.mjs'), `
const mark = (kind, id) => {
  const all = (globalThis.__p01 ??= { evaluated: [], activated: [], deactivated: [] });
  all[kind].push(id);
};
mark('evaluated', ${id});
export function activate() { mark('activated', ${id}); ${body} }
export function deactivate() { mark('deactivated', ${id}); }
`);
}

async function writeConfig(plugins: Record<string, Record<string, unknown>> = {}): Promise<void> {
  await fsp.writeFile(
    CONFIG_FILE,
    yaml.dump({ version: 1, user: { name: 'test' }, defaults: { priority: 'none' }, plugins }),
    'utf-8',
  );
}

async function readConfigPlugins(): Promise<Record<string, Record<string, unknown>>> {
  const raw = yaml.load(await fsp.readFile(CONFIG_FILE, 'utf-8')) as
    { plugins?: Record<string, Record<string, unknown>> } | null;
  return raw?.plugins ?? {};
}

function record(registry: IntegrationRegistry, id: string): PluginLifecycleRecord | undefined {
  return getPluginLifecycleRecords(registry).find((entry) => entry.id === id);
}

const dependencyEvents: Array<{ pluginId: string; dependencyId: string; action: string }> = [];
const lifecycleEvents: Array<{ pluginId: string; state: string }> = [];

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }));
  await writeConfig();
  (globalThis as unknown as { __p01: Markers }).__p01 = { evaluated: [], activated: [], deactivated: [] };
  captured.warnings.length = 0;
  dependencyEvents.length = 0;
  lifecycleEvents.length = 0;
  bus.subscribe('p01-observer', (event) => {
    if (event.name === 'plugin:dependency-changed') {
      dependencyEvents.push(event.data as { pluginId: string; dependencyId: string; action: string });
    }
    if (event.name === 'plugin:lifecycle-changed') {
      lifecycleEvents.push(event.data as { pluginId: string; state: string });
    }
  }, { global: true });
});

/**
 * Every registry this file loads, so `afterEach` can take the plugins DOWN before their home
 * is removed. The builtins really activate here (mail opens its cache from a host timer), and
 * deleting a live plugin's data dir under it is an ENOTEMPTY race, not a test of anything.
 */
const loadedRegistries: IntegrationRegistry[] = [];
async function load(registry: IntegrationRegistry): Promise<void> {
  if (!loadedRegistries.includes(registry)) loadedRegistries.push(registry);
  await loadPlugins(registry);
}

afterEach(async () => {
  setPluginCodeTimeoutForTesting(null);
  bus.unsubscribe('p01-observer');
  delete (globalThis as unknown as { __p01?: Markers }).__p01;
  for (const one of loadedRegistries.splice(0)) await disposeLoadedPlugins(one);
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('dependency-ordered loading', () => {
  /** alpha 1.2.0 · beta needs ^1 · gamma needs ^2 · ring-a ↔ ring-b. */
  async function writeMixedFixture(): Promise<void> {
    // Directory names fight the expected answer: `a-beta` is read first, so an
    // activation order of alpha-then-beta can only come from the dependency edge.
    await writePlugin('a-beta', { id: 'beta', name: 'beta', version: '1.0.0', dependencies: { alpha: '^1' } });
    await writePlugin('b-gamma', { id: 'gamma', name: 'gamma', version: '1.0.0', dependencies: { alpha: '^2' } });
    await writePlugin('c-ring-a', { id: 'ring-a', name: 'ring-a', version: '1.0.0', dependencies: { 'ring-b': '^1' } });
    await writePlugin('d-ring-b', { id: 'ring-b', name: 'ring-b', version: '1.0.0', dependencies: { 'ring-a': '^1' } });
    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '1.2.0' });
  }

  it('activates a dependency before its dependent, against the discovery order', async () => {
    await writeMixedFixture();
    const registry = new IntegrationRegistry();

    await load(registry);

    expect(record(registry, 'alpha')?.state).toBe('active');
    expect(record(registry, 'beta')?.state).toBe('active');
    expect(marks().activated.indexOf('alpha')).toBeLessThan(marks().activated.indexOf('beta'));

    // The guard on the guard: the discovery order has to be the one this test is fighting.
    // If the filesystem stops handing back `a-beta` before `z-alpha`, the assertion above
    // proves nothing and this line says so instead of quietly passing.
    const dirs = await fsp.readdir(path.join(WALNUT_HOME, 'plugins'));
    expect(dirs).toEqual([...dirs].sort());
    expect(dirs.indexOf('a-beta')).toBeLessThan(dirs.indexOf('z-alpha'));
  });

  it('blocks a wrong-version dependent without ever evaluating its module', async () => {
    await writeMixedFixture();
    const registry = new IntegrationRegistry();

    await load(registry);

    const gamma = record(registry, 'gamma')!;
    expect(gamma.state).toBe('needs-dependency');
    expect(gamma.reason).toContain('alpha');
    expect(gamma.reason).toContain('^2');
    expect(gamma.reason).toContain('1.2.0');
    expect(marks().evaluated).not.toContain('gamma');
    expect(registry.has('gamma')).toBe(false);
  });

  it('blocks both members of a cycle and keeps the server booting', async () => {
    await writeMixedFixture();
    const registry = new IntegrationRegistry();

    await expect(load(registry)).resolves.toBeUndefined();

    for (const id of ['ring-a', 'ring-b']) {
      expect(record(registry, id)?.state).toBe('needs-dependency');
      expect(record(registry, id)?.reason).toContain('cycle');
      expect(marks().evaluated).not.toContain(id);
    }
    // A third party's mis-declared dependency must never cost the machine its task source.
    expect(registry.has('local')).toBe(true);
    expect(record(registry, 'local')?.state).toBe('active');
  });

  it('reports every blocked plugin with the dependency that blocked it', async () => {
    await writeMixedFixture();
    const registry = new IntegrationRegistry();

    await load(registry);

    const unmet = getUnmetDependencyPlugins();
    expect(unmet.map((entry) => entry.id).sort()).toEqual(['gamma', 'ring-a', 'ring-b']);
    expect(unmet.find((entry) => entry.id === 'gamma')!.missing).toEqual([{
      id: 'alpha',
      range: '^2',
      found: '1.2.0',
      reason: 'version',
      note: expect.stringContaining('does not satisfy ^2'),
    }]);
    expect(unmet.find((entry) => entry.id === 'ring-a')!.missing).toEqual([{
      id: 'ring-b',
      range: '^1',
      reason: 'cycle',
      note: expect.stringContaining('cycle'),
    }]);
  });

  it('treats a version no range can match as unversioned, not as a range mismatch', async () => {
    // "1.0" is not a version any range can be tested against, and the fix belongs in
    // alpha's manifest. Calling it a range mismatch would send beta's author to the wrong
    // file to change the wrong line.
    await writePlugin('a-beta', { id: 'beta', name: 'beta', version: '1.0.0', dependencies: { alpha: '^1' } });
    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '1.0' });
    const registry = new IntegrationRegistry();

    await load(registry);

    expect(record(registry, 'beta')?.missingDependencies).toEqual([{
      id: 'alpha',
      range: '^1',
      found: '1.0',
      reason: 'unversioned',
      note: expect.stringContaining('x.y.z'),
    }]);
    expect(record(registry, 'beta')?.missingDependencies?.[0].note).toContain('1.0');
    expect(marks().evaluated).not.toContain('beta');
  });

  it('names the plugin whose manifest has no version, since only it can fix it', async () => {
    await writePlugin('a-beta', { id: 'beta', name: 'beta', version: '1.0.0', dependencies: { alpha: '^1' } });
    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha' });
    const registry = new IntegrationRegistry();

    await load(registry);

    // alpha itself is fine — the requirement only bites where somebody depends on it.
    expect(record(registry, 'alpha')?.state).toBe('active');
    const missing = getUnmetDependencyPlugins().find((entry) => entry.id === 'beta')!.missing;
    expect(missing[0]).toMatchObject({ id: 'alpha', reason: 'unversioned' });
    expect(missing[0].note).toContain('alpha');
    expect(missing[0].note).toContain('x.y.z');
    expect(marks().evaluated).not.toContain('beta');
  });

  it.each([
    ['disabled', {}, { alpha: { enabled: false } }],
    ['needs-config', { configSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] } }, {}],
    ['unsupported', { engines: { walnut: '>=999.0.0' } }, {}],
    ['failed', { body: 'throw new Error("alpha is broken")' }, {}],
  ])('blocks a dependent while its dependency is %s', async (state, extra, plugins) => {
    const { body, ...manifest } = extra as { body?: string };
    await writePlugin('a-beta', { id: 'beta', name: 'beta', version: '1.0.0', dependencies: { alpha: '^1' } });
    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '1.0.0', ...manifest }, body);
    await writeConfig(plugins as Record<string, Record<string, unknown>>);
    const registry = new IntegrationRegistry();

    await load(registry);

    expect(record(registry, 'alpha')?.state).toBe(state);
    const beta = record(registry, 'beta')!;
    expect(beta.state).toBe('needs-dependency');
    expect(beta.missingDependencies).toEqual([{
      id: 'alpha',
      range: '^1',
      found: '1.0.0',
      reason: 'inactive',
      // The state is in the note because "installed but not active" is not actionable;
      // "installed but disabled" tells the user where to click.
      note: expect.stringContaining(state),
    }]);
    expect(marks().evaluated).not.toContain('beta');
  });

  it('never lets an ordinary range adopt a prerelease of the next major', async () => {
    // `^1.0.0` is the obvious case; `^2.0.0` is the trap — 2.0.0-beta.1 sorts BELOW
    // 2.0.0, so a plain comparator would place it inside `^1` and outside `^2`, and a
    // dependent asking for either one would silently run against an unfinished build.
    await writePlugin('a-beta', { id: 'beta', name: 'beta', version: '1.0.0', dependencies: { alpha: '^1.0.0' } });
    await writePlugin('b-gamma', { id: 'gamma', name: 'gamma', version: '1.0.0', dependencies: { alpha: '^2.0.0' } });
    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '2.0.0-beta.1' });
    const registry = new IntegrationRegistry();

    await load(registry);

    expect(record(registry, 'alpha')?.state).toBe('active');
    for (const id of ['beta', 'gamma']) {
      expect(record(registry, id)?.state).toBe('needs-dependency');
      expect(record(registry, id)?.missingDependencies?.[0]).toMatchObject({
        reason: 'version',
        found: '2.0.0-beta.1',
      });
    }
  });

  it('unblocks a waiting plugin when its dependency is installed later', async () => {
    // The store's install path is an ADDITIVE load, where the waiting plugin is already
    // discovered and pass 3 skips it as a duplicate. Without the restore pass, installing
    // the dependency would look like it did nothing until a restart.
    await writePlugin('a-beta', { id: 'beta', name: 'beta', version: '1.0.0', dependencies: { alpha: '^1' } });
    const registry = new IntegrationRegistry();
    await load(registry);
    expect(record(registry, 'beta')?.missingDependencies?.[0]).toMatchObject({ id: 'alpha', reason: 'absent' });

    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '1.2.0' });
    await loadNewPlugins(registry);

    expect(record(registry, 'alpha')?.state).toBe('active');
    expect(record(registry, 'beta')?.state).toBe('active');
    expect(registry.has('beta')).toBe(true);
    expect(marks().activated.indexOf('alpha')).toBeLessThan(marks().activated.indexOf('beta'));
    expect(marks().activated.filter((id) => id === 'beta')).toHaveLength(1);
    expect(getUnmetDependencyPlugins()).toEqual([]);
  });

  it('rewrites the reason when the dependency arrives at the wrong version', async () => {
    // The stale-reason trap: pass 3 skips the waiting plugin as a duplicate and returns
    // before diagnostics are cleared, so a restore pass that merely gave up would leave
    // the row saying "not installed" while the thing is installed and active.
    await writePlugin('a-beta', { id: 'beta', name: 'beta', version: '1.0.0', dependencies: { alpha: '^2' } });
    const registry = new IntegrationRegistry();
    await load(registry);
    expect(record(registry, 'beta')?.missingDependencies?.[0]).toMatchObject({ id: 'alpha', reason: 'absent' });

    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '1.0.0' });
    await loadNewPlugins(registry);

    expect(record(registry, 'alpha')?.state).toBe('active');
    const beta = record(registry, 'beta')!;
    expect(beta.state).toBe('needs-dependency');
    expect(beta.missingDependencies).toEqual([{
      id: 'alpha',
      range: '^2',
      found: '1.0.0',
      reason: 'version',
      note: expect.stringContaining('does not satisfy ^2'),
    }]);
    expect(beta.reason).toContain('1.0.0');
    // The store reads the diagnostic list, not the record, so both have to move.
    expect(getUnmetDependencyPlugins()).toEqual([{
      id: 'beta',
      name: 'beta',
      missing: [expect.objectContaining({ reason: 'version', found: '1.0.0' })],
    }]);
    expect(marks().evaluated).not.toContain('beta');
  });

  it('drops a dependency block on the local fallback, warning instead of gating it', async () => {
    // The built-in `local` manifest cannot declare dependencies, so the only way to
    // drive the validator is an external copy of the id — which loses the duplicate
    // race, exactly as it should. What is verified: the field is refused with a reason,
    // and `local` still comes up as the task source.
    await writePlugin('local', { id: 'local', name: 'Local Override', version: '9.9.9', dependencies: { alpha: '^1' } });
    const registry = new IntegrationRegistry();

    await load(registry);

    expect(captured.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: 'Manifest dependencies dropped',
        meta: expect.objectContaining({ reason: expect.stringContaining('never gated') }),
      }),
    ]));
    expect(registry.has('local')).toBe(true);
    expect(record(registry, 'local')?.state).toBe('active');
    expect(getUnmetDependencyPlugins().some((entry) => entry.id === 'local')).toBe(false);
  });
});

describe('lifecycle cascade', () => {
  async function loadPair(): Promise<IntegrationRegistry> {
    await writePlugin('a-beta', { id: 'beta', name: 'beta', version: '1.0.0', dependencies: { alpha: '^1' } });
    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '1.2.0' });
    const registry = new IntegrationRegistry();
    await load(registry);
    expect(record(registry, 'beta')?.state).toBe('active');
    return registry;
  }

  it('refuses to turn off a plugin with live dependents, changing nothing', async () => {
    const registry = await loadPair();

    const failure = await disableLoadedPlugin(registry, 'alpha').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PluginDependentsError);
    expect(failure).toMatchObject({ code: 'has-dependents', dependents: ['beta'] });
    expect(record(registry, 'alpha')?.state).toBe('active');
    expect(record(registry, 'beta')?.state).toBe('active');
    expect(registry.has('alpha')).toBe(true);
    // The refusal happens before the first mutation, so there is nothing to undo.
    expect(await readConfigPlugins()).toEqual({});
    expect(marks().deactivated).toEqual([]);
  });

  it('cascades on request, and writes an off-switch for the target only', async () => {
    const registry = await loadPair();

    await disableLoadedPlugin(registry, 'alpha', { cascade: true });

    expect(record(registry, 'alpha')?.state).toBe('disabled');
    const beta = record(registry, 'beta')!;
    expect(beta.state).toBe('needs-dependency');
    expect(beta.missingDependencies).toEqual([
      { id: 'alpha', range: '^1', found: '1.2.0', reason: 'inactive', note: expect.stringContaining('turned off') },
    ]);
    // Beta owned resources, and they are gone: its deactivate ran, before alpha's, and
    // its contributions left the registry.
    expect(marks().deactivated).toEqual(['beta', 'alpha']);
    expect(registry.has('beta')).toBe(false);
    // The load-bearing assertion of this whole slice: a blocked dependent has NO
    // persisted enabled flag, so restarting alpha brings beta back on its own.
    expect(await readConfigPlugins()).toEqual({ alpha: { enabled: false } });
  });

  it('brings a blocked dependent back when the dependency returns, activating it once', async () => {
    const registry = await loadPair();
    await disableLoadedPlugin(registry, 'alpha', { cascade: true });
    dependencyEvents.length = 0;

    await reloadLoadedPlugin(registry, 'alpha');

    expect(record(registry, 'alpha')?.state).toBe('active');
    expect(record(registry, 'beta')?.state).toBe('active');
    expect(registry.has('beta')).toBe(true);
    // Exactly one extra activation: a restore pass that re-ran beta twice would be a
    // cascade storm hiding behind a passing test.
    expect(marks().activated.filter((id) => id === 'beta')).toHaveLength(2);
    expect(dependencyEvents).toEqual([
      { pluginId: 'beta', dependencyId: 'alpha', action: 'restored' },
    ]);
    expect(await readConfigPlugins()).toEqual({ alpha: { enabled: true } });
  });

  it('takes a live dependent down before the reload and brings it back after', async () => {
    const registry = await loadPair();

    await reloadLoadedPlugin(registry, 'alpha');

    // A dependent holds handles from the instance being thrown away, so it goes first.
    expect(marks().deactivated).toEqual(['beta', 'alpha']);
    expect(record(registry, 'alpha')?.state).toBe('active');
    expect(record(registry, 'beta')?.state).toBe('active');
    expect(marks().activated.filter((id) => id === 'beta')).toHaveLength(2);
    expect(dependencyEvents).toEqual([
      { pluginId: 'beta', dependencyId: 'alpha', action: 'blocked' },
      { pluginId: 'beta', dependencyId: 'alpha', action: 'restored' },
    ]);
  });

  it('restores the previous generation and its dependents when replacement activation fails', async () => {
    const registry = await loadPair();

    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '1.2.0' }, 'throw new Error("alpha is broken");');
    await expect(reloadLoadedPlugin(registry, 'alpha')).rejects.toThrow('previous version restored');

    expect(record(registry, 'alpha')?.state).toBe('active');
    expect(record(registry, 'beta')?.state).toBe('active');
    expect(getUnmetDependencyPlugins()).toEqual([]);
    // Still recoverable: fixing alpha and reloading brings both back.
    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '1.2.0' });
    await reloadLoadedPlugin(registry, 'alpha');
    expect(['alpha', 'beta'].map((id) => record(registry, id)?.state)).toEqual(['active', 'active']);
    expect(getUnmetDependencyPlugins()).toEqual([]);
  });

  /**
   * The lifecycle announcement. It exists for a capability plugin that hands out registrations
   * to other plugins: the base keys each row by the plugin that made it (the host's
   * `walnut.services.caller()`) and needs a signal for "that owner just left a live state" to
   * drop it. The case it is FOR is the one nobody else can cover, an `activate` that throws
   * after it registered, so the event has to fire on `failed` and not only on a tidy disable.
   */
  it('announces every lifecycle transition on the bus, including a failed activation', async () => {
    const registry = await loadPair();
    const states = (id: string) => lifecycleEvents.filter((event) => event.pluginId === id).map((event) => event.state);

    // The load itself: discovered, then the activation pair, for both plugins.
    expect(states('alpha')).toEqual(expect.arrayContaining(['discovered', 'activating', 'active']));
    expect(states('beta')).toEqual(expect.arrayContaining(['activating', 'active']));

    lifecycleEvents.length = 0;
    await disableLoadedPlugin(registry, 'alpha', { cascade: true });

    // Beta is parked, not disabled, and both endings are announced. `needs-dependency` and
    // `disabled` are the two non-live states a sweep has to react to.
    expect(states('beta')).toContain('needs-dependency');
    expect(states('alpha')).toContain('disabled');

    lifecycleEvents.length = 0;
    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '1.2.0' }, 'throw new Error("alpha is broken");');
    await reloadLoadedPlugin(registry, 'alpha');

    expect(record(registry, 'alpha')?.state).toBe('failed');
    expect(states('alpha')).toContain('failed');
    // Every event names a plugin and a state, and nothing else: a subscriber must not have to
    // know the loader's record shape to react.
    for (const event of lifecycleEvents) {
      expect(Object.keys(event).sort()).toEqual(['pluginId', 'state']);
    }
  });

  it('cascades through a chain, naming each plugin its own direct dependency', async () => {
    await writePlugin('a-gamma', { id: 'gamma', name: 'gamma', version: '1.0.0', dependencies: { beta: '^1' } });
    await writePlugin('b-beta', { id: 'beta', name: 'beta', version: '1.0.0', dependencies: { alpha: '^1' } });
    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '1.2.0' });
    const registry = new IntegrationRegistry();
    await load(registry);
    expect(marks().activated.slice(0, 3)).toEqual(['alpha', 'beta', 'gamma']);

    await disableLoadedPlugin(registry, 'alpha', { cascade: true });

    // Deepest first on the way down.
    expect(marks().deactivated).toEqual(['gamma', 'beta', 'alpha']);
    expect(record(registry, 'gamma')?.missingDependencies).toEqual([
      { id: 'beta', range: '^1', found: '1.0.0', reason: 'inactive', note: expect.stringContaining('depends on "alpha"') },
    ]);
    expect(await readConfigPlugins()).toEqual({ alpha: { enabled: false } });

    await reloadLoadedPlugin(registry, 'alpha');

    expect(['alpha', 'beta', 'gamma'].map((id) => record(registry, id)?.state)).toEqual(['active', 'active', 'active']);
    expect(marks().activated.filter((id) => id === 'gamma')).toHaveLength(2);
  });
});

/** The restore pass once more than one dependent is involved: what it tries, in what order,
 *  how many times, and what it must leave alone. */
describe('restore pass over a dependent graph', () => {
  /** Gamma refuses a SECOND activation, the way a plugin that never gave a handle back does.
   *  The code never changes, so a restore from the generation that already worked still
   *  fails — which is what makes "the reason is an activation failure" reachable at all. */
  const GAMMA_FAILS_ON_RESTART =
    'if (globalThis.__p01.activated.filter((one) => one === "gamma").length > 1) throw new Error("gamma cannot start twice");';

  /** alpha ← beta ← gamma ← delta plus the SHORTCUT edge delta → alpha, which makes delta a
   *  first-level dependent of alpha as well as the deepest one (dir names put it first, so
   *  the discovery order agrees with that trap). `solo`/`orphan` are the unrelated control. */
  async function writeDiamond(gammaBody = ''): Promise<void> {
    await writePlugin('a-delta', { id: 'delta', name: 'delta', version: '1.0.0', dependencies: { alpha: '^1', gamma: '^1' } });
    await writePlugin('b-gamma', { id: 'gamma', name: 'gamma', version: '1.0.0', dependencies: { beta: '^1' } }, gammaBody);
    await writePlugin('c-beta', { id: 'beta', name: 'beta', version: '1.0.0', dependencies: { alpha: '^1' } });
    await writePlugin('d-solo', { id: 'solo', name: 'solo', version: '1.0.0' });
    await writePlugin('e-orphan', { id: 'orphan', name: 'orphan', version: '1.0.0', dependencies: { ghost: '^1' } });
    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '1.0.0' });
  }

  async function loadDiamond(gammaBody = ''): Promise<IntegrationRegistry> {
    await writeDiamond(gammaBody);
    const registry = new IntegrationRegistry();
    await load(registry);

    expect(['alpha', 'beta', 'gamma', 'delta', 'solo'].map((id) => record(registry, id)?.state))
      .toEqual(['active', 'active', 'active', 'active', 'active']);
    expect(record(registry, 'orphan')?.state).toBe('needs-dependency');
    // The guard on the guard: discovered before the chain it ends, or the trap is not armed.
    const dirs = await fsp.readdir(path.join(WALNUT_HOME, 'plugins'));
    expect(dirs.indexOf('a-delta')).toBeLessThan(dirs.indexOf('b-gamma'));
    return registry;
  }

  it('brings a shortcut diamond back, each dependent exactly once and in depth order', async () => {
    const registry = await loadDiamond();
    await disableLoadedPlugin(registry, 'alpha', { cascade: true });
    // Deepest first on the way down; the shortcut edge does not promote delta out of that.
    expect(marks().deactivated).toEqual(['delta', 'gamma', 'beta', 'alpha']);
    dependencyEvents.length = 0;

    await reloadLoadedPlugin(registry, 'alpha');

    expect(['alpha', 'beta', 'gamma', 'delta'].map((id) => record(registry, id)?.state))
      .toEqual(['active', 'active', 'active', 'active']);
    for (const id of ['beta', 'gamma', 'delta']) {
      expect(registry.has(id)).toBe(true);
      // Boot plus this pass. Three would be a cascade storm; one means delta spent its
      // attempt before gamma was back and stayed parked, which is the bug this case is for.
      expect(marks().activated.filter((one) => one === id)).toHaveLength(2);
    }
    // Ancestors before descendants, in one pass — the order is the assertion.
    expect(dependencyEvents).toEqual([
      { pluginId: 'beta', dependencyId: 'alpha', action: 'restored' },
      { pluginId: 'gamma', dependencyId: 'alpha', action: 'restored' },
      { pluginId: 'delta', dependencyId: 'alpha', action: 'restored' },
    ]);
    expect(getUnmetDependencyPlugins().map((entry) => entry.id)).toEqual(['orphan']);
  });

  it('rewrites a descendant reason from what the plugin in between ended up as', async () => {
    const registry = await loadDiamond();
    await disableLoadedPlugin(registry, 'alpha', { cascade: true });
    // What the cascade wrote for delta: gamma is down only because alpha is.
    expect(record(registry, 'delta')?.missingDependencies).toEqual([
      { id: 'alpha', range: '^1', found: '1.0.0', reason: 'inactive', note: expect.stringContaining('turned off') },
      { id: 'gamma', range: '^1', found: '1.0.0', reason: 'inactive', note: expect.stringContaining('depends on "alpha"') },
    ]);
    // The user then turns gamma off while it is parked, so alpha coming back cannot help
    // delta any more — and the reason it cannot has changed under it.
    await disableLoadedPlugin(registry, 'gamma');
    dependencyEvents.length = 0;

    await reloadLoadedPlugin(registry, 'alpha');

    expect(record(registry, 'beta')?.state).toBe('active');
    expect(record(registry, 'gamma')?.state).toBe('disabled');
    expect(marks().activated.filter((id) => id === 'gamma')).toHaveLength(1);
    const delta = record(registry, 'delta')!;
    expect(delta.state).toBe('needs-dependency');
    // A walk that stops at gamma leaves delta saying gamma is `needs-dependency`, which is
    // no longer true and points the user at the wrong row to fix.
    expect(delta.missingDependencies).toEqual([
      { id: 'gamma', range: '^1', found: '1.0.0', reason: 'inactive', note: expect.stringContaining('disabled') },
    ]);
    // The store reads the diagnostic list, not the record, so both have to move.
    expect(getUnmetDependencyPlugins().find((entry) => entry.id === 'delta')!.missing[0].note).toContain('disabled');
    expect(dependencyEvents).toEqual([
      { pluginId: 'beta', dependencyId: 'alpha', action: 'restored' },
    ]);

    // Still recoverable from the middle: turning gamma back on restores delta with it.
    await reloadLoadedPlugin(registry, 'gamma');

    expect(['gamma', 'delta'].map((id) => record(registry, id)?.state)).toEqual(['active', 'active']);
    expect(getUnmetDependencyPlugins().map((entry) => entry.id)).toEqual(['orphan']);
  });

  it('names a failed activation as the reason for the descendant under it', async () => {
    const registry = await loadDiamond(GAMMA_FAILS_ON_RESTART);
    await disableLoadedPlugin(registry, 'alpha', { cascade: true });
    dependencyEvents.length = 0;

    await reloadLoadedPlugin(registry, 'alpha');

    expect(record(registry, 'beta')?.state).toBe('active');
    // Gamma really was tried, from the same code as the first time, and threw.
    expect(marks().activated.filter((id) => id === 'gamma')).toHaveLength(2);
    expect(record(registry, 'gamma')?.state).toBe('failed');
    const delta = record(registry, 'delta')!;
    expect(delta.state).toBe('needs-dependency');
    // A walk that stops at the failure leaves delta blaming alpha, which is back and fine.
    expect(delta.missingDependencies).toEqual([
      { id: 'gamma', range: '^1', found: '1.0.0', reason: 'inactive', note: expect.stringContaining('failed') },
    ]);
    expect(getUnmetDependencyPlugins().find((entry) => entry.id === 'delta')!.missing[0].note).toContain('failed');
    expect(dependencyEvents).toEqual([
      { pluginId: 'beta', dependencyId: 'alpha', action: 'restored' },
    ]);
  });

  it('leaves a blocked plugin the user then turned off exactly where they left it', async () => {
    await writePlugin('a-beta', { id: 'beta', name: 'beta', version: '1.0.0', dependencies: { alpha: '^1' } });
    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '1.0.0' });
    const registry = new IntegrationRegistry();
    await load(registry);
    await disableLoadedPlugin(registry, 'alpha', { cascade: true });

    // Turning off something already down writes the flag without moving it out of
    // `needs-dependency` — the exact pair the restore pass has to read correctly.
    await disableLoadedPlugin(registry, 'beta');
    expect(record(registry, 'beta')?.state).toBe('needs-dependency');
    expect(await readConfigPlugins()).toEqual({ alpha: { enabled: false }, beta: { enabled: false } });
    dependencyEvents.length = 0;

    await reloadLoadedPlugin(registry, 'alpha');

    expect(record(registry, 'alpha')?.state).toBe('active');
    // The pass does reach beta, and the flag outranks it: disabled, not active.
    expect(record(registry, 'beta')?.state).toBe('disabled');
    expect(registry.has('beta')).toBe(false);
    // Not restarted, in its strongest form: the flag is read before the import, so beta's
    // module is not even EVALUATED a second time.
    expect(marks().evaluated.filter((id) => id === 'beta')).toHaveLength(1);
    expect(marks().activated.filter((id) => id === 'beta')).toHaveLength(1);
    expect(dependencyEvents).toEqual([]);
    // Its row stops claiming an unmet dependency, because that is no longer why it is down.
    expect(getUnmetDependencyPlugins()).toEqual([]);
    expect(await readConfigPlugins()).toEqual({ alpha: { enabled: true }, beta: { enabled: false } });
  });

  it('never touches a plugin outside the dependent set of the one that changed', async () => {
    const registry = await loadDiamond();
    await disableLoadedPlugin(registry, 'alpha', { cascade: true });
    lifecycleEvents.length = 0;
    dependencyEvents.length = 0;

    await reloadLoadedPlugin(registry, 'alpha');

    // No transition at all for `solo`: an event for it means the pass left its own graph.
    expect(record(registry, 'solo')?.state).toBe('active');
    expect(marks().activated.filter((id) => id === 'solo')).toHaveLength(1);
    expect(lifecycleEvents.filter((event) => event.pluginId === 'solo')).toEqual([]);
    // `orphan` waits on something never installed, which this pass has no news about.
    expect(record(registry, 'orphan')?.missingDependencies).toEqual([
      { id: 'ghost', range: '^1', reason: 'absent', note: expect.stringContaining('not installed') },
    ]);
    expect(lifecycleEvents.filter((event) => event.pluginId === 'orphan')).toEqual([]);
    expect(dependencyEvents.map((event) => event.pluginId)).toEqual(['beta', 'gamma', 'delta']);
  });
});

/** `reloadLoadedPlugins`: one lane, one preflight over the whole candidate graph, one recovery.
 *  What a per-plugin reload cannot do is swap a dependency and its dependent across a major. */
describe('batch reload of one source', () => {
  /** Activations minus deactivations: one live instance, never a leaked second copy. */
  const live = (id: string) =>
    marks().activated.filter((one) => one === id).length - marks().deactivated.filter((one) => one === id).length;

  /** alpha 1.0.0 with beta 1.0.0 on `^1` — the pair an upgrade has to move together. */
  async function loadUpgradePair(): Promise<IntegrationRegistry> {
    await writePlugin('a-beta', { id: 'beta', name: 'beta', version: '1.0.0', dependencies: { alpha: '^1' } });
    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '1.0.0' });
    const registry = new IntegrationRegistry();
    await load(registry);
    expect(['alpha', 'beta'].map((id) => record(registry, id)?.state)).toEqual(['active', 'active']);
    return registry;
  }

  async function writeNextMajor(betaBody = ''): Promise<void> {
    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '2.0.0' });
    await writePlugin('a-beta', { id: 'beta', name: 'beta', version: '2.0.0', dependencies: { alpha: '^2' } }, betaBody);
  }

  it('upgrades a dependency and its dependent across a major, in whatever order they are asked', async () => {
    const registry = await loadUpgradePair();
    await writeNextMajor();
    const toldToTearDown: string[][] = [];
    const deactivatedDuringCallback: string[] = [];

    // Asked back to front on purpose: neither plugin alone satisfies the other's range, so a
    // per-plugin reload leaves one of them blocked whichever end you start from.
    const result = await reloadLoadedPlugins(registry, ['beta', 'alpha'], async (ids) => {
      toldToTearDown.push(ids);
      deactivatedDuringCallback.push(...marks().deactivated);
    });

    expect(result).toEqual({ reloaded: ['beta', 'alpha'], skipped: [] });
    // The callback is where the download goes, so it runs while both are still live.
    expect(toldToTearDown).toEqual([['beta', 'alpha']]);
    expect(deactivatedDuringCallback).toEqual([]);
    expect(marks().deactivated).toEqual(['beta', 'alpha']);
    expect([registry.get('alpha')?.version, registry.get('beta')?.version]).toEqual(['2.0.0', '2.0.0']);
    expect(['alpha', 'beta'].map((id) => record(registry, id)?.state)).toEqual(['active', 'active']);
    expect([live('alpha'), live('beta')]).toEqual([1, 1]);
    // Dependency first on the way up, dependent last, as at boot.
    expect(marks().activated.lastIndexOf('alpha')).toBeLessThan(marks().activated.lastIndexOf('beta'));
    expect(getUnmetDependencyPlugins()).toEqual([]);
  });

  it('puts both previous versions back when the new dependent cannot activate', async () => {
    const registry = await loadUpgradePair();
    await writeNextMajor('throw new Error("beta 2.0.0 is broken");');

    const failure = await reloadLoadedPlugins(registry, ['alpha', 'beta'], async () => undefined)
      .catch((error: unknown) => error);

    expect(String(failure)).toContain('previous versions restored');
    // The whole batch goes back, not just the half that threw: alpha must not be left at
    // 2.0.0 with a beta that declares `^1`.
    expect([registry.get('alpha')?.version, registry.get('beta')?.version]).toEqual(['1.0.0', '1.0.0']);
    expect(['alpha', 'beta'].map((id) => record(registry, id)?.state)).toEqual(['active', 'active']);
    expect(registry.has('beta')).toBe(true);
    // Recovery re-activates, so the count only proves anything net of teardowns.
    expect([live('alpha'), live('beta')]).toEqual([1, 1]);
  });

  it.each([false, true])('keeps a timed-out batch member controllable with disabled=%s', async disabled => {
    const registry = await loadUpgradePair();
    await writeNextMajor('return new Promise(resolve => { globalThis.__releaseBatch = resolve; });');
    setPluginCodeTimeoutForTesting(50);
    await expect(reloadLoadedPlugins(registry, ['alpha', 'beta'], async () => undefined))
      .rejects.toThrow(/recovery incomplete/);
    expect(record(registry, 'beta')).toBeDefined();
    if (disabled) await disableLoadedPlugin(registry, 'beta');
    (globalThis as any).__releaseBatch();
    delete (globalThis as any).__releaseBatch;
    if (disabled) {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(record(registry, 'beta')?.state).toBe('disabled');
      expect(registry.has('beta')).toBe(false);
    } else {
      await vi.waitFor(() => expect(record(registry, 'beta')?.state).toBe('active'));
      expect(registry.get('beta')?.version).toBe('1.0.0');
    }
    expect(registry.get('alpha')?.version).toBe('1.0.0');
  });

  it('never starts a target the user turned off before the batch reached it', async () => {
    // Turning it off INSIDE the callback would deadlock — the batch holds the loader's lane
    // for its whole run — so the decision lands the only way it can, before the call.
    await writePlugin('a-one', { id: 'one', name: 'one', version: '1.0.0' });
    await writePlugin('b-two', { id: 'two', name: 'two', version: '1.0.0' });
    const registry = new IntegrationRegistry();
    await load(registry);
    await disableLoadedPlugin(registry, 'two');
    const toldToTearDown: string[][] = [];

    const result = await reloadLoadedPlugins(registry, ['one', 'two'], async (ids) => {
      toldToTearDown.push(ids);
    });

    expect(result).toEqual({ reloaded: ['one'], skipped: ['two'] });
    // It is not even in the teardown list, so nothing downstream can bring it up.
    expect(toldToTearDown).toEqual([['one']]);
    expect(record(registry, 'two')?.state).toBe('disabled');
    expect(marks().activated.filter((id) => id === 'two')).toHaveLength(1);
    expect(marks().evaluated.filter((id) => id === 'two')).toHaveLength(1);
    expect(record(registry, 'one')?.state).toBe('active');
    expect(live('one')).toBe(1);
    // A batch reload records no decision of its own, so the user's flag is all there is.
    expect(await readConfigPlugins()).toEqual({ two: { enabled: false } });
  });

  it.each([false, true])('settles a timed-out replacement with user disabled=%s', async (disabled) => {
    await writePlugin('alpha', { id: 'alpha', name: 'alpha', version: '1.0.0' });
    const registry = new IntegrationRegistry();
    await load(registry);
    await writePlugin('alpha', { id: 'alpha', name: 'alpha', version: '2.0.0' },
      'return new Promise(resolve => { globalThis.__releasePlugin = resolve; });');
    setPluginCodeTimeoutForTesting(50);
    await expect(reloadLoadedPlugin(registry, 'alpha')).rejects.toThrow(/timed out/);
    if (disabled) await disableLoadedPlugin(registry, 'alpha');
    (globalThis as any).__releasePlugin();
    delete (globalThis as any).__releasePlugin;
    await vi.waitFor(() => expect(lifecycleEvents.filter(e => e.pluginId === 'alpha').at(-1)?.state)
      .toBe(disabled ? 'disabled' : 'active'));
    if (!disabled) expect(registry.get('alpha')?.version).toBe('1.0.0');
    else {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(registry.has('alpha')).toBe(false);
      expect((await readConfigPlugins()).alpha.enabled).toBe(false);
    }
  });

  it('restores a dependent after its slow cleanup settles using current settings', async () => {
    await writePlugin('alpha', { id: 'alpha', name: 'alpha', version: '1.0.0' });
    await writePlugin('beta', { id: 'beta', name: 'beta', version: '1.0.0', dependencies: { alpha: '^1' } });
    const file = path.join(WALNUT_HOME, 'plugins/beta/dist/server.mjs');
    await fsp.appendFile(file, '\nlet stopped = false;\ndeactivate = () => { if (stopped) return; stopped = true; return new Promise(resolve => { globalThis.__releaseDependent = resolve; }); };\n');
    const registry = new IntegrationRegistry();
    await load(registry);
    await expect(reloadLoadedPlugin(registry, 'alpha')).rejects.toThrow(/beta.*still stopping/);
    expect(record(registry, 'alpha')?.state).toBe('active');
    expect(record(registry, 'beta')?.state).toBe('needs-dependency');
    await writeConfig({ beta: { sync_interval_ms: 900 } });
    (globalThis as any).__releaseDependent();
    delete (globalThis as any).__releaseDependent;
    await vi.waitFor(() => expect(record(registry, 'beta')?.state).toBe('active'));
    expect(registry.get('beta')?.config).toEqual({ sync_interval_ms: 900 });
  });

  it('brings a blocked dependent back on the config written while it waited', async () => {
    await writePlugin('a-beta', { id: 'beta', name: 'beta', version: '1.0.0', dependencies: { alpha: '^2' } });
    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '1.0.0' });
    const registry = new IntegrationRegistry();
    await load(registry);
    expect(record(registry, 'beta')?.state).toBe('needs-dependency');

    // Settings edited while beta was parked, then the dependency it needs arrives as a batch.
    await writeConfig({ beta: { sync_interval_ms: 900 } });
    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '2.0.0' });
    const result = await reloadLoadedPlugins(registry, ['alpha'], async () => undefined);

    expect(result).toEqual({ reloaded: ['alpha'], skipped: [] });
    expect(registry.get('alpha')?.version).toBe('2.0.0');
    expect(record(registry, 'beta')?.state).toBe('active');
    // The batch reads config fresh, so the restore runs on 900 rather than the boot settings
    // a blocked plugin never got to read.
    expect(registry.get('beta')?.config).toEqual({ sync_interval_ms: 900 });
    expect(marks().activated.filter((id) => id === 'beta')).toHaveLength(1);
    expect(getUnmetDependencyPlugins()).toEqual([]);
  });
});
