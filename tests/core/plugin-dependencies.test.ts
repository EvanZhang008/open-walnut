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
  getPluginLifecycleRecords,
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

  it('never tells a dependent the dependency was turned off when a reload broke it', async () => {
    // The disable wording used to be hardcoded into the shared teardown, so a reload whose
    // new code throws left beta permanently claiming a user turned alpha off. Nobody did:
    // alpha is installed, enabled, and failed.
    const registry = await loadPair();

    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '1.2.0' }, 'throw new Error("alpha is broken");');
    const reloaded = await reloadLoadedPlugin(registry, 'alpha');

    expect(reloaded.state).toBe('failed');
    const beta = record(registry, 'beta')!;
    expect(beta.state).toBe('needs-dependency');
    expect(beta.missingDependencies?.[0].note).not.toContain('turned off');
    expect(beta.missingDependencies?.[0].note).not.toContain('reloading');
    expect(beta.missingDependencies?.[0].note).toContain('failed');
    expect(getUnmetDependencyPlugins().find((entry) => entry.id === 'beta')!.missing[0].note).toContain('failed');
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
