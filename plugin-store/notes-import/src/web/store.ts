/**
 * The browser's copy of the importer's state: the `status` op once, then the server's `state`
 * event. Every op answer that carries a state is taken too, the later snapshot winning.
 */
import type { WalnutWebApi } from '@open-walnut/plugin-api/web'
import type { PublicState } from '../server/runtime'

export type { PublicState }
export type OpOutcome<T = unknown> = { ok: true; result: T } | { ok: false; message: string }

export interface ImportStore {
  get(): PublicState | null
  loadError(): string | null
  subscribe(listener: () => void): () => void
  call<T = unknown>(localOp: string, args?: Record<string, unknown>): Promise<OpOutcome<T>>
  refresh(): Promise<void>
}

export function createImportStore(walnut: WalnutWebApi): ImportStore {
  let state: PublicState | null = null
  let error: string | null = null
  const listeners = new Set<() => void>()
  const prefix = `${walnut.pluginId.replace(/[^a-z0-9_]/g, '_')}_`
  const publish = () => { for (const listener of [...listeners]) listener() }
  const accept = (next: unknown) => {
    if (!next || typeof next !== 'object' || (next as { version?: unknown }).version !== 1) return
    const value = next as PublicState
    if (state && value.now < state.now) return
    state = value
    error = null
    publish()
  }
  walnut.events.on(`plugin:${walnut.pluginId}:state`, (event) => accept(event.data))

  const store: ImportStore = {
    get: () => state,
    loadError: () => error,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async call<T>(localOp: string, args: Record<string, unknown> = {}): Promise<OpOutcome<T>> {
      try {
        const outcome = await walnut.ops.call<T>(`${prefix}${localOp}`, args)
        if (outcome.ok) accept(outcome.result)
        return outcome
      } catch (failure) {
        return { ok: false, message: failure instanceof Error ? failure.message : String(failure) }
      }
    },
    async refresh() {
      const outcome = await store.call<PublicState>('status')
      if (!outcome.ok) { error = outcome.message; publish() }
    },
  }
  return store
}
