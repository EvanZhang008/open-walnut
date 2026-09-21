export interface Disposable {
  dispose(): void | Promise<void>
}

export type DisposeFn = () => void | Promise<void>

export function toDisposable(dispose: DisposeFn): Disposable {
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      return dispose()
    },
  }
}

/** Somewhere to park a cleanup promise that has not settled yet. */
type TrackCleanup = (cleanup: Promise<unknown>) => void

async function disposeEntries(
  entries: Disposable[],
  timeoutMs?: number,
  track?: TrackCleanup,
): Promise<void> {
  const errors: unknown[] = []
  const deadline = timeoutMs === undefined ? undefined : Date.now() + Math.max(0, timeoutMs)
  for (let i = entries.length - 1; i >= 0; i--) {
    try {
      const result = entries[i].dispose()
      if (!result || typeof result.then !== 'function') continue
      // Counted before the wait: the deadline below stops waiting, it cancels nothing.
      track?.(result)
      if (deadline === undefined) {
        await result
        continue
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        void result.catch(() => undefined)
        throw new Error('Plugin cleanup deadline exceeded')
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          result,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Plugin cleanup deadline exceeded')), remaining)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to dispose ${errors.length} resource${errors.length === 1 ? '' : 's'}`)
  }
}

export class DisposableStore implements Disposable {
  private readonly entries: Disposable[] = []
  private readonly pendingCleanups = new Set<Promise<unknown>>()
  private disposePromise: Promise<void> | null = null
  private disposed = false

  get isDisposed(): boolean {
    return this.disposed
  }

  /** A cleanup promise is still unsettled: `disposeWithin` stopped WAITING, the work and what it holds go on. Read-only — only the promise settling clears it. */
  get isCleanupPending(): boolean {
    return this.pendingCleanups.size > 0
  }

  get size(): number {
    return this.entries.length
  }

  async quiet(): Promise<void> {
    while (this.pendingCleanups.size > 0) {
      await Promise.allSettled([...this.pendingCleanups])
    }
  }

  add<T extends Disposable>(value: T): T {
    if (this.disposed) {
      try {
        const result = value.dispose()
        if (result && typeof (result as Promise<void>).then === 'function') {
          // A late disposable is a dead generation's other half; its cleanup counts the same.
          this.track(result as Promise<void>)
        }
      } catch {
        // The store is already gone. The resource is still disposed best-effort.
      }
      return value
    }
    this.entries.push(value)
    return value
  }

  delete(value: Disposable): boolean {
    const index = this.entries.indexOf(value)
    if (index < 0) return false
    this.entries.splice(index, 1)
    return true
  }

  async clear(): Promise<void> {
    const current = this.entries.splice(0)
    await disposeEntries(current, undefined, this.track)
  }

  dispose(): Promise<void> {
    return this.startDispose()
  }

  disposeWithin(timeoutMs: number): Promise<void> {
    return this.startDispose(timeoutMs)
  }

  private startDispose(timeoutMs?: number): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    const current = this.entries.splice(0)
    this.disposePromise = disposeEntries(current, timeoutMs, this.track)
    return this.disposePromise
  }

  /** Arrow field because `disposeEntries` takes it as a callback; also the one place an abandoned cleanup's rejection gets handled instead of going unhandled. */
  private readonly track = (cleanup: Promise<unknown>): void => {
    if (this.pendingCleanups.has(cleanup)) return
    this.pendingCleanups.add(cleanup)
    const forget = () => { this.pendingCleanups.delete(cleanup) }
    // Both arms: a cleanup that threw is finished too, just badly.
    void cleanup.then(forget, forget)
  }
}
