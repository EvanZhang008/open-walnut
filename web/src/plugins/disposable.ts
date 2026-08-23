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

export class DisposableStore implements Disposable {
  private readonly values: Disposable[] = []
  private disposed = false

  add<T extends Disposable>(value: T): T {
    if (this.disposed) {
      void value.dispose()
      return value
    }
    this.values.push(value)
    return value
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const errors: unknown[] = []
    for (const value of this.values.reverse()) {
      try {
        await value.dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    this.values.length = 0
    if (errors.length > 0) throw errors[0]
  }
}

export class WebPluginContext implements Disposable {
  private readonly controller = new AbortController()
  private readonly values = new DisposableStore()
  private disposePromise: Promise<void> | null = null

  get signal(): AbortSignal {
    return this.controller.signal
  }

  own<T extends Disposable>(value: T): T {
    return this.values.add(value)
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.controller.abort(new Error('Web Plugin disposed'))
    this.disposePromise = this.values.dispose()
    return this.disposePromise
  }
}
