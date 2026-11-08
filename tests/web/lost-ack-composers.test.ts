/**
 * A send whose answer was lost while the server kept the message is an accepted
 * send in every composer: the box empties, the error line goes, Enter sends
 * nothing twice (2026-11-11 review, F3: the Files "Ask here" card's reply box
 * kept the sent words, and the session chat a red "acknowledgement was lost"
 * line, after the server had queued the message and the CLI had answered it).
 *
 * The real ChatInput, ThreadCommentCard, useSessionSend and draft store, mounted
 * by react-dom on a linkedom document. Only the socket is stubbed: its
 * `session:send` stores the row the way the server does, then loses the answer.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { parseHTML } from 'linkedom'

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

vi.mock('@/api/client', () => ({
  apiGet: vi.fn(async (p: string) => (p === '/api/drafts' ? { drafts: {} } : {})),
  apiPut: vi.fn(async () => ({})),
  apiPost: vi.fn(async () => ({})),
}))

type Answer = 'ok' | 'refused' | 'lost' | 'lost-and-gone'
const LOST = 'Acceptance acknowledgement was lost; the server kept this message.'
const server = vi.hoisted(() => ({
  answers: [] as Answer[],
  sends: [] as Array<Record<string, unknown>>,
  queues: {} as Record<string, Array<Record<string, unknown>>>,
  events: new Map<string, (data: unknown) => void>(),
}))
vi.mock('@/api/ws', () => ({
  wsClient: new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'state') return 'connected'
      if (prop === 'onEvent') return (name: string, cb: (data: unknown) => void) => { server.events.set(name, cb) }
      if (prop !== 'sendRpc') return () => () => {}
      return async (method: string, payload: Record<string, unknown>) => {
        const sid = payload.sessionId as string
        if (method === 'session:get-queue') return { messages: server.queues[sid] ?? [] }
        if (method !== 'session:send') return {}
        server.sends.push(payload)
        const answer = server.answers.shift() ?? 'ok'
        if (answer === 'refused') throw new Error('Session is not running')
        const row = { id: `qm-${sid}-${server.sends.length}`, message: payload.message, status: 'pending', userUuid: payload.userUuid }
        // 'lost-and-gone': the CLI took it at once, so the queue no longer lists it.
        if (answer !== 'lost-and-gone') (server.queues[sid] ??= []).push(row)
        if (answer === 'ok') return { messageId: row.id }
        throw new Error(LOST)
      }
    },
  }),
}))
vi.mock('../../web/src/components/common/MicButton', () => ({ MicButton: () => null }))
vi.mock('../../web/src/components/chat/MentionPalette', () => ({ MentionPalette: () => null }))
vi.mock('../../web/src/components/chat/FileMentionPopup', () => ({ FileMentionPopup: () => null }))
vi.mock('../../web/src/components/chat/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('@/commands/index', () => ({ searchCommands: () => [], getCommand: () => undefined }))
vi.mock('@/hooks/useChat', () => ({ MAX_QUEUE_SIZE: 10 }))

import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js'
import { ChatInput } from '../../web/src/components/chat/ChatInput'
import { ThreadCommentCard } from '../../web/src/components/sessions/ThreadCommentCard'
import { useSessionSend } from '../../web/src/hooks/useSessionSend'
import { initDraftSync, type DraftOrigin } from '../../web/src/utils/drafts'
import { wrapLocalStorageWrites } from '../../web/src/utils/ui-prefs-sync'

let doc: Document
beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
  ;(dom.window as unknown as Record<string, unknown>).localStorage = shim.storage
  const home = { pathname: '/', search: '', href: 'http://localhost/' }
  try { Object.defineProperty(dom.window, 'location', { configurable: true, value: home }) } catch { (dom.window as unknown as Record<string, unknown>).location = home }
  wrapLocalStorageWrites()
  await initDraftSync()
  // The card scrolls itself into view and takes focus: linkedom has neither.
  for (const tag of ['div', 'textarea', 'button']) {
    const proto = Object.getPrototypeOf(doc.createElement(tag)) as Record<string, unknown>
    proto.scrollIntoView ??= () => {}
    proto.focus ??= () => {}
  }
  // The card puts the caret after a kept draft's words (setSelectionRange): linkedom's textarea has no selection API.
  const area = Object.getPrototypeOf(doc.createElement('textarea')) as Record<string, unknown>
  area.setSelectionRange ??= function (this: { selectionStart?: number; selectionEnd?: number }, start: number, end: number) { this.selectionStart = start; this.selectionEnd = end }
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('getComputedStyle', () => ({ maxHeight: 'none' }))
  server.answers.length = 0
  server.sends.length = 0
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function reactProps(node: Element): Record<string, (...args: unknown[]) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith('__reactProps$'))
  if (!key) throw new Error('no React props on the node')
  return (node as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>)[key]!
}
async function wait(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

const WORDS = 'Is this passage still right after the refactor?'
type Hook = ReturnType<typeof useSessionSend>

/** A session panel's composer, or a question card's reply box, on the real send hook. */
function mount(sessionId: string, kind: 'chat' | 'card') {
  const el = doc.createElement('div')
  doc.body.appendChild(el)
  let root: Root | null = createRoot(el as unknown as Element)
  const hook: { current: Hook | null } = { current: null }
  const key = kind === 'chat' ? `draft:session:${sessionId}` : `draft:session:${sessionId}:pending:p-1`
  const onSend = (text: string, images?: unknown, origin?: DraftOrigin) =>
    hook.current!.send(sessionId, text, undefined, origin ? { draftOrigin: origin } : undefined)
  function Host() {
    const s = useSessionSend(sessionId)
    hook.current = s
    return kind === 'chat'
      ? createElement(ChatInput, { draftKey: key, onSend } as Parameters<typeof ChatInput>[0])
      : createElement(ThreadCommentCard, {
        threadKey: 'q-1', draft: true, number: '1', title: 'A question', status: undefined, unread: false,
        answering: false, canAsk: true, draftKey: key, style: { top: 0, left: 0, width: 320, maxHeight: 400 },
        onClose: () => {}, onSend,
      } as unknown as Parameters<typeof ThreadCommentCard>[0])
  }
  const box = () => el.querySelector(kind === 'chat' ? 'textarea' : '.thread-card-input') as unknown as HTMLTextAreaElement
  return {
    key, hook,
    text: () => box().value,
    async render() { if (!root) root = createRoot(el as unknown as Element); await act(async () => { root!.render(createElement(Host)) }) },
    async unmount() { await act(async () => { root!.unmount() }); root = null },
    async type(text: string) { await act(async () => { reactProps(box() as unknown as Element).onChange!({ target: { value: text } }) }) },
    async send() {
      const btn = el.querySelector(kind === 'chat' ? '.chat-send-btn-icon' : '.thread-card-send')!
      await act(async () => { reactProps(btn).onClick!() })
      await wait(50)
    },
    bubble() { return hook.current!.optimisticMsgs[hook.current!.optimisticMsgs.length - 1]! },
  }
}

describe.each(['chat', 'card'] as const)('the %s composer, after a lost answer', (kind) => {
  it('the server still lists the row: accepted at once, like any send', async () => {
    const sid = `${kind}-listed`
    const c = mount(sid, kind)
    await c.render()
    await c.type(WORDS)
    server.answers.push('lost')
    await c.send()
    await wait(1_500)
    expect(c.text()).toBe('')
    expect(localStorage.getItem(c.key)).toBeNull()
    expect(c.bubble()).toMatchObject({ queueId: `qm-${sid}-1`, status: 'received' })
    expect(c.bubble().failedError).toBeUndefined()
    expect(c.hook.current!.sendError).toBeNull()
    expect(server.sends).toHaveLength(1)
    await c.unmount()
  })

  it('the row is already out of the queue: refused for now, then history shows the line and it settles', async () => {
    const sid = `${kind}-history`
    const c = mount(sid, kind)
    await c.render()
    await c.type(WORDS)
    server.answers.push('lost-and-gone')
    await c.send()
    expect(c.bubble().status).toBe('failed')
    expect(c.text()).toBe(WORDS)
    expect(c.hook.current!.sendError).toBe(LOST)
    const uuid = server.sends[0]!.userUuid as string
    await act(async () => { c.hook.current!.settleShownInHistory([{ role: 'user', text: WORDS, msgId: uuid }]) })
    await wait(1_500)
    expect(c.bubble().status).toBe('delivered')
    expect(c.text()).toBe('')
    expect(localStorage.getItem(c.key)).toBeNull()
    expect(c.hook.current!.sendError).toBeNull()
    await c.unmount()
  })

  it('the queued event comes after the error: the same, and the delivery then names it', async () => {
    const sid = `${kind}-late-event`
    const c = mount(sid, kind)
    await c.render()
    await c.type(WORDS)
    server.answers.push('lost-and-gone')
    await c.send()
    expect(c.text()).toBe(WORDS)
    const uuid = server.sends[0]!.userUuid as string
    await act(async () => { server.events.get('session:message-queued')!({ sessionId: sid, messageId: 'qm-late', userUuid: uuid, message: WORDS, source: 'ui' }) })
    await wait(1_500)
    expect(c.bubble()).toMatchObject({ queueId: 'qm-late', status: 'received' })
    expect(c.text()).toBe('')
    expect(localStorage.getItem(c.key)).toBeNull()
    expect(c.hook.current!.sendError).toBeNull()
    await act(async () => { c.hook.current!.handleMessagesDelivered(1, ['qm-late']) })
    expect(c.bubble().status).toBe('delivered')
    await c.unmount()
  })

  it('a real refusal keeps the words and the error', async () => {
    const sid = `${kind}-refused`
    const c = mount(sid, kind)
    await c.render()
    await c.type(WORDS)
    server.answers.push('refused')
    await c.send()
    await wait(1_500)
    expect(c.bubble().status).toBe('failed')
    expect(c.text()).toBe(WORDS)
    expect(localStorage.getItem(c.key)).toBe(WORDS)
    expect(c.hook.current!.sendError).toBe('Session is not running')
    await c.unmount()
  })

  it('words typed after the refusal are not taken by its late proof', async () => {
    const sid = `${kind}-typed-after`
    const c = mount(sid, kind)
    await c.render()
    await c.type(WORDS)
    server.answers.push('lost-and-gone')
    await c.send()
    await c.type(`${WORDS} And one more thing.`)
    const uuid = server.sends[0]!.userUuid as string
    await act(async () => { server.events.get('session:message-queued')!({ sessionId: sid, messageId: 'qm-late2', userUuid: uuid }) })
    await wait(1_500)
    expect(c.bubble().status).toBe('received')
    expect(c.text()).toBe(`${WORDS} And one more thing.`)
    expect(c.hook.current!.sendError).toBeNull()
    await c.unmount()
  })
})
