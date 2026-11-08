/**
 * A message that was sent never comes back as its composer's draft.
 *
 * 2026-10-30, the Mac app: the user dictated a message, the refined transcript
 * landed in the box, and they pressed the send arrow 283 ms later. The box's
 * 300 ms debounced save of that text was still armed (the send's reset keeps the
 * draft until the server accepts the message, and kept the timer with it). It
 * fired while the send was on its way and wrote the sent text back under the
 * session's draft key; the draft store told every box of that key, so the very
 * composer that had just emptied (not focused: the click moved focus off it)
 * showed the text again; and when the send was accepted, the "the user typed the
 * next message meanwhile" check saw text in the box and kept it. The server's
 * draft mirror got the text 800 ms later (PUT /api/drafts, 482 bytes), and the
 * remounted panel showed it: the user sent the same message twice.
 *
 * The same holds for a failed send that the user then sends with Retry: the
 * words the failure put back in the box went out with the Retry, so the box,
 * the draft and a pending Ask's draft row let them go (2026-11-07, the Mac app:
 * a rejected follow-up was retried and the restored words were sent again).
 *
 * The real ChatInput, useSessionSend, useThreadStack, the real draft store
 * (drafts.ts) and the real localStorage write mirror (ui-prefs-sync.ts), mounted
 * by react-dom on a linkedom document. Only the network (`@/api/client`, the
 * socket's `sendRpc`), leaf popups and the mic are stubbed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { parseHTML } from 'linkedom'

// A Storage the mirror can wrap: ui-prefs-sync captures `Storage.prototype` when it loads.
const shim = vi.hoisted(() => {
  class StorageShim {
    #m = new Map<string, string>()
    getItem(k: string) { return this.#m.has(k) ? this.#m.get(k)! : null }
    setItem(k: string, v: string) { this.#m.set(k, String(v)) }
    removeItem(k: string) { this.#m.delete(k) }
    clear() { this.#m.clear() }
    key(i: number) { return [...this.#m.keys()][i] ?? null }
    get length() { return this.#m.size }
  }
  const g = globalThis as unknown as Record<string, unknown>
  Object.defineProperty(g, 'Storage', { value: StorageShim, configurable: true, writable: true })
  const storage = new StorageShim()
  Object.defineProperty(g, 'localStorage', { value: storage, configurable: true, writable: true })
  return { storage: storage as unknown as Storage }
})

const net = vi.hoisted(() => ({
  server: {} as Record<string, { v: string | null; ts: number }>,
  puts: [] as Array<{ path: string; body: unknown }>,
}))
vi.mock('@/api/client', () => ({
  apiGet: vi.fn(async (p: string) => (p === '/api/drafts' ? { drafts: net.server } : {})),
  apiPut: vi.fn(async (p: string, body: unknown) => { net.puts.push({ path: p, body }); return {} }),
  apiPost: vi.fn(async () => ({})),
}))

// The socket: every `session:send` payload is recorded, and answers as the test says.
const rpc = vi.hoisted(() => ({
  sends: [] as Array<Record<string, unknown>>,
  answers: [] as Array<'reject' | 'ok' | Promise<'reject' | 'ok'>>,
  /** What `session:get-queue` answers per session: the rows the server holds. */
  queues: {} as Record<string, Array<Record<string, unknown>>>,
}))
vi.mock('@/api/ws', () => ({
  wsClient: new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'state') return 'connected'
      if (prop !== 'sendRpc') return () => () => {}
      return async (method: string, payload: Record<string, unknown>) => {
        if (method === 'session:get-queue') return { messages: rpc.queues[payload.sessionId as string] ?? [] }
        if (method !== 'session:send') return {}
        rpc.sends.push(payload)
        const answer = await (rpc.answers.shift() ?? 'ok')
        if (answer === 'reject') throw new Error('the host did not take it')
        return { messageId: `qm-${rpc.sends.length}` }
      }
    },
  }),
}))

const mic = vi.hoisted(() => ({ props: null as null | Record<string, (...a: unknown[]) => unknown> }))
vi.mock('../../web/src/components/common/MicButton', () => ({
  MicButton: (p: Record<string, (...a: unknown[]) => unknown>) => { mic.props = p; return null },
}))
vi.mock('../../web/src/components/chat/MentionPalette', () => ({ MentionPalette: () => null }))
vi.mock('../../web/src/components/chat/FileMentionPopup', () => ({ FileMentionPopup: () => null }))
vi.mock('../../web/src/components/chat/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('@/commands/index', () => ({ searchCommands: () => [], getCommand: () => undefined }))
vi.mock('@/hooks/useChat', () => ({ MAX_QUEUE_SIZE: 10 }))

import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js'
import { ChatInput } from '../../web/src/components/chat/ChatInput'
import { adoptFailedDraft, claimFailedDraft, draftHash, draftOriginOf, draftSaveMark, initDraftSync, isDraftKey, isSentDraftCopy, markDraftSent, settleConfirmedDrafts, settleRetriedDraft, type DraftOrigin } from '../../web/src/utils/drafts'
import { useSessionSend } from '../../web/src/hooks/useSessionSend'
import { useThreadStack, type ThreadStackHandle } from '../../web/src/hooks/useThreadStack'
import { ROOT_THREAD_KEY, emptyThreadTree } from '../../web/src/utils/thread-tree'
import { composerDraftKey, pendingPageKey } from '../../web/src/utils/thread-stack-state'
import { rawLocalStorage, wrapLocalStorageWrites } from '../../web/src/utils/ui-prefs-sync'
import { ThreadCommentCard } from '../../web/src/components/sessions/ThreadCommentCard'
import { useDraft, type DraftHandle } from '../../web/src/hooks/useDraft'
import { DRAFT_FLUSH_EVENT, type DraftFlushDetail } from '../../web/src/utils/unsaved-work'

let doc: Document
beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
  ;(dom.window as unknown as Record<string, unknown>).localStorage = shim.storage
  // The Home page's address: draft keys of a popout carry their own suffix (composer-insert.ts).
  const home = { pathname: '/', search: '', href: 'http://localhost/' }
  try { Object.defineProperty(dom.window, 'location', { configurable: true, value: home }) } catch { (dom.window as unknown as Record<string, unknown>).location = home }
  wrapLocalStorageWrites()
  await initDraftSync()
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('getComputedStyle', () => ({ maxHeight: 'none' }))
  net.puts.length = 0
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

type Props = Parameters<typeof ChatInput>[0]

function reactProps(node: Element): Record<string, (...args: unknown[]) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith('__reactProps$'))
  if (!key) throw new Error('no React props on the node')
  return (node as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>)[key]!
}

function deferred() {
  let resolve!: (ok: boolean) => void
  const promise = new Promise<boolean>((r) => { resolve = r })
  return { promise, resolve }
}

function harness() {
  const el = doc.createElement('div')
  doc.body.appendChild(el)
  let root: Root | null = createRoot(el as unknown as Element)
  return {
    async render(props: Partial<Props>) {
      if (!root) root = createRoot(el as unknown as Element)
      await act(async () => { root!.render(createElement(ChatInput, { onSend: vi.fn(), ...props } as Props)) })
    },
    async unmount() { await act(async () => { root!.unmount() }); root = null },
    box(): HTMLTextAreaElement { return el.querySelector('textarea') as unknown as HTMLTextAreaElement },
    text(): string { return (el.querySelector('textarea') as unknown as HTMLTextAreaElement).value },
    /** What a freshly mounted box starts with. React writes it to `defaultValue`, which
     *  linkedom's textarea does not carry over to `value` the way a browser does. */
    mountedText(): string { return (el.querySelector('textarea') as unknown as HTMLTextAreaElement).defaultValue ?? '' },
    async type(text: string) {
      const ta = el.querySelector('textarea')!
      await act(async () => { reactProps(ta as unknown as Element).onChange!({ target: { value: text } }) })
    },
    /** The send arrow, clicked: focus is not on the textarea (WebKit moves it off on a button click). */
    async clickSend() {
      const send = el.querySelector('.chat-send-btn-icon')!
      await act(async () => { reactProps(send).onClick!() })
    },
  }
}

async function wait(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

/** What the server's draft mirror last received for `key` (undefined: never sent). */
function lastMirrored(key: string): { v: string | null } | undefined {
  for (let i = net.puts.length - 1; i >= 0; i--) {
    const p = net.puts[i]!
    if (p.path !== '/api/drafts') continue
    const entry = (p.body as { drafts: Record<string, { v: string | null }> }).drafts[key]
    if (entry) return entry
  }
  return undefined
}

const SENT = 'A dictated message, refined a moment ago and sent by the arrow.'

describe('a sent message never comes back as the draft', () => {
  it('the debounced save still owed at the send does not put the sent text back (the 2026-10-30 report)', async () => {
    const key = 'draft:session:sent-1'
    const send = deferred()
    const h = harness()
    await h.render({ draftKey: key, onSend: () => send.promise })
    await h.type(SENT)              // the refined transcript lands: a 300 ms save is owed
    await wait(100)
    await h.clickSend()             // sent 100 ms later, inside the debounce
    expect(h.text()).toBe('')
    await wait(250)                 // the owed save's timer comes due while the send is on its way
    await act(async () => { send.resolve(true); await send.promise })
    await wait(1_000)               // the server mirror's debounce
    expect(h.text()).toBe('')
    expect(localStorage.getItem(key)).toBeNull()
    expect(lastMirrored(key)?.v ?? null).toBeNull()
    // The panel remounts (as it did 35 s later): an empty box.
    await h.unmount()
    await h.render({ draftKey: key, onSend: vi.fn() })
    expect(h.mountedText()).toBe('')
    await h.unmount()
  })

  it('a send that is accepted before the owed save comes due leaves nothing either', async () => {
    const key = 'draft:session:sent-2'
    const h = harness()
    await h.render({ draftKey: key, onSend: async () => true })
    await h.type(SENT)
    await h.clickSend()
    await wait(1_500)
    expect(h.text()).toBe('')
    expect(localStorage.getItem(key)).toBeNull()
    await h.unmount()
  })

  it('a refined transcript that arrives after the send is dropped', async () => {
    const key = 'draft:session:sent-3'
    const h = harness()
    await h.render({ draftKey: key, onSend: async () => true })
    await act(async () => { mic.props!.onTranscribe!('draft words') })
    await h.clickSend()
    await act(async () => { mic.props!.onRefine!('draft words, refined', 'draft words') })
    await wait(1_500)
    expect(h.text()).toBe('')
    expect(localStorage.getItem(key)).toBeNull()
    await h.unmount()
  })

  it('a reload flush does not save a copy of the sent text another writer put in the box', async () => {
    const key = 'draft:session:sent-4'
    const h = harness()
    await h.render({ draftKey: key, onSend: async () => true })
    await h.type(SENT)
    await h.clickSend()
    await wait(1_500)
    // The box shows the sent words again from somewhere that is not typing (it was
    // focused, so the store's removal never reached it), and the app restarts.
    // This harness's box: a box an earlier failed case left mounted is not this one.
    h.box().value = SENT
    const detail: DraftFlushDetail = { scope: 'reload', claims: [] }
    window.dispatchEvent(new (window as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent(DRAFT_FLUSH_EVENT, { detail }))
    expect(localStorage.getItem(key)).toBeNull()
    await h.unmount()
  })

  it('a server copy from before the send is not adopted, and the removal goes back up', async () => {
    const key = 'draft:session:sent-5'
    const h = harness()
    await h.render({ draftKey: key, onSend: async () => true })
    await h.type(SENT)
    await h.clickSend()
    await wait(1_500)
    await wait(3_000)               // past the focus pull's minimum gap (drafts.ts PULL_MIN_GAP_MS)
    // Another device's copy of the pre-send words, stamped ahead of this one (its clock runs
    // fast), still inside the sent-copy window (drafts.ts SENT_COPY_WINDOW_MS, 60 s after the send).
    net.server = { [key]: { v: SENT, ts: Date.now() + 30_000 } }
    window.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('focus'))
    await wait(1_500)
    expect(localStorage.getItem(key)).toBeNull()
    expect(h.text()).toBe('')
    expect(lastMirrored(key)).toEqual({ v: null, ts: expect.any(Number) })
    expect((lastMirrored(key) as { ts: number }).ts).toBeGreaterThan(net.server[key]!.ts)
    net.server = {}
    await h.unmount()
  })
})

describe('typing after a send saves as before', () => {
  it('words typed after the send are the new draft, here and on the server', async () => {
    const key = 'draft:session:after-1'
    const h = harness()
    await h.render({ draftKey: key, onSend: async () => true })
    await h.type(SENT)
    await h.clickSend()
    await wait(500)
    await h.type('the next message')
    await wait(1_500)
    expect(localStorage.getItem(key)).toBe('the next message')
    expect(lastMirrored(key)?.v).toBe('the next message')
    await h.unmount()
  })

  it('the same words typed again after the send save too', async () => {
    const key = 'draft:session:after-2'
    const h = harness()
    await h.render({ draftKey: key, onSend: async () => true })
    await h.type('yes')
    await h.clickSend()
    await wait(500)
    await h.type('yes')
    await wait(1_500)
    expect(localStorage.getItem(key)).toBe('yes')
    await h.unmount()
    await h.render({ draftKey: key, onSend: vi.fn() })
    expect(h.mountedText()).toBe('yes')
    await h.unmount()
  })

  it('words typed while the send is on its way stay', async () => {
    const key = 'draft:session:after-3'
    const send = deferred()
    const h = harness()
    await h.render({ draftKey: key, onSend: () => send.promise })
    await h.type(SENT)
    await h.clickSend()
    await h.type('typed during the send')
    await act(async () => { send.resolve(true); await send.promise })
    await wait(1_500)
    expect(h.text()).toBe('typed during the send')
    expect(localStorage.getItem(key)).toBe('typed during the send')
    await h.unmount()
  })

  it('a failed send puts the words back in the box and the draft', async () => {
    const key = 'draft:session:after-4'
    const send = deferred()
    const h = harness()
    await h.render({ draftKey: key, onSend: () => send.promise })
    await h.type(SENT)
    await h.clickSend()
    await act(async () => { send.resolve(false); await send.promise })
    await wait(1_500)
    expect(h.text()).toBe(SENT)
    expect(localStorage.getItem(key)).toBe(SENT)
    await h.unmount()
  })

  it('a reload while the send is on its way keeps the exact words being sent', async () => {
    const key = 'draft:session:after-5'
    const send = deferred()
    const h = harness()
    await h.render({ draftKey: key, onSend: () => send.promise })
    await h.type(SENT)
    await h.clickSend()
    expect(localStorage.getItem(key)).toBe(SENT)
    await h.unmount()
  })
})

// useDraft boxes (the Org bar, a Kanban card, a question's answer) share the rule.
describe('useDraft boxes', () => {
  function draftHarness(key: string) {
    const el = doc.createElement('div')
    doc.body.appendChild(el)
    const root = createRoot(el as unknown as Element)
    const ref: { current: DraftHandle | null } = { current: null }
    const Probe = () => { ref.current = useDraft(key); return null }
    return {
      ref,
      async mount() { await act(async () => { root.render(createElement(Probe)) }) },
      async unmount() { await act(async () => { root.unmount() }) },
    }
  }

  it('a save another box of the key owed from before the send does not bring the sent words back', async () => {
    const key = 'draft:session:use-draft-1'
    const a = draftHarness(key)
    const b = draftHarness(key)
    await a.mount()
    await b.mount()
    await act(async () => { b.ref.current!.setText(SENT) })   // typed in box B: a save is owed
    await act(async () => { a.ref.current!.clear(key, SENT) }) // sent from box A
    await b.unmount()                                          // B's unmount flush
    await wait(1_500)
    expect(localStorage.getItem(key)).toBeNull()
    await a.unmount()
  })

  it('a reload flush does not save the sent words another box still shows', async () => {
    const key = 'draft:session:use-draft-2'
    const a = draftHarness(key)
    const b = draftHarness(key)
    await a.mount()
    await b.mount()
    await act(async () => { a.ref.current!.setText(SENT) })
    await wait(500)
    expect(b.ref.current!.text).toBe(SENT)
    // Box B is focused, so the removal of the sent draft does not change what it shows.
    const focused = doc.createElement('textarea')
    focused.setAttribute('data-draft-key', key)
    Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => focused })
    try {
      await act(async () => { a.ref.current!.clear(key, SENT) })
      expect(b.ref.current!.text).toBe(SENT)
      const detail: DraftFlushDetail = { scope: 'reload', claims: [] }
      window.dispatchEvent(new (window as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent(DRAFT_FLUSH_EVENT, { detail }))
    } finally {
      delete (doc as unknown as Record<string, unknown>).activeElement
    }
    expect(localStorage.getItem(key)).toBeNull()
    await a.unmount()
    await b.unmount()
  })
})

// A failed send, then Retry: the restored words went out with the Retry.
describe('a failed send that its Retry sent never comes back as the draft', () => {
  beforeEach(() => { rpc.sends.length = 0; rpc.answers.length = 0; rpc.queues = {} })

  function focusOn(node: unknown) { Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => node }) }
  function unfocus() { delete (doc as unknown as Record<string, unknown>).activeElement }
  function reloadFlush() {
    const detail: DraftFlushDetail = { scope: 'reload', claims: [] }
    window.dispatchEvent(new (window as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent(DRAFT_FLUSH_EVENT, { detail }))
  }

  /** The session panel's send path: the composer's words, with their draft origin, into useSessionSend. */
  function panelHarness(sessionId: string) {
    const el = doc.createElement('div')
    doc.body.appendChild(el)
    let root: Root | null = null
    const hook: { current: ReturnType<typeof useSessionSend> | null } = { current: null }
    const origins: Array<DraftOrigin | undefined> = []
    function Panel({ draftKey }: { draftKey: string }) {
      const s = useSessionSend(sessionId)
      hook.current = s
      return createElement(ChatInput, {
        draftKey,
        onSend: (text: string, _images?: unknown, origin?: DraftOrigin) => {
          origins.push(origin)
          return s.send(sessionId, text, undefined, origin ? { draftOrigin: origin } : undefined)
        },
      } as Props)
    }
    const box = () => el.querySelector('textarea') as unknown as HTMLTextAreaElement
    return {
      hook, origins, box,
      text: () => box().value,
      mountedText: () => box().defaultValue ?? '',
      async render(draftKey: string) {
        if (!root) root = createRoot(el as unknown as Element)
        await act(async () => { root!.render(createElement(Panel, { draftKey })) })
      },
      async unmount() { await act(async () => { root!.unmount() }); root = null },
      async type(text: string) { await act(async () => { reactProps(box() as unknown as Element).onChange!({ target: { value: text } }) }) },
      async clickSend() { await act(async () => { reactProps(el.querySelector('.chat-send-btn-icon')!).onClick!() }) },
      failedRow() {
        const row = hook.current!.optimisticMsgs.find((m) => m.status === 'failed')
        if (!row) throw new Error('no failed row')
        return row
      },
      async retry(queueId: string) { await act(async () => { hook.current!.retryFailed(queueId, sessionId) }); await wait(10) },
    }
  }

  it('a rejected send that its Retry sent empties the focused composer, the draft and the server copy, for good', async () => {
    const sid = 'retry-1'
    const key = `draft:session:${sid}`
    rpc.answers.push('reject', 'ok')
    const h = panelHarness(sid)
    await h.render(key)
    await h.type(SENT)
    focusOn(h.box())
    try {
      await h.clickSend()
      await wait(10)
      expect(h.text()).toBe(SENT)                // the failure put the words back
      expect(localStorage.getItem(key)).toBe(SENT)
      const row = h.failedRow()
      expect(row.draftOrigin).toEqual({ key, text: SENT, sent: expect.any(Number) })
      await h.retry(row.queueId)                 // inside the restore's owed 300 ms save
      expect(rpc.sends[1]).toMatchObject({ sessionId: sid, message: SENT, retryOf: row.queueId })
      expect(h.text()).toBe('')
      await wait(1_500)
      expect(h.text()).toBe('')
      expect(localStorage.getItem(key)).toBeNull()
      expect(lastMirrored(key)?.v ?? null).toBeNull()
      // A reload flush of a box that still shows them keeps nothing.
      h.box().value = SENT
      reloadFlush()
      expect(localStorage.getItem(key)).toBeNull()
    } finally {
      unfocus()
    }
    await h.unmount()
    await h.render(key)
    expect(h.mountedText()).toBe('')
    // The same words typed again after the Retry are a new draft.
    await h.type(SENT)
    await wait(1_500)
    expect(localStorage.getItem(key)).toBe(SENT)
    await h.unmount()
  })

  it('the draft origin rides the bubble only, never a session:send payload', async () => {
    const sid = 'retry-wire'
    rpc.answers.push('reject', 'ok', 'ok')
    const h = panelHarness(sid)
    await h.render(`draft:session:${sid}`)
    await h.type(SENT)
    await h.clickSend()
    await wait(10)
    await h.retry(h.failedRow().queueId)
    const origin = h.origins[0]!
    await act(async () => { await h.hook.current!.interruptSend(sid, 'interrupting words', undefined, { draftOrigin: origin }) })
    expect(rpc.sends).toHaveLength(3)
    for (const payload of rpc.sends) {
      expect(Object.keys(payload)).not.toContain('draftOrigin')
      expect(JSON.stringify(payload)).not.toContain(origin.key)
    }
    await h.unmount()
  })

  it('a Retry that fails, or a Dismiss, keeps the restored words', async () => {
    const sid = 'retry-2'
    const key = `draft:session:${sid}`
    rpc.answers.push('reject', 'reject')
    const h = panelHarness(sid)
    await h.render(key)
    await h.type(SENT)
    await h.clickSend()
    await wait(10)
    const row = h.failedRow()
    await h.retry(row.queueId)
    await wait(1_500)
    expect(h.failedRow().queueId).toBe(row.queueId)
    expect(h.text()).toBe(SENT)
    expect(localStorage.getItem(key)).toBe(SENT)
    await act(async () => { h.hook.current!.dismissFailed(row.queueId) })
    await wait(1_500)
    expect(h.text()).toBe(SENT)
    expect(localStorage.getItem(key)).toBe(SENT)
    await h.unmount()
    await h.render(key)
    expect(h.mountedText()).toBe(SENT)
    await h.unmount()
  })

  it('words typed after the restore stay, the same words typed again included', async () => {
    const sid = 'retry-3'
    const key = `draft:session:${sid}`
    rpc.answers.push('reject', 'ok')
    const h = panelHarness(sid)
    await h.render(key)
    await h.type(SENT)
    await h.clickSend()
    await wait(10)
    await h.type(`${SENT} Edited.`)
    await h.type(SENT)                           // back to the very same words, typed
    focusOn(h.box())
    try {
      await h.retry(h.failedRow().queueId)
      await wait(1_500)
    } finally {
      unfocus()
    }
    expect(h.text()).toBe(SENT)
    expect(localStorage.getItem(key)).toBe(SENT)
    await h.unmount()
  })

  it('a Retry leaves the words of another question or session alone', async () => {
    const sid = 'retry-4'
    const key = `draft:session:${sid}`
    const other = `draft:session:${sid}:another-question`
    rpc.answers.push('reject', 'ok')
    const h = panelHarness(sid)
    await h.render(key)
    await h.type(SENT)
    await h.clickSend()
    await wait(10)
    await h.render(other)                        // the box moves on with the restored words kept
    expect(localStorage.getItem(key)).toBe(SENT)
    await h.type('words for the other question')
    focusOn(h.box())
    try {
      await h.retry(h.failedRow().queueId)
      await wait(1_500)
    } finally {
      unfocus()
    }
    expect(h.text()).toBe('words for the other question')
    expect(localStorage.getItem(other)).toBe('words for the other question')
    expect(localStorage.getItem(key)).toBeNull()  // the restored words were sent
    await h.unmount()
  })

  it('a failed send never overwrites words typed while it was on its way, and its Retry leaves them', async () => {
    const sid = 'retry-5'
    const key = `draft:session:${sid}`
    let refuse!: () => void
    rpc.answers.push(new Promise<'reject'>((r) => { refuse = () => r('reject') }), 'ok')
    const h = panelHarness(sid)
    await h.render(key)
    await h.type(SENT)
    await h.clickSend()
    await wait(10)
    await h.type('typed during the send')
    await act(async () => { refuse() })
    await wait(1_500)
    expect(h.text()).toBe('typed during the send')
    expect(localStorage.getItem(key)).toBe('typed during the send')
    await h.retry(h.failedRow().queueId)
    await wait(1_500)
    expect(h.text()).toBe('typed during the send')
    expect(localStorage.getItem(key)).toBe('typed during the send')
    await h.unmount()
  })

  it('a box emptied while the send was on its way stays empty when the send fails', async () => {
    const sid = 'retry-6'
    const key = `draft:session:${sid}`
    let refuse!: () => void
    rpc.answers.push(new Promise<'reject'>((r) => { refuse = () => r('reject') }))
    const h = panelHarness(sid)
    await h.render(key)
    await h.type(SENT)
    await h.clickSend()
    await wait(10)
    await h.type('x')
    await h.type('')
    await act(async () => { refuse() })
    await wait(1_500)
    expect(h.text()).toBe('')
    expect(localStorage.getItem(key)).toBeNull()
    await h.unmount()
  })

  it('a delivery that names the failed message settles its restored words too', async () => {
    const sid = 'retry-7'
    const key = `draft:session:${sid}`
    rpc.answers.push('reject')
    const h = panelHarness(sid)
    await h.render(key)
    await h.type(SENT)
    await h.clickSend()
    await wait(10)
    expect(h.text()).toBe(SENT)
    await act(async () => { h.hook.current!.handleMessagesDelivered(1, [h.failedRow().queueId]) })
    await wait(1_500)
    expect(h.text()).toBe('')
    expect(localStorage.getItem(key)).toBeNull()
    await h.unmount()
  })

  it('the same words written in another tab after the restore are that tab\'s draft: the Retry leaves them', async () => {
    const sid = 'retry-8'
    const key = `draft:session:${sid}`
    rpc.answers.push('reject', 'ok')
    const h = panelHarness(sid)
    await h.render(key)
    await h.type(SENT)
    await h.clickSend()
    await wait(1_000)
    rawLocalStorage.set(key, SENT)
    window.dispatchEvent(Object.assign(new (window as unknown as { Event: typeof Event }).Event('storage'), { key }))
    await h.retry(h.failedRow().queueId)
    await wait(1_500)
    expect(h.text()).toBe(SENT)
    expect(localStorage.getItem(key)).toBe(SENT)
    await h.unmount()
  })

  // A remount of the panel, in this module: a fresh page load (module state gone) is the WebKit spec's to show.
  describe('a refused send the server took after all, across a remount', () => {
    const FAILED = 'walnut-failed-drafts'
    const records = () => JSON.parse(rawLocalStorage.get(FAILED) ?? '[]') as Array<Record<string, unknown>>
    // Earlier cases' records go, the way another tab's clear reaches this one.
    beforeEach(() => {
      rawLocalStorage.remove(FAILED)
      window.dispatchEvent(Object.assign(new (window as unknown as { Event: typeof Event }).Event('storage'), { key: FAILED }))
    })

    /** A composer send refused at the RPC; the server queued it anyway as `qm-server-<sid>`. */
    async function refusedThenQueued(sid: string) {
      const key = `draft:session:${sid}`
      rpc.answers.push('reject')
      const h = panelHarness(sid)
      await h.render(key)
      await h.type(SENT)
      await h.clickSend()
      await wait(1_000)
      const uuid = rpc.sends[0]!.userUuid as string
      expect(uuid).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/))
      expect(localStorage.getItem(key)).toBe(SENT)
      rpc.queues[sid] = [{ id: `qm-server-${sid}`, message: SENT, status: 'pending', userUuid: uuid }]
      return { h, key, uuid, queueId: `qm-server-${sid}` }
    }
    /** The panel mounts again and reads the server's queue. */
    async function remount(h: ReturnType<typeof panelHarness>, key: string) {
      await h.unmount()
      await h.render(key)
      await wait(10)
    }

    it('the ownership is kept local, by session and user-line uuid, without the words', async () => {
      const { h, key, uuid } = await refusedThenQueued('owned-1')
      expect(records()).toEqual([{ sid: 'owned-1', uuid, key, hash: expect.any(String), stamp: expect.any(Number) }])
      expect(rawLocalStorage.get(FAILED)).not.toContain(SENT)
      expect(isDraftKey(FAILED)).toBe(false)
      expect(FAILED.startsWith('open-walnut-') || FAILED.startsWith('walnut-todo-')).toBe(false)
      await wait(1_500)
      expect(JSON.stringify(net.puts)).not.toContain(FAILED)
      await h.unmount()
    })

    it('a remounted panel\'s queued row owns the restored draft, and its Retry empties it', async () => {
      const { h, key, queueId } = await refusedThenQueued('owned-2')
      await remount(h, key)
      expect(h.mountedText()).toBe(SENT)
      const row = h.hook.current!.optimisticMsgs.find((m) => m.queueId === queueId)!
      expect(row.draftOrigin).toMatchObject({ key, text: SENT })
      rpc.answers.push('ok')
      await h.retry(queueId)
      await wait(1_500)
      expect(localStorage.getItem(key)).toBeNull()
      expect(records()).toEqual([])
      await remount(h, key)
      expect(h.mountedText()).toBe('')
      await h.unmount()
    })

    it('a late delivery naming the queued row after a remount settles it the same way', async () => {
      const { h, key, queueId } = await refusedThenQueued('owned-3')
      await remount(h, key)
      await act(async () => { h.hook.current!.handleMessagesDelivered(1, [queueId]) })
      await wait(1_500)
      expect(localStorage.getItem(key)).toBeNull()
      await h.unmount()
    })

    it('history holding its user line settles it too', async () => {
      const { h, key, uuid } = await refusedThenQueued('owned-4')
      rpc.queues['owned-4'] = []
      await remount(h, key)
      await act(async () => { settleConfirmedDrafts('owned-4', [{ role: 'user', msgId: 'another-line' }, { role: 'user', msgId: uuid }]) })
      await wait(1_500)
      expect(localStorage.getItem(key)).toBeNull()
      expect(records()).toEqual([])
      await h.unmount()
    })

    it('words edited before a remount, back to the very same words, stay the user\'s', async () => {
      const { h, key, queueId } = await refusedThenQueued('owned-5')
      await h.type(`${SENT} Edited.`)
      await h.type(SENT)
      await wait(1_000)
      expect(records()).toEqual([])
      await remount(h, key)
      const row = h.hook.current!.optimisticMsgs.find((m) => m.queueId === queueId)!
      expect(row.draftOrigin).toBeUndefined()
      rpc.answers.push('ok')
      await h.retry(queueId)
      await wait(1_500)
      expect(localStorage.getItem(key)).toBe(SENT)
      await h.unmount()
    })

    it('the same words written by another tab after the refusal are that tab\'s: no ownership after a remount', async () => {
      const { h, key, queueId } = await refusedThenQueued('owned-6')
      // The other tab's write stamps the shared draft META, as its own mirror does.
      const meta = JSON.parse(rawLocalStorage.get('walnut-drafts-meta') ?? '{}') as Record<string, number>
      rawLocalStorage.set('walnut-drafts-meta', JSON.stringify({ ...meta, [key]: (meta[key] ?? 0) + 5_000 }))
      window.dispatchEvent(Object.assign(new (window as unknown as { Event: typeof Event }).Event('storage'), { key }))
      await remount(h, key)
      expect(h.hook.current!.optimisticMsgs.find((m) => m.queueId === queueId)!.draftOrigin).toBeUndefined()
      expect(localStorage.getItem(key)).toBe(SENT)
      await h.unmount()
    })

    it('a refusal the server has no row for: after a remount only the draft, no made-up row', async () => {
      const { h, key } = await refusedThenQueued('owned-7')
      rpc.queues['owned-7'] = []
      await remount(h, key)
      expect(h.hook.current!.optimisticMsgs).toEqual([])
      expect(h.mountedText()).toBe(SENT)
      expect(localStorage.getItem(key)).toBe(SENT)
      await h.unmount()
    })

    it('reading the queue again (twice) keeps the failed bubble\'s own origin, and its Retry still settles', async () => {
      const sid = 'owned-9'
      const key = `draft:session:${sid}`
      rpc.answers.push('reject')
      const h = panelHarness(sid)
      await h.render(key)
      await h.type(SENT)
      await h.clickSend()
      await wait(10)
      const row = h.failedRow()
      const uuid = rpc.sends[0]!.userUuid as string
      expect(adoptFailedDraft(sid, uuid)).toBe(row.draftOrigin)
      expect(adoptFailedDraft(sid, uuid)).toBe(row.draftOrigin)
      rpc.answers.push('ok')
      await h.retry(row.queueId)
      await wait(1_500)
      expect(localStorage.getItem(key)).toBeNull()
      await h.unmount()
    })

    it('words typed after the refusal are not taken back by the queue or history', async () => {
      const sid = 'owned-10'
      const key = `draft:session:${sid}`
      rpc.answers.push('reject')
      const h = panelHarness(sid)
      await h.render(key)
      await h.type(SENT)
      await h.clickSend()
      await wait(10)
      const uuid = rpc.sends[0]!.userUuid as string
      await h.type('more words')
      expect(adoptFailedDraft(sid, uuid)).toBeUndefined()
      await act(async () => { settleConfirmedDrafts(sid, [{ role: 'user', msgId: uuid }]) })
      await wait(1_500)
      expect(h.text()).toBe('more words')
      expect(localStorage.getItem(key)).toBe('more words')
      await h.unmount()
    })

    it('a record left by an earlier page: adopted only on a key this page never touched, the stamp and words exact', () => {
      const fresh = (name: string) => {
        const key = `draft:session:${name}`
        localStorage.setItem(key, SENT)       // the draft store stamps its META
        const stamp = (JSON.parse(rawLocalStorage.get('walnut-drafts-meta') ?? '{}') as Record<string, number>)[key]!
        const list = records()
        rawLocalStorage.set(FAILED, JSON.stringify([...list, { sid: name, uuid: `uuid-${name}`, key, hash: draftHash(SENT), stamp }]))
        return key
      }
      const kept = fresh('fresh-1')
      const origin = adoptFailedDraft('fresh-1', 'uuid-fresh-1')!
      expect(origin).toMatchObject({ key: kept, text: SENT })
      expect(settleRetriedDraft(origin)).toBe(true)
      expect(localStorage.getItem(kept)).toBeNull()
      // A picture add starting (or typing) is a revision: the record goes.
      const picked = fresh('fresh-2')
      draftSaveMark(picked)
      expect(adoptFailedDraft('fresh-2', 'uuid-fresh-2')).toBeUndefined()
      expect(records().some((r) => r.sid === 'fresh-2')).toBe(false)
      // Another tab's write, as an event: no new origin over it, and the record is not judged.
      const external = fresh('fresh-3')
      window.dispatchEvent(Object.assign(new (window as unknown as { Event: typeof Event }).Event('storage'), { key: external }))
      expect(adoptFailedDraft('fresh-3', 'uuid-fresh-3')).toBeUndefined()
      expect(records().some((r) => r.sid === 'fresh-3')).toBe(true)
      expect(localStorage.getItem(external)).toBe(SENT)
      // A malformed record is no record.
      rawLocalStorage.set(FAILED, JSON.stringify([{ sid: 'fresh-4', uuid: 'uuid-fresh-4', key: 'k', hash: 1, stamp: 'x' }]))
      expect(adoptFailedDraft('fresh-4', 'uuid-fresh-4')).toBeUndefined()
    })

    it('a storage that cannot be read still gets the words back in the box; a Retry then clears nothing', async () => {
      const sid = 'owned-11'
      const key = `draft:session:${sid}`
      let refuse!: () => void
      rpc.answers.push(new Promise<'reject'>((r) => { refuse = () => r('reject') }))
      const h = panelHarness(sid)
      await h.render(key)
      await h.type(SENT)
      await h.clickSend()
      await wait(10)
      const read = localStorage.getItem.bind(localStorage)
      const off = vi.spyOn(localStorage, 'getItem').mockImplementation((k: string) => { if (k === key) throw new Error('storage off'); return read(k) })
      try {
        await act(async () => { refuse() })
        await wait(10)
        expect(h.text()).toBe(SENT)
        expect(records()).toEqual([])
        rpc.answers.push('ok')
        await h.retry(h.failedRow().queueId)
        await wait(1_500)
        expect(h.text()).toBe(SENT)
      } finally {
        off.mockRestore()
      }
      expect(localStorage.getItem(key)).toBe(SENT)
      await h.unmount()
    })

    it('the same words saved by another tab whose event has not arrived yet: the Retry keeps them', async () => {
      const sid = 'owned-12'
      const key = `draft:session:${sid}`
      rpc.answers.push('reject')
      const h = panelHarness(sid)
      await h.render(key)
      await h.type(SENT)
      await h.clickSend()
      await wait(10)
      const meta = JSON.parse(rawLocalStorage.get('walnut-drafts-meta') ?? '{}') as Record<string, number>
      rawLocalStorage.set('walnut-drafts-meta', JSON.stringify({ ...meta, [key]: (meta[key] ?? 0) + 5_000 }))
      rpc.answers.push('ok')
      await h.retry(h.failedRow().queueId)
      await wait(1_500)
      expect(h.text()).toBe(SENT)
      expect(localStorage.getItem(key)).toBe(SENT)
      await h.unmount()
    })

    it('Dismiss gives up the ownership and keeps the draft', async () => {
      const sid = 'owned-8'
      const key = `draft:session:${sid}`
      rpc.answers.push('reject')
      const h = panelHarness(sid)
      await h.render(key)
      await h.type(SENT)
      await h.clickSend()
      await wait(10)
      await act(async () => { h.hook.current!.dismissFailed(h.failedRow().queueId) })
      expect(records()).toEqual([])
      expect(adoptFailedDraft(sid, rpc.sends[0]!.userUuid as string)).toBeUndefined()
      expect(localStorage.getItem(key)).toBe(SENT)
      await h.unmount()
    })

    it('a picture add started after the refusal: the queue and history take nothing back', async () => {
      const sid = 'owned-13'
      const key = `draft:session:${sid}`
      rpc.answers.push('reject')
      const h = panelHarness(sid)
      await h.render(key)
      await h.type(SENT)
      await h.clickSend()
      await wait(10)
      const uuid = rpc.sends[0]!.userUuid as string
      draftSaveMark(key)                          // what a picture add marks as it starts
      expect(adoptFailedDraft(sid, uuid)).toBeUndefined()
      await act(async () => { settleConfirmedDrafts(sid, [{ role: 'user', msgId: uuid }]) })
      await wait(1_500)
      expect(h.text()).toBe(SENT)
      expect(localStorage.getItem(key)).toBe(SENT)
      await h.unmount()
    })
  })

  describe('the question card (ThreadCommentCard)', () => {
    function cardHarness(key: string) {
      for (const tag of ['div', 'textarea', 'button']) {
        const proto = Object.getPrototypeOf(doc.createElement(tag)) as Record<string, unknown>
        proto.scrollIntoView ??= () => {}
        proto.focus ??= () => {}
      }
      // The card puts the caret after a kept draft's words (setSelectionRange): linkedom's textarea has no selection API.
      const area = Object.getPrototypeOf(doc.createElement('textarea')) as Record<string, unknown>
      area.setSelectionRange ??= function (this: { selectionStart?: number; selectionEnd?: number }, start: number, end: number) { this.selectionStart = start; this.selectionEnd = end }
      class Reader {
        result: string | null = null
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        readAsDataURL() { queueMicrotask(() => { this.result = 'data:image/png;base64,AAAA'; this.onload?.() }) }
      }
      vi.stubGlobal('FileReader', Reader)
      const el = doc.createElement('div')
      doc.body.appendChild(el)
      const root = createRoot(el as unknown as Element)
      const origins: Array<DraftOrigin | undefined> = []
      const props = {
        threadKey: 'q-1', draft: false, number: '1', title: 'A question', status: undefined, unread: false,
        answering: false, canAsk: true, draftKey: key, style: { top: 0, left: 0, width: 320, maxHeight: 400 },
        onClose: () => {},
        onSend: async (_t: string, _i?: unknown, origin?: DraftOrigin) => { origins.push(origin); return false },
      }
      const q = (sel: string) => el.querySelector(sel)!
      return {
        origins,
        async mount() { await act(async () => { root.render(createElement(ThreadCommentCard, props as Parameters<typeof ThreadCommentCard>[0])) }) },
        async unmount() { await act(async () => { root.unmount() }) },
        text: () => (q('.thread-card-input') as unknown as HTMLTextAreaElement).value,
        pictures: () => el.querySelectorAll('.thread-card-pictures .chat-image-preview').length,
        async type(text: string) { await act(async () => { reactProps(q('.thread-card-input')).onChange!({ target: { value: text } }) }) },
        async addPicture() {
          const input = q('[data-testid="thread-card-attach-file"]')
          await act(async () => { reactProps(input).onChange!({ target: { files: [{ type: 'image/png', name: 'p.png' }], value: '' } }) })
          await wait(10)
        },
        async removePicture() { await act(async () => { reactProps(q('.chat-image-remove')).onClick!() }) },
        async send() { await act(async () => { reactProps(q('.thread-card-send')).onClick!() }); await wait(10) },
      }
    }

    it('a refused send with a picture, untouched, is emptied with its picture by the Retry', async () => {
      const key = 'draft:session:retry-card-pictures-1'
      const c = cardHarness(key)
      await c.mount()
      await c.type(SENT)
      await c.addPicture()
      await c.send()
      expect(c.text()).toBe(SENT)
      expect(c.pictures()).toBe(1)
      await act(async () => { expect(settleRetriedDraft(c.origins[0]!)).toBe(true) })
      expect(c.text()).toBe('')
      expect(c.pictures()).toBe(0)
      await c.unmount()
    })

    it('a picture still being read when the Retry is sent already counts as an edit', async () => {
      const key = 'draft:session:retry-card-pictures-reading'
      const c = cardHarness(key)
      await c.mount()
      await c.type(SENT)
      await c.send()
      vi.stubGlobal('FileReader', class { onload = null; onerror = null; readAsDataURL() { /* never finishes */ } })
      await c.addPicture()
      await act(async () => { expect(settleRetriedDraft(c.origins[0]!)).toBe(false) })
      expect(c.text()).toBe(SENT)
      expect(localStorage.getItem(key)).toBe(SENT)
      await c.unmount()
    })

    it('a picture added or removed after the refusal is an edit: the Retry leaves the card as it is', async () => {
      for (const edit of ['add', 'remove'] as const) {
        const key = `draft:session:retry-card-pictures-${edit}`
        const c = cardHarness(key)
        await c.mount()
        await c.type(SENT)
        await c.addPicture()
        await c.send()
        if (edit === 'add') await c.addPicture()
        else await c.removePicture()
        await act(async () => { expect(settleRetriedDraft(c.origins[0]!)).toBe(false) })
        await wait(1_500)
        expect(c.text()).toBe(SENT)
        expect(c.pictures()).toBe(edit === 'add' ? 2 : 0)
        expect(localStorage.getItem(key)).toBe(SENT)
        await c.unmount()
      }
    })
  })

  it('a card\'s box (useDraft) empties when the Retry is sent, focused, unless typed in since', async () => {
    const key = 'draft:session:retry-card'
    const el = doc.createElement('div')
    doc.body.appendChild(el)
    const root = createRoot(el as unknown as Element)
    const ref: { current: DraftHandle | null } = { current: null }
    const Probe = () => { ref.current = useDraft(key); return null }
    await act(async () => { root.render(createElement(Probe)) })
    const focused = doc.createElement('textarea')
    focused.setAttribute('data-draft-key', key)
    focusOn(focused)
    try {
      await act(async () => { ref.current!.setText(SENT) })
      const first = draftOriginOf(key, SENT)       // sent; refused
      await act(async () => { ref.current!.flush(); claimFailedDraft(first) })
      await act(async () => { ref.current!.setText(SENT) })   // typed again
      expect(settleRetriedDraft(first)).toBe(false)
      expect(ref.current!.text).toBe(SENT)
      const second = draftOriginOf(key, SENT)      // sent again; refused
      await act(async () => { ref.current!.flush(); claimFailedDraft(second) })
      await act(async () => { expect(settleRetriedDraft(second)).toBe(true) })
      expect(ref.current!.text).toBe('')
      await wait(1_500)
      expect(localStorage.getItem(key)).toBeNull()
    } finally {
      unfocus()
    }
    await act(async () => { root.unmount() })
  })

  it('a refused first send\'s draft row goes once its Retry is sent, and only when its words went', async () => {
    const sid = 'retry-ask'
    const tree = emptyThreadTree()
    const page = { pageKey: pendingPageKey('msg-a', 'a passage'), parentKey: ROOT_THREAD_KEY, parentMsgId: 'msg-a', title: 'A passage' }
    const edited = { pageKey: pendingPageKey('msg-b', 'another passage'), parentKey: ROOT_THREAD_KEY, parentMsgId: 'msg-b', title: 'Another passage' }
    const keyA = composerDraftKey(sid, page.pageKey, tree)
    const keyB = composerDraftKey(sid, edited.pageKey, tree)
    const args = {
      sessionId: sid, tree, anchors: [], hiddenKeys: new Set<string>(), metaIndex: new Map(), panelRef: { current: null },
      stackView: true, composer: { focused: () => false, text: () => '' }, toast: { show() {}, dismiss() {} }, focusComposer() {},
    }
    const el = doc.createElement('div')
    doc.body.appendChild(el)
    const root = createRoot(el as unknown as Element)
    const stack: { current: ThreadStackHandle | null } = { current: null }
    const Probe = () => { stack.current = useThreadStack(args); return null }
    await act(async () => { root.render(createElement(Probe)) })
    localStorage.setItem(keyA, SENT)
    localStorage.setItem(keyB, 'another ask')
    const originA = draftOriginOf(keyA, SENT)
    const originB = draftOriginOf(keyB, 'another ask')
    await act(async () => {
      stack.current!.settlePending(page, false)
      stack.current!.settlePending(edited, false)
      claimFailedDraft(originA)
      claimFailedDraft(originB)
    })
    expect(stack.current!.api.draftPages.map((d) => d.pageKey).sort()).toEqual([page.pageKey, edited.pageKey].sort())
    // Words typed for the second Ask after its refusal: its row and words stay.
    draftSaveMark(keyB)
    localStorage.setItem(keyB, 'another ask, edited')
    await act(async () => {
      expect(settleRetriedDraft(originA)).toBe(true)
      expect(settleRetriedDraft(originB)).toBe(false)
    })
    await wait(10)
    expect(stack.current!.api.draftPages.map((d) => d.pageKey)).toEqual([edited.pageKey])
    expect(localStorage.getItem(keyA)).toBeNull()
    expect(localStorage.getItem(keyB)).toBe('another ask, edited')
    expect(settleRetriedDraft(originA)).toBe(false)   // a second Retry answer settles nothing
    await act(async () => { root.unmount() })
  })
})

// The class guard: every writer of a draft key either carries a mark (and checks
// discardedSince) or checks isSentDraftCopy, and every box that clears a draft
// after a send records it with markDraftSent.
describe('a sent-words copy is only a copy for a while', () => {
  it('the same words saved on another device a minute after the send are that device\'s draft', () => {
    const key = 'walnut-draft-copy-window'
    markDraftSent(key, 'yes')
    const now = Date.now()
    expect(isSentDraftCopy(key, 'yes', undefined, now + 1_000)).toBe(true)
    expect(isSentDraftCopy(key, ' yes ', undefined, now)).toBe(true)
    expect(isSentDraftCopy(key, 'yes', undefined, now + 61_000)).toBe(false)
    expect(isSentDraftCopy(key, 'no', undefined, now)).toBe(false)
  })
})

describe('every draft writer respects a send', () => {
  const root = path.resolve(import.meta.dirname, '../../web/src')
  const files: string[] = []
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(n)) files.push(p) } }
  walk(root)
  const rel = (f: string) => path.relative(root, f).split(path.sep).join('/')
  const src = (f: string) => readFileSync(f, 'utf-8')

  it('a box with a debounced draft save records its sends with markDraftSent', () => {
    const debounced = files.filter((f) => /setTimeout\(\s*flush\w*\s*,/.test(src(f)))
    expect(debounced.map(rel).sort()).toEqual(expect.arrayContaining(['components/chat/ChatInput.tsx', 'hooks/useDraft.ts']))
    for (const f of debounced) {
      expect(src(f), `${rel(f)} keeps a debounced draft save: settle a send through markDraftSent`).toMatch(/markDraftSent\(/)
    }
  })

  it('a reload flush that writes a draft checks isSentDraftCopy first', () => {
    const writers = files.filter((f) => /DRAFT_FLUSH_EVENT/.test(src(f)) && /localStorage\.setItem\(|writeDraft\(/.test(src(f)))
    expect(writers.map(rel).sort()).toEqual(expect.arrayContaining(['components/chat/ChatInput.tsx', 'hooks/useDraft.ts']))
    for (const f of writers) {
      expect(src(f), `${rel(f)} writes a draft on a reload flush: skip a copy of sent words (isSentDraftCopy)`).toMatch(/isSentDraftCopy\(/)
    }
  })

  it('the server merge never adopts a copy of sent words', () => {
    const drafts = src(path.join(root, 'utils/drafts.ts'))
    const pull = drafts.slice(drafts.indexOf('async function pull('), drafts.indexOf('let lastPullAt'))
    expect(pull).toMatch(/isSentDraftCopy\(/)
  })
})
