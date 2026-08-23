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

async function disposeEntries(entries: Disposable[], timeoutMs?: number): Promise<void> {
  const errors: unknown[] = []
  const deadline = timeoutMs === undefined ? undefined : Date.now() + Math.max(0, timeoutMs)
  for (let i = entries.length - 1; i >= 0; i--) {
    try {
      const result = entries[i].dispose()
      if (!result || typeof result.then !== 'function') continue
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
  private disposePromise: Promise<void> | null = null
  private disposed = false

  get isDisposed(): boolean {
    return this.disposed
  }

  get size(): number {
    return this.entries.length
  }

  add<T extends Disposable>(value: T): T {
    if (this.disposed) {
      try {
        const result = value.dispose()
        if (result && typeof (result as Promise<void>).catch === 'function') {
          void (result as Promise<void>).catch(() => undefined)
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
    await disposeEntries(current)
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
    this.disposePromise = disposeEntries(current, timeoutMs)
    return this.disposePromise
  }
}
