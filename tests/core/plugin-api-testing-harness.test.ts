/**
 * The fake `walnut` that plugin authors write their own unit tests against
 * (`@open-walnut/plugin-api/testing`).
 *
 * Imported from SOURCE, not through the package name: the package's exports map
 * points at `dist/`, which is only rebuilt by `npm run build:plugins`, so a test
 * going through the package name would grade a stale build.
 */
import { describe, expect, it } from 'vitest'
import type { WalnutServerApi } from '../../packages/plugin-api/src/server.js'
import { createFakeWalnut } from '../../packages/plugin-api/src/testing.js'

function activate(walnut: WalnutServerApi) {
  return walnut.registry.op({
    name: 'ping',
    title: 'Ping',
    description: 'Answer with a greeting.',
    inputSchema: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] },
    readonly: true,
    async handler(args) {
      return { greeting: `hello ${String(args.who)}` }
    },
  })
}

describe('createFakeWalnut registry.op', () => {
  it('records what activate declared, schema included', async () => {
    const fake = createFakeWalnut({ pluginId: 'sample' })
    activate(fake.api)

    expect(fake.registeredOps).toHaveLength(1)
    const [op] = fake.registeredOps
    expect(op.name).toBe('ping')
    expect(op.readonly).toBe(true)
    expect(op.inputSchema).toEqual({ type: 'object', properties: { who: { type: 'string' } }, required: ['who'] })
    // The handler is the real one, so a plugin test can exercise it without the host.
    await expect(op.handler({ who: 'ada' }, { call: async () => undefined })).resolves.toEqual({ greeting: 'hello ada' })
  })

  it('forgets an op once its Disposable is disposed', () => {
    const fake = createFakeWalnut({ pluginId: 'sample' })
    const registration = activate(fake.api)

    registration.dispose()
    expect(fake.registeredOps).toEqual([])
  })
})

describe('createFakeWalnut services', () => {
  it('lets a test stand in for the plugin this one depends on', () => {
    const fake = createFakeWalnut({ pluginId: 'sample' })
    fake.services.set('greeter-plugin:greeter', { greet: (who: string) => `hi ${who}` })

    // What the plugin under test would write in its own activate.
    const greeter = fake.api.services.require<{ greet(who: string): string }>('greeter-plugin:greeter')

    expect(greeter.greet('ada')).toBe('hi ada')
    // Seeding a replacement is enough: the fake resolves at call time, like the host.
    fake.services.set('greeter-plugin:greeter', { greet: (who: string) => `hello ${who}` })
    expect(greeter.greet('ada')).toBe('hello ada')
  })

  it('splits eager require from lazy get, the way the host does', () => {
    const fake = createFakeWalnut({ pluginId: 'sample' })

    expect(() => fake.api.services.require('absent:thing')).toThrow(/No fake service published/)
    const lazy = fake.api.services.get<{ ping(): string }>('absent:thing')
    fake.services.set('absent:thing', { ping: () => 'pong' })

    expect(lazy.ping()).toBe('pong')
  })

  it('applies the host\'s method-bag rule, so a test cannot pass against a laxer contract', () => {
    const fake = createFakeWalnut({ pluginId: 'sample' })
    class Clock { now() { return 1 } }

    expect(() => fake.api.services.publish('clock', new Clock()))
      .toThrow(/plain object whose own enumerable properties are all functions/)
    expect(() => fake.api.services.publish('clock', { now: () => 1, tz: 'utc' } as never))
      .toThrow(/"tz" is string/)
    expect(() => fake.api.services.publish('clock', { then: () => undefined }))
      .toThrow(/may not have a method named "then"/)
    expect([...fake.services.keys()]).toEqual([])
  })

  it('records what the plugin published, keyed by its own id, and tells onChange', () => {
    const fake = createFakeWalnut({ pluginId: 'sample' })
    const changes: Array<{ key: string; action: string }> = []
    fake.api.services.onChange((change) => { changes.push({ key: change.key, action: change.action }) })

    const registration = fake.api.services.publish('clock', { now: () => 1 })
    expect([...fake.services.keys()]).toEqual(['sample:clock'])

    fake.api.services.publish('clock', { now: () => 2 })
    registration.dispose()

    // The replaced registration's Disposable is a no-op, same as the host's.
    expect(fake.services.get('sample:clock')?.now()).toBe(2)
    expect(changes).toEqual([
      { key: 'sample:clock', action: 'published' },
      { key: 'sample:clock', action: 'replaced' },
    ])
  })
})
