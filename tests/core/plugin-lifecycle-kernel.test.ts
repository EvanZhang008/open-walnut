import { describe, expect, it, vi } from 'vitest'
import { DisposableStore, toDisposable } from '../../src/core/plugins/disposable.js'
import { OwnedRegistry } from '../../src/core/plugins/owned-registry.js'
import { PluginContext, type PluginLogger } from '../../src/core/plugins/plugin-context.js'

const logger: PluginLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
}

describe('DisposableStore', () => {
  it('disposes resources once in reverse registration order', async () => {
    const order: string[] = []
    const store = new DisposableStore()
    store.add(toDisposable(() => { order.push('first') }))
    store.add(toDisposable(async () => { order.push('second') }))
    store.add(toDisposable(() => { order.push('third') }))

    await store.dispose()
    await store.dispose()

    expect(order).toEqual(['third', 'second', 'first'])
    expect(store.isDisposed).toBe(true)
    expect(store.size).toBe(0)
  })

  it('continues cleanup and aggregates disposal errors', async () => {
    const disposed = vi.fn()
    const store = new DisposableStore()
    store.add(toDisposable(disposed))
    store.add(toDisposable(() => { throw new Error('one') }))
    store.add(toDisposable(() => { throw new Error('two') }))

    const error = await store.dispose().catch((value: unknown) => value)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(2)
    expect(disposed).toHaveBeenCalledOnce()
  })

  it('continues invoking cleanup after the shared deadline expires', async () => {
    const order: string[] = []
    const store = new DisposableStore()
    store.add(toDisposable(() => { order.push('last') }))
    store.add(toDisposable(() => {
      order.push('hanging')
      return new Promise<void>(() => undefined)
    }))

    const error = await store.disposeWithin(10).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'Plugin cleanup deadline exceeded' }),
    ])
    expect(order).toEqual(['hanging', 'last'])
  })

  it('immediately disposes resources added after shutdown', async () => {
    const disposed = vi.fn()
    const store = new DisposableStore()
    await store.dispose()

    store.add(toDisposable(disposed))

    expect(disposed).toHaveBeenCalledOnce()
    expect(store.size).toBe(0)
  })

  it('can remove an owned resource before store disposal', async () => {
    const disposed = vi.fn()
    const resource = toDisposable(disposed)
    const store = new DisposableStore()
    store.add(resource)

    expect(store.delete(resource)).toBe(true)
    await store.dispose()

    expect(disposed).not.toHaveBeenCalled()
  })
})

describe('OwnedRegistry', () => {
  it('keeps deterministic insertion order and records ownership', () => {
    const registry = new OwnedRegistry<number>()
    registry.register('plugin-a', 'plugin-a:first', 1)
    registry.register('plugin-b', 'plugin-b:second', 2)

    expect(registry.entries()).toEqual([
      { owner: 'plugin-a', key: 'plugin-a:first', value: 1 },
      { owner: 'plugin-b', key: 'plugin-b:second', value: 2 },
    ])
  })

  it('rejects duplicate and cross-owner replacement', () => {
    const registry = new OwnedRegistry<number>()
    registry.register('plugin-a', 'shared', 1)

    expect(() => registry.register('plugin-a', 'shared', 2)).toThrow('already registered')
    expect(() => registry.replace('plugin-b', 'shared', 2)).toThrow('owned by "plugin-a"')
  })

  it('does not let a stale disposable remove a replacement', () => {
    const registry = new OwnedRegistry<number>()
    const oldRegistration = registry.register('plugin-a', 'plugin-a:item', 1)
    const replacement = registry.replace('plugin-a', 'plugin-a:item', 2)

    oldRegistration.dispose()
    expect(registry.get('plugin-a:item')).toBe(2)

    replacement.dispose()
    expect(registry.has('plugin-a:item')).toBe(false)
  })

  it('removes only the requested owner and makes old handles harmless', () => {
    const registry = new OwnedRegistry<number>()
    const old = registry.register('plugin-a', 'plugin-a:item', 1)
    registry.register('plugin-b', 'plugin-b:item', 2)

    expect(registry.removeOwner('plugin-a')).toBe(1)
    registry.register('plugin-a', 'plugin-a:item', 3)
    old.dispose()

    expect(registry.entries()).toEqual([
      { owner: 'plugin-b', key: 'plugin-b:item', value: 2 },
      { owner: 'plugin-a', key: 'plugin-a:item', value: 3 },
    ])
  })

  it('notifies observers without allowing them to break mutation', () => {
    const registry = new OwnedRegistry<number>()
    const changes: string[] = []
    registry.subscribe((change) => changes.push(change.type))
    registry.subscribe(() => { throw new Error('observer failed') })

    const registration = registry.register('plugin-a', 'plugin-a:item', 1)
    registration.dispose()

    expect(changes).toEqual(['registered', 'removed'])
    expect(registry.version).toBe(2)
  })
})

describe('PluginContext', () => {
  it('aborts before disposing resources and cleans them in reverse order', async () => {
    const order: string[] = []
    const context = new PluginContext({ id: 'test-plugin', dataDir: '/tmp/test-plugin', logger })
    context.onDispose(() => { order.push(context.signal.aborted ? 'first-after-abort' : 'first-before-abort') })
    context.onDispose(() => { order.push('second') })

    await context.dispose()

    expect(context.isDisposed).toBe(true)
    expect(order).toEqual(['second', 'first-after-abort'])
  })

  it('is idempotent', async () => {
    const disposed = vi.fn()
    const context = new PluginContext({ id: 'test-plugin', dataDir: '/tmp/test-plugin', logger })
    context.onDispose(disposed)

    await Promise.all([context.dispose(), context.dispose()])

    expect(disposed).toHaveBeenCalledOnce()
  })
})
