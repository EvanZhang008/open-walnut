import type { Disposable } from './types'

export function disposable(dispose: () => void | Promise<void>): Disposable {
  let disposed = false
  return {
    async dispose() {
      if (disposed) return
      disposed = true
      await dispose()
    },
  }
}

/** `unsettled` means a disposer blew the budget and is STILL running, so the owner is not gone. */
export interface DisposeReport {
  errors: unknown[]
  unsettled: boolean
}

type EntryOutcome = { kind: 'done' } | { kind: 'failed'; error: unknown } | { kind: 'timeout' }

function asPromise(result: void | Promise<void>): Promise<void> | null {
  if (!result || typeof (result as Promise<void>).then !== 'function') return null
  return result as Promise<void>
}

export class DisposableStore implements Disposable {
  private readonly values: Disposable[] = []
  private readonly pending = new Set<Promise<void>>()
  private report: Promise<DisposeReport> | null = null
  private disposed = false

  get isDisposed(): boolean {
    return this.disposed
  }

  add<T extends Disposable>(value: T): T {
    if (this.disposed) {
      this.detach(value)
      return value
    }
    this.values.push(value)
    return value
  }

  /** Resolves when nothing this store owns is still disposing, values added after dispose included. */
  async quiet(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending])
  }

  async dispose(): Promise<void> {
    const report = await this.start()
    if (report.errors.length > 0) throw report.errors[0]
  }

  disposeWithin(timeoutMs: number): Promise<DisposeReport> {
    return this.start(timeoutMs)
  }

  private start(timeoutMs?: number): Promise<DisposeReport> {
    if (this.report) return this.report
    // Both lines land BEFORE the first disposer runs: a disposer that re-enters add() or dispose()
    // synchronously would otherwise reach a values list nothing reads again, or recurse.
    this.disposed = true
    const entries = this.values.splice(0).reverse()
    let settle: ((report: DisposeReport) => void) | undefined
    this.report = new Promise<DisposeReport>((resolve) => { settle = resolve })
    void this.disposeEntries(entries, timeoutMs).then((report) => settle!(report))
    return this.report
  }

  private detach(value: Disposable): void {
    try {
      const pending = asPromise(value.dispose())
      if (pending) this.track(pending)
    } catch {
      // Nothing owns this value any more, so best effort is all that is left.
    }
  }

  private track(promise: Promise<void>): Promise<void> {
    const done = promise.then(() => undefined, () => undefined)
    this.pending.add(done)
    void done.then(() => { this.pending.delete(done) })
    return done
  }

  /** The budget bounds how long we WAIT, not how much is cleaned up: every disposer still runs. */
  private async disposeEntries(entries: Disposable[], timeoutMs?: number): Promise<DisposeReport> {
    const errors: unknown[] = []
    let unsettled = false
    const deadline = timeoutMs === undefined ? undefined : Date.now() + Math.max(0, timeoutMs)
    for (const value of entries) {
      let pending: Promise<void> | null
      try {
        pending = asPromise(value.dispose())
      } catch (error) {
        errors.push(error)
        continue
      }
      if (!pending) continue
      this.track(pending)
      if (deadline === undefined) {
        try {
          await pending
        } catch (error) {
          errors.push(error)
        }
        continue
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        unsettled = true
        continue
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const outcome = await Promise.race<EntryOutcome>([
          pending.then((): EntryOutcome => ({ kind: 'done' }), (error): EntryOutcome => ({ kind: 'failed', error })),
          new Promise<EntryOutcome>((resolve) => {
            timer = setTimeout(() => resolve({ kind: 'timeout' }), remaining)
          }),
        ])
        if (outcome.kind === 'failed') errors.push(outcome.error)
        if (outcome.kind === 'timeout') unsettled = true
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    return { errors, unsettled: unsettled || this.pending.size > 0 }
  }
}

export class WebPluginContext implements Disposable {
  private readonly controller = new AbortController()
  private readonly values = new DisposableStore()

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get isDisposed(): boolean {
    return this.values.isDisposed
  }

  own<T extends Disposable>(value: T): T {
    return this.values.add(value)
  }

  /** Resolves when every resource this context ever owned has finished being disposed. */
  quiet(): Promise<void> {
    return this.values.quiet()
  }

  dispose(): Promise<void> {
    this.abort()
    return this.values.dispose()
  }

  disposeWithin(timeoutMs: number): Promise<DisposeReport> {
    this.abort()
    return this.values.disposeWithin(timeoutMs)
  }

  private abort(): void {
    if (this.controller.signal.aborted) return
    this.controller.abort(new Error('Web Plugin disposed'))
  }
}
