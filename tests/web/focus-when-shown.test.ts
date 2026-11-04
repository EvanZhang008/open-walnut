/**
 * focusWhenShown (web/src/utils/focus-when-shown.ts): a box in a hidden page takes focus once it is
 * shown, however many frames that takes. 2026-11-03: New task from a mail opened its draft while
 * Home was still hidden, and the caret was not in the prompt. A fake box and a fake frame clock:
 * focus() only takes while the box is shown, as a browser does for a display:none textarea.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusWhenShown } from '../../web/src/utils/focus-when-shown'

let now = 0
let frames: Array<() => void> = []
const doc = { activeElement: null as unknown }

function tick(ms: number): void {
  for (let t = 0; t < ms; t += 16) {
    now += 16
    const due = frames
    frames = []
    for (const f of due) f()
  }
}

function box() {
  let shown = false
  const el = {
    value: 'Title\n\nContext\n\n',
    selectionStart: 0,
    get offsetParent() { return shown ? {} : null },
    focus() { if (shown) doc.activeElement = el },
    setSelectionRange(a: number) { el.selectionStart = a },
  }
  return { el: el as unknown as HTMLTextAreaElement, show: () => { shown = true } }
}

beforeEach(() => {
  now = 0
  frames = []
  doc.activeElement = null
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.stubGlobal('document', doc)
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => { frames.push(f); return ++id })
  vi.stubGlobal('cancelAnimationFrame', () => { frames = [] })
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('focusWhenShown', () => {
  it('waits while hidden, then focuses and runs the caret step once', () => {
    const { el, show } = box()
    const placed = vi.fn((t: HTMLTextAreaElement | HTMLInputElement) => t.setSelectionRange(t.value.length, t.value.length))
    focusWhenShown(() => el, placed)
    // 1.5 s of frames while hidden: more than the 20 frames the old loops allowed.
    tick(1500)
    expect(doc.activeElement).toBeNull()
    expect(placed).not.toHaveBeenCalled()
    show()
    tick(16)
    expect(doc.activeElement).toBe(el)
    expect(el.selectionStart).toBe(el.value.length)
    tick(500)
    expect(placed).toHaveBeenCalledTimes(1)
  })

  it('focuses a box already on screen at once, with no frame in between', () => {
    const { el, show } = box()
    show()
    const placed = vi.fn()
    focusWhenShown(() => el, placed)
    expect(doc.activeElement).toBe(el)
    expect(placed).toHaveBeenCalledTimes(1)
    // One look on the next frame, in case a later effect of the same commit took focus away.
    expect(frames).toHaveLength(1)
    tick(16)
    expect(doc.activeElement).toBe(el)
    expect(placed).toHaveBeenCalledTimes(1)
    expect(frames).toHaveLength(0)
  })

  it('takes focus back when a later effect of the same commit took it', () => {
    const { el, show } = box()
    const other = box()
    show()
    other.show()
    const placed = vi.fn()
    focusWhenShown(() => el, placed)
    other.el.focus()
    tick(16)
    expect(doc.activeElement).toBe(el)
    expect(placed).toHaveBeenCalledTimes(2)
  })

  it('tries one last time at the deadline, and a cancel stops it', () => {
    const a = box()
    const atEnd = vi.fn()
    focusWhenShown(() => a.el, atEnd, 200)
    tick(400)
    expect(atEnd).toHaveBeenCalledTimes(1)
    expect(frames).toHaveLength(0)
    const b = box()
    const cancel = focusWhenShown(() => b.el, undefined, 200)
    cancel()
    b.show()
    tick(400)
    expect(doc.activeElement).toBeNull()
  })
})

describe('focus retries in the web app use focusWhenShown', () => {
  it('no hand-rolled frame-counted focus loop is left', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const root = path.resolve(import.meta.dirname, '../../web/src')
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (/\.tsx?$/.test(e.name) && /offsetParent === null && frames\+\+/.test(fs.readFileSync(full, 'utf8'))) hits.push(path.relative(root, full))
      }
    }
    walk(root)
    // A frame count is no budget on a loaded machine (2026-11-03): retry by time with focusWhenShown.
    expect(hits).toEqual([])
  })
})
