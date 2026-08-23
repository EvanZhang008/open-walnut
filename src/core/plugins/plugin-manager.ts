import { PluginContext, type PluginContextOptions } from './plugin-context.js'
import type { Disposable } from './disposable.js'

export type PluginLifecycleState =
  | 'discovered'
  | 'disabled'
  | 'needs-config'
  | 'unsupported'
  | 'activating'
  | 'active'
  | 'failed'
  | 'disposing'
  | 'quarantined'

export interface PluginDefinition {
  id: string
  name: string
  builtin?: boolean
  enabled?: boolean
  missingConfig?: string[]
  unsupportedReason?: string
  quarantined?: boolean
  failureCount?: number
  activate(context: PluginContext): void | Disposable | Promise<void | Disposable>
  deactivate?(): void | Promise<void>
}

export interface PluginLifecycleRecord {
  id: string
  name: string
  state: PluginLifecycleState
  builtin: boolean
  failureCount: number
  missingConfig?: string[]
  reason?: string
  error?: string
}

interface ManagedPlugin {
  definition: PluginDefinition
  state: PluginLifecycleState
  context: PluginContext | null
  failureCount: number
  deactivateInvoked: boolean
  reason?: string
  error?: string
}

class PluginActivationCancelledError extends Error {
  constructor(pluginId: string) {
    super(`Plugin "${pluginId}" activation cancelled because PluginManager is disposed`)
    this.name = 'PluginActivationCancelledError'
  }
}

export interface PluginManagerOptions {
  createContext(definition: PluginDefinition): PluginContext
  safeMode?: boolean
  quarantineAfter?: number
  activationTimeoutMs?: number
  deactivationTimeoutMs?: number
  onStateChange?(record: PluginLifecycleRecord): void
  onActivationStart?(pluginId: string): void | Promise<void>
  onActivationEnd?(pluginId: string, outcome: 'active' | 'failed' | 'cancelled'): void | Promise<void>
}

export class PluginManager implements Disposable {
  private readonly plugins = new Map<string, ManagedPlugin>()
  private readonly operationTails = new Map<string, Promise<unknown>>()
  private readonly activationOrder: string[] = []
  private readonly safeMode: boolean
  private readonly quarantineAfter: number
  private readonly activationTimeoutMs: number
  private readonly deactivationTimeoutMs: number
  private disposed = false
  private disposePromise: Promise<void> | null = null

  constructor(private readonly options: PluginManagerOptions) {
    this.safeMode = options.safeMode ?? false
    this.quarantineAfter = Math.max(1, options.quarantineAfter ?? 2)
    this.activationTimeoutMs = Math.max(0, options.activationTimeoutMs ?? 0)
    this.deactivationTimeoutMs = Math.max(0, options.deactivationTimeoutMs ?? 5_000)
  }

  static withContextFactory(
    createOptions: (definition: PluginDefinition) => PluginContextOptions,
    options: Omit<PluginManagerOptions, 'createContext'> = {},
  ): PluginManager {
    return new PluginManager({
      ...options,
      createContext: (definition) => new PluginContext(createOptions(definition)),
    })
  }

  discover(definition: PluginDefinition): PluginLifecycleRecord {
    this.assertUsable()
    if (!definition.id.trim()) throw new Error('Plugin id must not be empty')
    if (this.plugins.has(definition.id)) {
      throw new Error(`Plugin "${definition.id}" is already discovered`)
    }

    let state: PluginLifecycleState = 'discovered'
    let reason: string | undefined
    if (definition.unsupportedReason) {
      state = 'unsupported'
      reason = definition.unsupportedReason
    } else if ((definition.missingConfig?.length ?? 0) > 0) {
      state = 'needs-config'
      reason = `Missing configuration: ${definition.missingConfig!.join(', ')}`
    } else if (definition.quarantined) {
      state = 'quarantined'
      reason = 'Quarantined after repeated activation failures'
    } else if (definition.enabled === false || (this.safeMode && !definition.builtin)) {
      state = 'disabled'
      if (this.safeMode && !definition.builtin) reason = 'Disabled by Safe Mode'
    }

    const plugin: ManagedPlugin = {
      definition,
      state,
      context: null,
      failureCount: definition.failureCount ?? 0,
      deactivateInvoked: false,
      reason,
    }
    this.plugins.set(definition.id, plugin)
    this.notify(plugin)
    return this.toRecord(plugin)
  }

  get(id: string): PluginLifecycleRecord | undefined {
    const plugin = this.plugins.get(id)
    return plugin ? this.toRecord(plugin) : undefined
  }

  list(): PluginLifecycleRecord[] {
    return Array.from(this.plugins.values(), (plugin) => this.toRecord(plugin))
  }

  activate(id: string): Promise<PluginLifecycleRecord> {
    return this.runExclusive(id, () => this.activateManaged(this.require(id)))
  }

  disable(id: string): Promise<PluginLifecycleRecord> {
    return this.runExclusive(id, () => this.disableManaged(this.require(id)))
  }

  reload(id: string): Promise<PluginLifecycleRecord> {
    return this.runExclusive(id, async () => {
      const plugin = this.require(id)
      await this.disableManaged(plugin)
      return this.activateManaged(plugin)
    })
  }

  forget(id: string): Promise<void> {
    return this.runExclusive(id, async () => {
      this.assertUsable()
      const plugin = this.require(id)
      try {
        await this.disableManaged(plugin)
      } finally {
        this.plugins.delete(id)
        this.forgetActivation(id)
      }
    })
  }

  clearQuarantine(id: string): PluginLifecycleRecord {
    const plugin = this.require(id)
    if (plugin.state !== 'quarantined') return this.toRecord(plugin)
    plugin.failureCount = 0
    plugin.error = undefined
    plugin.reason = undefined
    this.setState(plugin, 'disabled')
    return this.toRecord(plugin)
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.disposePromise = this.disposeManaged()
    return this.disposePromise
  }

  private async disposeManaged(): Promise<void> {
    const errors: unknown[] = []
    const ids = [...this.activationOrder].reverse()
    const seen = new Set(ids)
    for (const id of [...this.plugins.keys()].reverse()) {
      if (!seen.has(id)) ids.push(id)
    }
    for (const id of ids) {
      const plugin = this.plugins.get(id)
      if (!plugin) continue
      try {
        await this.disableForShutdown(plugin)
      } catch (error) {
        const shutdownErrors = [error]
        const liveState = plugin.state === 'activating'
          || plugin.state === 'active'
          || plugin.state === 'disposing'
        const context = plugin.context
        if (liveState && context !== null && !plugin.deactivateInvoked) {
          // The lifecycle queue is wedged; invoke deactivate once without extending shutdown.
          try {
            const deactivation = this.invokeDeactivate(plugin)
            if (deactivation && typeof deactivation.catch === 'function') {
              void deactivation.catch((deactivationError) => {
                const message = `deactivate failed after shutdown timeout: ${deactivationError instanceof Error ? deactivationError.message : String(deactivationError)}`
                plugin.error = plugin.error ? `${plugin.error}; ${message}` : message
                this.notify(plugin)
              })
            }
          } catch (deactivationError) {
            shutdownErrors.push(deactivationError)
          }
        }
        if (liveState && context !== null && !context.isDisposed) {
          void context.disposeWithin(0).catch(() => undefined)
        }
        if (liveState) {
          plugin.context = null
          this.forgetActivation(plugin.definition.id)
          plugin.error = shutdownErrors.map((item) => item instanceof Error ? item.message : String(item)).join('; ')
          plugin.reason = 'Plugin manager disposal did not settle'
          this.setState(plugin, 'disabled')
        }
        errors.push(...shutdownErrors)
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to dispose ${errors.length} plugin${errors.length === 1 ? '' : 's'}`)
    }
  }

  private async disableForShutdown(plugin: ManagedPlugin): Promise<void> {
    const contextCleanup = plugin.state === 'activating' && plugin.context && !plugin.context.isDisposed
      ? (this.deactivationTimeoutMs === 0
          ? plugin.context.dispose()
          : plugin.context.disposeWithin(this.deactivationTimeoutMs))
      : Promise.resolve()
    const lifecycle = this.runExclusive(plugin.definition.id, () => this.disableManaged(plugin))
    const completion = Promise.allSettled([lifecycle, contextCleanup]).then((results) => {
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
      if (errors.length > 0) {
        throw new AggregateError(errors, `Plugin "${plugin.definition.id}" shutdown cleanup failed`)
      }
    })
    if (this.deactivationTimeoutMs === 0) return completion

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            `Plugin "${plugin.definition.id}" shutdown timed out waiting for lifecycle cleanup after ${this.deactivationTimeoutMs}ms`,
          )), this.deactivationTimeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async activateManaged(plugin: ManagedPlugin): Promise<PluginLifecycleRecord> {
    this.assertUsable()
    if (plugin.state === 'active') return this.toRecord(plugin)
    if (this.safeMode && !plugin.definition.builtin) {
      throw new Error(`Plugin "${plugin.definition.id}" cannot activate while Safe Mode is enabled`)
    }
    if (plugin.definition.unsupportedReason || plugin.state === 'unsupported') {
      throw new Error(`Plugin "${plugin.definition.id}" cannot activate while unsupported`)
    }
    if ((plugin.definition.missingConfig?.length ?? 0) > 0 || plugin.state === 'needs-config') {
      throw new Error(`Plugin "${plugin.definition.id}" cannot activate while needs-config`)
    }
    if (plugin.state === 'quarantined') {
      throw new Error(`Plugin "${plugin.definition.id}" cannot activate while quarantined`)
    }

    plugin.error = undefined
    plugin.reason = undefined
    plugin.deactivateInvoked = false
    this.setState(plugin, 'activating')
    let context: PluginContext | null = null
    let activationStarted = false

    try {
      await this.options.onActivationStart?.(plugin.definition.id)
      if (this.disposed) throw new PluginActivationCancelledError(plugin.definition.id)
      context = this.options.createContext(plugin.definition)
      plugin.context = context
      activationStarted = true
      const activation = await this.activateWithDeadline(plugin, context)
      if (activation) context.own(activation)
      if (this.disposed) throw new PluginActivationCancelledError(plugin.definition.id)
      plugin.failureCount = 0
      this.rememberActivation(plugin.definition.id)
      this.setState(plugin, 'active')
      await this.options.onActivationEnd?.(plugin.definition.id, 'active')
      if (this.disposed) throw new PluginActivationCancelledError(plugin.definition.id)
      return this.toRecord(plugin)
    } catch (error) {
      const cancelled = this.disposed || error instanceof PluginActivationCancelledError
      if (!cancelled) plugin.error = error instanceof Error ? error.message : String(error)
      if (!cancelled) plugin.failureCount++
      const cleanupErrors = await this.teardownManaged(plugin, context, activationStarted)
      if (cleanupErrors.length > 0) {
        const cleanupMessage = `cleanup failed: ${cleanupErrors.map((cleanupError) => cleanupError instanceof Error ? cleanupError.message : String(cleanupError)).join('; ')}`
        plugin.error = plugin.error ? `${plugin.error}; ${cleanupMessage}` : cleanupMessage
      }
      plugin.context = null
      this.forgetActivation(plugin.definition.id)
      if (cancelled) {
        plugin.reason ??= 'Plugin manager disposed during activation'
        this.setState(plugin, 'disabled')
      } else {
        const quarantined = plugin.failureCount >= this.quarantineAfter
        plugin.reason = quarantined ? `Activation failed ${plugin.failureCount} times` : 'Activation failed'
        this.setState(plugin, quarantined ? 'quarantined' : 'failed')
      }
      try {
        await this.options.onActivationEnd?.(plugin.definition.id, cancelled ? 'cancelled' : 'failed')
      } catch (endError) {
        const endMessage = `activation end failed: ${endError instanceof Error ? endError.message : String(endError)}`
        plugin.error = plugin.error ? `${plugin.error}; ${endMessage}` : endMessage
        this.notify(plugin)
      }
      throw error
    }
  }

  private async activateWithDeadline(
    plugin: ManagedPlugin,
    context: PluginContext,
  ): Promise<void | Disposable> {
    let abandoned = false
    let settledActivation: void | Disposable
    let settledActivationDisposed = false
    const disposeAbandonedActivation = () => {
      if (!abandoned || !settledActivation || settledActivationDisposed) return
      settledActivationDisposed = true
      try {
        const result = settledActivation.dispose()
        if (result && typeof result.catch === 'function') void result.catch(() => undefined)
      } catch {
        // A timed-out activation can only be cleaned up best-effort.
      }
    }
    const pending = Promise.resolve(plugin.definition.activate(context))
    void pending.then((activation) => {
      settledActivation = activation
      disposeAbandonedActivation()
    }).catch(() => undefined)

    if (this.activationTimeoutMs === 0) return pending

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            `Plugin "${plugin.definition.id}" activation timed out after ${this.activationTimeoutMs}ms`,
          )), this.activationTimeoutMs)
        }),
      ])
    } catch (error) {
      abandoned = true
      disposeAbandonedActivation()
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private invokeDeactivate(plugin: ManagedPlugin): void | Promise<void> {
    if (plugin.deactivateInvoked) return
    plugin.deactivateInvoked = true
    return plugin.definition.deactivate?.()
  }

  private async teardownManaged(
    plugin: ManagedPlugin,
    context: PluginContext | null,
    callDeactivate = true,
  ): Promise<unknown[]> {
    const errors: unknown[] = []
    const deadline = this.deactivationTimeoutMs === 0
      ? undefined
      : Date.now() + this.deactivationTimeoutMs

    const timeoutReported = callDeactivate
      ? await this.runTeardownStep(
          plugin.definition.id,
          'deactivate',
          deadline,
          () => this.invokeDeactivate(plugin),
          errors,
        )
      : false
    await this.runTeardownStep(
      plugin.definition.id,
      'owned resources',
      deadline,
      (remainingMs) => {
        if (!context) return
        return remainingMs === undefined
          ? context.dispose()
          : context.disposeWithin(remainingMs)
      },
      errors,
      timeoutReported,
      !!context && !context.isDisposed,
    )
    return errors
  }

  private async runTeardownStep(
    pluginId: string,
    phase: string,
    deadline: number | undefined,
    cleanup: (remainingMs?: number) => void | Promise<void>,
    errors: unknown[],
    timeoutReported = false,
    selfBounded = false,
  ): Promise<boolean> {
    const timeoutError = () => new Error(
      `Plugin "${pluginId}" cleanup timed out during ${phase} after ${this.deactivationTimeoutMs}ms`,
    )
    let timedOut = false
    let timeoutAdded = false
    const recordTimeout = () => {
      timedOut = true
      if (timeoutReported || timeoutAdded) return
      errors.push(timeoutError())
      timeoutAdded = true
    }
    const appendError = (error: unknown) => {
      const nested = error instanceof AggregateError ? error.errors : [error]
      for (const item of nested) {
        if (
          deadline !== undefined
          && item instanceof Error
          && item.message === 'Plugin cleanup deadline exceeded'
        ) {
          recordTimeout()
        } else {
          errors.push(item)
        }
      }
    }

    const availableMs = deadline === undefined ? undefined : Math.max(0, deadline - Date.now())
    let pending: Promise<void>
    try {
      pending = Promise.resolve(cleanup(availableMs))
    } catch (error) {
      appendError(error)
      return timeoutReported || timedOut
    }

    if (deadline === undefined) {
      try {
        await pending
      } catch (error) {
        appendError(error)
      }
      return timedOut
    }

    if (selfBounded) {
      try {
        await pending
      } catch (error) {
        appendError(error)
      }
      if (Date.now() > deadline) recordTimeout()
      return timeoutReported || timedOut
    }

    const remainingMs = Math.max(0, deadline - Date.now())
    if (remainingMs === 0) {
      void pending.catch(() => undefined)
      recordTimeout()
      return true
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            reject(timeoutError())
          }, remainingMs)
        }),
      ])
    } catch (error) {
      appendError(error)
    } finally {
      if (timer) clearTimeout(timer)
    }
    return timeoutReported || timedOut
  }

  private async disableManaged(plugin: ManagedPlugin): Promise<PluginLifecycleRecord> {
    if (plugin.state === 'unsupported' || plugin.state === 'needs-config' || plugin.state === 'quarantined') {
      return this.toRecord(plugin)
    }
    if (plugin.state !== 'active' && plugin.state !== 'activating') {
      if (plugin.state !== 'disabled') this.setState(plugin, 'disabled')
      return this.toRecord(plugin)
    }

    this.setState(plugin, 'disposing')
    const errors = await this.teardownManaged(plugin, plugin.context)
    plugin.context = null
    this.forgetActivation(plugin.definition.id)
    plugin.reason = undefined
    plugin.error = errors.length > 0
      ? errors.map((error) => error instanceof Error ? error.message : String(error)).join('; ')
      : undefined
    this.setState(plugin, 'disabled')
    if (errors.length > 0) {
      throw new AggregateError(errors, `Plugin "${plugin.definition.id}" cleanup failed`)
    }
    return this.toRecord(plugin)
  }

  private runExclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(id) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.operationTails.set(id, current)
    void current.finally(() => {
      if (this.operationTails.get(id) === current) this.operationTails.delete(id)
    }).catch(() => undefined)
    return current
  }

  private setState(plugin: ManagedPlugin, state: PluginLifecycleState): void {
    plugin.state = state
    this.notify(plugin)
  }

  private notify(plugin: ManagedPlugin): void {
    try {
      this.options.onStateChange?.(this.toRecord(plugin))
    } catch {
      // Observability must not change lifecycle outcomes.
    }
  }

  private rememberActivation(id: string): void {
    this.forgetActivation(id)
    this.activationOrder.push(id)
  }

  private forgetActivation(id: string): void {
    const index = this.activationOrder.indexOf(id)
    if (index >= 0) this.activationOrder.splice(index, 1)
  }

  private require(id: string): ManagedPlugin {
    const plugin = this.plugins.get(id)
    if (!plugin) throw new Error(`Plugin "${id}" is not discovered`)
    return plugin
  }

  private toRecord(plugin: ManagedPlugin): PluginLifecycleRecord {
    return {
      id: plugin.definition.id,
      name: plugin.definition.name,
      state: plugin.state,
      builtin: plugin.definition.builtin ?? false,
      failureCount: plugin.failureCount,
      ...(plugin.definition.missingConfig?.length ? { missingConfig: [...plugin.definition.missingConfig] } : {}),
      ...(plugin.reason ? { reason: plugin.reason } : {}),
      ...(plugin.error ? { error: plugin.error } : {}),
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('PluginManager is disposed')
  }
}
