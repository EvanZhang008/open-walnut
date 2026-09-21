import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { PluginContext, type PluginLogger } from '../../src/core/plugins/plugin-context.js'
import { PluginManager, type PluginDefinition } from '../../src/core/plugins/plugin-manager.js'

const logger: PluginLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
}

function createManager(options: {
  safeMode?: boolean
  quarantineAfter?: number
  activationTimeoutMs?: number
  deactivationTimeoutMs?: number
} = {}) {
  return new PluginManager({
    ...options,
    createContext: (definition) => new PluginContext({
      id: definition.id,
      dataDir: `/tmp/${definition.id}`,
      logger,
    }),
  })
}

function definition(overrides: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    id: 'plugin-a',
    name: 'Plugin A',
    activate: vi.fn(),
    ...overrides,
  }
}

/** A promise the test settles by hand — the only honest way to hold a cleanup open. */
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolveFn, rejectFn) => { resolve = resolveFn; reject = rejectFn })
  return { promise, resolve, reject }
}

describe('PluginManager', () => {
  it('tracks activation and disposes every owned registration', async () => {
    const order: string[] = []
    const plugin = definition({
      activate(context) {
        context.onDispose(() => { order.push('registration') })
        return { dispose: () => { order.push('activation') } }
      },
      deactivate: () => { order.push('module') },
    })
    const manager = createManager()
    manager.discover(plugin)

    expect((await manager.activate(plugin.id)).state).toBe('active')
    expect((await manager.disable(plugin.id)).state).toBe('disabled')
    expect(order).toEqual(['module', 'activation', 'registration'])
  })

  it('cleans a partial activation and quarantines repeated failures', async () => {
    const cleanup = vi.fn()
    const plugin = definition({
      activate(context) {
        context.onDispose(cleanup)
        throw new Error('bad plugin')
      },
    })
    const manager = createManager({ quarantineAfter: 2 })
    manager.discover(plugin)

    await expect(manager.activate(plugin.id)).rejects.toThrow('bad plugin')
    expect(manager.get(plugin.id)).toMatchObject({ state: 'failed', failureCount: 1 })
    await expect(manager.activate(plugin.id)).rejects.toThrow('bad plugin')
    expect(manager.get(plugin.id)).toMatchObject({ state: 'quarantined', failureCount: 2 })
    expect(cleanup).toHaveBeenCalledTimes(2)
    await expect(manager.activate(plugin.id)).rejects.toThrow('cannot activate while quarantined')
  })

  it('aborts and cleans an activation that never settles', async () => {
    const cleanup = vi.fn()
    const manager = createManager({ activationTimeoutMs: 10 })
    const plugin = definition({
      activate(context) {
        context.onDispose(cleanup)
        return new Promise<never>(() => undefined)
      },
    })
    manager.discover(plugin)

    await expect(manager.activate(plugin.id)).rejects.toThrow(
      'Plugin "plugin-a" activation timed out after 10ms',
    )
    expect(cleanup).toHaveBeenCalledOnce()
    expect(manager.get(plugin.id)).toMatchObject({ state: 'failed', failureCount: 1 })
  })

  it('keeps activation and cleanup deadlines alive without other event-loop handles', () => {
    const child = spawnSync(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `
        import { PluginContext } from './src/core/plugins/plugin-context.ts'
        import { PluginManager } from './src/core/plugins/plugin-manager.ts'

        const noop = () => undefined
        const logger = {
          trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
          child() { return logger },
        }
        const createManager = (options = {}) => new PluginManager({
          ...options,
          createContext: (definition) => new PluginContext({
            id: definition.id,
            dataDir: '/tmp/plugin-deadline-review',
            logger,
          }),
        })

        const activationManager = createManager({ activationTimeoutMs: 20 })
        activationManager.discover({
          id: 'activation-deadline',
          name: 'Activation deadline',
          activate: () => new Promise(() => undefined),
        })
        await activationManager.activate('activation-deadline').catch(() => undefined)

        const cleanupManager = createManager({ deactivationTimeoutMs: 20 })
        cleanupManager.discover({
          id: 'cleanup-deadline',
          name: 'Cleanup deadline',
          activate(context) {
            context.onDispose(() => new Promise(() => undefined))
          },
        })
        await cleanupManager.activate('cleanup-deadline')
        await cleanupManager.dispose().catch(() => undefined)
        console.log('deadlines-settled')
      `,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 5_000,
    })

    expect(child.error).toBeUndefined()
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toContain('deadlines-settled')
  })

  it('settles failures before Plugin activation starts', async () => {
    const deactivate = vi.fn()
    const createContext = vi.fn(() => new PluginContext({
      id: 'never-created',
      dataDir: '/tmp/never-created',
      logger,
    }))
    const startManager = new PluginManager({
      createContext,
      onActivationStart: () => { throw new Error('start failed') },
    })
    startManager.discover(definition({ deactivate }))

    await expect(startManager.activate('plugin-a')).rejects.toThrow('start failed')
    expect(startManager.get('plugin-a')).toMatchObject({ state: 'failed', failureCount: 1 })
    expect(createContext).not.toHaveBeenCalled()
    expect(deactivate).not.toHaveBeenCalled()

    const contextManager = new PluginManager({
      createContext: () => { throw new Error('context failed') },
    })
    const contextDeactivate = vi.fn()
    contextManager.discover(definition({ id: 'plugin-b', deactivate: contextDeactivate }))

    await expect(contextManager.activate('plugin-b')).rejects.toThrow('context failed')
    expect(contextManager.get('plugin-b')).toMatchObject({ state: 'failed', failureCount: 1 })
    expect(contextDeactivate).not.toHaveBeenCalled()
  })

  it('does not deactivate when shutdown times out before activation starts', async () => {
    const deactivate = vi.fn()
    const createContext = vi.fn(() => new PluginContext({
      id: 'setup-hang',
      dataDir: '/tmp/setup-hang',
      logger,
    }))
    const manager = new PluginManager({
      deactivationTimeoutMs: 20,
      createContext,
      onActivationStart: () => new Promise<never>(() => undefined),
    })
    const plugin = definition({ id: 'setup-hang', deactivate })
    manager.discover(plugin)
    void manager.activate(plugin.id).catch(() => undefined)
    await vi.waitFor(() => expect(manager.get(plugin.id)?.state).toBe('activating'))

    const error = await manager.dispose().catch((value: unknown) => value)

    expect(error).toBeInstanceOf(AggregateError)
    expect(createContext).not.toHaveBeenCalled()
    expect(deactivate).not.toHaveBeenCalled()
    expect(manager.get(plugin.id)).toMatchObject({ state: 'disabled' })
  })

  it('disposes an activation result that settles during rollback', async () => {
    const cleanup = vi.fn()
    let resolveActivation!: (value: { dispose(): void }) => void
    let signalDeactivation!: () => void
    let releaseDeactivation!: () => void
    const activation = new Promise<{ dispose(): void }>((resolve) => { resolveActivation = resolve })
    const deactivationStarted = new Promise<void>((resolve) => { signalDeactivation = resolve })
    const deactivation = new Promise<void>((resolve) => { releaseDeactivation = resolve })
    const manager = createManager({ activationTimeoutMs: 10, deactivationTimeoutMs: 200 })
    const plugin = definition({
      activate: () => activation,
      deactivate: () => {
        signalDeactivation()
        return deactivation
      },
    })
    manager.discover(plugin)

    const pendingActivation = manager.activate(plugin.id)
    await deactivationStarted
    resolveActivation({ dispose: cleanup })
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce())
    releaseDeactivation()

    await expect(pendingActivation).rejects.toThrow('activation timed out after 10ms')
  })

  it('waits for an activating Plugin during idempotent shutdown', async () => {
    const cleanup = vi.fn()
    let releaseActivation!: () => void
    const activationGate = new Promise<void>((resolve) => { releaseActivation = resolve })
    const manager = createManager()
    const plugin = definition({
      async activate(context) {
        await activationGate
        context.onDispose(cleanup)
      },
    })
    manager.discover(plugin)
    const pendingActivation = manager.activate(plugin.id)
    await vi.waitFor(() => expect(manager.get(plugin.id)?.state).toBe('activating'))

    const firstDispose = manager.dispose()
    const secondDispose = manager.dispose()
    expect(secondDispose).toBe(firstDispose)
    releaseActivation()

    await expect(pendingActivation).rejects.toThrow('activation cancelled because PluginManager is disposed')
    await expect(firstDispose).resolves.toBeUndefined()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(manager.get(plugin.id)).toMatchObject({ state: 'disabled', failureCount: 0 })
    expect(manager.get(plugin.id)?.error).toBeUndefined()
  })

  it('bounds shutdown when an activation ignores abort', async () => {
    const healthyCleanup = vi.fn()
    const hangingDeactivate = vi.fn(async () => { throw new Error('late deactivate failed') })
    let hangingContext: PluginContext | undefined
    const manager = createManager({ deactivationTimeoutMs: 20 })
    const hanging = definition({
      id: 'hanging',
      activate(context) {
        hangingContext = context
        return new Promise<never>(() => undefined)
      },
      deactivate: hangingDeactivate,
    })
    manager.discover(hanging)
    void manager.activate(hanging.id).catch(() => undefined)
    await vi.waitFor(() => expect(manager.get(hanging.id)?.state).toBe('activating'))

    const healthy = definition({
      id: 'healthy',
      activate(context) {
        context.onDispose(healthyCleanup)
      },
    })
    manager.discover(healthy)
    await manager.activate(healthy.id)

    const firstDispose = manager.dispose()
    const secondDispose = manager.dispose()
    const error = await firstDispose.catch((value: unknown) => value)

    expect(secondDispose).toBe(firstDispose)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('shutdown timed out waiting for lifecycle cleanup after 20ms'),
      }),
    ])
    expect(healthyCleanup).toHaveBeenCalledOnce()
    expect(hangingDeactivate).toHaveBeenCalledOnce()
    expect(hangingContext?.isDisposed).toBe(true)
    expect(manager.get(hanging.id)).toMatchObject({ state: 'disabled' })
    await vi.waitFor(() => expect(manager.get(hanging.id)?.error).toContain(
      'deactivate failed after shutdown timeout: late deactivate failed',
    ))
  })

  it('forces cleanup when activation completion wedges after becoming active', async () => {
    const cleanup = vi.fn()
    const deactivate = vi.fn()
    let signalActivationEnd!: () => void
    let releaseActivationEnd!: () => void
    const activationEndStarted = new Promise<void>((resolve) => { signalActivationEnd = resolve })
    const activationEndGate = new Promise<void>((resolve) => { releaseActivationEnd = resolve })
    const manager = new PluginManager({
      deactivationTimeoutMs: 20,
      createContext: (plugin) => new PluginContext({
        id: plugin.id,
        dataDir: `/tmp/${plugin.id}`,
        logger,
      }),
      async onActivationEnd(_pluginId, outcome) {
        if (outcome !== 'active') return
        signalActivationEnd()
        await activationEndGate
        throw new Error('late activation-end failure')
      },
    })
    const plugin = definition({
      id: 'active-wedge',
      activate(context) {
        context.onDispose(cleanup)
      },
      deactivate,
    })
    manager.discover(plugin)
    const pendingActivation = manager.activate(plugin.id)
    void pendingActivation.catch(() => undefined)
    await activationEndStarted
    expect(manager.get(plugin.id)?.state).toBe('active')

    const error = await manager.dispose().catch((value: unknown) => value)

    expect(error).toBeInstanceOf(AggregateError)
    expect(deactivate).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(manager.get(plugin.id)).toMatchObject({
      state: 'disabled',
      failureCount: 0,
      reason: 'Plugin manager disposal did not settle',
      error: expect.stringContaining('shutdown timed out waiting for lifecycle cleanup after 20ms'),
    })

    releaseActivationEnd()
    await expect(pendingActivation).rejects.toThrow('late activation-end failure')
    expect(deactivate).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(manager.get(plugin.id)).toMatchObject({
      state: 'disabled',
      failureCount: 0,
      reason: 'Plugin manager disposal did not settle',
      error: expect.stringContaining('shutdown timed out waiting for lifecycle cleanup after 20ms'),
    })
  })

  it('keeps a failed-cleanup record so the caller can retry forget', async () => {
    const manager = createManager()
    const plugin = definition({
      deactivate: () => { throw new Error('cleanup failed') },
    })
    manager.discover(plugin)
    await manager.activate(plugin.id)

    // The record survives a failed teardown on purpose. Deleting it handed the caller's
    // recovery step a 404 with nothing left to retry, while the id itself stayed refused.
    await expect(manager.forget(plugin.id)).rejects.toThrow('cleanup failed')
    expect(manager.get(plugin.id)).toMatchObject({ state: 'disabled', error: 'cleanup failed' })

    // The retry has no teardown left to fail, so it removes the record.
    await expect(manager.forget(plugin.id)).resolves.toBeUndefined()
    expect(manager.get(plugin.id)).toBeUndefined()
    expect(() => manager.discover(plugin)).not.toThrow()
  })

  /**
   * One instance per id, even when the old one's cleanup never comes back. Two generations
   * would hold the same registry rows and the same outside account, and the loser's teardown
   * would then withdraw the winner's registrations.
   */
  it('refuses a same-id activation while the previous instance is still stopping', async () => {
    const hanging = deferred()
    const started: string[] = []
    const manager = createManager({ deactivationTimeoutMs: 10 })
    const slow = definition({
      id: 'slow',
      activate(context) {
        started.push('slow')
        context.onDispose(() => hanging.promise)
      },
    })
    const healthy = definition({
      id: 'healthy',
      activate(context) {
        started.push('healthy')
        context.onDispose(vi.fn())
      },
    })
    manager.discover(slow)
    manager.discover(healthy)
    await manager.activate(slow.id)
    await manager.activate(healthy.id)
    // A plugin that is simply running is never "stopping".
    expect(manager.isStopping(slow.id)).toBe(false)
    expect(manager.isStopping(healthy.id)).toBe(false)

    // The reload's teardown half reports its deadline and stops waiting...
    await expect(manager.reload(slow.id)).rejects.toBeInstanceOf(AggregateError)
    expect(manager.isStopping(slow.id)).toBe(true)

    // ...so the retry is refused instead of building a second instance next to the first.
    await expect(manager.activate(slow.id)).rejects.toThrow('a previous instance is still stopping')
    await expect(manager.reload(slow.id)).rejects.toThrow('a previous instance is still stopping')
    expect(started).toEqual(['slow', 'healthy'])
    // A host-side "not yet" is not the plugin failing: no failure count, so no quarantine.
    expect(manager.get(slow.id)).toMatchObject({ state: 'disabled', failureCount: 0 })

    // One wedged plugin must never hold another id hostage.
    expect(manager.isStopping(healthy.id)).toBe(false)
    await expect(manager.reload(healthy.id)).resolves.toMatchObject({ state: 'active' })
    expect(started).toEqual(['slow', 'healthy', 'healthy'])

    hanging.resolve()
    await hanging.promise

    expect(manager.isStopping(slow.id)).toBe(false)
    expect((await manager.reload(slow.id)).state).toBe('active')
    expect(started).toEqual(['slow', 'healthy', 'healthy', 'slow'])
  })

  it('keeps refusing the id after a forget that gave up on cleanup', async () => {
    const hanging = deferred()
    const activate = vi.fn((context: PluginContext) => { context.onDispose(() => hanging.promise) })
    const manager = createManager({ deactivationTimeoutMs: 10 })
    const plugin = definition({ activate })
    manager.discover(plugin)
    await manager.activate(plugin.id)

    await expect(manager.forget(plugin.id)).rejects.toBeInstanceOf(AggregateError)
    expect(manager.get(plugin.id)).toMatchObject({ state: 'disabled' })
    // The retry takes the record with it, which is exactly why the abandoned context cannot
    // be remembered on the record.
    await expect(manager.forget(plugin.id)).resolves.toBeUndefined()
    expect(manager.get(plugin.id)).toBeUndefined()
    expect(manager.isStopping(plugin.id)).toBe(true)

    manager.discover(plugin)
    await expect(manager.activate(plugin.id)).rejects.toThrow('a previous instance is still stopping')
    expect(activate).toHaveBeenCalledOnce()

    hanging.resolve()
    await hanging.promise

    expect((await manager.reload(plugin.id)).state).toBe('active')
    expect(activate).toHaveBeenCalledTimes(2)
  })

  it('counts an activation that ignored its deadline as an instance still stopping', async () => {
    const activation = deferred()
    const manager = createManager({ activationTimeoutMs: 10 })
    const plugin = definition({ activate: () => activation.promise })
    manager.discover(plugin)

    await expect(manager.activate(plugin.id)).rejects.toThrow('activation timed out after 10ms')
    expect(manager.isStopping(plugin.id)).toBe(true)
    await expect(manager.activate(plugin.id)).rejects.toThrow('a previous instance is still stopping')
    // Still ONE failure: the refusal replaced a retry, it did not add a second failure.
    expect(manager.get(plugin.id)).toMatchObject({ state: 'failed', failureCount: 1 })

    activation.resolve()
    await activation.promise

    expect(manager.isStopping(plugin.id)).toBe(false)
    expect((await manager.reload(plugin.id)).state).toBe('active')
  })

  /**
   * The sibling of the `onDispose` path, and the one nothing else counts: an activation that
   * RETURNS its lifetime past the deadline was never `own()`ed, so the manager disposes it by
   * hand — outside the store. An async dispose there is still the old instance letting go.
   */
  it('counts the hand-disposed lifetime an abandoned activation returned', async () => {
    const unhandled: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const activation = deferred()
      const lateDispose = deferred()
      const disposed = vi.fn(() => lateDispose.promise)
      const manager = createManager({ activationTimeoutMs: 10 })
      const plugin = definition({
        activate: () => activation.promise.then(() => ({ dispose: disposed })),
      })
      manager.discover(plugin)

      await expect(manager.activate(plugin.id)).rejects.toThrow('activation timed out after 10ms')

      activation.resolve()
      await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce())

      expect(manager.isStopping(plugin.id)).toBe(true)
      await expect(manager.activate(plugin.id)).rejects.toThrow('a previous instance is still stopping')

      lateDispose.reject(new Error('late dispose failed'))
      await lateDispose.promise.catch(() => undefined)

      expect(manager.isStopping(plugin.id)).toBe(false)
      expect((await manager.reload(plugin.id)).state).toBe('active')
      // Rejections are reported at the end of a turn, so judge after one.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('counts a disposable a late activation registers, and never leaves it unhandled', async () => {
    const unhandled: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const activation = deferred()
      const lateCleanup = deferred()
      let context!: PluginContext
      const manager = createManager({ activationTimeoutMs: 10 })
      const plugin = definition({
        async activate(ctx) {
          context = ctx
          await activation.promise
          // The host gave up long ago, so the store takes this over and disposes it at once.
          ctx.onDispose(() => lateCleanup.promise)
        },
      })
      manager.discover(plugin)
      await expect(manager.activate(plugin.id)).rejects.toThrow('activation timed out after 10ms')

      activation.resolve()
      await vi.waitFor(() => expect(context.isCleanupPending).toBe(true))

      expect(manager.isStopping(plugin.id)).toBe(true)
      await expect(manager.activate(plugin.id)).rejects.toThrow('a previous instance is still stopping')

      lateCleanup.reject(new Error('late cleanup failed'))
      await lateCleanup.promise.catch(() => undefined)

      expect(manager.isStopping(plugin.id)).toBe(false)
      expect((await manager.reload(plugin.id)).state).toBe('active')
      // Rejections are reported at the end of a turn, so judge after one.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  /**
   * A `deactivate` past its deadline still owns the plugin module's own state, so the queued
   * activation is RELEASED (it runs, it does not hang) and then REFUSED. The old contract here
   * let it activate, which is how a reload ended up with two instances of one module.
   */
  it('bounds teardown, disposes owned resources, and refuses the queued activation until deactivate settles', async () => {
    const cleanup = vi.fn()
    const deactivation = deferred()
    const started = vi.fn()
    const manager = createManager({ deactivationTimeoutMs: 10 })
    const plugin = definition({
      activate(context) {
        started()
        context.onDispose(cleanup)
      },
      deactivate: () => deactivation.promise,
    })
    manager.discover(plugin)
    await manager.activate(plugin.id)

    const disableResult = manager.disable(plugin.id).catch((error: unknown) => error)
    const queuedActivation = manager.activate(plugin.id).catch((error: unknown) => error)
    const error = await disableResult

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('cleanup timed out during deactivate after 10ms') }),
    ])
    expect(cleanup).toHaveBeenCalledOnce()

    const queuedError = await queuedActivation
    expect(queuedError).toBeInstanceOf(Error)
    expect((queuedError as Error).message).toContain('a previous instance is still stopping')
    expect(started).toHaveBeenCalledOnce()
    expect(manager.isStopping(plugin.id)).toBe(true)

    // A module wedged in its own `deactivate` is that module's problem, not the next plugin's.
    const sibling = definition({ id: 'sibling', deactivate: vi.fn() })
    manager.discover(sibling)
    await expect(manager.activate(sibling.id)).resolves.toMatchObject({ state: 'active' })
    await expect(manager.reload(sibling.id)).resolves.toMatchObject({ state: 'active' })
    expect(manager.isStopping(sibling.id)).toBe(false)

    deactivation.resolve()
    await deactivation.promise

    expect(manager.isStopping(plugin.id)).toBe(false)
    expect((await manager.activate(plugin.id)).state).toBe('active')
    expect(started).toHaveBeenCalledTimes(2)
  })

  it('bounds owned-resource cleanup and still reaches later disposables', async () => {
    const cleanup = vi.fn()
    const manager = createManager({ deactivationTimeoutMs: 10 })
    const plugin = definition({
      activate(context) {
        context.onDispose(cleanup)
        context.onDispose(() => new Promise<void>(() => undefined))
      },
    })
    manager.discover(plugin)
    await manager.activate(plugin.id)

    const error = await manager.disable(plugin.id).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('cleanup timed out during owned resources after 10ms') }),
    ])
    expect(cleanup).toHaveBeenCalledOnce()
    expect(manager.get(plugin.id)).toMatchObject({ state: 'disabled' })
  })

  it('bounds failed-activation rollback without hiding the activation error', async () => {
    const cleanup = vi.fn()
    const manager = createManager({ deactivationTimeoutMs: 10 })
    const plugin = definition({
      activate(context) {
        context.onDispose(cleanup)
        throw new Error('activation failed')
      },
      deactivate: () => new Promise<void>(() => undefined),
    })
    manager.discover(plugin)

    await expect(manager.activate(plugin.id)).rejects.toThrow('activation failed')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(manager.get(plugin.id)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('cleanup timed out during deactivate after 10ms'),
    })
  })

  it('can clear quarantine and activate corrected code', async () => {
    let fail = true
    const plugin = definition({
      activate() {
        if (fail) throw new Error('bad plugin')
      },
    })
    const manager = createManager({ quarantineAfter: 1 })
    manager.discover(plugin)
    await expect(manager.activate(plugin.id)).rejects.toThrow()

    fail = false
    expect(manager.clearQuarantine(plugin.id).state).toBe('disabled')
    expect((await manager.activate(plugin.id)).state).toBe('active')
  })

  it('loads builtins only in Safe Mode', async () => {
    const external = definition()
    const builtin = definition({ id: 'builtin', name: 'Builtin', builtin: true })
    const manager = createManager({ safeMode: true })

    expect(manager.discover(external)).toMatchObject({ state: 'disabled', reason: 'Disabled by Safe Mode' })
    expect(manager.discover(builtin).state).toBe('discovered')
    await expect(manager.activate(external.id)).rejects.toThrow('Safe Mode is enabled')
    await manager.activate(builtin.id)
    expect(manager.get(builtin.id)?.state).toBe('active')
  })

  it('rejects unsupported and unconfigured code before activation', async () => {
    const activate = vi.fn()
    const manager = createManager()
    manager.discover(definition({ id: 'future', unsupportedReason: 'API 9', activate }))
    manager.discover(definition({ id: 'missing', missingConfig: ['token'], activate }))

    await expect(manager.activate('future')).rejects.toThrow('while unsupported')
    await expect(manager.activate('missing')).rejects.toThrow('while needs-config')
    expect((await manager.disable('future')).state).toBe('unsupported')
    expect((await manager.disable('missing')).state).toBe('needs-config')
    expect(activate).not.toHaveBeenCalled()
  })

  it('refuses to activate a plugin whose dependency is missing, and keeps refusing', async () => {
    const activate = vi.fn()
    const manager = createManager()

    const record = manager.discover(definition({
      id: 'blocked',
      activate,
      missingDependencies: [
        { id: 'alpha', range: '^2', found: '1.2.0', reason: 'version', note: 'alpha is at 1.2.0' },
      ],
    }))

    expect(record.state).toBe('needs-dependency')
    // The reason is what a user reads on the row, so it has to name the dependency, the
    // range asked for, and the version actually there.
    expect(record.reason).toBe('Missing dependencies: alpha@^2 (found 1.2.0)')
    expect(record.missingDependencies).toEqual([
      { id: 'alpha', range: '^2', found: '1.2.0', reason: 'version', note: 'alpha is at 1.2.0' },
    ])
    await expect(manager.activate('blocked')).rejects.toThrow('while needs-dependency')
    // Same refusal shape as unsupported/needs-config: disable is a no-op, not a downgrade.
    expect((await manager.disable('blocked')).state).toBe('needs-dependency')
    expect(activate).not.toHaveBeenCalled()
  })

  it('ranks an unmet dependency above quarantine and the off-switch', async () => {
    const manager = createManager()
    const missing = [{ id: 'alpha', range: '^1', reason: 'absent' as const, note: 'alpha is not installed' }]

    expect(manager.discover(definition({
      id: 'off', enabled: false, quarantined: true, missingDependencies: missing,
    })).state).toBe('needs-dependency')
    // needs-config still wins: the user can fix that one from this row.
    expect(manager.discover(definition({
      id: 'unconfigured', missingConfig: ['token'], missingDependencies: missing,
    })).state).toBe('needs-config')
  })

  it('blocks a running plugin without recording a human decision', async () => {
    const order: string[] = []
    const plugin = definition({
      activate: (context) => context.onDispose(() => { order.push('registration') }),
      deactivate: () => { order.push('module') },
    })
    const manager = createManager()
    manager.discover(plugin)
    await manager.activate(plugin.id)

    const record = await manager.block(plugin.id, [
      { id: 'alpha', range: '^1', reason: 'inactive', note: '"alpha" was turned off' },
    ])

    // A full teardown, exactly like disable — the difference is the state it lands in,
    // which is what tells the loader to bring it back when alpha returns.
    expect(order).toEqual(['module', 'registration'])
    expect(record.state).toBe('needs-dependency')
    expect(record.missingDependencies?.[0].note).toContain('turned off')
    await expect(manager.activate(plugin.id)).rejects.toThrow('while needs-dependency')
  })

  it('serializes concurrent reloads without duplicating live resources', async () => {
    let active = 0
    let peak = 0
    const plugin = definition({
      async activate(context) {
        active++
        peak = Math.max(peak, active)
        context.onDispose(() => { active-- })
        await Promise.resolve()
      },
    })
    const manager = createManager()
    manager.discover(plugin)
    await manager.activate(plugin.id)

    await Promise.all([manager.reload(plugin.id), manager.reload(plugin.id), manager.reload(plugin.id)])

    expect(active).toBe(1)
    expect(peak).toBe(1)
    expect(manager.get(plugin.id)?.state).toBe('active')
  })

  it('disposes active plugins in reverse activation order', async () => {
    const order: string[] = []
    const manager = createManager()
    for (const id of ['a', 'b', 'c']) {
      manager.discover(definition({
        id,
        name: id,
        activate: (context) => context.onDispose(() => { order.push(id) }),
      }))
      await manager.activate(id)
    }

    await manager.dispose()

    expect(order).toEqual(['c', 'b', 'a'])
  })
})
