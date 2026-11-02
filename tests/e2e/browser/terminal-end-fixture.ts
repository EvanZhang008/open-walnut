/**
 * Fixture-only: make "End terminal" meet a dtach master the server cannot prove
 * (terminal-end-unconfirmed.spec.ts). The spec arms it over the page's own
 * WebSocket with `test:terminal-end-unconfirmed { sessionId, times, delayMs }`:
 * each of the next `times` stops of that session answers 'left' (an unanswered
 * probe) and signals nothing, every other stop is the real one, and every stop
 * of it first waits `delayMs` (a slow host) until it is armed again
 * (src/web/terminal/terminal-end.ts seam). Runs in the fixture server's process
 * only; production never installs it.
 */
import { registerMethod } from '../../../src/web/ws/handler.js'
import { __setTerminalStopForTesting } from '../../../src/web/terminal/terminal-end.js'
import { stopDtachSession } from '../../../src/web/terminal/dtach-lifecycle.js'

/** The technical reason an unanswered probe gives (dtach-master.ts); the user reads it in plain words. */
export const FIXTURE_UNCONFIRMED_REASON = 'the probe did not finish'
const MAX_DELAY_MS = 20_000

export function installTerminalEndFixture(): void {
  const armed = new Map<string, number>()
  const delays = new Map<string, number>()
  __setTerminalStopForTesting(async (record) => {
    const delay = delays.get(record.claudeSessionId) ?? 0
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    const left = armed.get(record.claudeSessionId) ?? 0
    if (left > 0) {
      armed.set(record.claudeSessionId, left - 1)
      return { outcome: 'left', reason: FIXTURE_UNCONFIRMED_REASON }
    }
    return stopDtachSession(record)
  })
  registerMethod('test:terminal-end-unconfirmed', async (payload: unknown) => {
    const o = (payload ?? {}) as { sessionId?: unknown; times?: unknown; delayMs?: unknown }
    if (typeof o.sessionId !== 'string' || !o.sessionId.startsWith('pw-term-end-')) throw new Error('fixture sessions only')
    const times = typeof o.times === 'number' && o.times >= 0 ? Math.floor(o.times) : 1
    const delayMs = typeof o.delayMs === 'number' && o.delayMs > 0 ? Math.min(Math.floor(o.delayMs), MAX_DELAY_MS) : 0
    armed.set(o.sessionId, times)
    delays.set(o.sessionId, delayMs)
    return { armed: times, delayMs }
  })
}
