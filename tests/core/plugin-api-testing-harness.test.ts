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
