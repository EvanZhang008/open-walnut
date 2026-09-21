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
  private readonly pendingActivations = new Set<Promise<unknown>>()
  private readonly pendingCleanups = new Set<Promise<unknown>>()
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

  /** A cleanup promise has not settled yet: one of this context's disposables, or a teardown the host tracked here. */
  get isCleanupPending(): boolean {
    return this.subscriptions.isCleanupPending || this.pendingCleanups.size > 0
  }

  /** A tracked activation promise has not settled yet. */
  get isActivationPending(): boolean {
    return this.pendingActivations.size > 0
  }

  /** Setup or cleanup still running, so a second instance of this id would run alongside it and the loser's teardown would withdraw the winner's rows. Disposal never clears it. */
  get hasPendingWork(): boolean {
    return this.isActivationPending || this.isCleanupPending
  }

  /** Count the real activate promise as this context's work; returns it unchanged for chaining, cancels nothing, and is safe (and useful) after disposal. */
  trackActivation<T>(activation: Promise<T>): Promise<T> {
    this.track(this.pendingActivations, activation)
    return activation
  }

  /** Count a teardown promise no disposable holds — the plugin definition's own `deactivate()`, which still owns the module's state while it runs. */
  trackCleanup(cleanup: Promise<unknown>): void {
    this.track(this.pendingCleanups, cleanup)
  }

  /** One bucket, one promise: also the only place an abandoned promise's rejection gets handled instead of going unhandled. */
  private track(bucket: Set<Promise<unknown>>, promise: Promise<unknown>): void {
    if (bucket.has(promise)) return
    bucket.add(promise)
    const forget = () => { bucket.delete(promise) }
    void promise.then(forget, forget)
  }

  async quiet(): Promise<void> {
    while (this.hasPendingWork) {
      await Promise.allSettled([...this.pendingActivations, ...this.pendingCleanups])
      await this.subscriptions.quiet()
    }
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
