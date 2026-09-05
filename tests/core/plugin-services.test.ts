/**
 * `walnut.services` end to end, through the real loader, real manifests and the real
 * lifecycle cascade. The fixtures are plugins that genuinely publish and consume, so what
 * is graded here is the seam a capability plugin will actually stand on:
 *
 * - A declared dependency can `require` its dependency's service DURING activate, and the
 *   value it got is asserted from the consumer's side, not from the registry.
 * - A plugin that did NOT declare the publisher is refused, by name, and its activation
 *   fails while everything else keeps running. A service seam that could be reached without
 *   a declaration would work exactly until the directory read order changed.
 * - The handle is per KEY: the one beta captured in its FIRST activation resolves to the
 *   instance a later reload published. That is what lets a reload be a single-node
 *   operation instead of a coordinated restart.
 * - Once the publisher is off, the same handle throws and says why. Silence would produce a
 *   bug report about the consumer.
 * - `core:` services need no declaration, because the host is not a plugin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('plugin-services-test'));

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js';
import { IntegrationRegistry } from '../../src/core/integration-registry.js';
import {
  disableLoadedPlugin,
  disposeLoadedPlugins,
  loadNewPlugins,
  loadPlugins,
  reloadLoadedPlugin,
  getPluginLifecycleRecords,
} from '../../src/core/integration-loader.js';
import { publishCoreService, disposeCoreServices } from '../../src/core/platform-services.js';
import {
  listServiceKeys,
  resetServicesForTesting,
  SERVICE_CHANGED_EVENT,
  type ServiceChange,
} from '../../src/core/plugins/service-registry.js';
import { bus } from '../../src/core/event-bus.js';
import type { PluginLifecycleRecord } from '../../src/core/plugins/plugin-manager.js';

interface Markers {
  activated: string[];
  deactivated: string[];
  /** Handles captured by a consumer, in activation order, kept past teardown on purpose. */
  handles: Array<Record<string, (...args: any[]) => any>>;
  /** Whatever a fixture wants to prove it computed. */
  log: string[];
  /** What a fixture's own `services.onChange` was told. */
  changes: ServiceChange[];
}

function marks(): Markers {
  return (globalThis as unknown as { __p02: Markers }).__p02;
}

/** One external apiVersion 1 plugin whose `activate` receives the real `walnut` api. */
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
const all = () => (globalThis.__p02 ??= { activated: [], deactivated: [], handles: [], log: [], changes: [] });
export function activate(walnut) { all().activated.push(${id}); ${body} }
export function deactivate() { all().deactivated.push(${id}); }
`);
}

async function writeConfig(plugins: Record<string, Record<string, unknown>> = {}): Promise<void> {
  await fsp.writeFile(
    CONFIG_FILE,
    yaml.dump({ version: 1, user: { name: 'test' }, defaults: { priority: 'none' }, plugins }),
    'utf-8',
  );
}

function record(registry: IntegrationRegistry, id: string): PluginLifecycleRecord | undefined {
  return getPluginLifecycleRecords(registry).find((entry) => entry.id === id);
}

const busChanges: ServiceChange[] = [];
const loadedRegistries: IntegrationRegistry[] = [];

/** Tracked so `afterEach` can dispose the plugins for real, the way the server does. */
function newRegistry(): IntegrationRegistry {
  const registry = new IntegrationRegistry();
  loadedRegistries.push(registry);
  return registry;
}

/** alpha publishes `greeter`; beta declared alpha and requires it during activate. */
const ALPHA_PUBLISH = `walnut.services.publish('greeter', { greet: (who) => 'hi ' + who });`;
const BETA_REQUIRE = `
  const g = walnut.services.require('alpha:greeter');
  all().handles.push(g);
  all().log.push(g.greet('beta'));
`;

async function writePair(alphaBody = ALPHA_PUBLISH, betaBody = BETA_REQUIRE): Promise<void> {
  // Directory names fight the answer, so an order that works can only come from the edge.
  await writePlugin('a-beta', { id: 'beta', name: 'beta', version: '1.0.0', dependencies: { alpha: '^1' } }, betaBody);
  await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '1.2.0' }, alphaBody);
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }));
  await writeConfig();
  resetServicesForTesting();
  (globalThis as unknown as { __p02: Markers }).__p02 = {
    activated: [], deactivated: [], handles: [], log: [], changes: [],
  };
  busChanges.length = 0;
  bus.subscribe('p02-observer', (event) => {
    if (event.name === SERVICE_CHANGED_EVENT) busChanges.push(event.data as ServiceChange);
  }, { global: true, interest: [SERVICE_CHANGED_EVENT] });
});

afterEach(async () => {
  bus.unsubscribe('p02-observer');
  // Real teardown first: the point is that the production dispose path is what empties the
  // registry. `resetServicesForTesting` stays as belt and braces for a test that never
  // loaded, and would hide a leak if it ran alone.
  for (const registry of loadedRegistries.splice(0)) {
    await disposeLoadedPlugins(registry).catch(() => undefined);
  }
  delete (globalThis as unknown as { __p02?: Markers }).__p02;
  resetServicesForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('publish and require across a declared dependency', () => {
  it('hands the dependent the publisher\'s method bag during activate', async () => {
    await writePair();
    const registry = newRegistry();

    await loadPlugins(registry);

    expect(record(registry, 'alpha')?.state).toBe('active');
    expect(record(registry, 'beta')?.state).toBe('active');
    // Asserted from beta's side: the call happened inside beta's activate, with the value
    // alpha's function returned.
    expect(marks().log).toEqual(['hi beta']);
    expect(listServiceKeys()).toEqual(['alpha:greeter']);
  });

  it('refuses a plugin that never declared the publisher, naming the rule', async () => {
    await writePair();
    await writePlugin(
      'b-gamma',
      { id: 'gamma', name: 'gamma', version: '1.0.0' },
      `walnut.services.get('alpha:greeter');`,
    );
    const registry = newRegistry();

    // A third party reaching for a service it did not declare must not take the boot down.
    await expect(loadPlugins(registry)).resolves.toBeUndefined();

    const gamma = record(registry, 'gamma')!;
    expect(gamma.state).toBe('failed');
    expect(gamma.error).toContain('dependencies.alpha');
    expect(gamma.error).toContain('gamma');
    expect(['alpha', 'beta'].map((id) => record(registry, id)?.state)).toEqual(['active', 'active']);
    expect(marks().log).toEqual(['hi beta']);
    // The server keeps its task source, and the loader lane is still usable.
    expect(record(registry, 'local')?.state).toBe('active');
    await expect(loadNewPlugins(registry)).resolves.toBeUndefined();
  });

  it('lets a plugin use its own service without declaring a dependency on itself', async () => {
    await writePlugin('a-solo', { id: 'solo', name: 'solo', version: '1.0.0' }, `
      walnut.services.publish('clock', { now: () => 'noon' });
      all().log.push(walnut.services.get('solo:clock').now());
    `);
    const registry = newRegistry();

    await loadPlugins(registry);

    expect(record(registry, 'solo')?.state).toBe('active');
    expect(marks().log).toEqual(['noon']);
  });
});

describe('the handle is per key, not per instance', () => {
  it('follows the publisher through a reload, for a handle captured before it', async () => {
    await writePair();
    const registry = newRegistry();
    await loadPlugins(registry);
    expect(marks().log).toEqual(['hi beta']);

    await writePlugin(
      'z-alpha',
      { id: 'alpha', name: 'alpha', version: '1.2.0' },
      `walnut.services.publish('greeter', { greet: (who) => 'hello ' + who });`,
    );
    await reloadLoadedPlugin(registry, 'alpha');

    // P0-1 makes a reload tear the dependent down first and bring it back after, so beta
    // ran twice — and its SECOND activation saw the new instance.
    expect(marks().activated.filter((id) => id === 'beta')).toHaveLength(2);
    expect(marks().log).toEqual(['hi beta', 'hello beta']);
    // The load-bearing half: the handle from the FIRST activation, which beta would have
    // held in a field, resolves to the new instance too.
    expect(marks().handles).toHaveLength(2);
    expect(marks().handles[0].greet('x')).toBe('hello x');
    expect(marks().handles[1].greet('x')).toBe('hello x');
  });

  it('throws on a stale handle once the publisher is off, and says why', async () => {
    await writePair();
    const registry = newRegistry();
    await loadPlugins(registry);
    const stale = marks().handles[0];

    await disableLoadedPlugin(registry, 'alpha', { cascade: true });

    expect(record(registry, 'alpha')?.state).toBe('disabled');
    expect(record(registry, 'beta')?.state).toBe('needs-dependency');
    expect(() => stale.greet('x')).toThrow(/Service "alpha:greeter" is unavailable/);
    expect(() => stale.greet('x')).toThrow(/"alpha" is disabled/);
    // The publisher's teardown withdrew the entry, so nothing answers for that key.
    expect(listServiceKeys()).toEqual([]);
    // And the server is untouched: task source up, loader lane still accepting work.
    expect(record(registry, 'local')?.state).toBe('active');
    await expect(loadNewPlugins(registry)).resolves.toBeUndefined();
  });
});

describe('plugin:service-changed', () => {
  it('emits published, replaced and removed with the same payload shape', async () => {
    await writePair(`
      walnut.services.publish('greeter', { greet: (who) => 'hi ' + who });
      walnut.services.publish('greeter', { greet: (who) => 'hey ' + who });
    `);
    const registry = newRegistry();
    await loadPlugins(registry);

    expect(busChanges).toEqual([
      { key: 'alpha:greeter', pluginId: 'alpha', action: 'published' },
      { key: 'alpha:greeter', pluginId: 'alpha', action: 'replaced' },
    ]);
    // The second publish is the live one, and beta got the replacement.
    expect(marks().log).toEqual(['hey beta']);

    busChanges.length = 0;
    await disableLoadedPlugin(registry, 'alpha', { cascade: true });

    expect(busChanges).toEqual([
      { key: 'alpha:greeter', pluginId: 'alpha', action: 'removed' },
    ]);
  });

  it('delivers to a plugin\'s own onChange and stops when the plugin goes away', async () => {
    await writePair(ALPHA_PUBLISH, `
      walnut.services.onChange((change) => { all().changes.push(change); });
      walnut.services.publish('echo', { say: () => 'echo' });
    `);
    const registry = newRegistry();
    await loadPlugins(registry);

    // Subscribed before publishing, so beta hears its own registration first.
    expect(marks().changes).toEqual([
      { key: 'beta:echo', pluginId: 'beta', action: 'published' },
    ]);

    await disableLoadedPlugin(registry, 'beta');
    const heard = marks().changes.length;
    await reloadLoadedPlugin(registry, 'alpha');

    // The subscription was owned by beta's context, so a disabled beta hears nothing —
    // even though alpha's reload emitted a removal and a publish.
    expect(busChanges.filter((change) => change.key === 'alpha:greeter').length).toBeGreaterThan(0);
    expect(marks().changes).toHaveLength(heard);
  });
});

describe('core services', () => {
  it('are readable by any plugin with no declared dependency', async () => {
    publishCoreService('calendar-source', { list: () => ['one', 'two'] });
    await writePlugin('a-delta', { id: 'delta', name: 'delta', version: '1.0.0' }, `
      all().log.push(walnut.services.require('core:calendar-source').list().join(','));
    `);
    const registry = newRegistry();

    await loadPlugins(registry);

    expect(record(registry, 'delta')?.state).toBe('active');
    expect(marks().log).toEqual(['one,two']);
    expect(listServiceKeys()).toEqual(['core:calendar-source']);

    // Shutdown withdraws them, and a plugin still holding a handle finds out honestly.
    expect(disposeCoreServices()).toBe(1);
    expect(listServiceKeys()).toEqual([]);
  });

  it('are the only keys exempt: a plugin service still needs the declaration', async () => {
    publishCoreService('calendar-source', { list: () => [] });
    await writePlugin('a-delta', { id: 'delta', name: 'delta', version: '1.0.0' }, `
      walnut.services.require('core:calendar-source');
      walnut.services.require('alpha:greeter');
    `);
    await writePlugin('z-alpha', { id: 'alpha', name: 'alpha', version: '1.2.0' }, ALPHA_PUBLISH);
    const registry = newRegistry();

    await loadPlugins(registry);

    expect(record(registry, 'delta')?.state).toBe('failed');
    expect(record(registry, 'delta')?.error).toContain('dependencies.alpha');
    expect(record(registry, 'alpha')?.state).toBe('active');
  });

  it('reserves the id, so no plugin can ever be the core owner', async () => {
    // A plugin holding `core` would publish keys every other plugin trusts without
    // declaring anything, and its teardown sweep would withdraw the host's own services.
    publishCoreService('calendar-source', { list: () => [] });
    await writePlugin('a-core', { id: 'core', name: 'Core', version: '9.9.9' }, ALPHA_PUBLISH);
    const registry = newRegistry();

    await loadPlugins(registry);

    expect(record(registry, 'core')).toBeUndefined();
    expect(registry.has('core')).toBe(false);
    // Its module was never imported, so it published nothing.
    expect(marks().activated).toEqual([]);
    expect(listServiceKeys()).toEqual(['core:calendar-source']);
  });
});

describe('teardown', () => {
  it('withdraws every plugin service on dispose and leaves the host\'s alone', async () => {
    publishCoreService('calendar-source', { list: () => [] });
    await writePair();
    const registry = newRegistry();
    await loadPlugins(registry);
    expect(listServiceKeys()).toEqual(['alpha:greeter', 'core:calendar-source']);

    await disposeLoadedPlugins(registry);

    // The per-plugin sweep in the dispose path cannot reach the `core` owner.
    expect(listServiceKeys()).toEqual(['core:calendar-source']);
  });

  it('withdraws a service published by an activate that then threw', async () => {
    // Half-activated is the case the owned Disposable exists for: the plugin is `failed`,
    // so its service must not stay in the registry answering for a plugin that is not there.
    await writePlugin('a-solo', { id: 'solo', name: 'solo', version: '1.0.0' }, `
      walnut.services.publish('clock', { now: () => 'noon' });
      throw new Error('solo is broken');
    `);
    const registry = newRegistry();

    await loadPlugins(registry);

    expect(record(registry, 'solo')?.state).toBe('failed');
    expect(listServiceKeys()).toEqual([]);
  });
});

describe('require versus get, from a plugin', () => {
  it('fails a typo\'d key inside the activate that wrote it', async () => {
    await writePair(ALPHA_PUBLISH, `walnut.services.require('alpha:greetr');`);
    const registry = newRegistry();

    await loadPlugins(registry);

    const beta = record(registry, 'beta')!;
    expect(beta.state).toBe('failed');
    expect(beta.error).toContain('alpha:greetr');
    // The publisher is up, so the message must not read "alpha is active".
    expect(beta.error).toContain('has not published "greetr"');
    expect(record(registry, 'alpha')?.state).toBe('active');
  });

  it('lets get defer, so a handle may predate the key', async () => {
    await writePair(ALPHA_PUBLISH, `all().handles.push(walnut.services.get('alpha:greetr'));`);
    const registry = newRegistry();

    await loadPlugins(registry);

    expect(record(registry, 'beta')?.state).toBe('active');
    expect(() => marks().handles[0].greet()).toThrow(/alpha:greetr" is unavailable/);
  });
});
