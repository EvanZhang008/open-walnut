/**
 * A form saved with useDraftValue never shows one frame of "unsaved" after its save.
 *
 * 2026-11-08, router review round 2: the router's area rules form confirmed, then cleared its
 * draft and took the server's reply as its new saved value in the same render. The clear set the
 * box back to the OLD saved value (the one it read when clear ran), so for one render the form
 * compared the old value against the new one, read it as an unsaved edit on an older revision, and
 * showed "Area rules changed elsewhere" until the baseline effect caught up. A check that read the
 * page in that frame saw the refusal. The class: every useDraftValue form whose save moves its
 * baseline; the fix is in the one hook they all share (useDraft), so this test covers every one.
 *
 * The real hook and draft store on a linkedom document; every render's `dirty` is recorded.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
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
vi.mock('@/api/client', () => ({ apiGet: vi.fn(async () => ({ drafts: {} })), apiPut: vi.fn(async () => ({})) }))

import { createElement, act, useState } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import { useDraftValue, type DraftValueHandle } from '../../web/src/hooks/useDraft'
import { initDraftSync } from '../../web/src/utils/drafts'

let doc: Document
beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
  ;(dom.window as unknown as Record<string, unknown>).localStorage = shim.storage
  await initDraftSync()
})

interface Saved { revision: string; picks: string[] }

describe('useDraftValue after a save', () => {
  it('a clear in the same render as the new saved value is never read as unsaved', async () => {
    const renders: Array<{ dirty: boolean; revision: string }> = []
    let form!: DraftValueHandle<Saved>
    let setSaved!: (s: Saved) => void
    function Form() {
      const [saved, set] = useState<Saved>({ revision: 'r1', picks: [] })
      setSaved = set
      form = useDraftValue<Saved>('draft:test-form', saved)
      renders.push({ dirty: form.dirty, revision: form.value.revision })
      return null
    }
    const el = doc.createElement('div')
    doc.body.appendChild(el)
    const root = createRoot(el as unknown as Element)
    await act(async () => { root.render(createElement(Form)) })
    await act(async () => { form.setValue((v) => ({ ...v, picks: ['work'] })) })
    expect(form.dirty).toBe(true)
    const sentKey = form.key, sentText = JSON.stringify(form.value)
    const from = renders.length
    // The save's answer: clear the sent draft and take the server's value, in one batch.
    await act(async () => { form.clear(sentKey, sentText); setSaved({ revision: 'r2', picks: ['work'] }) })
    const after = renders.slice(from)
    expect(after.length).toBeGreaterThan(0)
    expect(after.filter((r) => r.dirty)).toEqual([])
    expect(after.at(-1)).toEqual({ dirty: false, revision: 'r2' })
    // Typing again is a draft again, against the new value.
    await act(async () => { form.setValue((v) => ({ ...v, picks: [] })) })
    expect(form.dirty).toBe(true)
    expect(form.value.revision).toBe('r2')
    await act(async () => { root.unmount() })
  })
})
