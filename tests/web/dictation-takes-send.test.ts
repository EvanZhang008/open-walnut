/**
 * A send names the recordings dictated into its draft (`dictationIds` on session:send), so the
 * server pairs the sent text with each take exactly (src/core/stt/compare/sent-text.ts).
 *
 * The claim rule (web/src/utils/dictation-takes.ts) first, then the real path: the real ChatInput
 * and useSessionSend mounted by react-dom on a linkedom document, the mic stubbed (its onTranscribe
 * and onTake called as the speech hook calls them), and the socket recording every payload.
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

const rpc = vi.hoisted(() => ({
  sends: [] as Array<Record<string, unknown>>,
  answers: [] as Array<'reject' | 'ok'>,
}))
vi.mock('@/api/ws', () => ({
  wsClient: new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'state') return 'connected'
      if (prop !== 'sendRpc') return () => () => {}
      return async (method: string, payload: Record<string, unknown>) => {
        if (method === 'session:get-queue') return { messages: [] }
        if (method !== 'session:send') return {}
        rpc.sends.push(payload)
        if ((rpc.answers.shift() ?? 'ok') === 'reject') throw new Error('the host did not take it')
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
import { useSessionSend } from '../../web/src/hooks/useSessionSend'
import { discardDraft, initDraftSync, type DraftOrigin } from '../../web/src/utils/drafts'
import { wrapLocalStorageWrites } from '../../web/src/utils/ui-prefs-sync'
import { _resetDictatedTakes, claimDictation, dictationField, forgetDictatedTakes, noteDictatedTake, takeWordsKept } from '../../web/src/utils/dictation-takes'
import { deliverFinalText } from '../../web/src/utils/stt-final-text'

const REC_A = '2026-11-22T10-00-00-000Z'
const REC_B = '2026-11-22T10-01-00-000Z'

const idsOf = (c: ReturnType<typeof claimDictation>) => c.dictation?.ids ?? []

describe('which recordings a draft carries', () => {
  beforeEach(() => _resetDictatedTakes())

  it('a take is still there with 3 of its word pairs and half of them; a short one only whole', () => {
    expect(takeWordsKept('deploy the cloud companion now', 'deploy the cloud companion now')).toBe(true)
    // Edited, with most of it left: 3 of its 4 pairs.
    expect(takeWordsKept('deploy the cloud companion now', 'deploy the cloud companion later')).toBe(true)
    // Edited a lot: one pair left is not the take any more.
    expect(takeWordsKept('deploy the cloud companion now', 'OK, so deploy the new one later')).toBe(false)
    expect(takeWordsKept('deploy the cloud companion to the staging box tonight', 'ok thanks')).toBe(false)
    expect(takeWordsKept('first dictation about the deploy', 'just the review part')).toBe(false)
    expect(takeWordsKept('', 'anything')).toBe(false)
    // Fewer than 3 pairs: the whole text, spaces aside.
    expect(takeWordsKept('ok', 'ok then')).toBe(true)
    expect(takeWordsKept('ship it', 'ship  it, now')).toBe(true)
    expect(takeWordsKept('ship it', 'it ships')).toBe(false)
    // CJK: neighbouring characters (test data, written as escapes).
    const cjkTake = '\u4eca\u5929\u4e0b\u5348\u5f00\u4f1a'
    expect(takeWordsKept(cjkTake, '\u4eca\u5929\u4e0b\u5348\u4e0d\u5f00\u4e86')).toBe(true)
    expect(takeWordsKept(cjkTake, '\u660e\u5929\u518d\u8bf4')).toBe(false)
  })

  it('a deleted 2-character CJK take is never claimed, though the box shares one of its characters', () => {
    noteDictatedTake('box-cjk', REC_A, '\u597d\u7684')
    expect(idsOf(claimDictation('box-cjk', '\u6211\u89c9\u5f97\u4e0d\u597d'))).toEqual([])
    noteDictatedTake('box-cjk', REC_B, '\u597d\u7684')
    expect(idsOf(claimDictation('box-cjk', '\u597d\u7684\uff0c\u8c22\u8c22'))).toEqual([REC_B])
  })

  it('names every take of its own box whose words it sends, with the box text; drops a take sent without', () => {
    noteDictatedTake('box-1', REC_A, 'first dictation about the deploy')
    noteDictatedTake('box-1', REC_B, 'second dictation about the review')
    noteDictatedTake('box-2', 'other', 'first dictation about the deploy')
    const both = 'first dictation about the deploy and second dictation about the review'
    expect(claimDictation('box-1', both).dictation).toEqual({ ids: [REC_A, REC_B], text: both })
    // Sent without A: A is dropped, B stays.
    expect(idsOf(claimDictation('box-1', 'second dictation about the review, only'))).toEqual([REC_B])
    expect(idsOf(claimDictation('box-1', both))).toEqual([REC_B])
    expect(claimDictation('box-1', 'something typed instead').dictation).toBeNull()
    expect(claimDictation(undefined, 'first dictation about the deploy').dictation).toBeNull()
  })

  it('an emptied box or a discarded draft forgets its takes', () => {
    noteDictatedTake('box-1', REC_A, 'first dictation about the deploy')
    forgetDictatedTakes('box-1')
    expect(idsOf(claimDictation('box-1', 'first dictation about the deploy'))).toEqual([])
    noteDictatedTake('draft:session:x', REC_B, 'second dictation about the review')
    discardDraft('draft:session:x')
    expect(idsOf(claimDictation('draft:session:x', 'second dictation about the review'))).toEqual([])
  })

  it('an accepted send settles its takes; a take dictated after the claim stays for the next send', () => {
    noteDictatedTake('box-1', REC_A, 'first words')
    const claim = claimDictation('box-1', 'first words')
    noteDictatedTake('box-1', REC_B, 'later words')
    claim.settle()
    expect(idsOf(claimDictation('box-1', 'first words later words'))).toEqual([REC_B])
  })

  it('the RPC fields are absent for none, so an older server sees the same payload', () => {
    expect(dictationField(null)).toEqual({})
    expect(dictationField(undefined)).toEqual({})
    expect(dictationField({ ids: [REC_A], text: 'box words' })).toEqual({ dictationIds: [REC_A], dictationText: 'box words' })
  })
})

describe('the final text of a take into its box', () => {
  it('a preview the consumer kept (edited, or another dictation took over): the take did not land', () => {
    const written: string[] = []
    const cb = (swap: boolean) => ({ onTranscribe: (t: string) => { written.push(t) }, onRefine: () => swap })
    expect(deliverFinalText('the whole clip', 'the whole', cb(false))).toBe(false)
    expect(deliverFinalText('the whole clip', 'the whole', cb(true))).toBe(true)
    expect(deliverFinalText('the whole clip', null, cb(false))).toBe(true)
    expect(written).toEqual(['the whole clip'])
    // A consumer that cannot refine gets the final text written.
    expect(deliverFinalText('the whole clip', 'the whole', { onTranscribe: (t) => { written.push(t) } })).toBe(true)
    expect(written).toEqual(['the whole clip', 'the whole clip'])
  })
})

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
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('getComputedStyle', () => ({ maxHeight: 'none' }))
  rpc.sends.length = 0
  rpc.answers.length = 0
  _resetDictatedTakes()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

type Props = Parameters<typeof ChatInput>[0]

function reactProps(node: Element): Record<string, (...args: unknown[]) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith('__reactProps$'))
  if (!key) throw new Error('no React props on the node')
  return (node as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>)[key]!
}

async function wait(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

/** The session panel's send path: the composer's words, with their draft origin, into useSessionSend. */
/** `frame`: what the parent adds around the box's words before the send (a thread's back-to-question line). */
function panel(sessionId: string, frame: (text: string) => string = (t) => t) {
  const el = doc.createElement('div')
  doc.body.appendChild(el)
  let root: Root | null = null
  const hook: { current: ReturnType<typeof useSessionSend> | null } = { current: null }
  function Panel({ draftKey }: { draftKey: string }) {
    const s = useSessionSend(sessionId)
    hook.current = s
    return createElement(ChatInput, {
      draftKey,
      onSend: (text: string, _images?: unknown, origin?: DraftOrigin) => s.send(sessionId, frame(text), undefined, origin ? { draftOrigin: origin } : undefined),
    } as Props)
  }
  const box = () => el.querySelector('textarea') as unknown as HTMLTextAreaElement
  return {
    hook,
    text: () => box().value,
    async render(draftKey: string) {
      root = createRoot(el as unknown as Element)
      await act(async () => { root!.render(createElement(Panel, { draftKey })) })
    },
    async unmount() { await act(async () => { root!.unmount() }) },
    async type(text: string) { await act(async () => { reactProps(box() as unknown as Element).onChange!({ target: { value: text } }) }) },
    /** A take lands as the speech hook delivers it: the words, then the recording's id. */
    async dictate(id: string, words: string) {
      await act(async () => { mic.props!.onTranscribe!(words); mic.props!.onTake!(id, words) })
    },
    async clickSend() { await act(async () => { reactProps(el.querySelector('.chat-send-btn-icon')!).onClick!() }); await wait(10) },
  }
}

describe('the composer names its dictations on the send', () => {
  it('one dictation, edited before the send: its id rides the send', async () => {
    const h = panel('dict-1')
    await h.render('draft:session:dict-1')
    await h.dictate(REC_A, 'please restart the cloud companion before the demo')
    await h.type('Please restart the companion before the demo, then ping me.')
    await h.clickSend()
    expect(rpc.sends[0]).toMatchObject({
      sessionId: 'dict-1', message: 'Please restart the companion before the demo, then ping me.',
      dictationIds: [REC_A], dictationText: 'Please restart the companion before the demo, then ping me.',
    })
    await h.unmount()
  })

  it('the box text goes as the person typed it, never the message Walnut framed from it', async () => {
    const h = panel('dict-6', (t) => `> Back to question 3\n\n${t}`)
    await h.render('draft:session:dict-6')
    await h.dictate(REC_A, 'please restart the cloud companion before the demo')
    await h.clickSend()
    expect(rpc.sends[0]).toMatchObject({
      message: '> Back to question 3\n\nplease restart the cloud companion before the demo',
      dictationIds: [REC_A], dictationText: 'please restart the cloud companion before the demo',
    })
    await h.unmount()
  })

  it('a box emptied by hand forgets its take: dictated again later, only the new one goes', async () => {
    const h = panel('dict-7')
    await h.render('draft:session:dict-7')
    await h.dictate(REC_A, 'deploy the cloud companion to the staging box')
    await h.type('')
    await h.type('deploy the cloud companion to the staging box')
    await h.clickSend()
    expect(rpc.sends[0]).not.toHaveProperty('dictationIds')
    await h.unmount()
  })

  it('two dictations in one draft send both ids', async () => {
    const h = panel('dict-2')
    await h.render('draft:session:dict-2')
    await h.dictate(REC_A, 'first we deploy the server')
    await h.dictate(REC_B, 'then we check the logs')
    expect(h.text()).toContain('then we check the logs')
    await h.clickSend()
    expect(rpc.sends[0]!.dictationIds).toEqual([REC_A, REC_B])
    await h.unmount()
  })

  it('every dictated word deleted before the send: no id is sent', async () => {
    const h = panel('dict-3')
    await h.render('draft:session:dict-3')
    await h.dictate(REC_A, 'deploy the cloud companion to the staging box tonight')
    await h.type('ok thanks')
    await h.clickSend()
    expect(rpc.sends[0]).toMatchObject({ message: 'ok thanks' })
    expect(rpc.sends[0]).not.toHaveProperty('dictationIds')
    await h.unmount()
  })

  it('a typed message with no dictation sends no field; the next send does not repeat a sent take', async () => {
    const h = panel('dict-4')
    await h.render('draft:session:dict-4')
    await h.dictate(REC_A, 'the first message')
    await h.clickSend()
    expect(rpc.sends[0]!.dictationIds).toEqual([REC_A])
    await h.type('the first message again, typed')
    await h.clickSend()
    expect(rpc.sends[1]).not.toHaveProperty('dictationIds')
    await h.unmount()
  })

  it('a failed send keeps its ids for the Retry', async () => {
    rpc.answers.push('reject', 'ok')
    const h = panel('dict-5')
    await h.render('draft:session:dict-5')
    await h.dictate(REC_A, 'words that fail to go the first time')
    await h.clickSend()
    expect(rpc.sends[0]!.dictationIds).toEqual([REC_A])
    const failed = h.hook.current!.optimisticMsgs.find((m) => m.status === 'failed')!
    await act(async () => { h.hook.current!.retryFailed(failed.queueId, 'dict-5') })
    await vi.waitFor(() => expect(rpc.sends[1]).toMatchObject({ retryOf: failed.queueId, dictationIds: [REC_A] }))
    await h.unmount()
  })
})
