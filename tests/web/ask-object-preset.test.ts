/**
 * The context block rides the FIRST message about an object and nothing after it.
 *
 * Why this is a latch in STORAGE rather than a module-level Set (which is what the Slack copy has):
 * the drawer is unmounted the moment the user closes it, so an in-memory flag forgets, and the next
 * question about the same mail quotes the whole mail again — a second copy of the context the model
 * already has, paid for out of the window. The same latch answers "has this object's preset already
 * been sent", which is what keeps `Summarize…` from re-asking every time the drawer is reopened.
 *
 * A latch is CLAIMED at send time, never during render: React StrictMode runs state initializers and
 * effects twice, so a claim made while rendering would consume the preset without ever sending it.
 * `askObjectLatchTaken` is therefore a pure read, and that is pinned below.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  askObjectLatchTaken,
  claimAskObjectLatch,
  prefixContextOnce,
} from '../../web/src/components/chat/ask-object-conversation'

const MODULE = '../../web/src/components/chat/ask-object-conversation'

class FakeStorage {
  readonly map = new Map<string, string>()
  get length(): number { return this.map.size }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null }
  getItem(key: string): string | null { return this.map.get(key) ?? null }
  setItem(key: string, value: string): void { this.map.set(key, value) }
  removeItem(key: string): void { this.map.delete(key) }
}

const BLOCK = 'Context from Mail (Inbox, Bo Marina, Sep 21):\n> Can we ship the whiteboard today?\n\n'
const KEY = 'mail:acct-1:msg-1'

let storage: FakeStorage

beforeEach(() => {
  storage = new FakeStorage()
})

describe('prefixContextOnce', () => {
  it('quotes the object on the first send and never again', () => {
    expect(prefixContextOnce(KEY, BLOCK, 'Summarize this', { storage }))
      .toBe(`${BLOCK}Summarize this`)
    expect(prefixContextOnce(KEY, BLOCK, 'and who else is on it?', { storage }))
      .toBe('and who else is on it?')
    expect(prefixContextOnce(KEY, BLOCK, 'third', { storage })).toBe('third')
  })

  it('is per object: a second mail gets its own first message', () => {
    prefixContextOnce(KEY, BLOCK, 'first', { storage })
    expect(prefixContextOnce('mail:acct-1:msg-2', BLOCK, 'first', { storage }))
      .toBe(`${BLOCK}first`)
    // ...and the same object under a second account is a second object.
    expect(prefixContextOnce('mail:acct-2:msg-1', BLOCK, 'first', { storage }))
      .toBe(`${BLOCK}first`)
  })

  it('survives a remount: fresh module state, same storage, still no second quote', async () => {
    expect(prefixContextOnce(KEY, BLOCK, 'first', { storage })).toBe(`${BLOCK}first`)

    // The drawer closed and reopened: every module-level variable is gone, storage is not.
    vi.resetModules()
    const fresh = await import(MODULE)
    expect(fresh.prefixContextOnce(KEY, BLOCK, 'back again', { storage })).toBe('back again')
    expect(fresh.askObjectLatchTaken('context', KEY, storage)).toBe(true)
  })

  it('an empty context block changes nothing and does not burn the latch', () => {
    expect(prefixContextOnce(KEY, '', 'no context to give', { storage })).toBe('no context to give')
    expect(askObjectLatchTaken('context', KEY, storage)).toBe(false)
    expect(prefixContextOnce(KEY, BLOCK, 'now there is', { storage })).toBe(`${BLOCK}now there is`)
  })

  it('still sends the message when storage refuses to remember', () => {
    const hostile = new FakeStorage()
    vi.spyOn(hostile, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(prefixContextOnce(KEY, BLOCK, 'first', { storage: hostile })).toBe(`${BLOCK}first`)
    // It cannot remember, so it quotes again — the honest degradation. Never a lost message.
    expect(prefixContextOnce(KEY, BLOCK, 'second', { storage: hostile })).toBe(`${BLOCK}second`)
  })
})

describe('the preset latch', () => {
  it('is claimed exactly once per object', () => {
    expect(claimAskObjectLatch('preset', KEY, { storage })).toBe(true)
    expect(claimAskObjectLatch('preset', KEY, { storage })).toBe(false)
    expect(claimAskObjectLatch('preset', 'mail:acct-1:msg-2', { storage })).toBe(true)
  })

  it('reads without consuming — the property StrictMode needs', () => {
    expect(askObjectLatchTaken('preset', KEY, storage)).toBe(false)
    expect(askObjectLatchTaken('preset', KEY, storage)).toBe(false)
    expect(claimAskObjectLatch('preset', KEY, { storage })).toBe(true)
    expect(askObjectLatchTaken('preset', KEY, storage)).toBe(true)
  })

  it('is independent of the context latch for the same object', () => {
    claimAskObjectLatch('context', KEY, { storage })
    expect(askObjectLatchTaken('preset', KEY, storage)).toBe(false)
    expect(claimAskObjectLatch('preset', KEY, { storage })).toBe(true)
  })

  it('stamps when it was taken, so the 30-day prune can reach it', () => {
    claimAskObjectLatch('preset', KEY, { storage, now: () => 1_700_000_000_000 })
    expect(JSON.parse(storage.getItem(`walnut:ask-object-once:preset:${KEY}`)!))
      .toEqual({ at: 1_700_000_000_000 })
  })
})
