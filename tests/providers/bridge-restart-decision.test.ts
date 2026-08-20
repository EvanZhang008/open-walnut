/**
 * decideBridgeRestart — the pure configure-time restart decision shared by
 * the daemon twins (daemon-core.ts; mirrored inline in daemon-source.ts).
 *
 * Context: the cloud bridge wedged for 2 days because (a) a dial stuck in
 * CONNECTING was never torn down and (b) the Mac's periodic identical config
 * push hit `if (changed) startBridge(...)` and never healed anything. The
 * reconcile decision makes every push a healing opportunity while refusing to
 * restart when a redial timer or a young dial is already working on it.
 */
import { describe, it, expect } from 'vitest'
import { decideBridgeRestart, type BridgeConfigureState } from '../../src/providers/daemon-core.js'

const DIAL_TIMEOUT = 20_000

function state(overrides: Partial<BridgeConfigureState>): BridgeConfigureState {
  return {
    enabled: true,
    changed: false,
    adapterConnected: false,
    redialPending: false,
    dialAgeMs: null,
    dialTimeoutMs: DIAL_TIMEOUT,
    ...overrides,
  }
}

describe('decideBridgeRestart', () => {
  it('changed config always restarts with reason configure, regardless of anything else', () => {
    // Exhaust the other axes — changed wins every time.
    for (const enabled of [true, false]) {
      for (const adapterConnected of [true, false]) {
        for (const redialPending of [true, false]) {
          for (const dialAgeMs of [null, 0, DIAL_TIMEOUT - 1, DIAL_TIMEOUT + 1]) {
            expect(decideBridgeRestart(state({ changed: true, enabled, adapterConnected, redialPending, dialAgeMs })))
              .toEqual({ restart: true, reason: 'configure' })
          }
        }
      }
    }
  })

  it('unchanged + disabled never restarts', () => {
    for (const adapterConnected of [true, false]) {
      for (const redialPending of [true, false]) {
        for (const dialAgeMs of [null, 0, DIAL_TIMEOUT + 1]) {
          expect(decideBridgeRestart(state({ enabled: false, adapterConnected, redialPending, dialAgeMs })))
            .toEqual({ restart: false })
        }
      }
    }
  })

  it('unchanged + healthy adapter does not restart (identical push is a no-op)', () => {
    expect(decideBridgeRestart(state({ adapterConnected: true }))).toEqual({ restart: false })
  })

  it('unchanged + pending redial of unknown age does not restart (no restart storm)', () => {
    // An older daemon reports no remaining wait — keep the conservative answer.
    expect(decideBridgeRestart(state({ redialPending: true }))).toEqual({ restart: false })
    // Even alongside a stale dial timestamp.
    expect(decideBridgeRestart(state({ redialPending: true, dialAgeMs: DIAL_TIMEOUT * 2 })))
      .toEqual({ restart: false })
  })

  it('unchanged + redial about to fire does not restart (let it fire)', () => {
    for (const remaining of [0, 1, DIAL_TIMEOUT - 1, DIAL_TIMEOUT]) {
      expect(decideBridgeRestart(state({ redialPending: true, redialWaitRemainingMs: remaining })))
        .toEqual({ restart: false })
    }
  })

  it('unchanged + redial parked FAR out restarts — backoff earned offline is not paid after recovery', () => {
    // The 2026-08-20 gap: a 2.5-minute Wi-Fi loss drove the daemon's backoff to
    // its 60s ceiling, so when the network returned the bridge stayed down for
    // another ~108s and BOTH of the Mac's heal pushes no-op'd behind the pinned
    // timer. A heal push exists precisely to short-circuit that wait.
    expect(decideBridgeRestart(state({ redialPending: true, redialWaitRemainingMs: DIAL_TIMEOUT + 1 })))
      .toEqual({ restart: true, reason: 'reconcile' })
    expect(decideBridgeRestart(state({ redialPending: true, redialWaitRemainingMs: 60_000 })))
      .toEqual({ restart: true, reason: 'reconcile' })
  })

  it('a far-out redial still loses to a healthy adapter and to a young dial', () => {
    // Preemption must not outrank the two "something is already working" guards.
    expect(decideBridgeRestart(state({
      redialPending: true, redialWaitRemainingMs: 60_000, adapterConnected: true,
    }))).toEqual({ restart: false })
    expect(decideBridgeRestart(state({
      redialPending: true, redialWaitRemainingMs: 60_000, dialAgeMs: DIAL_TIMEOUT - 1,
    }))).toEqual({ restart: false })
  })

  it('unchanged + dial in flight younger than the timeout does not restart', () => {
    expect(decideBridgeRestart(state({ dialAgeMs: 0 }))).toEqual({ restart: false })
    expect(decideBridgeRestart(state({ dialAgeMs: DIAL_TIMEOUT - 1 }))).toEqual({ restart: false })
  })

  it('unchanged + wedged (no adapter, no timer, no dial) restarts with reason reconcile', () => {
    // THE fix: the observed 2-day wedge — bridge enabled, nothing in flight,
    // Mac re-pushing the identical config every reconnect. Must heal.
    expect(decideBridgeRestart(state({}))).toEqual({ restart: true, reason: 'reconcile' })
  })

  it('unchanged + dial older than the timeout restarts (belt-and-suspenders over the dial timer)', () => {
    expect(decideBridgeRestart(state({ dialAgeMs: DIAL_TIMEOUT }))).toEqual({ restart: true, reason: 'reconcile' })
    expect(decideBridgeRestart(state({ dialAgeMs: DIAL_TIMEOUT + 60_000 }))).toEqual({ restart: true, reason: 'reconcile' })
  })
})
