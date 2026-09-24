export function createDaemonCommandDrain() {
  let closed = false
  let paused = false
  const pending = new Set<Promise<unknown>>()
  const admitted = new Set<Promise<unknown>>()
  const track = <T>(result: T, set: Set<Promise<unknown>>): T => {
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
      const settled = Promise.resolve(result)
      set.add(settled)
      void settled.then(() => set.delete(settled), () => set.delete(settled))
    }
    return result
  }
  const check = () => {
    if (closed || paused) throw new Error('Daemon is shutting down; retry after reconnecting')
  }
  const admit = <T>(work: () => T): T => {
    check()
    return track(work(), admitted)
  }
  return {
    get closed() { return closed || paused },
    get stopping() { return closed },
    pause() {
      check()
      if ([...admitted].some((work) => !pending.has(work))) throw new Error('Daemon has active operations; retry after they finish')
      paused = true
      return {
        drained: Promise.allSettled([...pending]).then(() => {}),
        resume: () => { paused = false },
      }
    },
    admit,
    run<T>(work: () => T): T {
      check()
      return track(work(), pending)
    },
    async close(): Promise<void> {
      closed = true
      await Promise.allSettled([...pending])
    },
  }
}
