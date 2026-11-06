/**
 * An unlock client waits and sends the unlock again while the server checks another one
 * (`429 unlock_busy`), a bounded number of times, and never sends a wrong password again
 * (src/core/vault/unlock-retry.ts). And the words a lock screen shows for each refusal code.
 */
import { describe, expect, it } from 'vitest'
import {
  busyWaitOf, throwingWhileUnlockBusy, unlockRefusalText, whileUnlockBusy, UNLOCK_BUSY_RETRIES, UNLOCK_BUSY_WAIT_CAP_MS,
} from '../../../src/core/vault/unlock-retry'

type R = { ok: boolean; code?: string; waitMs?: number; error?: string }
const BUSY: R = { ok: false, code: 'unlock_busy', waitMs: 1000, error: 'Another unlock is being checked; try again in a moment.' }
const OK: R = { ok: true }
const WRONG: R = { ok: false, code: 'wrong_password', error: 'Wrong master password' }

/** An attempt that answers `answers` in turn, counting its calls, and a sleep that only records. */
function rig(answers: R[]) {
  let calls = 0
  const waits: number[] = []
  const shown: number[] = []
  const attempt = async () => answers[Math.min(calls++, answers.length - 1)]
  const opts = { sleep: async (ms: number) => { waits.push(ms) }, onWait: (ms: number) => { shown.push(ms) } }
  return { attempt, opts, waits, shown, calls: () => calls }
}

describe('an unlock while another is being checked', () => {
  it('waits what the server asked, shows Checking, and sends it again: busy, then unlocked', async () => {
    const r = rig([BUSY, OK])
    const out = await whileUnlockBusy(r.attempt, (o) => (o.ok ? null : busyWaitOf(o)), r.opts)
    expect(out).toEqual(OK)
    expect(r.calls()).toBe(2)
    expect(r.waits).toEqual([1000])
    expect(r.shown).toEqual([1000])
  })

  it('busy every time: tries again a bounded number of times, then the busy refusal is the answer', async () => {
    const r = rig([BUSY])
    const out = await whileUnlockBusy(r.attempt, (o) => (o.ok ? null : busyWaitOf(o)), r.opts)
    expect(out).toEqual(BUSY)
    expect(r.calls()).toBe(1 + UNLOCK_BUSY_RETRIES)
    expect(r.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(UNLOCK_BUSY_WAIT_CAP_MS)
    expect(unlockRefusalText({ code: out.code, waitMs: out.waitMs, message: out.error })).toBe('Another unlock is being checked. Try again in a moment.')
  })

  it('never waits past the cap in all, whatever wait the server asks for', async () => {
    const r = rig([{ ...BUSY, waitMs: 3000 }])
    await whileUnlockBusy(r.attempt, (o) => (o.ok ? null : busyWaitOf(o)), r.opts)
    expect(r.waits).toEqual([3000])
    expect(r.calls()).toBe(2)
  })

  it('a wrong password is never sent again, nor any other refusal', async () => {
    for (const answer of [WRONG, { ok: false, code: 'unlock_slowed', waitMs: 30_000 }, { ok: false, code: 'secret_key_needed' }, { ok: false }]) {
      const r = rig([answer, OK])
      const out = await whileUnlockBusy(r.attempt, (o) => (o.ok ? null : busyWaitOf(o)), r.opts)
      expect(out).toEqual(answer)
      expect(r.calls()).toBe(1)
      expect(r.waits).toEqual([])
    }
  })

  it('the throwing form: busy then unlocked returns, a wrong password throws at once', async () => {
    class E extends Error { constructor(readonly code: string, readonly waitMs?: number) { super(code) } }
    const waitOf = (e: unknown) => (e instanceof E ? busyWaitOf(e) : null)
    let n = 0
    await expect(throwingWhileUnlockBusy(async () => { if (n++ === 0) throw new E('unlock_busy', 500); return 'in' }, waitOf, { sleep: async () => {} })).resolves.toBe('in')
    expect(n).toBe(2)
    n = 0
    await expect(throwingWhileUnlockBusy(async () => { n++; throw new E('wrong_password') }, waitOf, { sleep: async () => {} })).rejects.toThrow('wrong_password')
    expect(n).toBe(1)
  })
})

describe('the words for a refusal', () => {
  it('the brake on wrong passwords, by the code the server sends and an older Walnut\'s', () => {
    expect(unlockRefusalText({ code: 'unlock_slowed', waitMs: 30_000, message: 'Too many wrong passwords: try again in 30 s.' })).toBe('Too many tries. Wait 30 s.')
    expect(unlockRefusalText({ code: 'too_many_attempts', waitMs: 1_500 })).toBe('Too many tries. Wait 2 s.')
  })

  it('anything else: the server\'s own words, else a plain line', () => {
    expect(unlockRefusalText({ code: 'wrong_password', message: 'Wrong master password' })).toBe('Wrong master password')
    expect(unlockRefusalText({ code: 'something_new', message: 'Its words' })).toBe('Its words')
    expect(unlockRefusalText({})).toBe('That did not unlock.')
  })
})
