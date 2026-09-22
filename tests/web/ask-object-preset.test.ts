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
 *
 * Two things a latch has to get right besides once-ness, both pinned here:
 *   . WHOSE latch it is. The agent is part of the identity, exactly as it is part of the conversation
 *     key, because the same object asked under two agents is two chats.
 *   . that it is only spent on a message that really went out. A claim is made when the send is handed
 *     to the transport and given back when the turn ends with nothing to show for it.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  askObjectLatchTaken,
  autoSendOutcome,
  claimAskObjectLatch,
  prefixContextOnce,
  presetLatchName,
  releaseAskObjectLatch,
  type AutoSendWatch,
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
const AGENT = 'walnut'
/** The scope a latch belongs to: this object, under this agent. */
const scope = (key: string, agentId = AGENT) => ({ agentId, key })
const HERE = scope(KEY)

let storage: FakeStorage

beforeEach(() => {
  storage = new FakeStorage()
})

describe('prefixContextOnce', () => {
  it('quotes the object on the first send and never again', () => {
    expect(prefixContextOnce(HERE, BLOCK, 'Summarize this', { storage }))
      .toBe(`${BLOCK}Summarize this`)
    expect(prefixContextOnce(HERE, BLOCK, 'and who else is on it?', { storage }))
      .toBe('and who else is on it?')
    expect(prefixContextOnce(HERE, BLOCK, 'third', { storage })).toBe('third')
  })

  it('is per object: a second mail gets its own first message', () => {
    prefixContextOnce(HERE, BLOCK, 'first', { storage })
    expect(prefixContextOnce(scope('mail:acct-1:msg-2'), BLOCK, 'first', { storage }))
      .toBe(`${BLOCK}first`)
    // ...and the same object under a second account is a second object.
    expect(prefixContextOnce(scope('mail:acct-2:msg-1'), BLOCK, 'first', { storage }))
      .toBe(`${BLOCK}first`)
  })

  it('survives a remount: fresh module state, same storage, still no second quote', async () => {
    expect(prefixContextOnce(HERE, BLOCK, 'first', { storage })).toBe(`${BLOCK}first`)

    // The drawer closed and reopened: every module-level variable is gone, storage is not.
    vi.resetModules()
    const fresh = await import(MODULE)
    expect(fresh.prefixContextOnce(HERE, BLOCK, 'back again', { storage })).toBe('back again')
    expect(fresh.askObjectLatchTaken('context', HERE, storage)).toBe(true)
  })

  it('an empty context block changes nothing and does not burn the latch', () => {
    expect(prefixContextOnce(HERE, '', 'no context to give', { storage })).toBe('no context to give')
    expect(askObjectLatchTaken('context', HERE, storage)).toBe(false)
    expect(prefixContextOnce(HERE, BLOCK, 'now there is', { storage })).toBe(`${BLOCK}now there is`)
  })

  it('still sends the message when storage refuses to remember', () => {
    const hostile = new FakeStorage()
    vi.spyOn(hostile, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(prefixContextOnce(HERE, BLOCK, 'first', { storage: hostile })).toBe(`${BLOCK}first`)
    // It cannot remember, so it quotes again — the honest degradation. Never a lost message.
    expect(prefixContextOnce(HERE, BLOCK, 'second', { storage: hostile })).toBe(`${BLOCK}second`)
  })
})

/**
 * A latch belongs to an object AND an agent, the same pair the conversation key is built from.
 *
 * The bug: the latch key carried no agent id while the conversation key did. Asking about a mail under
 * Walnut took both latches; asking about the SAME mail under Mentor then correctly opened a second
 * conversation, into which the quote was never sent (the context latch read as taken) and the canned
 * question was never asked (so did the preset latch) — the drawer opened on an empty composer.
 */
describe('a latch belongs to one agent', () => {
  it('quotes the object again for a second agent, in that agent\'s own chat', () => {
    expect(prefixContextOnce(HERE, BLOCK, 'Summarize this', { storage }))
      .toBe(`${BLOCK}Summarize this`)
    expect(prefixContextOnce(scope(KEY, 'mentor'), BLOCK, 'Summarize this', { storage }))
      .toBe(`${BLOCK}Summarize this`)
    // ...and each agent still quotes exactly once.
    expect(prefixContextOnce(scope(KEY, 'mentor'), BLOCK, 'again', { storage })).toBe('again')
  })

  it('lets the second agent send the same canned question', () => {
    expect(claimAskObjectLatch('preset', HERE, { storage })).toBe(true)
    expect(askObjectLatchTaken('preset', scope(KEY, 'mentor'), storage)).toBe(false)
    expect(claimAskObjectLatch('preset', scope(KEY, 'mentor'), { storage })).toBe(true)
    // Neither agent's latch moved the other's.
    expect(claimAskObjectLatch('preset', HERE, { storage })).toBe(false)
    expect(claimAskObjectLatch('preset', scope(KEY, 'mentor'), { storage })).toBe(false)
  })

  it('writes the agent into the key, so the prune can find the chat it belongs to', () => {
    claimAskObjectLatch('preset', HERE, { storage, now: () => 1_700_000_000_000 })
    expect([...storage.map.keys()]).toEqual([`walnut:ask-object-once:preset:${AGENT}:${KEY}`])
    // The conversation key for the same pair is `walnut:ask-object:<agent>:<object>`, so what follows
    // the latch's `<name>:` head is exactly the conversation's scope.
    expect([...storage.map.keys()][0].split(':').slice(3).join(':')).toBe(`${AGENT}:${KEY}`)
  })
})

describe('the preset latch', () => {
  it('is claimed exactly once per object', () => {
    expect(claimAskObjectLatch('preset', HERE, { storage })).toBe(true)
    expect(claimAskObjectLatch('preset', HERE, { storage })).toBe(false)
    expect(claimAskObjectLatch('preset', scope('mail:acct-1:msg-2'), { storage })).toBe(true)
  })

  it('reads without consuming — the property StrictMode needs', () => {
    expect(askObjectLatchTaken('preset', HERE, storage)).toBe(false)
    expect(askObjectLatchTaken('preset', HERE, storage)).toBe(false)
    expect(claimAskObjectLatch('preset', HERE, { storage })).toBe(true)
    expect(askObjectLatchTaken('preset', HERE, storage)).toBe(true)
  })

  it('is independent of the context latch for the same object', () => {
    claimAskObjectLatch('context', HERE, { storage })
    expect(askObjectLatchTaken('preset', HERE, storage)).toBe(false)
    expect(claimAskObjectLatch('preset', HERE, { storage })).toBe(true)
  })

  it('stamps when it was taken, so the 30-day prune can reach it', () => {
    claimAskObjectLatch('preset', HERE, { storage, now: () => 1_700_000_000_000 })
    expect(JSON.parse(storage.getItem(`walnut:ask-object-once:preset:${AGENT}:${KEY}`)!))
      .toEqual({ at: 1_700_000_000_000 })
  })

  /**
   * Two DIFFERENT questions about the same object each get their own latch.
   *
   * The drawer keys the latch by `<objectKey>#<presetLatchName(preset)>`, and the reason is a bug this
   * pins: with one latch per object, having asked Walnut to summarize a mail meant that clicking
   * "finish unsubscribing" on the same mail later opened the drawer and sent nothing at all.
   */
  it('separates two different presets on one object, and still fires once per preset', () => {
    const summarize = scope(`${KEY}#${presetLatchName('Summarize this for me.')}`)
    const unsubscribe = scope(`${KEY}#${presetLatchName('Finish unsubscribing from this list.')}`)
    expect(summarize.key).not.toBe(unsubscribe.key)

    expect(claimAskObjectLatch('preset', summarize, { storage })).toBe(true)
    // The other question has not been asked, so it is still allowed to go out.
    expect(askObjectLatchTaken('preset', unsubscribe, storage)).toBe(false)
    expect(claimAskObjectLatch('preset', unsubscribe, { storage })).toBe(true)
    // And asking for the same thing twice still sends once.
    expect(claimAskObjectLatch('preset', summarize, { storage })).toBe(false)
  })

  it('names a preset by its text, not by its length or its identity', () => {
    expect(presetLatchName('Summarize this for me.')).toBe(presetLatchName('Summarize this for me.'))
    expect(presetLatchName('Summarize this for me.')).not.toBe(presetLatchName('Summarize this for me!'))
    // A key, not the paragraph itself: the preset is prose and this ends up in localStorage.
    expect(presetLatchName('x'.repeat(4000)).length).toBeLessThan(10)
  })
})

/**
 * A latch may only be spent on a message that really went out.
 *
 * The bug: the view called `chat.sendMessage` (fire and forget — it returns void and swallows its RPC's
 * promise) and then claimed the latch synchronously. A server 500 or an offline socket sent nothing and
 * spent the latch anyway, so reopening the drawer never auto-sent again and the user was left with an
 * empty conversation and no way back: the latch is in localStorage.
 */
describe('giving a latch back', () => {
  it('makes the question askable again, and only that one latch', () => {
    const summarize = scope(`${KEY}#${presetLatchName('Summarize this for me.')}`)
    claimAskObjectLatch('context', HERE, { storage })
    claimAskObjectLatch('preset', summarize, { storage })

    releaseAskObjectLatch('preset', summarize, storage)
    expect(askObjectLatchTaken('preset', summarize, storage)).toBe(false)
    expect(claimAskObjectLatch('preset', summarize, { storage })).toBe(true)
    expect(askObjectLatchTaken('context', HERE, storage)).toBe(true)
  })

  it('releases the quote too, since the message that was carrying it never left', () => {
    expect(prefixContextOnce(HERE, BLOCK, 'Summarize this', { storage })).toBe(`${BLOCK}Summarize this`)
    releaseAskObjectLatch('context', HERE, storage)
    expect(prefixContextOnce(HERE, BLOCK, 'Summarize this', { storage })).toBe(`${BLOCK}Summarize this`)
  })

  it('leaves another agent alone, and survives a storage that throws', () => {
    claimAskObjectLatch('preset', HERE, { storage })
    claimAskObjectLatch('preset', scope(KEY, 'mentor'), { storage })
    releaseAskObjectLatch('preset', HERE, storage)
    expect(askObjectLatchTaken('preset', scope(KEY, 'mentor'), storage)).toBe(true)

    const hostile = new FakeStorage()
    vi.spyOn(hostile, 'removeItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => releaseAskObjectLatch('preset', HERE, hostile)).not.toThrow()
  })
})

describe('autoSendOutcome', () => {
  const fresh: AutoSendWatch = { repliesAtDispatch: 0, started: false }
  const probe = (over: Partial<{ replies: number; streaming: boolean; queued: number }> = {}) => (
    { replies: 0, streaming: false, queued: 0, ...over }
  )

  it('says nothing on the render the send was dispatched in', () => {
    // The hook's `isStreaming` has not landed yet in that render. Reading it there and concluding
    // would call EVERY send a failure and release every latch — the one mistake that must not happen.
    expect(autoSendOutcome(fresh, probe()).verdict).toBe('pending')
  })

  it('waits while the turn runs', () => {
    const started = autoSendOutcome(fresh, probe({ streaming: true }))
    expect(started.verdict).toBe('pending')
    expect(started.watch.started).toBe(true)
    // Queued behind another turn counts as started too.
    expect(autoSendOutcome(fresh, probe({ queued: 1 })).watch.started).toBe(true)
  })

  it('calls it SENT as soon as the conversation gains an assistant turn', () => {
    expect(autoSendOutcome(fresh, probe({ streaming: true, replies: 1 })).verdict).toBe('sent')
    // Still streaming the rest of the answer — already proof enough that the send landed.
    expect(autoSendOutcome({ repliesAtDispatch: 3, started: true }, probe({ replies: 4, streaming: true })).verdict)
      .toBe('sent')
  })

  it('calls it FAILED when a started turn stops with no answer', () => {
    const started = autoSendOutcome(fresh, probe({ streaming: true })).watch
    expect(autoSendOutcome(started, probe()).verdict).toBe('failed')
  })

  it('does not call a reply from an earlier turn its own', () => {
    // The drawer dispatched while three answers were already on screen; only a FOURTH is evidence.
    const watch: AutoSendWatch = { repliesAtDispatch: 3, started: true }
    expect(autoSendOutcome(watch, probe({ replies: 3, streaming: true })).verdict).toBe('pending')
    expect(autoSendOutcome(watch, probe({ replies: 3 })).verdict).toBe('failed')
  })

  it('keeps waiting while the send sits in the queue after the turn ended', () => {
    const watch: AutoSendWatch = { repliesAtDispatch: 1, started: true }
    expect(autoSendOutcome(watch, probe({ replies: 1, queued: 1 })).verdict).toBe('pending')
  })
})

/**
 * The two views that spend these latches, read as source.
 *
 * This tier has no DOM, so an effect cannot be run here; what it CAN pin is that neither view has gone
 * back to the shape the bugs had — a claim with no correction, and a latch keyed without its agent. The
 * behaviour of the parts they call is graded above; a Playwright spec covers the click.
 */
describe('the drawer and the chat view still wire it this way', () => {
  const read = (rel: string) => readFileSync(path.join(import.meta.dirname, '../../web/src', rel), 'utf8')
  const view = read('components/chat/PluginChatView.tsx')
  const drawer = read('components/chat/AskObjectDrawer.tsx')

  it('asks autoSendOutcome for the verdict and reports a failure back', () => {
    expect(view).toContain('autoSendOutcome(')
    expect(view).toContain('onAutoSendFailed?.(pending.text)')
    // The bug: `onAutoSent` fired on the line after the fire-and-forget send, with nothing that could
    // ever take it back. It may still be claimed there, but only alongside the watcher above.
    expect(view).toMatch(/watchRef\.current = \{[\s\S]*handleSend\(autoSend\)/)
  })

  it('gives both latches back when the auto-send went nowhere', () => {
    expect(drawer).toContain("releaseAskObjectLatch('preset', presetScope)")
    expect(drawer).toContain("releaseAskObjectLatch('context', contextScope)")
  })

  it('keys every latch by agent AND object', () => {
    // A bare string reaching a latch call is the defect: the conversation key has the agent in it and
    // the latch must be built from the same pair.
    expect(drawer).toContain('const contextScope = { agentId, key: objectKey }')
    expect(drawer).toMatch(/askObjectLatchTaken\('preset', presetScope\)/)
    expect(drawer).toMatch(/prefixContextOnce\(contextScope,/)
  })
})
