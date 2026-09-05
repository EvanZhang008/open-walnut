/**
 * The service registry on its own: what may be published, what a handle does while the
 * publisher changes underneath it, and which mutation produces which event.
 *
 * The fixture-level story (real loader, real manifests, real cascade) lives in
 * `plugin-services.test.ts`. This file pins the rules that have to hold before any of that
 * is reachable, and the ones a fixture cannot state precisely: a class instance is refused,
 * a handle never caches, and a sweep emits one removal per key.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { bus } from '../../src/core/event-bus.js';
import {
  assertServiceAvailable,
  createServiceHandle,
  currentServiceCaller,
  getServiceEntry,
  listServiceKeys,
  publishOwnedService,
  publishService,
  removeOwnedServices,
  removeServicesOf,
  resetServicesForTesting,
  resolveServiceAccess,
  ServiceUnavailableError,
  SERVICE_CHANGED_EVENT,
  type ServiceChange,
} from '../../src/core/plugins/service-registry.js';

const changes: ServiceChange[] = [];

beforeEach(() => {
  resetServicesForTesting();
  changes.length = 0;
  bus.subscribe('service-registry-test', (event) => {
    if (event.name === SERVICE_CHANGED_EVENT) changes.push(event.data as ServiceChange);
  }, { global: true, interest: [SERVICE_CHANGED_EVENT] });
});

afterEach(() => {
  bus.unsubscribe('service-registry-test');
  resetServicesForTesting();
});

describe('publish', () => {
  it('accepts a plain method bag and names the key after the publisher', () => {
    publishService('alpha', 'greeter', { greet: (who: string) => `hi ${who}` });

    expect(listServiceKeys()).toEqual(['alpha:greeter']);
    expect(getServiceEntry('alpha:greeter')).toMatchObject({ key: 'alpha:greeter', pluginId: 'alpha' });
  });

  class Greeter {
    greet(who: string): string { return `hi ${who}`; }
  }

  it.each([
    ['a class instance', () => new Greeter()],
    ['an EventEmitter', () => new EventEmitter()],
    ['a Promise', () => Promise.resolve({ greet: () => 'hi' })],
    ['a Map', () => new Map()],
  ])('refuses %s, because a handle cannot re-resolve identity', (_label, make) => {
    // Every one of these passes a naive "object with callable properties" check while
    // carrying state on a prototype the consumer's per-key handle can never follow.
    expect(() => publishService('alpha', 'greeter', make()))
      .toThrow(/plain object whose own enumerable properties are all functions/);
  });

  it('refuses a bag with a non-function property, naming the property', () => {
    expect(() => publishService('alpha', 'greeter', { greet: () => 'hi', version: 2 }))
      .toThrow(/"version" is number/);
  });

  it('refuses a method named "then", which would make the handle a thenable', () => {
    // `await handle` on a thenable resolves it instead of handing it over, so the consumer
    // silently receives whatever `then` decided to call back with.
    expect(() => publishService('alpha', 'greeter', { then: () => undefined }))
      .toThrow(/may not have a method named "then"/);
  });

  it.each([
    ['null', null],
    ['an array', ['greet']],
    ['a function', () => 'hi'],
    ['a string', 'greeter'],
  ])('refuses %s outright', (_label, api) => {
    expect(() => publishService('alpha', 'greeter', api)).toThrow(/cannot be published/);
  });

  it.each(['mail:base', 'Greeter', '-greeter', '', 'greeter.base', 'greeter/base'])(
    'refuses the service name %j',
    (name) => {
      expect(() => publishService('alpha', name, { greet: () => 'hi' })).toThrow(/Invalid service name/);
    },
  );

  it('replaces this plugin\'s earlier value and neutralizes the earlier handle', () => {
    const first = publishService('alpha', 'greeter', { greet: () => 'one' });
    publishService('alpha', 'greeter', { greet: () => 'two' });

    // The stale Disposable must not withdraw the CURRENT value: a plugin that publishes in
    // a loop would otherwise delete its own live service on teardown of the first handle.
    first.dispose();
    expect(getServiceEntry('alpha:greeter')?.api.greet()).toBe('two');
  });
});

describe('live handle', () => {
  function handle(): Record<string, (...args: any[]) => any> {
    return createServiceHandle({ key: 'alpha:greeter', publisherId: 'alpha' });
  }

  it('resolves the current entry on every access', () => {
    publishService('alpha', 'greeter', { greet: (who: string) => `hi ${who}` });
    const g = handle();
    expect(g.greet('ada')).toBe('hi ada');

    publishService('alpha', 'greeter', { greet: (who: string) => `hello ${who}` });

    // Same handle, obtained before the republish: the Proxy is per KEY, not per instance.
    expect(g.greet('ada')).toBe('hello ada');
  });

  it('resolves at CALL time, so even a destructured method follows a republish', () => {
    publishService('alpha', 'greeter', { greet: () => 'one' });
    const g = handle();
    // Every spelling a consumer might use, captured BEFORE the republish.
    const destructured = g.greet;
    const stored = { greet: g.greet };

    publishService('alpha', 'greeter', { greet: () => 'two' });

    expect(g.greet()).toBe('two');
    expect(destructured()).toBe('two');
    expect(stored.greet()).toBe('two');
  });

  it('throws from a destructured method once the publisher is gone', () => {
    const registration = publishService('alpha', 'greeter', { greet: () => 'one' });
    const { greet } = handle();

    registration.dispose();

    expect(() => greet()).toThrow(ServiceUnavailableError);
  });

  it('throws when a republish dropped the method the caller holds', () => {
    publishService('alpha', 'greeter', { greet: () => 'one' });
    const { greet } = handle();

    publishService('alpha', 'greeter', { hello: () => 'one' });

    expect(() => greet()).toThrow(/Service "alpha:greeter" no longer provides "greet"/);
  });

  it('binds the method to the api so a bag can close over its own object', () => {
    const api = {
      count: () => 0,
      greet(this: { count(): number }) { return `hi ${this.count()}`; },
    };
    publishService('alpha', 'greeter', api);

    const { greet } = handle();
    expect(greet()).toBe('hi 0');
  });

  it('reflects the current api through has, ownKeys and typeof', () => {
    publishService('alpha', 'greeter', { greet: () => 'hi', bye: () => 'bye' });
    const g = handle();

    expect(typeof g).toBe('object');
    expect(Object.keys(g).sort()).toEqual(['bye', 'greet']);
    expect('greet' in g).toBe(true);
    expect('nope' in g).toBe(false);
    expect(g.nope).toBeUndefined();

    publishService('alpha', 'greeter', { greet: () => 'hi' });
    expect(Object.keys(g)).toEqual(['greet']);
  });

  it('throws with the publisher\'s state once the entry is gone', () => {
    const registration = publishService('alpha', 'greeter', { greet: () => 'hi' });
    const g = createServiceHandle<Record<string, () => string>>({
      key: 'alpha:greeter',
      publisherId: 'alpha',
      lookupState: () => 'disabled',
    });
    registration.dispose();

    expect(() => g.greet()).toThrow(ServiceUnavailableError);
    expect(() => g.greet()).toThrow(/Service "alpha:greeter" is unavailable: "alpha" is disabled/);
    // Describing a dead handle must not throw: a test reporter, a debugger, `util.inspect`
    // and a defensive `'x' in svc` all have to keep answering. Only a property READ throws.
    expect(Object.keys(g)).toEqual([]);
    expect('greet' in g).toBe(false);
    expect(() => (g as unknown as Record<symbol, unknown>)[Symbol.toStringTag]).not.toThrow();
  });

  it('says "not running" when nobody can name the publisher\'s state', () => {
    expect(() => handle().greet()).toThrow(/"alpha" is not running/);
  });

  it('renders a lifecycle state as words, and blames nothing on a broken lookup', () => {
    const blocked = createServiceHandle<Record<string, () => string>>({
      key: 'alpha:greeter',
      publisherId: 'alpha',
      lookupState: () => 'needs-dependency',
    });
    expect(() => blocked.greet()).toThrow(/"alpha" is waiting on its own dependencies/);

    // A lookup that throws must not be able to replace the honest error with its own.
    const broken = createServiceHandle<Record<string, () => string>>({
      key: 'alpha:greeter',
      publisherId: 'alpha',
      lookupState: () => { throw new Error('manager is gone'); },
    });
    expect(() => broken.greet()).toThrow(/is unavailable: "alpha" is not running/);
  });

  it('says so when the publisher is running but nobody published that name', () => {
    // The typo case. Reporting `"alpha" is active` would send the reader to the wrong file.
    publishService('alpha', 'clock', { now: () => 0 });
    const typo = createServiceHandle<Record<string, () => string>>({
      key: 'alpha:greeter',
      publisherId: 'alpha',
      lookupState: () => 'active',
    });

    expect(() => typo.greet()).toThrow(/"alpha" is running but has not published "greeter"/);
  });

  it('await on a handle resolves to the handle, and rejects once it is dead', async () => {
    const registration = publishService('alpha', 'greeter', { greet: () => 'hi' });
    const g = handle();

    // `then` cannot exist on a service api, so awaiting a live handle is a no-op.
    await expect(Promise.resolve(g)).resolves.toBe(g);

    registration.dispose();
    await expect(Promise.resolve(g)).rejects.toThrow(ServiceUnavailableError);
  });

  it('is read-only', () => {
    publishService('alpha', 'greeter', { greet: () => 'hi' });
    const g = handle();

    expect(() => { (g as Record<string, unknown>).greet = () => 'mine'; }).toThrow(TypeError);
    expect(g.greet()).toBe('hi');
  });

  it('cannot be frozen, sealed, redefined or reparented, and survives the attempt', () => {
    // The trap this pins: a successful freeze against the EMPTY target would make the
    // proxy's own invariants unsatisfiable, and every later `Object.keys(svc)` would throw
    // a TypeError forever. Defensive code doing `Object.freeze(svc)` is not exotic.
    publishService('alpha', 'greeter', { greet: () => 'hi' });
    const g = handle();

    expect(() => Object.freeze(g)).toThrow(TypeError);
    expect(() => Object.seal(g)).toThrow(TypeError);
    expect(() => Object.preventExtensions(g)).toThrow(TypeError);
    expect(() => Object.defineProperty(g, 'greet', { value: () => 'mine' })).toThrow(TypeError);
    expect(() => Object.setPrototypeOf(g, null)).toThrow(TypeError);

    expect(Object.keys(g)).toEqual(['greet']);
    expect({ ...g }).toEqual({ greet: expect.any(Function) });
    expect(g.greet()).toBe('hi');
  });
});

/**
 * The current caller, which exists for exactly one job: letting a publisher that hands out
 * REGISTRATIONS key them by owner, so it can drop a row when that owner goes away. Before it, a
 * consumer whose `activate` threw right after registering left the publisher with a row it could
 * not attribute to anybody, and every retry then hit the duplicate-id refusal.
 */
describe('current caller', () => {
  function handleFor(consumerId: string | undefined): Record<string, (...args: any[]) => any> {
    return createServiceHandle({
      key: 'alpha:greeter',
      publisherId: 'alpha',
      ...(consumerId ? { consumerId } : {}),
    });
  }

  it('is the consumer inside a method body, and nothing outside one', () => {
    let seen: string | undefined = 'not set';
    publishService('alpha', 'greeter', { greet: () => { seen = currentServiceCaller(); } });

    expect(currentServiceCaller()).toBeUndefined();
    handleFor('beta').greet();

    expect(seen).toBe('beta');
    // Restored, not left behind: a leaked value would make the NEXT registration look like it
    // came from whoever called last.
    expect(currentServiceCaller()).toBeUndefined();
  });

  it('is undefined after an await, by design', async () => {
    const seen: Array<string | undefined> = [];
    publishService('alpha', 'greeter', {
      greet: async () => {
        seen.push(currentServiceCaller());
        await Promise.resolve();
        seen.push(currentServiceCaller());
      },
    });

    await handleFor('beta').greet();

    // Synchronous prologue sees it; the continuation does not. Making it survive an await would
    // need AsyncLocalStorage on every service call, and a publisher that needs the caller reads
    // it on its first line.
    expect(seen).toEqual(['beta', undefined]);
  });

  it('restores the outer caller after a nested service call', () => {
    const seen: Array<string | undefined> = [];
    // `inner` is published by a different plugin and called from inside `outer`'s body, exactly
    // like a base standing on another base.
    publishService('gamma', 'inner', { work: () => { seen.push(currentServiceCaller()); } });
    const inner = createServiceHandle<Record<string, () => void>>({
      key: 'gamma:inner',
      publisherId: 'gamma',
      consumerId: 'alpha',
    });
    publishService('alpha', 'greeter', {
      greet: () => {
        seen.push(currentServiceCaller());
        inner.work();
        seen.push(currentServiceCaller());
      },
    });

    handleFor('beta').greet();

    expect(seen).toEqual(['beta', 'alpha', 'beta']);
    expect(currentServiceCaller()).toBeUndefined();
  });

  it('is undefined when the HOST is the caller', () => {
    // A handle with no consumer id is a host-made handle, and "the host asked" has to be
    // distinguishable from "a plugin asked": a publisher must not attribute a host call to some
    // plugin and then sweep the row when that plugin restarts.
    let seen: string | undefined = 'not set';
    publishService('alpha', 'greeter', { greet: () => { seen = currentServiceCaller(); } });

    handleFor(undefined).greet();

    expect(seen).toBeUndefined();
  });

  it('is restored even when the method throws', () => {
    publishService('alpha', 'greeter', { greet: () => { throw new Error('nope'); } });

    expect(() => handleFor('beta').greet()).toThrow('nope');
    expect(currentServiceCaller()).toBeUndefined();
  });
});

describe('the reserved core owner', () => {
  it('refuses a plugin publishing as core through the plugin door', () => {
    expect(() => publishService('core', 'calendar-source', { list: () => [] }))
      .toThrow(/Plugin id "core" is reserved: only the host publishes core:\* services/);
    expect(listServiceKeys()).toEqual([]);
  });

  it('keeps host services out of reach of a plugin teardown sweep', () => {
    publishOwnedService('core', 'calendar-source', { list: () => [] });
    publishService('alpha', 'greeter', { greet: () => 'hi' });

    // The loader's per-plugin sweep, called with every id the manager held.
    expect(removeServicesOf('core')).toBe(0);
    expect(removeServicesOf('alpha')).toBe(1);

    expect(listServiceKeys()).toEqual(['core:calendar-source']);
    expect(removeOwnedServices('core')).toBe(1);
    expect(listServiceKeys()).toEqual([]);
  });
});

describe('require versus get', () => {
  it('asserts a publisher exists now, so a typo fails where it was written', () => {
    publishService('alpha', 'greeter', { greet: () => 'hi' });

    expect(() => assertServiceAvailable('alpha:greetr', 'alpha', () => 'active'))
      .toThrow(ServiceUnavailableError);
    expect(() => assertServiceAvailable('alpha:greeter', 'alpha', () => 'active')).not.toThrow();
  });

  it('lets a lazy handle predate its publisher', () => {
    // What `get` buys: a handle taken before the key exists resolves once it does.
    const g = createServiceHandle<Record<string, () => string>>({ key: 'alpha:greeter', publisherId: 'alpha' });
    expect(() => g.greet()).toThrow(ServiceUnavailableError);

    publishService('alpha', 'greeter', { greet: () => 'hi' });

    expect(g.greet()).toBe('hi');
  });
});

describe('access rule', () => {
  it('requires the consumer to have declared the publisher', () => {
    expect(() => resolveServiceAccess('gamma', 'alpha:greeter', {}))
      .toThrow(/"gamma" must declare dependencies.alpha in its manifest/);
    expect(() => resolveServiceAccess('gamma', 'alpha:greeter', undefined))
      .toThrow(/dependencies.alpha/);
    expect(resolveServiceAccess('beta', 'alpha:greeter', { alpha: '^1' })).toBe('alpha');
  });

  it('exempts core keys and the consumer\'s own services', () => {
    expect(resolveServiceAccess('gamma', 'core:calendar-source', {})).toBe('core');
    expect(resolveServiceAccess('gamma', 'gamma:private', {})).toBe('gamma');
  });

  it.each(['greeter', ':greeter', 'alpha:', 'alpha:Greeter', 'alpha::greeter'])(
    'refuses the malformed key %j',
    (key) => {
      expect(() => resolveServiceAccess('beta', key, { alpha: '^1' })).toThrow(/Invalid service key/);
    },
  );
});

describe('events', () => {
  it('emits published, replaced and removed for one key', () => {
    const registration = publishService('alpha', 'greeter', { greet: () => 'one' });
    publishService('alpha', 'greeter', { greet: () => 'two' });
    registration.dispose();
    const second = publishService('alpha', 'greeter', { greet: () => 'three' });
    second.dispose();

    expect(changes).toEqual([
      { key: 'alpha:greeter', pluginId: 'alpha', action: 'published' },
      { key: 'alpha:greeter', pluginId: 'alpha', action: 'replaced' },
      // The disposed first registration was already stale, so it announces nothing.
      { key: 'alpha:greeter', pluginId: 'alpha', action: 'replaced' },
      { key: 'alpha:greeter', pluginId: 'alpha', action: 'removed' },
    ]);
  });

  it('emits one removal per key when a plugin is swept', () => {
    publishService('alpha', 'greeter', { greet: () => 'hi' });
    publishService('alpha', 'clock', { now: () => 0 });
    publishService('beta', 'echo', { say: () => 'hi' });
    changes.length = 0;

    expect(removeServicesOf('alpha')).toBe(2);

    expect(changes).toEqual([
      { key: 'alpha:greeter', pluginId: 'alpha', action: 'removed' },
      { key: 'alpha:clock', pluginId: 'alpha', action: 'removed' },
    ]);
    expect(listServiceKeys()).toEqual(['beta:echo']);
  });
});
