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
 * The real ChatInput, the real draft store (drafts.ts) and the real localStorage
 * write mirror (ui-prefs-sync.ts), mounted by react-dom on a linkedom document.
 * Only the network (`@/api/client`), leaf popups and the mic are stubbed.
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
import { initDraftSync, isSentDraftCopy, markDraftSent } from '../../web/src/utils/drafts'
import { wrapLocalStorageWrites } from '../../web/src/utils/ui-prefs-sync'
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
