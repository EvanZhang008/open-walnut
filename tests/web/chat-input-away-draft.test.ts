/**
 * A presence flip never takes what is being typed (docs/plan/walnut-replica-servers-impl.md,
 * WP7 review fix W2). On a host replica's console, a session the Mac runs used
 * to swap its whole composer for the "Your Mac is away" notice, so every flip
 * unmounted ChatInput: the last keystrokes (still in the 300 ms draft debounce),
 * attached images, focus and an IME composition were lost, and the remount
 * replayed the last prefill over the draft. Now the composer stays mounted with
 * `sendBlocked` (send controls hidden), so a flip remounts nothing, and the
 * debounce is flushed on unmount. A composer that MOUNTS with a new prefill still
 * applies it (callers reveal the composer in the same batch as the prefill).
 *
 * The real ChatInput, mounted by react-dom on a linkedom document (the repo has
 * no jsdom). Only its leaf popups and the mic (router + speech hooks) are stubbed;
 * typing and Enter go through the textarea's own React handlers.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js'

vi.mock('../../web/src/components/common/MicButton', () => ({ MicButton: () => null }))
vi.mock('../../web/src/components/chat/MentionPalette', () => ({ MentionPalette: () => null }))
vi.mock('../../web/src/components/chat/FileMentionPopup', () => ({ FileMentionPopup: () => null }))
vi.mock('../../web/src/components/chat/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('@/commands/index', () => ({ searchCommands: () => [], getCommand: () => undefined }))
vi.mock('@/hooks/useChat', () => ({ MAX_QUEUE_SIZE: 10 }))

import { ChatInput } from '../../web/src/components/chat/ChatInput'

class MemoryStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

let doc: Document
let storage: MemoryStorage
beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
})
beforeEach(() => {
  storage = new MemoryStorage()
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  // Focus retries run on frames; nothing here is about focus, so frames never come.
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('getComputedStyle', () => ({ maxHeight: 'none' }))
})
afterEach(() => { vi.unstubAllGlobals() })

type Props = Parameters<typeof ChatInput>[0]

/** The React props on a DOM node (react-dom keeps them there), to call its own handlers. */
function reactProps(node: Element): Record<string, (...args: unknown[]) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith('__reactProps$'))
  if (!key) throw new Error('no React props on the node')
  return (node as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>)[key]!
}

function harness() {
  const el = doc.createElement('div')
  doc.body.appendChild(el)
  let root: Root | null = createRoot(el as unknown as Element)
  const seen: string[] = []
  const base: Props = { onSend: vi.fn(), onValueChange: (t: string) => { seen.push(t) } }
  return {
    el,
    seen,
    base,
    async render(props: Partial<Props>) {
      if (!root) root = createRoot(el as unknown as Element)
      await act(async () => { root!.render(createElement(ChatInput, { ...base, ...props } as Props)) })
    },
    async unmount() {
      await act(async () => { root!.unmount() })
      root = null
    },
    textarea(): HTMLTextAreaElement {
      const ta = el.querySelector('textarea')
      if (!ta) throw new Error('no textarea')
      return ta as unknown as HTMLTextAreaElement
    },
    async type(text: string) {
      const ta = this.textarea()
      await act(async () => { reactProps(ta as unknown as Element).onChange!({ target: { value: text } }) })
    },
    async enter() {
      const ta = this.textarea()
      await act(async () => {
        reactProps(ta as unknown as Element).onKeyDown!({
          key: 'Enter', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, keyCode: 13,
          nativeEvent: { isComposing: false }, preventDefault() {},
        })
      })
    },
    last(): string | undefined { return seen[seen.length - 1] },
  }
}

describe('the draft survives the composer going away', () => {
  it('unmount persists the last keystrokes still inside the debounce', async () => {
    const h = harness()
    await h.render({ draftKey: 'draft:session:s-away-1' })
    await h.type('half a sentence typed just now')
    // Unmounted well inside the 300 ms debounce (a presence flip, a panel closing).
    await h.unmount()
    expect(storage.getItem('draft:session:s-away-1')).toBe('half a sentence typed just now')
    // And the next mount shows it.
    await h.render({ draftKey: 'draft:session:s-away-1' })
    expect(h.last()).toBe('half a sentence typed just now')
    await h.unmount()
  })

  it('a key change writes the previous key\'s last keystrokes under that key', async () => {
    const h = harness()
    await h.render({ draftKey: 'draft:session:s-root' })
    await h.type('root words')
    await h.render({ draftKey: 'draft:session:s-root:q1' })
    expect(storage.getItem('draft:session:s-root')).toBe('root words')
    expect(storage.getItem('draft:session:s-root:q1')).toBeNull()
    await h.unmount()
  })

  it('a composer that mounts with a new prefill applies it (the caller reveals it in the same batch)', async () => {
    const h = harness()
    const key = 'draft:session:s-away-2'
    const quote = 'About src/a.ts line 3: const x = 1'
    await h.render({ draftKey: key, prefillText: quote, prefillNonce: 1 })
    expect(h.last()).toBe(quote)
    expect(storage.getItem(key)).toBe(quote)
    await h.unmount()
  })
})

describe('sendBlocked: the editor stays, the send controls go', () => {
  it('a flip keeps the same textarea and its text, hides send, ignores Enter, and gives send back', async () => {
    const h = harness()
    const onSend = vi.fn()
    const slot = createElement('span', { className: 'controls-slot-probe' }, 'Mode')
    await h.render({ draftKey: 'draft:session:s-away-3', onSend, controlsSlot: slot })
    await h.type('hello there')
    const ta = h.textarea()
    expect(h.el.querySelector('.chat-send-btn-icon')).not.toBeNull()
    expect(h.el.querySelector('.controls-slot-probe')).not.toBeNull()

    await h.render({ draftKey: 'draft:session:s-away-3', onSend, controlsSlot: slot, sendBlocked: true })
    expect(h.textarea()).toBe(ta)
    expect(ta.hasAttribute('disabled')).toBe(false)
    expect(h.last()).toBe('hello there')
    expect(h.el.querySelector('.chat-input-container')!.getAttribute('data-send-blocked')).toBe('true')
    expect(h.el.querySelector('.chat-send-group')).toBeNull()
    expect(h.el.querySelector('.chat-send-btn-icon')).toBeNull()
    expect(h.el.querySelector('.controls-slot-probe')).toBeNull()
    // Enter sends nothing and clears nothing.
    await h.enter()
    expect(onSend).not.toHaveBeenCalled()
    expect(h.last()).toBe('hello there')
    // Typing goes on while blocked.
    await h.type('hello there, still typing')

    await h.render({ draftKey: 'draft:session:s-away-3', onSend, controlsSlot: slot, sendBlocked: false })
    expect(h.textarea()).toBe(ta)
    expect(h.el.querySelector('.chat-input-container')!.hasAttribute('data-send-blocked')).toBe(false)
    const send = h.el.querySelector('.chat-send-btn-icon')!
    await act(async () => { reactProps(send).onClick!() })
    expect(onSend).toHaveBeenCalledWith('hello there, still typing', undefined)
    await h.unmount()
  })

  it('not blocked renders exactly what a composer without the prop renders (the Mac\'s panel is unchanged)', async () => {
    const a = harness()
    await a.render({ draftKey: 'draft:session:s-same', placeholder: 'Message' })
    const plain = a.el.innerHTML
    await a.unmount()
    const b = harness()
    await b.render({ draftKey: 'draft:session:s-same', placeholder: 'Message', sendBlocked: false })
    expect(b.el.innerHTML).toBe(plain)
    expect(plain).toContain('chat-send-btn-icon')
    expect(plain).not.toContain('data-send-blocked')
    await b.unmount()
  })

  it('the session panel keeps ChatInput mounted while the Mac is away (no swap for the notice)', () => {
    const src = readFileSync(new URL('../../web/src/components/sessions/SessionPanel.tsx', import.meta.url), 'utf8')
    expect(src).not.toMatch(/macSessionAway\s*\?\s*<MacAwayComposer/)
    expect(src).toMatch(/\{macSessionAway && <MacAwayComposer \/>\}\s*<ChatInput\s+sendBlocked=\{macSessionAway\}/)
  })
})
