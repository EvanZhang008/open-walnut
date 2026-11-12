/**
 * A composer replaced under the caret takes it back (web/src/utils/composer-caret-keep.ts), but
 * only when the person did not choose something else first. 2026-11-12: the extension panel's
 * Save as todo re-keys its composer after the click on Save, and the new box took the caret back,
 * so the composer stayed grown instead of docking (extension-first-page.spec.ts). A press anywhere
 * outside the box the person typed in is their choice: no remount after it pulls the caret back.
 */
import { afterEach, describe, expect, it } from 'vitest'

class FakeBox {
  isConnected = true
  disabled = false
  value = 'Renew the card'
  selectionStart = 14
  selectionEnd = 14
  dataset: Record<string, string>
  ownerDocument: FakeDoc
  focused = false
  constructor(doc: FakeDoc, key: string) { this.ownerDocument = doc; this.dataset = { draftKey: key } }
  focus() { this.focused = true; this.ownerDocument.activeElement = this }
  setSelectionRange() {}
  contains(n: unknown) { return n === this }
}
class FakeDoc {
  body = { tag: 'body' }
  documentElement = { tag: 'html' }
  activeElement: unknown = this.body
  listeners = new Map<string, Array<(e: Event) => void>>()
  addEventListener(t: string, f: (e: Event) => void) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), f]) }
  removeEventListener(t: string, f: (e: Event) => void) { this.listeners.set(t, (this.listeners.get(t) ?? []).filter((g) => g !== f)) }
  querySelectorAll() { return [] }
  fire(t: string, target: unknown) { for (const f of this.listeners.get(t) ?? []) f({ target } as unknown as Event) }
}
// The module checks `instanceof HTMLTextAreaElement` and `instanceof Node`.
Object.assign(globalThis, { HTMLTextAreaElement: FakeBox, Node: Object })

const { initComposerCaretKeep, caretBackOnMount } = await import('../../web/src/utils/composer-caret-keep')

let stop: (() => void) | null = null
afterEach(() => { stop?.(); stop = null })

function typedThenReplaced(pressElsewhere: boolean) {
  const doc = new FakeDoc()
  let t = 0
  stop = initComposerCaretKeep({ doc: doc as unknown as Document, now: () => t })
  const old = new FakeBox(doc, 'draft:home')
  doc.fire('input', old)
  t = 100
  if (pressElsewhere) doc.fire('pointerdown', { tag: 'button' })
  // The box is re-keyed: the old one leaves, the caret falls to the body, a new one mounts.
  old.isConnected = false
  doc.activeElement = doc.body
  const fresh = new FakeBox(doc, 'draft:home')
  caretBackOnMount(fresh as unknown as HTMLTextAreaElement, 200)
  return fresh
}

describe('composer caret keep', () => {
  it('a box replaced while the person types takes the caret back', () => {
    expect(typedThenReplaced(false).focused).toBe(true)
  })
  it('a press outside the box first (a Save button) keeps the person\'s choice: the new box stays unfocused', () => {
    expect(typedThenReplaced(true).focused).toBe(false)
  })
  it('a press inside the box the person types in keeps the rescue armed', () => {
    const doc = new FakeDoc()
    let t = 0
    stop = initComposerCaretKeep({ doc: doc as unknown as Document, now: () => t })
    const old = new FakeBox(doc, 'draft:home')
    doc.fire('input', old)
    doc.fire('pointerdown', old)
    t = 100
    old.isConnected = false
    const fresh = new FakeBox(doc, 'draft:home')
    caretBackOnMount(fresh as unknown as HTMLTextAreaElement, 200)
    expect(fresh.focused).toBe(true)
  })
})
