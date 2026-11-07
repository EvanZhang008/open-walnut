/**
 * A redraw of the popup never empties what the person typed (packages/browser-extension/src/popup-view.ts
 * paint): the vault watch redrew the lock screen between a typed master password and Unlock, so the
 * click submitted an empty field and the popup stayed locked (extension-fill-menus.spec.ts on a loaded
 * runner, 2026-11-07). Every field in KEEP_TYPED moves into the new view, with the focus.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../packages/browser-extension/src/ext', () => ({ ext: { storage: { onChanged: { addListener() {}, removeListener() {} } } } }))

class Field {
  value = ''
  focused = 0
  constructor(public id: string) {}
  focus() { this.focused++ }
}
class View {
  dataset: Record<string, string> = {}
  constructor(public fields: Field[] = []) {}
  querySelector(sel: string): Field | null { return this.fields.find((f) => `#${f.id}` === sel) ?? null }
  replaceChildren(el: View) { this.fields = el.fields }
}

describe('paint keeps typed fields', () => {
  it('every kept field carries its typed value and focus into the redrawn view', async () => {
    const { paint, nextView, KEEP_TYPED } = await import('../../../packages/browser-extension/src/popup-view')
    const typed = KEEP_TYPED.map((id) => Object.assign(new Field(id), { value: `typed-${id}` }))
    const root = new View(typed)
    ;(globalThis as Record<string, unknown>).document = { activeElement: typed[0] }
    const fresh = KEEP_TYPED.map((id) => new Field(id))
    expect(paint(root as never, new View(fresh) as never, nextView(), 'locked', 'home')).toBe(true)
    await Promise.resolve()
    for (const f of fresh) expect(f.value).toBe(`typed-${f.id}`)
    expect(fresh[0].focused).toBe(1)
  })

  it('a value the new view brings (a server address it found) wins, and an empty field stays empty', async () => {
    const { paint, nextView } = await import('../../../packages/browser-extension/src/popup-view')
    const root = new View([Object.assign(new Field('server'), { value: 'http://old:1' }), new Field('pw')])
    ;(globalThis as Record<string, unknown>).document = { activeElement: null }
    const server = Object.assign(new Field('server'), { value: 'http://found:2' })
    const pw = new Field('pw')
    paint(root as never, new View([server, pw]) as never, nextView(), 'neutral', 'home')
    expect(server.value).toBe('http://found:2')
    expect(pw.value).toBe('')
  })
})
