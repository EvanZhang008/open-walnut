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

  it('forgets a Plugin even when cleanup reports an error', async () => {
    const manager = createManager()
    const plugin = definition({
      deactivate: () => { throw new Error('cleanup failed') },
    })
    manager.discover(plugin)
    await manager.activate(plugin.id)

    await expect(manager.forget(plugin.id)).rejects.toThrow('cleanup failed')
    expect(manager.get(plugin.id)).toBeUndefined()
    expect(() => manager.discover(plugin)).not.toThrow()
  })

  it('bounds teardown, disposes owned resources, and releases queued mutations', async () => {
    const cleanup = vi.fn()
    const manager = createManager({ deactivationTimeoutMs: 10 })
    const plugin = definition({
      activate(context) {
        context.onDispose(cleanup)
      },
      deactivate: () => new Promise<void>(() => undefined),
    })
    manager.discover(plugin)
    await manager.activate(plugin.id)

    const disableResult = manager.disable(plugin.id).catch((error: unknown) => error)
    const queuedActivation = manager.activate(plugin.id)
    const error = await disableResult

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('cleanup timed out during deactivate after 10ms') }),
    ])
    expect(cleanup).toHaveBeenCalledOnce()
    await expect(queuedActivation).resolves.toMatchObject({ state: 'active' })
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
