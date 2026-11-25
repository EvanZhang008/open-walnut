/**
 * A start a host refused as host_runs_sessions_off while this leader's switch says on for it
 * (src/core/session-channel/switch-catch-up.ts): the host's copy of the config lags the write that
 * turned it on. The config copy goes now, the leader waits for the host's answer (and its link),
 * and asks once more; never a third time, never past the budget, never for another refusal.
 */
import { describe, expect, it } from 'vitest'
import { HOST_SESSIONS_OFF } from '../../../src/core/session-channel/host-api.js'
import type { HostCallAnswer } from '../../../src/core/session-channel/leader-links.js'
import { startOnHostCatchingUp, type SwitchCatchUpSide } from '../../../src/core/session-channel/switch-catch-up.js'

const OFF: HostCallAnswer = { ok: false, error: HOST_SESSIONS_OFF }
const OK: HostCallAnswer = { ok: true, sessionId: 's-1' }

function sideOf(answers: HostCallAnswer[], o: { on?: boolean; linked?: boolean } = {}) {
  const asked: string[] = []
  const waited: number[] = []
  const side: SwitchCatchUpSide = {
    startOnHost: async (host) => { asked.push(host); return answers.shift() ?? OFF },
    switchOn: () => o.on !== false,
    whenLinked: async (_host, ms) => { waited.push(ms); return o.linked !== false },
  }
  return { side, asked, waited }
}

describe('startOnHostCatchingUp', () => {
  it('off on the host, on here: the config copy goes, the host takes it, and the start goes once more', async () => {
    const { side, asked, waited } = sideOf([OFF, OK])
    const copied: string[] = []
    const a = await startOnHostCatchingUp(side, 'devbox', { taskId: 't' }, { copyConfigNow: async (h) => { copied.push(h); return true }, takesTaskRows: () => false })
    expect(a).toEqual(OK)
    expect(asked).toEqual(['devbox', 'devbox'])
    expect(copied).toEqual(['devbox'])
    expect(waited).toHaveLength(1)
  })

  it('never a third ask: a host still off after catching up is off', async () => {
    const { side, asked } = sideOf([OFF, OFF, OK])
    const a = await startOnHostCatchingUp(side, 'devbox', {}, { copyConfigNow: async () => true })
    expect(a).toEqual(OFF)
    expect(asked).toHaveLength(2)
  })

  it('off here too: the refusal stands, nothing is copied or asked again', async () => {
    const { side, asked } = sideOf([OFF, OK], { on: false })
    let copied = 0
    const a = await startOnHostCatchingUp(side, 'devbox', {}, { copyConfigNow: async () => { copied++; return true } })
    expect(a).toEqual(OFF)
    expect(asked).toHaveLength(1)
    expect(copied).toBe(0)
  })

  it('the host did not take the copy, or its session side never linked: the first refusal stands', async () => {
    const notTaken = sideOf([OFF, OK])
    expect(await startOnHostCatchingUp(notTaken.side, 'devbox', {}, { copyConfigNow: async () => false })).toEqual(OFF)
    expect(notTaken.asked).toHaveLength(1)
    const copyThrew = sideOf([OFF, OK])
    expect(await startOnHostCatchingUp(copyThrew.side, 'devbox', {}, { copyConfigNow: async () => { throw new Error('no target') } })).toEqual(OFF)
    expect(copyThrew.asked).toHaveLength(1)
    const notLinked = sideOf([OFF, OK], { linked: false })
    expect(await startOnHostCatchingUp(notLinked.side, 'devbox', {}, { copyConfigNow: async () => true })).toEqual(OFF)
    expect(notLinked.asked).toHaveLength(1)
  })

  it('any other answer is the first one, asked once: a success, another refusal', async () => {
    for (const first of [OK, { ok: false, error: 'not_its_session' }, { ok: false, error: 'busy' }] as HostCallAnswer[]) {
      const { side, asked } = sideOf([first, OK])
      let copied = 0
      expect(await startOnHostCatchingUp(side, 'devbox', {}, { copyConfigNow: async () => { copied++; return true } })).toEqual(first)
      expect(asked).toHaveLength(1)
      expect(copied).toBe(0)
    }
  })

  it('the switch turned off during the wait: no second ask', async () => {
    const answers = [OFF, OK]
    let on = true
    const asked: string[] = []
    const side: SwitchCatchUpSide = {
      startOnHost: async (host) => { asked.push(host); return answers.shift() ?? OFF },
      switchOn: () => on,
      whenLinked: async () => { on = false; return true },
    }
    expect(await startOnHostCatchingUp(side, 'devbox', {}, { copyConfigNow: async () => true })).toEqual(OFF)
    expect(asked).toHaveLength(1)
  })

  it('one budget for the copy and the link: the link waits only what the copy left', async () => {
    let t = 1_000
    const { side, waited } = sideOf([OFF, OK])
    await startOnHostCatchingUp(side, 'devbox', {}, { budgetMs: 10_000, now: () => t, copyConfigNow: async (_h, ms) => { expect(ms).toBe(10_000); t += 4_000; return true } })
    expect(waited).toEqual([6_000])
  })
})
