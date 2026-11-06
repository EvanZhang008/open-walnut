/**
 * The extension's lock screens (popup, side panel Passwords view, key popover) unlock through
 * packages/browser-extension/src/unlock-send.ts: sent again while Walnut checks another unlock,
 * "Checking…" meanwhile, never again for a wrong password; the brake reads "Too many tries".
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../packages/browser-extension/src/ext', () => ({ ask: async () => ({ ok: false, error: 'not in a test' }), ext: {} }))
const { sendUnlock, unlockRefusal } = await import('../../../packages/browser-extension/src/unlock-send')

function background(answers: Array<Record<string, unknown>>) {
  const sent: Array<Record<string, unknown>> = []
  const send = async (m: Record<string, unknown>) => { sent.push(m); return answers[Math.min(sent.length - 1, answers.length - 1)] as { ok: boolean } }
  return { sent, send }
}

describe('the extension\'s unlock', () => {
  it('busy, then unlocked: one more send, and Checking shows while it waits', async () => {
    const bg = background([{ ok: false, code: 'unlock_busy', waitMs: 1000 }, { ok: true }])
    const checking: number[] = []
    const r = await sendUnlock('pw', '', { send: bg.send, sleep: async () => {}, onWait: (ms) => checking.push(ms) })
    expect(r.ok).toBe(true)
    expect(bg.sent).toEqual([{ type: 'unlock', password: 'pw', secretKey: '' }, { type: 'unlock', password: 'pw', secretKey: '' }])
    expect(checking).toEqual([1000])
  })

  it('busy every time: a bounded number of sends, then the busy words', async () => {
    const bg = background([{ ok: false, code: 'unlock_busy', waitMs: 1000, error: 'Another unlock is being checked; try again in a moment.' }])
    const r = await sendUnlock('pw', '', { send: bg.send, sleep: async () => {} })
    expect(bg.sent.length).toBe(4)
    expect(unlockRefusal(r)).toBe('Another unlock is being checked. Try again in a moment.')
  })

  it('a wrong password is sent once', async () => {
    const bg = background([{ ok: false, code: 'wrong_password', error: 'Wrong master password' }, { ok: true }])
    const r = await sendUnlock('nope', '', { send: bg.send, sleep: async () => {} })
    expect(bg.sent.length).toBe(1)
    expect(unlockRefusal(r)).toBe('Wrong master password')
  })

  it('the server\'s brake reads "Too many tries. Wait N s."', () => {
    expect(unlockRefusal({ ok: false, code: 'unlock_slowed', waitMs: 60_000, error: 'Too many wrong passwords: try again in 60 s.' })).toBe('Too many tries. Wait 60 s.')
  })
})
