/**
 * The browser's one copy of Rhythm's state: filled by the `status` op on start and
 * kept live by the server's `state` event. The badge and the App both read it, so
 * the badge is right even when the App was never opened.
 *
 * The browser clock can disagree with the server's, and a countdown drawn from
 * `endsAt` would then be off by that much. The store keeps the skew seen at the last
 * update and `serverNow()` corrects for it.
 */
import type { WalnutWebApi } from '@open-walnut/plugin-api/web'
import type { RhythmPublicState } from '../server/public-state'

export type { RhythmPublicState }

export type OpOutcome<T = unknown> = { ok: true; result: T } | { ok: false; message: string }

export interface RhythmStore {
  get(): RhythmPublicState | null
  loadError(): string | null
  subscribe(listener: () => void): () => void
  serverNow(): number
  refresh(options?: { refreshShortcuts?: boolean }): Promise<void>
  call<T = unknown>(localOp: string, args?: Record<string, unknown>): Promise<OpOutcome<T>>
  opName(localOp: string): string
}

export function createRhythmStore(walnut: WalnutWebApi): RhythmStore {
  let state: RhythmPublicState | null = null
  let error: string | null = null
  let skewMs = 0
  const listeners = new Set<() => void>()
  const prefix = `${walnut.pluginId.replace(/[^a-z0-9_]/g, '_')}_`

  const publish = () => { for (const listener of [...listeners]) listener() }
  const accept = (next: unknown) => {
    if (!next || typeof next !== 'object' || (next as { version?: unknown }).version !== 1) return
    const value = next as RhythmPublicState
    // An op's answer and the live `state` event race; the snapshot the server took later
    // wins. (An Install answer computed before the watch saw the Add would otherwise put
    // "Missing" back after the event said both are installed.)
    if (state && typeof value.now === 'number' && value.now < state.now) return
    if (typeof value.now === 'number') skewMs = value.now - Date.now()
    state = value
    error = null
    publish()
  }

  walnut.events.on(`plugin:${walnut.pluginId}:state`, (event) => { accept(event.data) })

  const store: RhythmStore = {
    get: () => state,
    loadError: () => error,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    serverNow: () => Date.now() + skewMs,
    opName: (localOp) => `${prefix}${localOp}`,
    async call<T>(localOp: string, args: Record<string, unknown> = {}): Promise<OpOutcome<T>> {
      try {
        const outcome = await walnut.ops.call<T>(store.opName(localOp), args)
        if (outcome.ok) {
          const result = outcome.result as { state?: unknown } | undefined
          if (result && typeof result === 'object' && 'state' in result) accept(result.state)
        }
        return outcome
      } catch (failure) {
        return { ok: false, message: failure instanceof Error ? failure.message : String(failure) }
      }
    },
    async refresh(options = {}) {
      const outcome = await store.call<RhythmPublicState>('status', options.refreshShortcuts ? { refresh: true } : {})
      if (outcome.ok) accept(outcome.result)
      else { error = outcome.message; publish() }
    },
  }
  return store
}
