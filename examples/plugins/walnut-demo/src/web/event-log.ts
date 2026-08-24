export interface DemoEventEntry {
  name: string
  at: string
  data: unknown
}

const LIMIT = 8

export class DemoEventLog {
  private entries: DemoEventEntry[] = []
  private readonly listeners = new Set<() => void>()

  push = (entry: DemoEventEntry): void => {
    // Replace the array, never mutate it: `useSyncExternalStore` compares snapshots by identity.
    this.entries = [entry, ...this.entries].slice(0, LIMIT)
    for (const listener of this.listeners) listener()
  }

  snapshot = (): DemoEventEntry[] => this.entries

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}
