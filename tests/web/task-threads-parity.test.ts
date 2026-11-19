/**
 * The web's Threads switch reads the same rule as the server's keepsThreads
 * (src/core/org/keeps-threads.ts), flag on and off: a task the server files threads for shows them,
 * and one the user turned off shows none (2026-11-19, the experiment task_threads).
 */
import { describe, it, expect, vi } from 'vitest'
vi.mock('@/api/client', () => ({ apiPatch: vi.fn() }))
import { keepsThreads } from '../../src/core/org/keeps-threads.js'
import { threadsKeptBy, threadsOffered } from '../../web/src/components/sessions/session-threads-model.js'

const ROLES = [undefined, 'router', 'worker'] as const
const ONS = [undefined, true, false] as const

describe('the web and the server agree on who keeps Threads', () => {
  it('for every role, switch and experiment value', () => {
    for (const org_role of ROLES) for (const threads_on of ONS) for (const every of [false, true]) {
      const task = { org_role, threads_on } as never
      expect(threadsKeptBy(task, every), JSON.stringify({ org_role, threads_on, every })).toBe(keepsThreads(task, every))
    }
  })

  it('under the experiment every task offers the switch, so the user can turn one off', () => {
    expect(threadsOffered({ threads_on: undefined } as never, false, true)).toBe(true)
    expect(threadsOffered({ threads_on: undefined } as never, false, false)).toBe(false)
  })
})
