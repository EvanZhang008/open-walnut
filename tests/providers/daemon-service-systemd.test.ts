/**
 * keepUnitActive (src/providers/daemon-service-systemd.ts), the last step of a failed install,
 * update or restart of a systemd unit: a unit that is not running is started, and a unit that
 * waits out a crash (is-active `activating`, SubState `auto-restart`) is not running (2026-11-04
 * review: it read as running, so nothing started it and its start limit ended it). Every
 * systemctl call is a stand-in on a virtual clock.
 */
import { describe, expect, it } from 'vitest'
import { keepUnitActive, UNIT_START_RETRY_MS } from '../../src/providers/daemon-service-systemd.js'

const UNIT = 'open-walnut-daemon.service'

/** A unit in `state`; a start succeeds unless `startFails`, and leaves it active. */
function unit(state: 'active' | 'inactive' | 'failed' | 'crash-loop' | 'starting', o: { startFails?: boolean } = {}) {
  let now = 0
  let current = state
  const calls: string[] = []
  const io = {
    now: () => now,
    sleep: async (ms: number) => { now += ms },
    async run(program: string, args: string[]) {
      calls.push([program, ...args].join(' '))
      const [verb] = args.slice(1)
      if (verb === 'is-active') {
        if (current === 'active') return { code: 0, stdout: 'active\n', stderr: '' }
        if (current === 'crash-loop' || current === 'starting') return { code: 3, stdout: 'activating\n', stderr: '' }
        return { code: 3, stdout: `${current}\n`, stderr: '' }
      }
      // As systemd 219 answers (2026-11-04 review): no --value, SubState=<word> every time.
      if (verb === 'show') {
        if (args.includes('--value')) return { code: 1, stdout: '', stderr: "systemctl: unrecognized option '--value'" }
        return { code: 0, stdout: current === 'crash-loop' ? 'SubState=auto-restart\n' : 'SubState=start\n', stderr: '' }
      }
      if (verb === 'start') {
        if (o.startFails) return { code: 1, stdout: '', stderr: 'Job failed' }
        current = 'active'
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  return { io, calls, scoped: (a: string[]) => ['--user', ...a] }
}

describe('keepUnitActive', () => {
  it('leaves an active unit, and one systemd is starting, alone', async () => {
    for (const state of ['active', 'starting'] as const) {
      const u = unit(state)
      expect(await keepUnitActive(u.io, u.scoped, UNIT)).toEqual({ active: true, did: false })
      expect(u.calls.some((c) => c.includes(' start '))).toBe(false)
    }
  })

  it.each(['inactive', 'failed', 'crash-loop'] as const)('starts a %s unit, its start limit cleared first', async (state) => {
    const u = unit(state)
    expect(await keepUnitActive(u.io, u.scoped, UNIT)).toEqual({ active: true, did: true })
    expect(u.calls).toEqual(expect.arrayContaining([
      `systemctl --user reset-failed ${UNIT}`, `systemctl --user start ${UNIT}`,
    ]))
    expect(u.calls.indexOf(`systemctl --user reset-failed ${UNIT}`)).toBeLessThan(u.calls.indexOf(`systemctl --user start ${UNIT}`))
  })

  it('says why after a start that keeps failing for the whole retry window', async () => {
    const u = unit('failed', { startFails: true })
    const kept = await keepUnitActive(u.io, u.scoped, UNIT)
    expect(kept.active).toBe(false)
    expect(kept.why).toBe(`systemctl --user start ${UNIT} kept failing for ${UNIT_START_RETRY_MS / 1000} s (last exit 1)`)
    expect(u.calls.filter((c) => c.endsWith(` start ${UNIT}`)).length).toBeGreaterThan(1)
  })
})
