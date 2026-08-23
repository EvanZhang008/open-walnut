import type { SubsystemLogger } from '../../logging/subsystem.js'
import { DisposableStore, toDisposable, type Disposable, type DisposeFn } from './disposable.js'

export type PluginLogger = SubsystemLogger

export interface PluginContextOptions {
  id: string
  dataDir: string
  logger: PluginLogger
}

export class PluginContext implements Disposable {
  readonly id: string
  readonly dataDir: string
  readonly logger: PluginLogger
  readonly subscriptions = new DisposableStore()
  readonly signal: AbortSignal

  private readonly abortController = new AbortController()
  private disposePromise: Promise<void> | null = null

  constructor(options: PluginContextOptions) {
    if (!options.id.trim()) throw new Error('Plugin id must not be empty')
    this.id = options.id
    this.dataDir = options.dataDir
    this.logger = options.logger
    this.signal = this.abortController.signal
  }

  get isDisposed(): boolean {
    return this.signal.aborted
  }

  own<T extends Disposable>(value: T): T {
    return this.subscriptions.add(value)
  }

  onDispose(dispose: DisposeFn): Disposable {
    return this.own(toDisposable(dispose))
  }

  dispose(): Promise<void> {
    return this.startDispose()
  }

  disposeWithin(timeoutMs: number): Promise<void> {
    return this.startDispose(timeoutMs)
  }

  private startDispose(timeoutMs?: number): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.abortController.abort(new Error(`Plugin "${this.id}" was disposed`))
    this.disposePromise = timeoutMs === undefined
      ? this.subscriptions.dispose()
      : this.subscriptions.disposeWithin(timeoutMs)
    return this.disposePromise
  }
}
